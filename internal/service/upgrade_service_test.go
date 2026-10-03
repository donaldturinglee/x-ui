package service

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type fakeUpgradeSource struct {
	release  UpgradeRelease
	archive  []byte
	fail     bool
	resolves int
}

func (source *fakeUpgradeSource) Latest(context.Context, string) (*UpgradeRelease, error) {
	if source.fail {
		return nil, errors.New("private transport failure")
	}
	value := source.release
	return &value, nil
}
func (source *fakeUpgradeSource) Resolve(ctx context.Context, _ int64, platform string) (*UpgradeRelease, error) {
	source.resolves++
	return source.Latest(ctx, platform)
}
func (source *fakeUpgradeSource) Download(_ context.Context, _ string, target io.Writer, _ int64) error {
	_, err := target.Write(source.archive)
	return err
}

type fakeUpgradeHost struct {
	directory string
	failure   string
	events    []string
	version   string
	schedules int
}

func (*fakeUpgradeHost) Cleanup(context.Context, string, *upgradeRecord) error { return nil }

func (*fakeUpgradeHost) Available(string) (string, bool, string) { return "amd64", true, "" }
func (*fakeUpgradeHost) Components(context.Context) ([]string, bool, error) {
	return []string{"API", "Worker", "CLI"}, false, nil
}
func (host *fakeUpgradeHost) event(name string) error {
	host.events = append(host.events, name)
	if host.failure == name {
		return errors.New("private configuration value")
	}
	return nil
}
func (host *fakeUpgradeHost) Schedule(context.Context, string, string) error {
	host.schedules++
	return host.event("schedule")
}
func (host *fakeUpgradeHost) Preflight(context.Context, string, *upgradeRecord, string) error {
	return host.event("preflight")
}
func (host *fakeUpgradeHost) BackupFiles(context.Context, string, *upgradeRecord) error {
	if err := host.event("backup-files"); err != nil {
		return err
	}
	return copyUpgradeFile(filepath.Join(host.directory, "program"), filepath.Join(host.directory, "program.backup"), 0o600)
}
func (host *fakeUpgradeHost) Stop(context.Context, *upgradeRecord) error { return host.event("stop") }
func (host *fakeUpgradeHost) BackupDatabase(context.Context, string, *upgradeRecord) error {
	if err := host.event("backup-db"); err != nil {
		return err
	}
	return copyUpgradeFile(filepath.Join(host.directory, "schema"), filepath.Join(host.directory, "schema.backup"), 0o600)
}
func (host *fakeUpgradeHost) Migrate(context.Context, string, *upgradeRecord, string) error {
	_ = os.WriteFile(filepath.Join(host.directory, "schema"), []byte("new column and dependent table"), 0o600)
	return host.event("migrate")
}
func (host *fakeUpgradeHost) Install(_ context.Context, _ string, record *upgradeRecord, _ string) error {
	host.version = record.Job.ToVersion
	_ = os.WriteFile(filepath.Join(host.directory, "program"), []byte("new binary"), 0o600)
	return host.event("install")
}
func (host *fakeUpgradeHost) Start(context.Context, *upgradeRecord) error { return host.event("start") }
func (host *fakeUpgradeHost) Verify(_ context.Context, _ string, record *upgradeRecord, version string) error {
	if err := host.event("verify-" + version); err != nil {
		return err
	}
	if host.version != version {
		return errors.New("wrong running version")
	}
	return nil
}
func (host *fakeUpgradeHost) RestoreDatabase(context.Context, string, *upgradeRecord) error {
	if err := host.event("restore-db"); err != nil {
		return err
	}
	return copyUpgradeFile(filepath.Join(host.directory, "schema.backup"), filepath.Join(host.directory, "schema"), 0o600)
}
func (host *fakeUpgradeHost) RestoreFiles(_ context.Context, _ string, record *upgradeRecord) error {
	if err := host.event("restore-files"); err != nil {
		return err
	}
	host.version = record.Job.FromVersion
	return copyUpgradeFile(filepath.Join(host.directory, "program.backup"), filepath.Join(host.directory, "program"), 0o600)
}

