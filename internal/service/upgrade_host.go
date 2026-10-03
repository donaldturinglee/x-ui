package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
)

type systemdUpgradeHost struct{}

func (systemdUpgradeHost) Available(directory string) (string, bool, string) {
	platform, _ := releasePlatform(runtime.GOARCH)
	if runtime.GOOS != "linux" {
		return platform, false, "Automatic upgrade requires a Linux systemd installation."
	}
	if output, err := exec.Command("uname", "-m").Output(); err == nil {
		platform, _ = releasePlatform(strings.TrimSpace(string(output)))
	}
	if runtime.GOARCH == "arm" && platform == "arm64" {
		platform = "armv7"
	}
	if platform == "" {
		return "", false, "This CPU architecture has no release package."
	}
	if os.Geteuid() != 0 || directory != installedConfigDir {
		return platform, false, "Automatic upgrade requires the standard root-managed installation."
	}
	if supported, reason := (systemdPanelHost{}).Available(); !supported {
		return platform, false, reason
	}
	return platform, true, ""
}

func (systemdUpgradeHost) Components(ctx context.Context) ([]string, bool, error) {
	components := []string{"API", "Worker", "CLI", "Web panel", "Database migrations", "Menu", "Service files"}
	for _, unit := range []string{"x-ui-api", "x-ui-worker"} {
		if err := verifyUpgradeUnit(ctx, unit); err != nil {
			return nil, false, err
		}
		if _, err := (systemdPanelHost{}).PID(ctx, unit); err != nil {
			return nil, false, err
		}
	}
	managed, err := locallyManagedPanelAgent("/etc/x-ui")
	if err != nil {
		return nil, false, err
	}
	if managed {
		if err := verifyUpgradeUnit(ctx, "x-ui-agent"); err != nil {
			return nil, false, err
		}
		if _, err := (systemdPanelHost{}).PID(ctx, "x-ui-agent"); err != nil {
			return nil, false, err
		}
		components = append(components, "Local agent", "Core reload helper")
	} else if _, err := os.Stat("/etc/systemd/system/x-ui-agent.service"); err == nil {
		return nil, false, fmt.Errorf("The installed agent is not managed by this panel")
	}
	return components, managed, nil
}

func verifyUpgradeUnit(ctx context.Context, unit string) error {
	filename := "/etc/systemd/system/" + unit + ".service"
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("Unsupported installed service file")
	}
	output, err := exec.CommandContext(ctx, "systemctl", "show", unit+".service", "--property=FragmentPath,DropInPaths,User,WorkingDirectory,ExecStart,Environment,EnvironmentFiles").Output()
	if err != nil {
		return err
	}
	properties := make(map[string]string)
	for _, line := range strings.Split(string(output), "\n") {
		key, value, _ := strings.Cut(line, "=")
		properties[key] = value
	}
	if properties["FragmentPath"] != filename || properties["DropInPaths"] != "" || properties["User"] != "" && properties["User"] != "root" {
		return fmt.Errorf("Custom service overrides require a command-line upgrade")
	}
	matches := coreArguments.FindAllStringSubmatch(properties["ExecStart"], -1)
	expected := "/usr/local/x-ui/bin/" + unit
	if unit == "x-ui-agent" {
		expected += " -config /etc/x-ui/agent.yaml"
	}
	if len(matches) != 1 || matches[0][1] != expected {
		return fmt.Errorf("Unsupported installed service command")
	}
	if unit != "x-ui-agent" && (strings.TrimSuffix(properties["WorkingDirectory"], "/") != "/usr/local/x-ui" || properties["Environment"] != "" || properties["EnvironmentFiles"] != "") {
		return fmt.Errorf("Custom panel service configuration requires a command-line upgrade")
	}
	return nil
}

const upgradeRecoveryUnit = `[Unit]
Description=Recover an interrupted x-ui upgrade
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/var/lib/x-ui/upgrade/recovery-cli upgrade-resume
TimeoutStartSec=45min

[Install]
WantedBy=multi-user.target
`

