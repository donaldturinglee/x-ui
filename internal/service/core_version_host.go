package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
)

type systemdCoreVersionHost struct{}

func coreExecutableVersion(ctx context.Context, executable string) (string, error) {
	output, err := exec.CommandContext(ctx, executable, "version").Output()
	fields := strings.Fields(strings.SplitN(string(output), "\n", 2)[0])
	if err != nil || len(fields) != 3 || fields[0] != "sing-box" || fields[1] != "version" || !stableVersion.MatchString(fields[2]) {
		return "", fmt.Errorf("The installed sing-box version is not a supported stable build")
	}
	return strings.TrimPrefix(fields[2], "v"), nil
}

func (systemdCoreVersionHost) Info(ctx context.Context) (coreVersionInfo, error) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return coreVersionInfo{}, fmt.Errorf("Version management requires a root-managed Linux systemd installation")
	}
	directory, _ := filepath.Abs(config.Dir())
	if directory != installedConfigDir {
		return coreVersionInfo{}, fmt.Errorf("Version management requires the standard x-ui installation directory")
	}
	core := systemdCoreHost{}
	// This probe runs in both the API and its independent CLI runner. The panel
	// restart capability's API-PID check cannot be reused in the CLI process.
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return coreVersionInfo{}, fmt.Errorf("Version management requires systemd")
	}
	if _, err := os.Stat(panelCLI); err != nil {
		return coreVersionInfo{}, fmt.Errorf("Version management requires the installed x-ui-cli")
	}
	for _, tool := range []string{"systemd-run", "flock"} {
		if _, err := exec.LookPath(tool); err != nil {
			return coreVersionInfo{}, fmt.Errorf("Version management requires the %s tool", tool)
		}
	}
	snapshot, err := core.Info(ctx)
	if err != nil || !snapshot.Supported || snapshot.State != "active" || snapshot.PID < 1 {
		return coreVersionInfo{}, fmt.Errorf("Version management requires a running local sing-box service and the managed native-statistics agent")
	}
	if snapshot.Launch.Executable != "/usr/bin/sing-box" {
		return coreVersionInfo{}, fmt.Errorf("This sing-box executable is not managed by a supported package manager")
	}
	installed, err := os.Stat(snapshot.Launch.Executable)
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("The installed executable could not be read")
	}
	running, err := os.Stat(fmt.Sprintf("/proc/%d/exe", snapshot.PID))
	if err != nil || !os.SameFile(installed, running) {
		return coreVersionInfo{}, fmt.Errorf("The running sing-box process differs from the installed package; resolve it on the server first")
	}
	version, err := coreExecutableVersion(ctx, snapshot.Launch.Executable)
	if err != nil {
		return coreVersionInfo{}, err
	}
	if comparison, _ := compareUpgradeVersions(version, minimumCoreVersion); comparison < 0 {
		return coreVersionInfo{}, fmt.Errorf("This panel requires sing-box %s or newer", minimumCoreVersion)
	}
	output, err := exec.CommandContext(ctx, "uname", "-m").Output()
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("The host platform could not be read")
	}
	platform, err := releasePlatform(strings.TrimSpace(string(output)))
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("This platform has no supported sing-box package")
	}
	manager, packageVersion := "", ""
	if _, err := exec.LookPath("dpkg-query"); err == nil {
		output, err := exec.CommandContext(ctx, "dpkg-query", "-W", "-f=${Status}\n${Version}\n${Architecture}\n", "sing-box").Output()
		fields := strings.Split(strings.TrimSpace(string(output)), "\n")
		if err == nil && len(fields) == 3 && fields[0] == "install ok installed" && fields[2] == corePackageArchitecture(platform, "apt") {
			owner, err := exec.CommandContext(ctx, "dpkg-query", "-S", "/usr/bin/sing-box").Output()
			if err == nil && strings.HasPrefix(string(owner), "sing-box: ") {
				manager, packageVersion = "apt", fields[1]
			}
		}
	}
	if _, err := exec.LookPath("dnf"); manager == "" && err == nil {
		output, err := exec.CommandContext(ctx, "rpm", "-qf", "/usr/bin/sing-box", "--qf", "%{NAME}\n%{VERSION}-%{RELEASE}\n%{ARCH}\n").Output()
		fields := strings.Split(strings.TrimSpace(string(output)), "\n")
		if err == nil && len(fields) == 3 && fields[0] == "sing-box" && fields[2] == corePackageArchitecture(platform, "dnf") {
			manager, packageVersion = "dnf", fields[1]
		}
	}
	if manager == "" || corePackageArchitecture(platform, manager) == "" {
		return coreVersionInfo{}, fmt.Errorf("Version management currently supports official APT/DNF sing-box packages")
	}
	tools := []string{"systemctl"}
	if manager == "apt" {
		tools = append(tools, "dpkg", "dpkg-deb", "apt-get")
	} else {
		tools = append(tools, "rpm", "rpm2cpio")
	}
	for _, tool := range tools {
		if _, err := exec.LookPath(tool); err != nil {
			return coreVersionInfo{}, fmt.Errorf("Version management requires the %s tool", tool)
		}
	}
	info := coreVersionInfo{Version: version, PackageVersion: packageVersion, Platform: platform, Manager: manager,
		Launch: snapshot.Launch, PID: snapshot.PID, ConfigDir: filepath.Dir(snapshot.Launch.LockPath)}
	bootID, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("The host boot identifier could not be read")
	}
	info.BootID = strings.TrimSpace(string(bootID))
	for index := 0; index+1 < len(info.Launch.Arguments); index += 2 {
		if info.Launch.Arguments[index] == "-D" || info.Launch.Arguments[index] == "--directory" {
			info.DataDir = info.Launch.Arguments[index+1]
		}
	}
	if info.ConfigDir != "/etc/sing-box" || info.DataDir != "/var/lib/sing-box" {
		return coreVersionInfo{}, fmt.Errorf("Version management currently requires the standard /etc/sing-box and /var/lib/sing-box directories")
	}
	output, err = exec.CommandContext(ctx, "systemctl", "show", "sing-box.service", "--property=FragmentPath", "--property=DropInPaths").Output()
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("The sing-box service files could not be verified")
	}
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "FragmentPath=") {
			fragment := strings.TrimPrefix(line, "FragmentPath=")
			if fragment != "/usr/lib/systemd/system/sing-box.service" && fragment != "/lib/systemd/system/sing-box.service" {
				return coreVersionInfo{}, fmt.Errorf("A custom sing-box unit requires command-line version management")
			}
		}
	}
	if _, err := os.Lstat("/run/systemd/system/sing-box.service"); !os.IsNotExist(err) {
		return coreVersionInfo{}, fmt.Errorf("A runtime sing-box service override must be resolved before switching versions")
	}
	info.Revision, err = coreInstallationRevision(info, string(output))
	if err != nil {
		return coreVersionInfo{}, fmt.Errorf("The local configuration could not be fingerprinted; symlinked or oversized configuration is unsupported")
	}
	return info, nil
}

