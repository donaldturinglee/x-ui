package service

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

type fakeCoreVersionSource struct {
	releases map[string]UpgradeRelease
	changed  bool
}

func (source *fakeCoreVersionSource) List(context.Context, string, string) ([]UpgradeRelease, error) {
	return []UpgradeRelease{source.releases["1.14.2"], source.releases["1.14.1"]}, nil
}
func (source *fakeCoreVersionSource) Resolve(_ context.Context, version, _, _ string) (*UpgradeRelease, error) {
	release, ok := source.releases[strings.TrimPrefix(version, "v")]
	if !ok {
		return nil, errors.New("missing package")
	}
	if source.changed {
		release.AssetID++
	}
	return &release, nil
}
func (*fakeCoreVersionSource) Download(context.Context, string, io.Writer, int64) error { return nil }

type fakeCoreVersionHost struct {
	info                                                                                                      coreVersionInfo
	events                                                                                                    []string
	validationErr, recoveryPackageErr, backupErr, installErr, rollbackErr, verifyErr, restoreErr, scheduleErr bool
}

func (host *fakeCoreVersionHost) Info(context.Context) (coreVersionInfo, error) {
	return host.info, nil
}
func (host *fakeCoreVersionHost) Schedule(context.Context, string, string) error {
	host.events = append(host.events, "schedule")
	if host.scheduleErr {
		return errors.New("scheduler failed")
	}
	return nil
}
func (host *fakeCoreVersionHost) Prepare(_ context.Context, directory string, _ coreVersionInfo, release UpgradeRelease) (string, string, error) {
	host.events = append(host.events, "prepare:"+release.Version)
	if host.recoveryPackageErr && release.Version == "1.14.2" {
		return "", "", errors.New("wrong installed package revision")
	}
	return filepath.Join(directory, "packages", release.Version, release.AssetName), "candidate", nil
}
func (host *fakeCoreVersionHost) Validate(context.Context, coreVersionInfo, string, string) error {
	host.events = append(host.events, "validate")
	if host.validationErr {
		return errors.New("a private password from a config must not reach the API")
	}
	return nil
}
func (host *fakeCoreVersionHost) Backup(context.Context, string, coreVersionInfo) error {
	host.events = append(host.events, "backup")
	if host.backupErr {
		return errors.New("disk full")
	}
	return nil
}
func (host *fakeCoreVersionHost) Stop(context.Context) error {
	host.events = append(host.events, "stop")
	return nil
}
func (host *fakeCoreVersionHost) Install(_ context.Context, _ coreVersionInfo, name string) error {
	version := filepath.Base(filepath.Dir(name))
	host.events = append(host.events, "install:"+version)
	host.info.Version, host.info.PackageVersion = version, version
	if version == "1.14.1" && host.installErr || version == "1.14.2" && host.rollbackErr {
		return errors.New("package transaction failed")
	}
	return nil
}
func (host *fakeCoreVersionHost) Restore(context.Context, string, coreVersionInfo) error {
	host.events = append(host.events, "restore")
	if host.restoreErr {
		return errors.New("state recovery failed")
	}
	return nil
}
func (host *fakeCoreVersionHost) Start(context.Context) error {
	host.events = append(host.events, "start")
	host.info.PID++
	return nil
}
func (host *fakeCoreVersionHost) Unmask(context.Context) error {
	host.events = append(host.events, "unmask")
	return nil
}
func (host *fakeCoreVersionHost) ScheduleRecovery(context.Context, string, string) error {
	host.events = append(host.events, "schedule-recovery")
	return nil
}
func (host *fakeCoreVersionHost) Verify(_ context.Context, _ coreVersionInfo, version string) error {
	host.events = append(host.events, "verify:"+version)
	if host.verifyErr && version == "1.14.1" {
		return errors.New("native API not ready")
	}
	return nil
}

func coreVersionFixture(t *testing.T) (*CoreVersionService, *fakeCoreVersionHost, *fakeCoreVersionSource) {
	t.Helper()
	directory := t.TempDir()
	host := &fakeCoreVersionHost{info: coreVersionInfo{Version: "1.14.2", PackageVersion: "1.14.2", Platform: "amd64", Manager: "apt", Revision: "config-revision", PID: 10,
		ConfigDir: filepath.Join(directory, "config"), DataDir: filepath.Join(directory, "data"), Launch: coreLaunch{Executable: "/usr/bin/sing-box", Arguments: []string{"-C", "/etc/sing-box", "run"}, LockPath: filepath.Join(directory, "config", ".x-ui-core.lock")}}}
	source := &fakeCoreVersionSource{releases: map[string]UpgradeRelease{
		"1.14.2": {ID: 2, Version: "1.14.2", AssetID: 22, AssetName: "sing-box.deb", AssetSize: 12, SHA256: strings.Repeat("b", 64)},
		"1.14.1": {ID: 1, Version: "1.14.1", AssetID: 11, AssetName: "sing-box.deb", AssetSize: 12, SHA256: strings.Repeat("a", 64)},
	}}
	service := &CoreVersionService{directory: directory, root: coreVersionRoot(directory), host: host, source: source}
	return service, host, source
}

