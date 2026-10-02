package service

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/agent"
)

type systemdCoreHost struct{}

func (systemdCoreHost) Available() (bool, string) {
	if supported, reason := (systemdPanelHost{}).Available(); !supported {
		return false, reason
	}
	if os.Geteuid() != 0 {
		return false, "Core restart requires the installed local service manager permissions."
	}
	if _, err := exec.LookPath("flock"); err != nil {
		return false, "Install flock to coordinate core restart with agent configuration updates."
	}
	return true, ""
}

var coreArguments = regexp.MustCompile(`argv\[\]=(.*?) ;`)
var corePath = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)

func parseCoreLaunch(value, workingDirectory string) (coreLaunch, error) {
	matches := coreArguments.FindAllStringSubmatch(value, -1)
	if len(matches) != 1 {
		return coreLaunch{}, fmt.Errorf("Unsupported sing-box launch command")
	}
	args := strings.Fields(matches[0][1])
	if len(args) < 4 || (args[0] != "/usr/bin/sing-box" && args[0] != "/usr/local/bin/sing-box") || args[len(args)-1] != "run" {
		return coreLaunch{}, fmt.Errorf("Unsupported sing-box launch command")
	}
	if workingDirectory != "" && (!corePath.MatchString(workingDirectory) || path.Clean(workingDirectory) != workingDirectory) {
		return coreLaunch{}, fmt.Errorf("Unsupported core working directory")
	}
	var lockDirectory string
	for i := 1; i < len(args)-1; i += 2 {
		if i+1 >= len(args)-1 || !corePath.MatchString(args[i+1]) || path.Clean(args[i+1]) != args[i+1] {
			return coreLaunch{}, fmt.Errorf("Unsupported sing-box launch arguments")
		}
		switch args[i] {
		case "-D", "--directory":
		case "-C", "--config-directory", "-c", "--config":
			if lockDirectory != "" {
				return coreLaunch{}, fmt.Errorf("Multiple core configuration locations are not supported")
			}
			lockDirectory = args[i+1]
			if args[i] == "-c" || args[i] == "--config" {
				lockDirectory = path.Dir(lockDirectory)
			}
		default:
			return coreLaunch{}, fmt.Errorf("Unsupported sing-box launch argument")
		}
	}
	if lockDirectory == "" {
		return coreLaunch{}, fmt.Errorf("The service has no explicit core configuration location")
	}
	return coreLaunch{Executable: args[0], Arguments: append([]string{}, args[1:]...), WorkingDirectory: workingDirectory,
		LockPath: path.Join(lockDirectory, ".x-ui-core.lock")}, nil
}

func localCoreAgent() (*agent.Config, error) {
	environment, err := agent.ReadEnvironment("/etc/x-ui/agent.env")
	if err != nil {
		return nil, err
	}
	cfg, err := agent.LoadWithEnvironment("/etc/x-ui/agent.yaml", environment)
	if err != nil {
		return nil, err
	}
	endpoint, err := url.Parse(cfg.Stats.URL)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(endpoint.Hostname())
	if cfg.Stats.Source != agent.StatsSourceSingBox || cfg.Stats.Secret == "" || (endpoint.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
		return nil, fmt.Errorf("An authenticated local native sing-box statistics API is required")
	}
	if len(cfg.Core.ReloadCommand) == 0 || cfg.Core.ReloadCommand[0] != "/usr/local/x-ui/bin/x-ui-core-reload" {
		return nil, fmt.Errorf("The local agent must use the installed core reload helper")
	}
	helper, err := os.ReadFile(cfg.Core.ReloadCommand[0])
	if err != nil || !bytes.Contains(helper, []byte(".x-ui-core.lock")) {
		return nil, fmt.Errorf("Install the updated core reload helper to enable coordinated restart")
	}
	return cfg, nil
}