func coreInstallationRevision(info coreVersionInfo, units string) (string, error) {
	hash := sha256.New()
	metadata, err := json.Marshal(struct {
		Version, PackageVersion, Manager, Units string
		Launch                                  coreLaunch
	}{info.Version, info.PackageVersion, info.Manager, units, info.Launch})
	if err != nil {
		return "", err
	}
	_, _ = hash.Write(metadata)
	for _, directory := range []string{info.ConfigDir, "/etc/systemd/system/sing-box.service.d"} {
		var total int64
		err := filepath.WalkDir(directory, func(name string, entry os.DirEntry, walkErr error) error {
			if os.IsNotExist(walkErr) && name == directory {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			if strings.HasPrefix(entry.Name(), ".x-ui-") {
				if entry.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			stat, err := entry.Info()
			if err != nil || (!stat.IsDir() && !stat.Mode().IsRegular()) {
				return fmt.Errorf("Invalid configuration entry")
			}
			_, _ = io.WriteString(hash, name+"\x00"+stat.Mode().String()+"\x00")
			if stat.IsDir() {
				return nil
			}
			total += stat.Size()
			if total > 64<<20 {
				return fmt.Errorf("Configuration exceeds the size limit")
			}
			file, err := os.Open(name)
			if err != nil {
				return err
			}
			_, err = io.Copy(hash, file)
			_ = file.Close()
			return err
		})
		if err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

const coreVersionRecoveryUnit = `[Unit]
Description=Recover an interrupted sing-box version change
After=local-fs.target
Before=sing-box.service x-ui-agent.service

[Service]
Type=oneshot
ExecStart=/var/lib/x-ui/core-version/recovery-cli core-version-resume -boot
TimeoutStartSec=15min

[Install]
WantedBy=multi-user.target
`

func (systemdCoreVersionHost) Schedule(ctx context.Context, directory, id string) error {
	if filepath.Clean(directory) != installedConfigDir {
		return fmt.Errorf("Version management requires the standard x-ui installation")
	}
	root := coreVersionRoot(directory)
	if err := copyUpgradeFile(panelCLI, filepath.Join(coreVersionJobDir(root, id), "runner"), 0o700); err != nil {
		return err
	}
	if err := copyUpgradeFile(panelCLI, filepath.Join(root, "recovery-cli"), 0o700); err != nil {
		return err
	}
	if err := writePanelPrivate("/etc/systemd/system/x-ui-core-version-recovery.service", []byte(coreVersionRecoveryUnit)); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, "systemctl", "enable", "x-ui-core-version-recovery.service"); err != nil {
		return err
	}
	return fixedPanelCommand(ctx, "systemd-run", "--quiet", "--collect", "--unit=x-ui-core-version-"+id,
		"--on-active=2s", "--timer-property=AccuracySec=100ms", "--timer-property=RemainAfterElapse=no",
		"--property=Type=exec", "--property=WorkingDirectory=/usr/local/x-ui", "--property=RuntimeMaxSec=25min",
		"--property=Restart=on-failure", "--property=RestartSec=5s",
		filepath.Join(coreVersionJobDir(root, id), "runner"), "core-version-run", "-directory", directory, "-job", id)
}

func (systemdCoreVersionHost) Prepare(ctx context.Context, directory string, info coreVersionInfo, release UpgradeRelease) (string, string, error) {
	var stateBytes int64
	for _, target := range coreStatePaths(info) {
		err := filepath.WalkDir(target, func(name string, entry os.DirEntry, walkErr error) error {
			if os.IsNotExist(walkErr) && name == target {
				return nil
			}
			if walkErr != nil {
				return walkErr
			}
			stat, err := entry.Info()
			if err != nil || (!stat.IsDir() && !stat.Mode().IsRegular()) {
				return fmt.Errorf("Symlinked core state is unsupported")
			}
			stateBytes += stat.Size()
			if stateBytes > 512<<20 {
				return fmt.Errorf("Core state exceeds the supported backup size")
			}
			return nil
		})
		if err != nil {
			return "", "", err
		}
	}
	if err := checkUpgradeSpace(directory, uint64(release.AssetSize)*8+uint64(stateBytes)*2+64<<20); err != nil {
		return "", "", err
	}
	stage := filepath.Join(directory, "packages", release.Version)
	if err := ensurePanelRuntimeDir(stage); err != nil {
		return "", "", err
	}
	packageFile := filepath.Join(stage, release.AssetName)
	file, err := os.OpenFile(packageFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", "", err
	}
	hash := sha256.New()
	err = newCoreVersionSource().Download(ctx, release.AssetURL, io.MultiWriter(file, hash), release.AssetSize)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return "", "", err
	}
	if closeErr != nil {
		return "", "", closeErr
	}
	stat, err := os.Stat(packageFile)
	if err != nil || stat.Size() != release.AssetSize || hex.EncodeToString(hash.Sum(nil)) != release.SHA256 {
		return "", "", fmt.Errorf("The official package failed SHA256 verification")
	}
	packageVersion, architecture, err := inspectCorePackage(ctx, info.Manager, packageFile)
	if err != nil || architecture != corePackageArchitecture(info.Platform, info.Manager) {
		return "", "", fmt.Errorf("The package architecture does not match this host")
	}
	if release.Version == info.Version && packageVersion != info.PackageVersion {
		return "", "", fmt.Errorf("The recovery package does not match the exact installed package version")
	}
	if err := validateCorePackageTransaction(ctx, info.Manager, packageFile); err != nil {
		return "", "", err
	}
	candidate := filepath.Join(stage, "sing-box")
	if err := unpackCoreExecutable(ctx, info.Manager, packageFile, candidate); err != nil {
		return "", "", err
	}
	version, err := coreExecutableVersion(ctx, candidate)
	if err != nil || version != release.Version {
		return "", "", fmt.Errorf("The package executable does not match the official release")
	}
	return packageFile, candidate, nil
}

func (systemdCoreVersionHost) Validate(ctx context.Context, info coreVersionInfo, executable, expected string) error {
	version, err := coreExecutableVersion(ctx, executable)
	if err != nil || version != expected {
		return fmt.Errorf("Candidate version verification failed")
	}
	launch := info.Launch
	launch.Executable = executable
	if err := (systemdCoreHost{}).Validate(ctx, launch); err != nil {
		return fmt.Errorf("The current configuration is not supported by the selected version")
	}
	probe := filepath.Join(filepath.Dir(executable), "native-api-check.json")
	if err := writePanelPrivate(probe, []byte(`{"services":[{"type":"api","tag":"x-ui-api-check","listen":"127.0.0.1","listen_port":9091,"secret":"compatibility-check","dashboard":false}]}`)); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, executable, "check", "-c", probe); err != nil {
		return fmt.Errorf("The selected version does not support the required native statistics API")
	}
	return nil
}

type coreStateBackup struct {
	Path    string `json:"path"`
	Missing bool   `json:"missing"`
	Mode    uint32 `json:"mode"`
	UID     int    `json:"uid"`
	GID     int    `json:"gid"`
}

func copyCoreStateTree(source, target string) error {
	return filepath.WalkDir(source, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Name() == ".x-ui-core.lock" {
			return nil
		}
		stat, err := entry.Info()
		if err != nil || (!stat.IsDir() && !stat.Mode().IsRegular()) {
			return fmt.Errorf("Symlinked core state cannot be backed up")
		}
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if stat.IsDir() {
			err = os.MkdirAll(destination, stat.Mode().Perm())
		} else {
			err = copyUpgradeFile(name, destination, stat.Mode().Perm())
		}
		if err != nil {
			return err
		}
		uid, gid := coreFileOwners(stat)
		if err := os.Chown(destination, uid, gid); err != nil && runtime.GOOS == "linux" {
			return err
		}
		return os.Chmod(destination, stat.Mode().Perm())
	})
}