func checkedCoreVersion(t *testing.T, service *CoreVersionService) CoreVersionRequest {
	t.Helper()
	checked, err := service.Check(context.Background(), "1.14.1")
	if err != nil {
		t.Fatal(err)
	}
	if checked.Direction != "downgrade" {
		t.Fatalf("direction = %s", checked.Direction)
	}
	return CoreVersionRequest{CheckID: checked.ID, ExpectedCurrentVersion: checked.CurrentVersion, ConfigRevision: checked.ConfigRevision}
}

func runVersionFixture(t *testing.T, service *CoreVersionService, host *fakeCoreVersionHost, source *fakeCoreVersionSource, id string) *CoreVersionJob {
	t.Helper()
	if err := runCoreVersion(context.Background(), service.directory, id, host, source, false); err != nil {
		t.Fatal(err)
	}
	job, err := service.Job(id)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestCoreVersionDowngradePersistsAndDoesNotScheduleTwice(t *testing.T) {
	s, host, source := coreVersionFixture(t)
	request := checkedCoreVersion(t, s)
	job, err := s.Queue(context.Background(), "operator", request)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Queue(context.Background(), "operator", request)
	if err != nil || again.ID != job.ID || len(host.events) != 1 {
		t.Fatal("duplicate request scheduled another task", err)
	}
	if _, err := maintenanceGate(s.directory, "upgrade", ""); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("panel upgrade admitted during core version task", err)
	}
	finished := runVersionFixture(t, s, host, source, job.ID)
	if finished.State != "succeeded" || finished.NeedsRecovery || host.info.Version != "1.14.1" || finished.FinishedAt == nil {
		t.Fatalf("result = %+v", finished)
	}
	joined := strings.Join(host.events, ",")
	if !strings.Contains(joined, "prepare:1.14.2,prepare:1.14.1,validate,stop,backup,install:1.14.1,start,verify:1.14.1") {
		t.Fatal("wrong execution order", joined)
	}
	before := len(host.events)
	runVersionFixture(t, s, host, source, job.ID)
	if len(host.events) != before {
		t.Fatal("completed task changed the core again")
	}
	if unlock, err := BeginHostWrite(s.directory); err != nil {
		t.Fatal(err)
	} else {
		unlock()
	}
}

func TestCoreVersionPreparationFailuresKeepRunningCore(t *testing.T) {
	for _, failure := range []string{"validation", "recovery-package", "changed-release", "changed-config"} {
		t.Run(failure, func(t *testing.T) {
			s, host, source := coreVersionFixture(t)
			job, err := s.Queue(context.Background(), "operator", checkedCoreVersion(t, s))
			if err != nil {
				t.Fatal(err)
			}
			host.validationErr, host.recoveryPackageErr, source.changed = failure == "validation", failure == "recovery-package", failure == "changed-release"
			if failure == "changed-config" {
				host.info.Revision = "changed"
			}
			finished := runVersionFixture(t, s, host, source, job.ID)
			if finished.State != "failed" || finished.NeedsRecovery || strings.Contains(strings.Join(host.events, ","), "stop") || host.info.Version != "1.14.2" || strings.Contains(finished.Error, "private password") {
				t.Fatalf("result = %+v, events = %v", finished, host.events)
			}
		})
	}
}

func TestCoreVersionInstallAndHealthFailuresRecoverExactPreviousVersion(t *testing.T) {
	for _, failure := range []string{"install", "health", "backup"} {
		t.Run(failure, func(t *testing.T) {
			s, host, source := coreVersionFixture(t)
			job, err := s.Queue(context.Background(), "operator", checkedCoreVersion(t, s))
			if err != nil {
				t.Fatal(err)
			}
			host.installErr, host.verifyErr, host.backupErr = failure == "install", failure == "health", failure == "backup"
			finished := runVersionFixture(t, s, host, source, job.ID)
			if finished.State != "rolled_back" || finished.NeedsRecovery || host.info.Version != "1.14.2" {
				t.Fatalf("result = %+v, events = %v", finished, host.events)
			}
			if failure != "backup" && !strings.Contains(strings.Join(host.events, ","), "install:1.14.2,restore,start,verify:1.14.2") {
				t.Fatal("missing package/state recovery", host.events)
			}
		})
	}
}