func upgradeTestArchive(t *testing.T, extras []*tar.Header) []byte {
	t.Helper()
	var output bytes.Buffer
	gz := gzip.NewWriter(&output)
	writer := tar.NewWriter(gz)
	for _, name := range []string{"x-ui/bin/x-ui-api", "x-ui/bin/x-ui-worker", "x-ui/bin/x-ui-cli", "x-ui/bin/x-ui-agent", "x-ui/bin/x-ui-core-reload", "x-ui/x-ui.sh", "x-ui/x-ui-api.service", "x-ui/x-ui-worker.service", "x-ui/x-ui-agent.service", "x-ui/release.json", "x-ui/web/build/index.html", "x-ui/migrations/001_initial.up.sql"} {
		data := []byte("fixture")
		if name == "x-ui/release.json" {
			data = []byte(`{"version":"v0.0.2","platform":"amd64","upgradeProtocol":1}`)
		}
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	for _, header := range extras {
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func upgradeFixture(t *testing.T) (*UpgradeService, *fakeUpgradeHost, *fakeUpgradeSource) {
	t.Helper()
	directory := t.TempDir()
	t.Setenv("X_UI_CONFIG_DIR", directory)
	data := []byte("database:\n  password: private-database\nsession:\n  secret: private-session\n")
	if err := os.WriteFile(filepath.Join(directory, "config.yaml"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	host := &fakeUpgradeHost{directory: directory, version: "v0.0.1"}
	source := &fakeUpgradeSource{archive: upgradeTestArchive(t, nil)}
	source.release = UpgradeRelease{ID: 1, Version: "v0.0.2", AssetID: 2, AssetName: "x-ui-linux-amd64.tar.gz", AssetURL: "https://github.com/donaldturinglee/x-ui/releases/download/v0.0.2/x-ui-linux-amd64.tar.gz", AssetSize: int64(len(source.archive)), SHA256: fmt.Sprintf("%x", sha256.Sum256(source.archive)), PublishedAt: time.Now().UTC(), AssetUpdatedAt: time.Now().UTC()}
	for name, value := range map[string]string{"schema": "old schema and data", "program": "old binary"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	s := &UpgradeService{directory: directory, root: upgradeRoot(directory), version: "v0.0.1", platform: "amd64", supported: true, host: host, source: source, panel: NewPanelSettingsService(nil, cfg)}
	return s, host, source
}

func confirmedUpgrade(t *testing.T, s *UpgradeService) UpgradeRequest {
	t.Helper()
	state, err := s.Check(context.Background())
	if err != nil || !state.CanUpgrade {
		t.Fatalf("check = %+v, %v", state, err)
	}
	return UpgradeRequest{CheckID: state.CheckID, ExpectedCurrentVersion: state.CurrentVersion, ConfigRevision: state.ConfigRevision}
}

func TestUpgradeQueuesOnceSurvivesNewServiceAndProtectsWrites(t *testing.T) {
	s, host, _ := upgradeFixture(t)
	request := confirmedUpgrade(t, s)
	job, err := s.Queue(context.Background(), "operator", request)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Queue(context.Background(), "operator", request)
	if err != nil || again.ID != job.ID || host.schedules != 1 {
		t.Fatal("duplicate queue", err)
	}
	if unlock, err := BeginHostWrite(s.directory); !errors.Is(err, domain.ErrConflict) {
		if unlock != nil {
			unlock()
		}
		t.Fatal("writes admitted during queued upgrade", err)
	}
	core, _ := coreFixture(t)
	core.directory = s.directory
	if _, err := core.Queue(context.Background(), "operator"); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("core restart admitted", err)
	}
	restart := &PanelRestartService{panel: s.panel, supported: true}
	if _, err := restart.Queue(context.Background(), "operator", request.ConfigRevision); !errors.Is(err, domain.ErrConflict) {
		t.Fatal("settings application admitted", err)
	}
	if err := runUpgrade(context.Background(), s.directory, job.ID, host, s.source); err != nil {
		t.Fatal(err)
	}
	restarted := NewUpgradeService(config.Default())
	restarted.root = s.root
	finished, err := restarted.Job(job.ID)
	if err != nil || finished.State != "succeeded" || finished.FinishedAt == nil {
		t.Fatalf("result = %+v, %v", finished, err)
	}
	if !reflect.DeepEqual(host.events, []string{"schedule", "preflight", "backup-files", "stop", "backup-db", "migrate", "install", "start", "verify-v0.0.2"}) {
		t.Fatal(host.events)
	}
	public, _ := json.Marshal(finished)
	if strings.Contains(string(public), "private-") || strings.Contains(string(public), "environment") {
		t.Fatal("private upgrade record exposed")
	}
	if unlock, err := BeginHostWrite(s.directory); err != nil {
		t.Fatal("host remained reserved", err)
	} else {
		unlock()
	}
	before := len(host.events)
	if err := runUpgrade(context.Background(), s.directory, job.ID, host, s.source); err != nil || len(host.events) != before {
		t.Fatal("completed task executed again", err)
	}
}

func TestUpgradeRejectsStaleConfirmationAndReplacedAssets(t *testing.T) {
	for _, change := range []string{"revision", "version", "check", "asset"} {
		t.Run(change, func(t *testing.T) {
			s, host, source := upgradeFixture(t)
			request := confirmedUpgrade(t, s)
			switch change {
			case "revision":
				request.ConfigRevision = "other"
			case "version":
				request.ExpectedCurrentVersion = "v0.0.0"
			case "check":
				request.CheckID = strings.Repeat("a", 32)
			case "asset":
				source.release.AssetID++
			}
			if _, err := s.Queue(context.Background(), "operator", request); !errors.Is(err, domain.ErrConflict) || host.schedules != 0 {
				t.Fatalf("stale %s accepted: %v", change, err)
			}
		})
	}
}

func TestUpgradePendingSettingsNetworkFailureAndExpiredChecks(t *testing.T) {
	s, _, source := upgradeFixture(t)
	state, err := s.Status(context.Background())
	if err != nil || state.CheckState != "unchecked" || state.CanUpgrade {
		t.Fatal(state, err)
	}
	source.fail = true
	state, err = s.Check(context.Background())
	if err != nil || state.CheckState != "failed" || state.CanUpgrade || strings.Contains(state.CheckError, "private") {
		t.Fatal(state, err)
	}
	source.fail = false
	request := confirmedUpgrade(t, s)
	if err := os.WriteFile(filepath.Join(s.directory, "config.yaml"), []byte("server:\n  port: 8123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err = s.Status(context.Background())
	if err != nil || state.CanUpgrade || !strings.Contains(state.BlockedReason, "Apply") {
		t.Fatal(state, err)
	}
	var checked upgradeCheck
	_ = readPanelJSON(filepath.Join(s.root, "check.json"), &checked)
	checked.CheckedAt = time.Now().Add(-11 * time.Minute)
	_ = writePanelJSON(filepath.Join(s.root, "check.json"), checked)
	if _, err := s.Queue(context.Background(), "operator", request); !errors.Is(err, domain.ErrConflict) {
		t.Fatal(err)
	}
}

func TestUpgradeFailuresRestoreBinarySchemaAndPreserveSecrets(t *testing.T) {
	for _, failure := range []string{"preflight", "backup-files", "backup-db", "migrate", "install", "verify-v0.0.2"} {
		t.Run(failure, func(t *testing.T) {
			s, host, _ := upgradeFixture(t)
			job, err := s.Queue(context.Background(), "operator", confirmedUpgrade(t, s))
			if err != nil {
				t.Fatal(err)
			}
			host.failure = failure
			if err := runUpgrade(context.Background(), s.directory, job.ID, host, s.source); err != nil {
				t.Fatal(err)
			}
			result, _ := s.Job(job.ID)
			expected := "rolled_back"
			if failure == "preflight" || failure == "backup-files" {
				expected = "failed"
			}
			if result.State != expected || result.NeedsRecovery || strings.Contains(result.Error, "private") {
				t.Fatalf("result=%+v", result)
			}
			for name, expected := range map[string]string{"schema": "old schema and data", "program": "old binary"} {
				data, _ := os.ReadFile(filepath.Join(s.directory, name))
				if string(data) != expected {
					t.Fatalf("%s not restored: %s", name, data)
				}
			}
			data, _ := os.ReadFile(filepath.Join(s.directory, "config.yaml"))
			if !strings.Contains(string(data), "private-session") {
				t.Fatal("credentials changed")
			}
			if failure == "preflight" || failure == "backup-files" {
				for _, event := range host.events {
					if event == "stop" {
						t.Fatal("preparation stopped services")
					}
				}
			}
		})
	}
}

func TestInterruptedUpgradeRecoversCheckpointAndRetainsReservationOnRestoreFailure(t *testing.T) {
	s, host, _ := upgradeFixture(t)
	job, err := s.Queue(context.Background(), "operator", confirmedUpgrade(t, s))
	if err != nil {
		t.Fatal(err)
	}
	record, _ := readUpgradeRecord(s.root, job.ID)
	_ = host.BackupFiles(context.Background(), s.directory, record)
	_ = host.BackupDatabase(context.Background(), s.directory, record)
	_ = host.Migrate(context.Background(), s.directory, record, "")
	_ = host.Install(context.Background(), s.directory, record, "")
	record.Job.State = "running"
	record.FilesBackedUp = true
	record.StopRequested = true
	record.DatabaseBackedUp = true
	record.DatabaseChanged = true
	record.FilesChanged = true
	_ = writePanelJSON(upgradeRecordPath(s.root, job.ID), record)
	host.failure = "restore-db"
	if err := runUpgrade(context.Background(), s.directory, job.ID, host, s.source); err != nil {
		t.Fatal(err)
	}
	result, _ := s.Job(job.ID)
	if result.State != "failed" || !result.NeedsRecovery {
		t.Fatal(result)
	}
	if unlock, err := BeginHostWrite(s.directory); !errors.Is(err, domain.ErrConflict) {
		if unlock != nil {
			unlock()
		}
		t.Fatal("writes admitted after failed DB recovery")
	}
	host.failure = ""
	if err := runUpgrade(context.Background(), s.directory, job.ID, host, s.source); err != nil {
		t.Fatal(err)
	}
	result, _ = s.Job(job.ID)
	if result.State != "rolled_back" || result.NeedsRecovery {
		t.Fatal(result)
	}
	data, _ := os.ReadFile(filepath.Join(s.directory, "schema"))
	if string(data) != "old schema and data" {
		t.Fatal("interrupted migration was not restored")
	}
}

func TestReleaseArchiveRejectsTraversalLinksDuplicatesAndBadChecksum(t *testing.T) {
	for _, header := range []*tar.Header{{Name: "../escaped", Typeflag: tar.TypeReg}, {Name: "x-ui/web/build/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}, {Name: "x-ui/web/build/hard", Typeflag: tar.TypeLink, Linkname: "x-ui/bin/x-ui-cli"}, {Name: "x-ui/web/build/index.html", Typeflag: tar.TypeReg}, {Name: "x-ui/configs/config.yaml", Typeflag: tar.TypeReg}} {
		t.Run(header.Name, func(t *testing.T) {
			directory := t.TempDir()
			archive := filepath.Join(directory, "archive")
			_ = os.WriteFile(archive, upgradeTestArchive(t, []*tar.Header{header}), 0o600)
			stage := filepath.Join(directory, "stage")
			_ = os.Mkdir(stage, 0o700)
			if extractUpgrade(context.Background(), archive, stage) == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
	s, host, source := upgradeFixture(t)
	job, _ := s.Queue(context.Background(), "operator", confirmedUpgrade(t, s))
	source.archive = append(source.archive, 0)
	if err := runUpgrade(context.Background(), s.directory, job.ID, host, source); err != nil {
		t.Fatal(err)
	}
	result, _ := s.Job(job.ID)
	if result.State != "failed" || len(host.events) != 1 {
		t.Fatal("bad checksum affected installation", result, host.events)
	}
}

func TestUpgradeVersionsAndPlatforms(t *testing.T) {
	for _, pair := range [][2]string{{"v0.0.9", "v0.0.10"}, {"1.2.3", "v1.2.4"}, {"v1.9.9", "v2.0.0"}} {
		if value, err := compareUpgradeVersions(pair[0], pair[1]); err != nil || value != -1 {
			t.Fatal(pair, value, err)
		}
	}
	for _, version := range []string{"dev", "abc123", "v1.2.3-beta.1", "v01.2.3", "v1.2.3;command"} {
		if _, err := compareUpgradeVersions(version, "v9.9.9"); err == nil {
			t.Fatal(version)
		}
	}
	for machine, expected := range map[string]string{"x86_64": "amd64", "i686": "386", "aarch64": "arm64", "armv7l": "armv7", "armv6l": "armv6", "armv5tel": "armv5", "s390x": "s390x"} {
		if actual, err := releasePlatform(machine); err != nil || actual != expected {
			t.Fatal(machine, actual, err)
		}
	}
}

func TestMaintenanceAllowsConcurrentWritesAndReservesAfterTheyFinish(t *testing.T) {
	directory := t.TempDir()
	first, err := BeginHostWrite(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer first()
	second, err := BeginHostWrite(directory)
	if err != nil {
		t.Fatal("ordinary concurrent writes blocked", err)
	}
	defer second()
	if gate, err := maintenanceGate(directory, "upgrade", ""); !errors.Is(err, domain.ErrConflict) {
		if gate != nil {
			gate()
		}
		t.Fatal("maintenance passed admitted writes", err)
	}
	second()
	if gate, err := maintenanceGate(directory, "upgrade", ""); !errors.Is(err, domain.ErrConflict) {
		if gate != nil {
			gate()
		}
		t.Fatal("maintenance passed remaining write", err)
	}
	first()
	gate, err := maintenanceGate(directory, "upgrade", "")
	if err != nil {
		t.Fatal("completed writes still blocked maintenance", err)
	}
	if err := maintenanceReserve(directory, "upgrade", strings.Repeat("a", 32)); err != nil {
		gate()
		t.Fatal(err)
	}
	gate()
	if unlock, err := BeginHostWrite(directory); !errors.Is(err, domain.ErrConflict) {
		if unlock != nil {
			unlock()
		}
		t.Fatal("writes admitted after reservation", err)
	}
}

func TestMaintenanceCLIChildCanUseItsOwnReservation(t *testing.T) {
	directory := t.TempDir()
	id := strings.Repeat("c", 32)
	if err := maintenanceReserve(directory, "panel", id); err != nil {
		t.Fatal(err)
	}
	t.Setenv("X_UI_MAINTENANCE_OWNER", "panel:"+strings.Repeat("d", 32))
	if unlock, err := BeginHostCLIWrite(directory); !errors.Is(err, domain.ErrConflict) {
		if unlock != nil {
			unlock()
		}
		t.Fatal("foreign helper admitted", err)
	}
	t.Setenv("X_UI_MAINTENANCE_OWNER", "panel:"+id)
	if unlock, err := BeginHostCLIWrite(directory); err != nil {
		t.Fatal("own CLI child blocked", err)
	} else {
		unlock()
	}
	if unlock, err := BeginHostWrite(directory); !errors.Is(err, domain.ErrConflict) {
		if unlock != nil {
			unlock()
		}
		t.Fatal("HTTP write bypassed maintenance", err)
	}
}