func (systemdUpgradeHost) Schedule(ctx context.Context, directory, id string) error {
	root := upgradeRoot(directory)
	jobDirectory := upgradeJobDir(root, id)
	if err := copyUpgradeFile(panelCLI, filepath.Join(jobDirectory, "runner"), 0o700); err != nil {
		return err
	}
	if err := copyUpgradeFile(panelCLI, filepath.Join(root, "recovery-cli"), 0o700); err != nil {
		return err
	}
	if err := writePanelPrivate("/etc/systemd/system/x-ui-upgrade-recovery.service", []byte(upgradeRecoveryUnit)); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, "systemctl", "enable", "x-ui-upgrade-recovery.service"); err != nil {
		return err
	}
	return fixedPanelCommand(ctx, "systemd-run", "--quiet", "--collect", "--unit=x-ui-upgrade-"+id,
		"--on-active=2s", "--timer-property=AccuracySec=100ms", "--timer-property=RemainAfterElapse=no",
		"--property=Type=exec", "--property=WorkingDirectory=/usr/local/x-ui", "--property=RuntimeMaxSec=45min",
		"--property=Restart=on-failure", "--property=RestartSec=5s",
		filepath.Join(jobDirectory, "runner"), "upgrade-run", "-directory", directory, "-job", id)
}

func upgradeCommand(ctx context.Context, directory string, record *upgradeRecord, executable string, extraEnvironment map[string]string, args ...string) error {
	command := exec.CommandContext(ctx, executable, args...)
	command.Dir = "/usr/local/x-ui"
	command.Env = os.Environ()
	for key, value := range record.Environment {
		if strings.HasPrefix(key, "X_UI_") && key != "X_UI_MAINTENANCE_OWNER" {
			command.Env = append(command.Env, key+"="+value)
		}
	}
	command.Env = append(command.Env, "X_UI_CONFIG_DIR="+directory, "X_UI_MAINTENANCE_OWNER=upgrade:"+record.Job.ID)
	for key, value := range extraEnvironment {
		command.Env = append(command.Env, key+"="+value)
	}
	command.Stdout, command.Stderr = io.Discard, io.Discard
	if err := command.Run(); err != nil {
		return fmt.Errorf("Upgrade command %s failed: %w", filepath.Base(executable), err)
	}
	return nil
}

func upgradeBinaryVersion(ctx context.Context, executable, expected string) error {
	output, err := exec.CommandContext(ctx, executable, "version").Output()
	if err != nil {
		return err
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 || fields[0] != config.Name || fields[1] != expected {
		return fmt.Errorf("The binary version does not match the confirmed release")
	}
	return nil
}

func (host systemdUpgradeHost) Preflight(ctx context.Context, directory string, record *upgradeRecord, stage string) error {
	components, agent, err := host.Components(ctx)
	if err != nil || agent != record.Agent || !reflect.DeepEqual(components, record.Job.Components) {
		return fmt.Errorf("The installed components changed")
	}
	var manifest struct {
		Version  string `json:"version"`
		Platform string `json:"platform"`
		Protocol int    `json:"upgradeProtocol"`
	}
	if err := readPanelJSON(filepath.Join(stage, "release.json"), &manifest); err != nil {
		return err
	}
	if manifest.Version != record.Job.ToVersion || manifest.Platform != record.Platform || manifest.Protocol != 1 {
		return fmt.Errorf("This release has no compatible upgrade protocol")
	}
	if err := upgradeBinaryVersion(ctx, filepath.Join(stage, "bin", "x-ui-cli"), record.Job.ToVersion); err != nil {
		return err
	}
	if err := upgradeBinaryVersion(ctx, panelCLI, record.Job.FromVersion); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(directory, "config.yaml"))
	if err != nil {
		return err
	}
	cfg, err := config.Parse(data)
	if err != nil {
		return err
	}
	if cfg.Database.MigrationsDir != "migrations" && cfg.Database.MigrationsDir != "/usr/local/x-ui/migrations" || cfg.Server.WebDir != "web" && cfg.Server.WebDir != "/usr/local/x-ui/web" {
		return fmt.Errorf("Custom migration or web directories require a command-line upgrade")
	}
	if !startupProcessesAgree(directory, panelSettingsOf(cfg), subscriptionSettingsOf(cfg)) {
		return fmt.Errorf("API and worker do not agree on the saved startup configuration")
	}
	for _, kind := range []string{"api", "worker"} {
		var process PanelProcessRuntime
		pid, err := (systemdPanelHost{}).PID(ctx, "x-ui-"+kind)
		if err != nil || readPanelJSON(filepath.Join(panelRuntimeDir(directory), kind+".json"), &process) != nil || process.PID != pid || process.Version != record.Job.FromVersion || process.DatabaseRevision != upgradeDatabaseRevision(cfg) {
			return fmt.Errorf("API and worker must run the same version and database before upgrading")
		}
	}
	if err := upgradeCommand(ctx, directory, record, filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "runner"), nil, "database", "-check"); err != nil {
		return err
	}
	var fileBytes uint64
	for _, item := range upgradeFileTargets(directory, record.Agent) {
		if err := rejectUpgradeLinks(filepath.Dir(item.target)); err != nil {
			return err
		}
		if err := filepath.WalkDir(item.target, func(filename string, entry os.DirEntry, walkErr error) error {
			if os.IsNotExist(walkErr) {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.IsDir() && !info.Mode().IsRegular() {
				return fmt.Errorf("Unsupported installation backup file")
			}
			if info.Mode().IsRegular() {
				fileBytes += uint64(info.Size())
			}
			return nil
		}); err != nil {
			return err
		}
	}
	db, err := database.Open(cfg.Database, false)
	if err != nil {
		return err
	}
	defer database.Close(db)
	var databaseBytes int64
	if err := db.WithContext(ctx).Raw("SELECT pg_database_size(current_database())").Scan(&databaseBytes).Error; err != nil {
		return err
	}
	if databaseBytes < 0 || uint64(databaseBytes) > (1<<63)/3 {
		return fmt.Errorf("Invalid database backup size")
	}
	if err := checkUpgradeSpace(upgradeJobDir(upgradeRoot(directory), record.Job.ID), fileBytes+uint64(databaseBytes)*3+uint64(record.Release.AssetSize)*4+128<<20); err != nil {
		return err
	}
	if err := checkUpgradeSpace("/usr/local/x-ui", uint64(record.Release.AssetSize)*4+128<<20); err != nil {
		return err
	}
	// Allocate the replacement trees on the installation filesystem now, before
	// services are stopped, so a full filesystem fails during preparation.
	for _, name := range []string{"migrations", "web/build"} {
		target := upgradePreparedTree("/usr/local/x-ui/"+name, record.Job.ID)
		if err := os.Mkdir(target, 0o755); err != nil {
			return err
		}
		if err := copyUpgradeTree(filepath.Join(stage, filepath.FromSlash(name)), target); err != nil {
			return err
		}
	}
	return nil
}