func coreStatePaths(info coreVersionInfo) []string {
	return []string{info.ConfigDir, info.DataDir, "/etc/systemd/system/sing-box.service.d"}
}

func (systemdCoreVersionHost) Backup(ctx context.Context, directory string, info coreVersionInfo) error {
	backup := filepath.Join(directory, "backup")
	if err := ensurePanelRuntimeDir(backup); err != nil {
		return err
	}
	states := []coreStateBackup{}
	for index, source := range coreStatePaths(info) {
		if err := ctx.Err(); err != nil {
			return err
		}
		stat, err := os.Lstat(source)
		if os.IsNotExist(err) {
			states = append(states, coreStateBackup{Path: source, Missing: true})
			continue
		}
		if err != nil || !stat.IsDir() {
			return fmt.Errorf("Invalid core state directory")
		}
		uid, gid := coreFileOwners(stat)
		states = append(states, coreStateBackup{Path: source, Mode: uint32(stat.Mode().Perm()), UID: uid, GID: gid})
		if err := copyCoreStateTree(source, filepath.Join(backup, strconv.Itoa(index))); err != nil {
			return err
		}
	}
	return writePanelJSON(filepath.Join(backup, "snapshot.json"), states)
}

func (systemdCoreVersionHost) Stop(ctx context.Context) error {
	if err := fixedPanelCommand(ctx, "systemctl", "stop", "sing-box.service"); err != nil {
		return err
	}
	// Mask only this service while package maintainer scripts run. A crash leaves
	// it masked until the persisted recovery task restores the previous package.
	return fixedPanelCommand(ctx, "systemctl", "mask", "--runtime", "sing-box.service")
}

