package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type CoreVersionJob struct {
	ID            string     `json:"id"`
	State         string     `json:"state"`
	Phase         string     `json:"phase"`
	Direction     string     `json:"direction"`
	Actor         string     `json:"actor"`
	FromVersion   string     `json:"fromVersion"`
	ToVersion     string     `json:"toVersion"`
	RequestedAt   time.Time  `json:"requestedAt"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
	Error         string     `json:"error,omitempty"`
	NeedsRecovery bool       `json:"needsRecovery"`
}

func (job *CoreVersionJob) active() bool {
	return job.State == "queued" || job.State == "running" || job.State == "rolling_back"
}

type CoreVersionCheck struct {
	ID             string          `json:"checkId"`
	CheckedAt      time.Time       `json:"checkedAt"`
	CurrentVersion string          `json:"currentVersion"`
	ConfigRevision string          `json:"configRevision"`
	Direction      string          `json:"direction"`
	Target         UpgradeRelease  `json:"target"`
	Previous       UpgradeRelease  `json:"previous"`
	Snapshot       coreVersionInfo `json:"snapshot"`
}

type CoreVersionStatus struct {
	Supported      bool             `json:"supported"`
	Reason         string           `json:"reason,omitempty"`
	CurrentVersion string           `json:"currentVersion"`
	PackageVersion string           `json:"packageVersion"`
	Platform       string           `json:"platform"`
	Manager        string           `json:"manager"`
	ConfigRevision string           `json:"configRevision"`
	Versions       []UpgradeRelease `json:"versions"`
	CheckedAt      *time.Time       `json:"checkedAt,omitempty"`
	CheckError     string           `json:"checkError,omitempty"`
	BlockedReason  string           `json:"blockedReason,omitempty"`
	Job            *CoreVersionJob  `json:"job,omitempty"`
}

type CoreVersionRequest struct {
	CheckID                string `json:"checkId"`
	ExpectedCurrentVersion string `json:"expectedCurrentVersion"`
	ConfigRevision         string `json:"configRevision"`
}

type coreVersionInfo struct {
	Version        string     `json:"version"`
	PackageVersion string     `json:"packageVersion"`
	Platform       string     `json:"platform"`
	Manager        string     `json:"manager"`
	Revision       string     `json:"revision"`
	Launch         coreLaunch `json:"launch"`
	PID            int        `json:"pid"`
	BootID         string     `json:"bootId"`
	ConfigDir      string     `json:"configDir"`
	DataDir        string     `json:"dataDir"`
}

type coreVersionRecord struct {
	Job              CoreVersionJob   `json:"job"`
	Check            CoreVersionCheck `json:"check"`
	StopRequested    bool             `json:"stopRequested"`
	BackupComplete   bool             `json:"backupComplete"`
	InstallRequested bool             `json:"installRequested"`
	RecoveryReady    bool             `json:"recoveryReady"`
}

type coreVersionHost interface {
	Info(context.Context) (coreVersionInfo, error)
	Schedule(context.Context, string, string) error
	Prepare(context.Context, string, coreVersionInfo, UpgradeRelease) (string, string, error)
	Validate(context.Context, coreVersionInfo, string, string) error
	Backup(context.Context, string, coreVersionInfo) error
	Stop(context.Context) error
	Install(context.Context, coreVersionInfo, string) error
	Restore(context.Context, string, coreVersionInfo) error
	Start(context.Context) error
	Unmask(context.Context) error
	ScheduleRecovery(context.Context, string, string) error
	Verify(context.Context, coreVersionInfo, string) error
}

type CoreVersionService struct {
	mu        sync.Mutex
	directory string
	root      string
	host      coreVersionHost
	source    coreVersionSource
	settings  *SettingService
}

func NewCoreVersionService(settings *SettingService) *CoreVersionService {
	directory, _ := filepath.Abs(config.Dir())
	return &CoreVersionService{directory: directory, root: coreVersionRoot(directory), host: systemdCoreVersionHost{}, source: newCoreVersionSource(), settings: settings}
}

func coreVersionRoot(directory string) string {
	if filepath.Clean(directory) == installedConfigDir {
		return "/var/lib/x-ui/core-version"
	}
	return filepath.Join(directory, ".core-version")
}

func coreVersionJobDir(root, id string) string { return filepath.Join(root, "jobs", id) }

func readCoreVersionRecord(root, id string) (*coreVersionRecord, error) {
	if !panelJobID.MatchString(id) {
		return nil, domain.Invalidf("Invalid sing-box version task ID")
	}
	var record coreVersionRecord
	if err := readPanelJSON(filepath.Join(coreVersionJobDir(root, id), "job.json"), &record); err != nil {
		return nil, err
	}
	if record.Job.ID != id {
		return nil, fmt.Errorf("Core version task ID does not match its record")
	}
	return &record, nil
}

func latestCoreVersion(root string) (*coreVersionRecord, error) {
	data, err := os.ReadFile(filepath.Join(root, "latest"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return readCoreVersionRecord(root, string(data))
}

type coreVersionCatalog struct {
	Platform  string           `json:"platform"`
	Manager   string           `json:"manager"`
	CheckedAt time.Time        `json:"checkedAt"`
	Error     string           `json:"error,omitempty"`
	Versions  []UpgradeRelease `json:"versions"`
}

func (s *CoreVersionService) Status(ctx context.Context, refresh bool) (CoreVersionStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := CoreVersionStatus{Versions: []UpgradeRelease{}}
	if record, err := latestCoreVersion(s.root); err != nil {
		return state, err
	} else if record != nil {
		state.Job = &record.Job
	}
	probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	info, err := s.host.Info(probeCtx)
	cancel()
	if err != nil {
		state.Reason, state.BlockedReason = err.Error(), err.Error()
		return state, nil
	}
	state.Supported, state.CurrentVersion, state.PackageVersion = true, info.Version, info.PackageVersion
	state.Platform, state.Manager, state.ConfigRevision = info.Platform, info.Manager, info.Revision
	var catalog coreVersionCatalog
	err = readPanelJSON(filepath.Join(s.root, "versions.json"), &catalog)
	if err != nil && !os.IsNotExist(err) {
		return state, err
	}
	if refresh || err != nil || catalog.Platform != info.Platform || catalog.Manager != info.Manager || time.Since(catalog.CheckedAt) > 15*time.Minute {
		checkCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
		versions, checkErr := s.source.List(checkCtx, info.Platform, info.Manager)
		cancel()
		catalog = coreVersionCatalog{Platform: info.Platform, Manager: info.Manager, CheckedAt: time.Now().UTC(), Versions: versions}
		if checkErr != nil {
			catalog.Error = "Official versions could not be checked. Check this server's GitHub connection and retry."
			catalog.Versions = []UpgradeRelease{}
		}
		if err := writePanelJSON(filepath.Join(s.root, "versions.json"), catalog); err != nil {
			return state, err
		}
	}
	state.Versions, state.CheckedAt, state.CheckError = catalog.Versions, &catalog.CheckedAt, catalog.Error
	if state.Job != nil && (state.Job.active() || state.Job.NeedsRecovery) {
		state.BlockedReason = "A sing-box version task is in progress or requires recovery."
	} else if operation, err := maintenanceActive(s.directory); err != nil {
		return state, err
	} else if operation != nil && !maintenancePrune(s.directory, operation) {
		state.BlockedReason = "Wait for the current host maintenance operation to finish."
	}
	return state, nil
}

func (s *CoreVersionService) Check(ctx context.Context, version string) (*CoreVersionCheck, error) {
	comparison, err := compareUpgradeVersions(version, minimumCoreVersion)
	if err != nil || comparison < 0 {
		return nil, domain.Invalidf("Select a stable sing-box version %s or newer; this panel requires its native statistics API", minimumCoreVersion)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	gate, err := maintenanceGate(s.directory, "", "")
	if err != nil {
		return nil, err
	}
	defer gate()
	checkCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	info, err := s.host.Info(checkCtx)
	if err != nil {
		return nil, domain.Invalidf("%s", err)
	}
	comparison, err = compareUpgradeVersions(info.Version, version)
	if err != nil || comparison == 0 {
		return nil, domain.Invalidf("Select a different stable sing-box version")
	}
	target, err := s.source.Resolve(checkCtx, version, info.Platform, info.Manager)
	if err != nil {
		return nil, domain.Invalidf("The selected official version could not be verified; refresh the version list")
	}
	previous, err := s.source.Resolve(checkCtx, info.Version, info.Platform, info.Manager)
	if err != nil {
		return nil, domain.Invalidf("The installed version has no verified official recovery package; version switching is unavailable")
	}
	id, err := upgradeID()
	if err != nil {
		return nil, err
	}
	direction := "upgrade"
	if comparison > 0 {
		direction = "downgrade"
	}
	checked := &CoreVersionCheck{ID: id, CheckedAt: time.Now().UTC(), CurrentVersion: info.Version, ConfigRevision: info.Revision,
		Direction: direction, Target: *target, Previous: *previous, Snapshot: info}
	if err := writePanelJSON(filepath.Join(s.root, "checks", id+".json"), checked); err != nil {
		return nil, err
	}
	return checked, nil
}

func (s *CoreVersionService) Queue(ctx context.Context, actor string, request CoreVersionRequest) (*CoreVersionJob, error) {
	if !panelJobID.MatchString(request.CheckID) || request.ConfigRevision == "" || request.ExpectedCurrentVersion == "" {
		return nil, domain.Invalidf("Confirm the checked version, current version and configuration revision")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	gate, err := maintenanceGate(s.directory, "core-version", "")
	if err != nil {
		return nil, err
	}
	defer gate()
	if record, err := latestCoreVersion(s.root); err != nil {
		return nil, err
	} else if record != nil && (record.Job.active() || record.Job.NeedsRecovery) {
		if !record.Job.NeedsRecovery && record.Check.ID == request.CheckID && record.Check.ConfigRevision == request.ConfigRevision && record.Check.CurrentVersion == request.ExpectedCurrentVersion {
			return &record.Job, nil
		}
		return nil, domain.Conflictf("Another sing-box version task is in progress or requires recovery")
	}
	var checked CoreVersionCheck
	if err := readPanelJSON(filepath.Join(s.root, "checks", request.CheckID+".json"), &checked); err != nil {
		return nil, domain.Conflictf("Check the selected version before confirming")
	}
	if checked.ID != request.CheckID || time.Since(checked.CheckedAt) > 10*time.Minute || checked.CheckedAt.After(time.Now().Add(time.Minute)) || checked.ConfigRevision != request.ConfigRevision || checked.CurrentVersion != request.ExpectedCurrentVersion {
		return nil, domain.Conflictf("The version check expired or changed; check the selected version again")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	info, err := s.host.Info(checkCtx)
	if err != nil || info.Revision != checked.ConfigRevision || info.Version != checked.CurrentVersion || !sameCoreInstallation(info, checked.Snapshot) {
		return nil, domain.Conflictf("The installed version or configuration changed; check the selected version again")
	}
	for _, pinned := range []*UpgradeRelease{&checked.Target, &checked.Previous} {
		current, err := s.source.Resolve(checkCtx, pinned.Version, info.Platform, info.Manager)
		if err != nil || !reflect.DeepEqual(current, pinned) {
			return nil, domain.Conflictf("An official package changed or cannot be verified; check the selected version again")
		}
	}
	id, err := upgradeID()
	if err != nil {
		return nil, err
	}
	record := &coreVersionRecord{Job: CoreVersionJob{ID: id, State: "queued", Phase: "scheduled", Direction: checked.Direction, Actor: actor,
		FromVersion: checked.CurrentVersion, ToVersion: checked.Target.Version, RequestedAt: time.Now().UTC()}, Check: checked}
	if err := writePanelJSON(filepath.Join(coreVersionJobDir(s.root, id), "job.json"), record); err != nil {
		return nil, err
	}
	if err := writePanelPrivate(filepath.Join(s.root, "latest"), []byte(id)); err != nil {
		return nil, err
	}
	if err := maintenanceReserve(s.directory, "core-version", id); err != nil {
		return nil, err
	}
	if err := s.host.Schedule(ctx, s.directory, id); err != nil {
		now := time.Now().UTC()
		record.Job.State, record.Job.Error, record.Job.FinishedAt = "failed", "The version task could not be scheduled; sing-box was not changed.", &now
		if err := writePanelJSON(filepath.Join(coreVersionJobDir(s.root, id), "job.json"), record); err != nil {
			return nil, err
		}
		_ = os.Remove(filepath.Join(maintenanceDir(s.directory), "active.json"))
		return nil, domain.Invalidf("%s", record.Job.Error)
	}
	if s.settings != nil {
		AuditCoreVersion(ctx, s.settings, &record.Job)
	}
	return &record.Job, nil
}

func sameCoreInstallation(a, b coreVersionInfo) bool {
	return a.PackageVersion == b.PackageVersion && a.Platform == b.Platform && a.Manager == b.Manager && a.ConfigDir == b.ConfigDir && a.DataDir == b.DataDir && reflect.DeepEqual(a.Launch, b.Launch)
}

func (s *CoreVersionService) Job(id string) (*CoreVersionJob, error) {
	record, err := readCoreVersionRecord(s.root, id)
	if os.IsNotExist(err) {
		return nil, domain.NotFoundf("Sing-box version task does not exist")
	}
	if err != nil {
		return nil, err
	}
	return &record.Job, nil
}

func AuditCoreVersion(ctx context.Context, settings *SettingService, job *CoreVersionJob) {
	logChange(ctx, settings.store, job.Actor, "core-version", job.State, job.ID)
}