type upgradeFileTarget struct {
	name, target    string
	tree, reference bool
}

func upgradeFileTargets(directory string, agent bool) []upgradeFileTarget {
	items := []upgradeFileTarget{
		{"api", "/usr/local/x-ui/bin/x-ui-api", false, false}, {"worker", "/usr/local/x-ui/bin/x-ui-worker", false, false}, {"cli", panelCLI, false, false},
		{"migrations", "/usr/local/x-ui/migrations", true, false}, {"web", "/usr/local/x-ui/web/build", true, false},
		{"cli-wrapper", "/usr/bin/x-ui-cli", false, false}, {"menu", "/usr/bin/x-ui", false, false},
		{"service-api", "/etc/systemd/system/x-ui-api.service", false, false}, {"service-worker", "/etc/systemd/system/x-ui-worker.service", false, false},
		{"configs", directory, true, true},
	}
	if agent {
		items = append(items, upgradeFileTarget{"agent", "/usr/local/x-ui/bin/x-ui-agent", false, false}, upgradeFileTarget{"core-helper", "/usr/local/x-ui/bin/x-ui-core-reload", false, false}, upgradeFileTarget{"service-agent", "/etc/systemd/system/x-ui-agent.service", false, false}, upgradeFileTarget{"agent-configs", "/etc/x-ui", true, true})
	}
	return items
}

type upgradeFileSnapshot struct {
	Mode    uint32 `json:"mode"`
	Missing bool   `json:"missing"`
}

func (systemdUpgradeHost) BackupFiles(ctx context.Context, directory string, record *upgradeRecord) error {
	backup := filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "backup")
	if err := os.Mkdir(backup, 0o700); err != nil {
		return err
	}
	snapshot := make(map[string]upgradeFileSnapshot)
	for _, item := range upgradeFileTargets(directory, record.Agent) {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := os.Lstat(item.target)
		if os.IsNotExist(err) {
			snapshot[item.name] = upgradeFileSnapshot{Missing: true}
			continue
		}
		if err != nil {
			return err
		}
		snapshot[item.name] = upgradeFileSnapshot{Mode: uint32(info.Mode().Perm())}
		if item.tree {
			if !info.IsDir() {
				return fmt.Errorf("Unsupported installation directory")
			}
			if err := copyUpgradeTree(item.target, filepath.Join(backup, item.name)); err != nil {
				return err
			}
		} else if err := copyUpgradeFile(item.target, filepath.Join(backup, item.name), info.Mode()); err != nil {
			return err
		}
	}
	return writePanelJSON(filepath.Join(backup, "files.json"), snapshot)
}