func (systemdCoreVersionHost) Install(ctx context.Context, info coreVersionInfo, packageFile string) error {
	if !filepath.IsAbs(packageFile) || (info.Manager != "apt" && info.Manager != "dnf") {
		return fmt.Errorf("Invalid core package installation")
	}
	// Native package transactions modify only sing-box. Missing dependencies
	// fail rather than silently upgrading unrelated system packages.
	if info.Manager == "apt" {
		command := exec.CommandContext(ctx, "dpkg", "--force-confold", "--install", packageFile)
		command.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive", "SYSTEMD_OFFLINE=1")
		return command.Run()
	}
	return fixedPanelCommand(ctx, "rpm", "--upgrade", "--oldpackage", packageFile)
}

func (systemdCoreVersionHost) Restore(ctx context.Context, directory string, info coreVersionInfo) error {
	var states []coreStateBackup
	if err := readPanelJSON(filepath.Join(directory, "backup", "snapshot.json"), &states); err != nil {
		return err
	}
	paths := coreStatePaths(info)
	if len(states) != len(paths) {
		return fmt.Errorf("Invalid core backup manifest")
	}
	for index, state := range states {
		if err := ctx.Err(); err != nil {
			return err
		}
		if state.Path != paths[index] || (state.Path != "/etc/sing-box" && state.Path != "/var/lib/sing-box" && state.Path != "/etc/systemd/system/sing-box.service.d") {
			return fmt.Errorf("Invalid core recovery path")
		}
		if stat, err := os.Lstat(state.Path); err == nil && !stat.IsDir() {
			return fmt.Errorf("Invalid core recovery directory")
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		entries, err := os.ReadDir(state.Path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		// Preserve the locked directory and lock inode so the agent cannot race
		// recovery by opening a freshly replaced configuration directory.
		for _, entry := range entries {
			if entry.Name() != ".x-ui-core.lock" {
				if err := os.RemoveAll(filepath.Join(state.Path, entry.Name())); err != nil {
					return err
				}
			}
		}
		if state.Missing {
			continue
		}
		if err := copyCoreStateTree(filepath.Join(directory, "backup", strconv.Itoa(index)), state.Path); err != nil {
			return err
		}
		if err := os.Chown(state.Path, state.UID, state.GID); err != nil {
			return err
		}
		if err := os.Chmod(state.Path, os.FileMode(state.Mode)); err != nil {
			return err
		}
	}
	return nil
}

func (systemdCoreVersionHost) Unmask(ctx context.Context) error {
	if err := fixedPanelCommand(ctx, "systemctl", "unmask", "--runtime", "sing-box.service"); err != nil {
		return err
	}
	if err := fixedPanelCommand(ctx, "systemctl", "daemon-reload"); err != nil {
		return err
	}
	return nil
}

func (host systemdCoreVersionHost) Start(ctx context.Context) error {
	if err := host.Unmask(ctx); err != nil {
		return err
	}
	return fixedPanelCommand(ctx, "systemctl", "start", "sing-box.service")
}

func (systemdCoreVersionHost) ScheduleRecovery(ctx context.Context, directory, id string) error {
	return fixedPanelCommand(ctx, "systemd-run", "--quiet", "--collect", "--unit=x-ui-core-version-recover-"+id,
		"--on-active=3s", "--timer-property=AccuracySec=100ms", "--timer-property=RemainAfterElapse=no",
		"--property=Type=exec", "--property=WorkingDirectory=/usr/local/x-ui", "--property=RuntimeMaxSec=15min",
		filepath.Join(coreVersionRoot(directory), "recovery-cli"), "core-version-resume")
}

func (systemdCoreVersionHost) Verify(ctx context.Context, before coreVersionInfo, expected string) error {
	verifyCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	bootID, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return fmt.Errorf("The host boot identifier could not be read")
	}
	newBoot := before.BootID != "" && strings.TrimSpace(string(bootID)) != before.BootID
	for {
		probeCtx, cancel := context.WithTimeout(verifyCtx, 4*time.Second)
		snapshot, err := (systemdCoreHost{}).Info(probeCtx)
		ready := err == nil && snapshot.Supported && snapshot.State == "active" && snapshot.PID > 0 && (newBoot || snapshot.PID != before.PID) && reflect.DeepEqual(snapshot.Launch, before.Launch)
		if ready {
			version, err := coreExecutableVersion(probeCtx, fmt.Sprintf("/proc/%d/exe", snapshot.PID))
			ready = err == nil && version == expected
		}
		if ready {
			ready = (systemdCoreHost{}).Healthy(probeCtx) == nil
		}
		cancel()
		if ready {
			return nil
		}
		select {
		case <-verifyCtx.Done():
			return fmt.Errorf("The requested sing-box version and native statistics API could not be confirmed")
		case <-time.After(500 * time.Millisecond):
		}
	}
}
