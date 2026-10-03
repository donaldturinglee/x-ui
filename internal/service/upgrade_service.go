package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type UpgradeJob struct {
	ID            string     `json:"id"`
	State         string     `json:"state"`
	Phase         string     `json:"phase"`
	Actor         string     `json:"actor"`
	FromVersion   string     `json:"fromVersion"`
	ToVersion     string     `json:"toVersion"`
	Components    []string   `json:"components"`
	RequestedAt   time.Time  `json:"requestedAt"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
	Error         string     `json:"error,omitempty"`
	NeedsRecovery bool       `json:"needsRecovery"`
}

func (job *UpgradeJob) active() bool {
	return job.State == "queued" || job.State == "running" || job.State == "rolling_back"
}

type UpgradeStatus struct {
	Supported      bool            `json:"supported"`
	Reason         string          `json:"reason,omitempty"`
	CurrentVersion string          `json:"currentVersion"`
	Platform       string          `json:"platform"`
	CheckState     string          `json:"checkState"`
	CheckedAt      *time.Time      `json:"checkedAt,omitempty"`
	CheckError     string          `json:"checkError,omitempty"`
	CheckID        string          `json:"checkId,omitempty"`
	ConfigRevision string          `json:"configRevision"`
	Latest         *UpgradeRelease `json:"latest,omitempty"`
	CanUpgrade     bool            `json:"canUpgrade"`
	BlockedReason  string          `json:"blockedReason,omitempty"`
	Components     []string        `json:"components"`
	Job            *UpgradeJob     `json:"job,omitempty"`
}

type UpgradeRequest struct {
	CheckID                string `json:"checkId"`
	ExpectedCurrentVersion string `json:"expectedCurrentVersion"`
	ConfigRevision         string `json:"configRevision"`
}

type upgradeCheck struct {
	ID        string          `json:"id"`
	CheckedAt time.Time       `json:"checkedAt"`
	Error     string          `json:"error,omitempty"`
	Release   *UpgradeRelease `json:"release,omitempty"`
}

type upgradeRecord struct {
	Job              UpgradeJob        `json:"job"`
	Release          UpgradeRelease    `json:"release"`
	Platform         string            `json:"platform"`
	CheckID          string            `json:"checkId"`
	Revision         string            `json:"revision"`
	Environment      map[string]string `json:"environment"`
	Agent            bool              `json:"agent"`
	FilesBackedUp    bool              `json:"filesBackedUp"`
	StopRequested    bool              `json:"stopRequested"`
	DatabaseBackedUp bool              `json:"databaseBackedUp"`
	DatabaseChanged  bool              `json:"databaseChanged"`
	FilesChanged     bool              `json:"filesChanged"`
	RestartedAt      time.Time         `json:"restartedAt"`
}

type upgradeHost interface {
	Available(string) (string, bool, string)
	Components(context.Context) ([]string, bool, error)
	Schedule(context.Context, string, string) error
	Preflight(context.Context, string, *upgradeRecord, string) error
	BackupFiles(context.Context, string, *upgradeRecord) error
	Stop(context.Context, *upgradeRecord) error
	BackupDatabase(context.Context, string, *upgradeRecord) error
	Migrate(context.Context, string, *upgradeRecord, string) error
	Install(context.Context, string, *upgradeRecord, string) error
	Start(context.Context, *upgradeRecord) error
	Verify(context.Context, string, *upgradeRecord, string) error
	RestoreDatabase(context.Context, string, *upgradeRecord) error
	RestoreFiles(context.Context, string, *upgradeRecord) error
	Cleanup(context.Context, string, *upgradeRecord) error
}

type UpgradeService struct {
	mu        sync.Mutex
	directory string
	root      string
	version   string
	platform  string
	supported bool
	reason    string
	panel     *PanelSettingsService
	source    upgradeReleaseSource
	host      upgradeHost
}

func NewUpgradeService(cfg *config.Config) *UpgradeService {
	directory, _ := filepath.Abs(config.Dir())
	host := systemdUpgradeHost{}
	platform, supported, reason := host.Available(directory)
	return &UpgradeService{directory: directory, root: upgradeRoot(directory), version: config.Version, platform: platform,
		supported: supported, reason: reason, panel: NewPanelSettingsService(nil, cfg), source: newGithubUpgradeSource(), host: host}
}

func upgradeRoot(directory string) string {
	if filepath.Clean(directory) == installedConfigDir {
		return "/var/lib/x-ui/upgrade"
	}
	return filepath.Join(directory, ".upgrade")
}

func upgradeJobDir(root, id string) string { return filepath.Join(root, "jobs", id) }
func upgradeRecordPath(root, id string) string {
	return filepath.Join(upgradeJobDir(root, id), "job.json")
}

func readUpgradeRecord(root, id string) (*upgradeRecord, error) {
	if !panelJobID.MatchString(id) {
		return nil, domain.Invalidf("Invalid upgrade task ID")
	}
	var record upgradeRecord
	if err := readPanelJSON(upgradeRecordPath(root, id), &record); err != nil {
		return nil, err
	}
	if record.Job.ID != id {
		return nil, fmt.Errorf("Upgrade task ID does not match its record")
	}
	return &record, nil
}

func latestUpgrade(root string) (*upgradeRecord, error) {
	data, err := os.ReadFile(filepath.Join(root, "latest"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return readUpgradeRecord(root, string(data))
}

func upgradeID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func (s *UpgradeService) Status(ctx context.Context) (UpgradeStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status(ctx)
}

func (s *UpgradeService) status(ctx context.Context) (UpgradeStatus, error) {
	state := UpgradeStatus{Supported: s.supported, Reason: s.reason, CurrentVersion: s.version, Platform: s.platform, CheckState: "unchecked", Components: []string{}}
	if record, err := latestUpgrade(s.root); err != nil {
		return state, err
	} else if record != nil {
		state.Job = &record.Job
	}
	var checked upgradeCheck
	err := readPanelJSON(filepath.Join(s.root, "check.json"), &checked)
	if err != nil && !os.IsNotExist(err) {
		return state, err
	}
	if err == nil {
		state.CheckedAt, state.CheckID, state.CheckError, state.Latest = &checked.CheckedAt, checked.ID, checked.Error, checked.Release
		state.CheckState = "checked"
		if checked.Error != "" {
			state.CheckState = "failed"
		}
		if time.Since(checked.CheckedAt) > 10*time.Minute {
			state.CheckState = "expired"
		}
	}
	panel, err := s.panel.Read()
	if err != nil {
		return state, err
	}
	state.ConfigRevision = panel.Revision
	if s.supported {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		components, _, err := s.host.Components(probeCtx)
		if err != nil {
			state.BlockedReason = "The installed services could not be verified."
		} else {
			state.Components = components
		}
	}
	operation, err := maintenanceActive(s.directory)
	if err != nil {
		return state, err
	}
	switch {
	case !state.Supported:
		state.BlockedReason = state.Reason
	case state.Job != nil && (state.Job.active() || state.Job.NeedsRecovery):
		state.BlockedReason = "An upgrade task is in progress or requires recovery."
	case operation != nil && !maintenancePrune(s.directory, operation):
		state.BlockedReason = "Wait for the current host maintenance operation to finish."
	case panel.RestartRequired:
		state.BlockedReason = "Apply the saved Panel and Subscription settings before upgrading."
	case state.BlockedReason != "":
	case state.CheckState != "checked":
		state.BlockedReason = "Check for updates before upgrading."
	case state.Latest == nil:
		state.BlockedReason = "No release package is available."
	default:
		comparison, err := compareUpgradeVersions(s.version, state.Latest.Version)
		if err != nil {
			state.BlockedReason = "The current build has no stable version; use the command line to upgrade."
		} else if comparison >= 0 {
			state.BlockedReason = "This installation is up to date."
		} else {
			state.CanUpgrade = true
		}
	}
	return state, nil
}

func (s *UpgradeService) Check(ctx context.Context) (UpgradeStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.platform == "" {
		return s.status(ctx)
	}
	id, err := upgradeID()
	if err != nil {
		return UpgradeStatus{}, err
	}
	checkCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	release, checkErr := s.source.Latest(checkCtx, s.platform)
	checked := upgradeCheck{ID: id, CheckedAt: time.Now().UTC(), Release: release}
	if checkErr != nil {
		checked.Error = "The release could not be checked. Check the host's GitHub connection and try again."
		checked.Release = nil
	}
	if err := writePanelJSON(filepath.Join(s.root, "check.json"), checked); err != nil {
		return UpgradeStatus{}, err
	}
	return s.status(ctx)
}

func (s *UpgradeService) Job(id string) (*UpgradeJob, error) {
	record, err := readUpgradeRecord(s.root, id)
	if os.IsNotExist(err) {
		return nil, domain.NotFoundf("Upgrade task does not exist")
	}
	if err != nil {
		return nil, err
	}
	return &record.Job, nil
}

func (s *UpgradeService) Queue(ctx context.Context, actor string, request UpgradeRequest) (*UpgradeJob, error) {
	if !panelJobID.MatchString(request.CheckID) || request.ConfigRevision == "" || request.ExpectedCurrentVersion == "" {
		return nil, domain.Invalidf("Confirm the checked release, current version and configuration revision")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	gate, err := maintenanceGate(s.directory, "upgrade", "")
	if err != nil {
		return nil, err
	}
	defer gate()
	if record, err := latestUpgrade(s.root); err != nil {
		return nil, err
	} else if record != nil && (record.Job.active() || record.Job.NeedsRecovery) {
		if record.CheckID == request.CheckID && record.Revision == request.ConfigRevision && record.Job.FromVersion == request.ExpectedCurrentVersion && !record.Job.NeedsRecovery {
			return &record.Job, nil
		}
		return nil, domain.Conflictf("Another upgrade is in progress or requires recovery")
	}
	state, err := s.status(ctx)
	if err != nil {
		return nil, err
	}
	if !state.Supported {
		return nil, domain.Invalidf("%s", state.Reason)
	}
	if !state.CanUpgrade {
		return nil, domain.Conflictf("%s", state.BlockedReason)
	}
	if request.CheckID != state.CheckID || request.ConfigRevision != state.ConfigRevision || request.ExpectedCurrentVersion != s.version {
		return nil, domain.Conflictf("Version or configuration changed; check for updates again")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	release, err := s.source.Resolve(checkCtx, state.Latest.ID, s.platform)
	if err != nil || !reflect.DeepEqual(release, state.Latest) {
		return nil, domain.Conflictf("The confirmed release changed or cannot be verified; check for updates again")
	}
	components, agent, err := s.host.Components(checkCtx)
	if err != nil {
		return nil, domain.Conflictf("The installed services cannot be upgraded")
	}
	id, err := upgradeID()
	if err != nil {
		return nil, err
	}
	record := &upgradeRecord{Job: UpgradeJob{ID: id, State: "queued", Phase: "scheduled", Actor: actor, FromVersion: s.version, ToVersion: release.Version,
		Components: components, RequestedAt: time.Now().UTC()}, Release: *release, Platform: s.platform, CheckID: request.CheckID, Revision: request.ConfigRevision, Environment: capturedUpgradeEnvironment(), Agent: agent}
	if err := writePanelJSON(upgradeRecordPath(s.root, id), record); err != nil {
		return nil, err
	}
	if err := writePanelPrivate(filepath.Join(s.root, "latest"), []byte(id)); err != nil {
		return nil, err
	}
	if err := maintenanceReserve(s.directory, "upgrade", id); err != nil {
		return nil, err
	}
	if err := s.host.Schedule(ctx, s.directory, id); err != nil {
		now := time.Now().UTC()
		record.Job.State, record.Job.Error, record.Job.FinishedAt = "failed", "The upgrade task could not be scheduled; the installation was not changed.", &now
		if writeErr := writePanelJSON(upgradeRecordPath(s.root, id), record); writeErr != nil {
			return nil, writeErr
		}
		_ = os.Remove(filepath.Join(maintenanceDir(s.directory), "active.json")) // gate is already held
		return nil, domain.Invalidf("%s", record.Job.Error)
	}
	return &record.Job, nil
}
