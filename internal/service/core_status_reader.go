package service

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type coreCommandRunner func(context.Context, string, ...string) ([]byte, error)

// CoreStatusReader collects local core readings without restart permissions or
// requiring the caller to be the systemd-managed API process.
type CoreStatusReader struct {
	run coreCommandRunner
}

func NewCoreStatusReader() *CoreStatusReader {
	return &CoreStatusReader{run: runCoreStatusCommand}
}

func runCoreStatusCommand(ctx context.Context, executable string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, executable, args...).Output()
}

func (s *CoreStatusReader) Status(ctx context.Context) CoreStatus {
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	snapshot, values, err := readCoreSystemdSnapshot(probeCtx, s.run)
	if err != nil {
		return CoreStatus{State: "unknown", Reason: "The local sing-box service status could not be read."}
	}
	status := snapshot.CoreStatus
	if values["LoadState"] != "loaded" {
		status.State = "unknown"
		return status
	}
	executable, err := coreStatusExecutable(values["ExecStart"])
	if err != nil {
		status.Reason = "The local sing-box executable could not be identified."
		return status
	}
	output, err := s.run(probeCtx, executable, "version")
	if err == nil {
		status.CurrentVersion, err = parseCoreReportedVersion(output)
	}
	if err != nil {
		status.Reason = "The local sing-box version could not be read."
	}
	return status
}

func readCoreSystemdSnapshot(ctx context.Context, run coreCommandRunner) (coreSnapshot, map[string]string, error) {
	output, err := run(ctx, "systemctl", "show", "sing-box.service", "--property=LoadState", "--property=ActiveState", "--property=MainPID", "--property=ExecStart", "--property=WorkingDirectory", "--property=ExecMainStartTimestampMonotonic")
	if err != nil {
		return coreSnapshot{}, nil, err
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
	}
	return snapshot, values, nil
}

var coreExecutablePath = regexp.MustCompile(`\bpath=([^ ;]+) ;`)
var coreReportedVersion = regexp.MustCompile(`^v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)

func coreStatusExecutable(value string) (string, error) {
	matches := coreExecutablePath.FindAllStringSubmatch(value, -1)
	if len(matches) == 1 {
		switch matches[0][1] {
		case "/usr/bin/sing-box", "/usr/local/bin/sing-box":
			return matches[0][1], nil
		}
	}
	return "", fmt.Errorf("Unsupported sing-box executable")
}

func parseCoreReportedVersion(output []byte) (string, error) {
	fields := strings.Fields(strings.SplitN(string(output), "\n", 2)[0])
	if len(fields) != 3 || fields[0] != "sing-box" || fields[1] != "version" || !coreReportedVersion.MatchString(fields[2]) {
		return "", fmt.Errorf("The installed sing-box version could not be read")
	}
	return strings.TrimPrefix(fields[2], "v"), nil
}