func (systemdCoreHost) Info(ctx context.Context) (coreSnapshot, error) {
	command := exec.CommandContext(ctx, "systemctl", "show", "sing-box.service", "--property=LoadState", "--property=ActiveState", "--property=MainPID", "--property=ExecStart", "--property=WorkingDirectory", "--property=ExecMainStartTimestampMonotonic")
	output, err := command.Output()
	if err != nil {
		return coreSnapshot{}, err
	}
	values := make(map[string]string)
	for _, line := range strings.Split(string(output), "\n") {
		key, value, _ := strings.Cut(line, "=")
		values[key] = value
	}
	pid, _ := strconv.Atoi(values["MainPID"])
	started, _ := strconv.ParseInt(values["ExecMainStartTimestampMonotonic"], 10, 64)
	snapshot := coreSnapshot{CoreStatus: CoreStatus{State: values["ActiveState"], PID: pid}, StartedMicro: started}
	if snapshot.State == "" {
		snapshot.State = "unknown"
	}
	if pid > 0 && started > 0 {
		snapshot.UptimeSeconds = max(0, (coreMonotonicMicro()-started)/1_000_000)
	}
	if values["LoadState"] != "loaded" {
		snapshot.Reason = "A local sing-box systemd service is not installed."
		return snapshot, nil
	}
	snapshot.Launch, err = parseCoreLaunch(values["ExecStart"], values["WorkingDirectory"])
	if err != nil {
		snapshot.Reason = "The local sing-box startup command is unsupported; use the service manager on the server."
		return snapshot, nil
	}
	cfg, err := localCoreAgent()
	if err != nil {
		snapshot.Reason = "Coordinated restart requires the managed local agent, native statistics and the updated core reload helper."
		return snapshot, nil
	}
	target := "/etc/sing-box/config.json"
	if len(cfg.Core.ReloadCommand) == 3 {
		target = cfg.Core.ReloadCommand[2]
	} else if len(cfg.Core.ReloadCommand) != 1 {
		snapshot.Reason = "The local agent uses unsupported core reload arguments."
		return snapshot, nil
	}
	if path.Join(path.Dir(target), ".x-ui-core.lock") != snapshot.Launch.LockPath {
		snapshot.Reason = "The local agent and service use different core configuration directories."
		return snapshot, nil
	}
	if info, err := os.Lstat(path.Dir(snapshot.Launch.LockPath)); err != nil || !info.IsDir() {
		snapshot.Reason = "The service configuration directory is missing or symlinked."
		return snapshot, nil
	}
	snapshot.Supported = true
	return snapshot, nil
}

func (systemdCoreHost) Schedule(ctx context.Context, directory, id string) error {
	return fixedPanelCommand(ctx, "systemd-run", "--quiet", "--collect", "--unit=x-ui-core-restart-"+id,
		"--on-active=2s", "--timer-property=AccuracySec=100ms", "--timer-property=RemainAfterElapse=no",
		"--property=Type=exec", "--property=WorkingDirectory=/usr/local/x-ui", "--property=RuntimeMaxSec=120s",
		"--property=Restart=on-failure", "--property=RestartSec=3s", panelCLI, "core-restart", "-directory", directory, "-job", id)
}

// Never publish validator output: it can contain values from private configs.
func (systemdCoreHost) Validate(ctx context.Context, launch coreLaunch) error {
	args := append([]string{}, launch.Arguments...)
	args[len(args)-1] = "check"
	command := exec.CommandContext(ctx, launch.Executable, args...)
	command.Dir = launch.WorkingDirectory
	return command.Run()
}

func (systemdCoreHost) Restart(ctx context.Context) error {
	return fixedPanelCommand(ctx, "systemctl", "restart", "sing-box.service")
}

func (systemdCoreHost) Healthy(ctx context.Context) error {
	cfg, err := localCoreAgent()
	if err != nil {
		return err
	}
	return agent.ProbeSingBoxStats(ctx, cfg.Stats)
}

type coreLogBuffer struct{ data []byte }

func (buffer *coreLogBuffer) Write(data []byte) (int, error) {
	if left := 64*1024 - len(buffer.data); left > 0 {
		buffer.data = append(buffer.data, data[:min(left, len(data))]...)
	}
	return len(data), nil
}

func (systemdCoreHost) Logs(ctx context.Context) ([]string, error) {
	var output coreLogBuffer
	command := exec.CommandContext(ctx, "journalctl", "--unit=sing-box.service", "--lines=80", "--no-pager", "--output=cat")
	command.Stdout = &output
	if err := command.Run(); err != nil {
		return nil, err
	}
	text := strings.TrimSpace(strings.ToValidUTF8(string(output.data), ""))
	if text == "" {
		return []string{}, nil
	}
	return strings.Split(text, "\n"), nil
}