func TestCoreVersionRecoveryFailureRetainsReservationAndCanResume(t *testing.T) {
	s, host, source := coreVersionFixture(t)
	job, err := s.Queue(context.Background(), "operator", checkedCoreVersion(t, s))
	if err != nil {
		t.Fatal(err)
	}
	host.installErr, host.rollbackErr = true, true
	finished := runVersionFixture(t, s, host, source, job.ID)
	if finished.State != "failed" || !finished.NeedsRecovery {
		t.Fatalf("result = %+v", finished)
	}
	if unlock, err := BeginHostWrite(s.directory); err == nil {
		unlock()
		t.Fatal("write admitted before recovery")
	}
	if _, err := s.Queue(context.Background(), "operator", CoreVersionRequest{CheckID: strings.Repeat("a", 32), ExpectedCurrentVersion: "1.14.1", ConfigRevision: "config-revision"}); err == nil {
		t.Fatal("another core version change was admitted")
	}
	host.rollbackErr = false
	finished = runVersionFixture(t, s, host, source, job.ID)
	if finished.State != "rolled_back" || finished.NeedsRecovery {
		t.Fatalf("resume = %+v", finished)
	}
}

func TestCoreVersionInterruptedInstallAndBootRecoveryVerifyAfterSystemdOrdering(t *testing.T) {
	s, host, source := coreVersionFixture(t)
	job, err := s.Queue(context.Background(), "operator", checkedCoreVersion(t, s))
	if err != nil {
		t.Fatal(err)
	}
	record, _ := readCoreVersionRecord(s.root, job.ID)
	record.Job.State, record.Job.Phase = "running", "installing"
	record.StopRequested, record.BackupComplete, record.InstallRequested = true, true, true
	if err := writePanelJSON(filepath.Join(coreVersionJobDir(s.root, job.ID), "job.json"), record); err != nil {
		t.Fatal(err)
	}
	if err := runCoreVersion(context.Background(), s.directory, job.ID, host, source, true); err != nil {
		t.Fatal(err)
	}
	staged, _ := readCoreVersionRecord(s.root, job.ID)
	if !staged.RecoveryReady || staged.Job.State != "rolling_back" || !strings.Contains(strings.Join(host.events, ","), "restore,unmask,schedule-recovery") || strings.Contains(strings.Join(host.events, ","), ",start") {
		t.Fatal("boot helper synchronously started its dependent service", host.events)
	}
	count := len(host.events)
	finished := runVersionFixture(t, s, host, source, job.ID)
	if finished.State != "rolled_back" || strings.Join(host.events[count:], ",") != "start,verify:1.14.2" {
		t.Fatal("recovery repeated installation or did not verify", host.events)
	}
}

func TestCoreVersionChecksRejectUnsupportedStaleAndTamperedConfirmation(t *testing.T) {
	for _, version := range []string{"1.13.9", "1.14.0-alpha.1", "1.14.2", "../../file"} {
		s, _, _ := coreVersionFixture(t)
		if _, err := s.Check(context.Background(), version); err == nil {
			t.Fatal("accepted invalid or unchanged target", version)
		}
	}
	for _, change := range []string{"expired", "revision", "installed-version", "release"} {
		s, host, source := coreVersionFixture(t)
		request := checkedCoreVersion(t, s)
		switch change {
		case "expired":
			var checked CoreVersionCheck
			name := filepath.Join(s.root, "checks", request.CheckID+".json")
			_ = readPanelJSON(name, &checked)
			checked.CheckedAt = time.Now().Add(-11 * time.Minute)
			_ = writePanelJSON(name, checked)
		case "revision":
			host.info.Revision = "changed"
		case "installed-version":
			host.info.Version = "1.14.1"
		case "release":
			source.changed = true
		}
		if _, err := s.Queue(context.Background(), "operator", request); !errors.Is(err, domain.ErrConflict) {
			t.Fatal("accepted changed confirmation", change, err)
		}
		if len(host.events) != 0 {
			t.Fatal("rejected confirmation scheduled a task", host.events)
		}
	}
}

func TestCoreVersionStatusCachesCatalogAndReportsPersistentTask(t *testing.T) {
	s, host, source := coreVersionFixture(t)
	state, err := s.Status(context.Background(), false)
	if err != nil || !state.Supported || len(state.Versions) != 2 {
		t.Fatal(state, err)
	}
	request := checkedCoreVersion(t, s)
	job, err := s.Queue(context.Background(), "operator", request)
	if err != nil {
		t.Fatal(err)
	}
	s.settings = nil
	other := &CoreVersionService{directory: s.directory, root: s.root, host: host, source: source}
	state, err = other.Status(context.Background(), false)
	if err != nil || state.Job == nil || state.Job.ID != job.ID || state.BlockedReason == "" {
		t.Fatal(state, err)
	}
	info, err := os.Stat(filepath.Join(s.root, "checks", request.CheckID+".json"))
	if err != nil || !info.Mode().IsRegular() {
		t.Fatal(err)
	}
}