func upgradeUnits(record *upgradeRecord) []string {
	units := []string{"x-ui-worker.service", "x-ui-api.service"}
	if record.Agent {
		units = append([]string{"x-ui-agent.service"}, units...)
	}
	return units
}

func (systemdUpgradeHost) Stop(ctx context.Context, record *upgradeRecord) error {
	return fixedPanelCommand(ctx, "systemctl", append([]string{"stop"}, upgradeUnits(record)...)...)
}

func (systemdUpgradeHost) Start(ctx context.Context, record *upgradeRecord) error {
	if err := fixedPanelCommand(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	// Start separately so an agent never races the API readiness check.
	for _, unit := range []string{"x-ui-api.service", "x-ui-worker.service"} {
		if err := fixedPanelCommand(ctx, "systemctl", "start", unit); err != nil {
			return err
		}
	}
	if record.Agent {
		return fixedPanelCommand(ctx, "systemctl", "start", "x-ui-agent.service")
	}
	return nil
}

func upgradeDatabaseFile(directory string, record *upgradeRecord) string {
	return filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "backup", "database.dump")
}

func (systemdUpgradeHost) BackupDatabase(ctx context.Context, directory string, record *upgradeRecord) error {
	return upgradeCommand(ctx, directory, record, filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "runner"), nil, "database", "-backup", upgradeDatabaseFile(directory, record))
}

func (systemdUpgradeHost) RestoreDatabase(ctx context.Context, directory string, record *upgradeRecord) error {
	return upgradeCommand(ctx, directory, record, filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "runner"), nil, "database", "-restore", upgradeDatabaseFile(directory, record), "-yes")
}

func (systemdUpgradeHost) Migrate(ctx context.Context, directory string, record *upgradeRecord, stage string) error {
	return upgradeCommand(ctx, directory, record, filepath.Join(stage, "bin", "x-ui-cli"), map[string]string{"X_UI_DATABASE_MIGRATIONS_DIR": filepath.Join(stage, "migrations")}, "migrate")
}

func upgradePreparedTree(target, id string) string { return target + ".upgrade-" + id }

func replaceUpgradeTree(prepared, target, id string) error {
	if !panelJobID.MatchString(id) {
		return fmt.Errorf("Invalid upgrade ID")
	}
	if info, err := os.Lstat(prepared); err != nil || !info.IsDir() {
		return fmt.Errorf("The prepared upgrade directory is unavailable")
	}
	if info, err := os.Lstat(target); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("Upgrade target must be a directory")
		}
		if err := os.Rename(target, target+".previous-"+id); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(prepared, target)
}

func (systemdUpgradeHost) Install(ctx context.Context, directory string, record *upgradeRecord, stage string) error {
	for _, name := range []string{"x-ui-api", "x-ui-worker", "x-ui-cli"} {
		if err := copyUpgradeFile(filepath.Join(stage, "bin", name), "/usr/local/x-ui/bin/"+name, 0o755); err != nil {
			return err
		}
	}
	if record.Agent {
		for _, name := range []string{"x-ui-agent", "x-ui-core-reload"} {
			if err := copyUpgradeFile(filepath.Join(stage, "bin", name), "/usr/local/x-ui/bin/"+name, 0o755); err != nil {
				return err
			}
		}
	}
	for _, name := range []string{"migrations", "web/build"} {
		target := "/usr/local/x-ui/" + name
		if err := replaceUpgradeTree(upgradePreparedTree(target, record.Job.ID), target, record.Job.ID); err != nil {
			return err
		}
	}
	if err := copyUpgradeFile(filepath.Join(stage, "x-ui.sh"), "/usr/bin/x-ui", 0o755); err != nil {
		return err
	}
	wrapper := "#!/bin/sh\nX_UI_CONFIG_DIR=" + installedConfigDir + "\nexport X_UI_CONFIG_DIR\nexec " + panelCLI + " \"$@\"\n"
	if err := writePanelPrivate("/usr/bin/x-ui-cli", []byte(wrapper)); err != nil {
		return err
	}
	if err := os.Chmod("/usr/bin/x-ui-cli", 0o755); err != nil {
		return err
	}
	for _, unit := range upgradeUnits(record) {
		if err := copyUpgradeFile(filepath.Join(stage, unit), "/etc/systemd/system/"+unit, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (systemdUpgradeHost) RestoreFiles(ctx context.Context, directory string, record *upgradeRecord) error {
	backup := filepath.Join(upgradeJobDir(upgradeRoot(directory), record.Job.ID), "backup")
	var snapshot map[string]upgradeFileSnapshot
	if err := readPanelJSON(filepath.Join(backup, "files.json"), &snapshot); err != nil {
		return err
	}
	for _, item := range upgradeFileTargets(directory, record.Agent) {
		if item.reference {
			continue
		} // Configs were backed up for recovery, never overwritten by an upgrade.
		if err := ctx.Err(); err != nil {
			return err
		}
		state, exists := snapshot[item.name]
		if !exists {
			return fmt.Errorf("Incomplete installation backup")
		}
		if state.Missing {
			if item.tree {
				return fmt.Errorf("A required installation directory was missing")
			}
			if err := os.Remove(item.target); err != nil && !os.IsNotExist(err) {
				return err
			}
			continue
		}
		if item.tree {
			prepared := item.target + ".recovery-" + record.Job.ID
			// A previous recovery may have been interrupted. Only discard this
			// task's temporary directory, then rebuild it from the external backup.
			if info, err := os.Lstat(prepared); err == nil && !info.IsDir() {
				return fmt.Errorf("Invalid recovery directory")
			}
			if err := os.RemoveAll(prepared); err != nil {
				return err
			}
			if err := copyUpgradeTree(filepath.Join(backup, item.name), prepared); err != nil {
				return err
			}
			if info, err := os.Lstat(item.target); err == nil {
				if !info.IsDir() {
					return fmt.Errorf("Invalid recovery target")
				}
				failed := item.target + ".failed-" + record.Job.ID
				if err := os.RemoveAll(failed); err != nil {
					return err
				}
				if err := os.Rename(item.target, failed); err != nil {
					return err
				}
			} else if !os.IsNotExist(err) {
				return err
			}
			if err := os.Rename(prepared, item.target); err != nil {
				return err
			}
		} else if err := copyUpgradeFile(filepath.Join(backup, item.name), item.target, os.FileMode(state.Mode)); err != nil {
			return err
		}
	}
	return nil
}

func upgradeDatabaseRevision(cfg *config.Config) string {
	data, _ := json.Marshal(cfg.Database)
	return panelRevision(data)
}

func (systemdUpgradeHost) Cleanup(ctx context.Context, directory string, record *upgradeRecord) error {
	if !panelJobID.MatchString(record.Job.ID) {
		return fmt.Errorf("Invalid upgrade ID")
	}
	for _, target := range []string{"/usr/local/x-ui/migrations", "/usr/local/x-ui/web/build"} {
		if err := rejectUpgradeLinks(filepath.Dir(target)); err != nil {
			return err
		}
		for _, suffix := range []string{".upgrade-", ".previous-", ".failed-", ".recovery-"} {
			name := target + suffix + record.Job.ID
			if info, err := os.Lstat(name); os.IsNotExist(err) {
				continue
			} else if err != nil || !info.IsDir() {
				return fmt.Errorf("Invalid upgrade cleanup directory")
			}
			if err := os.RemoveAll(name); err != nil {
				return err
			}
		}
	}
	return nil
}

func (systemdUpgradeHost) Verify(ctx context.Context, directory string, record *upgradeRecord, version string) error {
	verifyCtx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
	data, err := os.ReadFile(filepath.Join(directory, "config.yaml"))
	if err != nil {
		return err
	}
	if panelRevision(data) != record.Revision {
		return fmt.Errorf("Configuration was edited during the upgrade")
	}
	cfg, err := config.Parse(data)
	if err != nil {
		return err
	}
	if err := upgradeBinaryVersion(verifyCtx, panelCLI, version); err != nil {
		return err
	}
	if err := waitPanelProcesses(verifyCtx, directory, systemdPanelHost{}, cfg, record.RestartedAt, record.Agent); err != nil {
		return err
	}
	for _, kind := range []string{"api", "worker"} {
		var process PanelProcessRuntime
		if readPanelJSON(filepath.Join(panelRuntimeDir(directory), kind+".json"), &process) != nil || process.Version != version || process.DatabaseRevision != upgradeDatabaseRevision(cfg) {
			return fmt.Errorf("The new processes have an unexpected version or database")
		}
	}
	if err := probeStartupListener(verifyCtx, cfg.Server.Listen, cfg.Server.Port, cfg.Server.Domain, cfg.Server.TLSEnabled(), "GET", cfg.Server.Base(), 200); err != nil {
		return err
	}
	return nil
}
