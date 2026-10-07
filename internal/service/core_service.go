package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type CoreRestartJob struct {
	ID          string     `json:"id"`
	State       string     `json:"state"`
	Actor       string     `json:"actor"`
	RequestedAt time.Time  `json:"requestedAt"`
	FinishedAt  *time.Time `json:"finishedAt,omitempty"`
	BeforePID   int        `json:"beforePid"`
	AfterPID    int        `json:"afterPid"`
	Error       string     `json:"error,omitempty"`
}

func (job *CoreRestartJob) active() bool {
	return job.State == "queued" || job.State == "checking" || job.State == "restarting" || job.State == "verifying"
}

type CoreStatus struct {
	CurrentVersion string          `json:"currentVersion,omitempty"`
	Supported      bool            `json:"supported"`
	Reason         string          `json:"reason,omitempty"`
	State          string          `json:"state"`
	PID            int             `json:"pid"`
	UptimeSeconds  int64           `json:"uptimeSeconds"`
	RestartJob     *CoreRestartJob `json:"restartJob,omitempty"`
}

// Launch parameters come only from the fixed local systemd unit, never HTTP.
type coreLaunch struct {
	Executable       string
	Arguments        []string
	WorkingDirectory string
	LockPath         string
}

type coreSnapshot struct {
	CoreStatus
	Launch       coreLaunch
	StartedMicro int64
}

type coreHost interface {
	Available() (bool, string)
	Info(context.Context) (coreSnapshot, error)
	Schedule(context.Context, string, string) error
	Validate(context.Context, coreLaunch) error
	Restart(context.Context) error
	Healthy(context.Context) error
	Logs(context.Context) ([]string, error)
}

type CoreService struct {
	mu        sync.Mutex
	directory string
	settings  *SettingService
	host      coreHost
	supported bool
	reason    string
}

func NewCoreService(settings *SettingService) *CoreService {
	host := systemdCoreHost{}
	supported, reason := host.Available()
	directory, _ := filepath.Abs(config.Dir())
	return &CoreService{directory: directory, settings: settings, host: host, supported: supported, reason: reason}
}

func coreRuntimeDir(directory string) string { return filepath.Join(directory, ".core-runtime") }
func coreJobPath(directory, id string) string {
	return filepath.Join(coreRuntimeDir(directory), "job-"+id+".json")
}

func readCoreRestart(directory, id string) (*CoreRestartJob, error) {
	if !panelJobID.MatchString(id) {
		return nil, domain.Invalidf("Invalid core restart task ID")
	}
	var job CoreRestartJob
	if err := readPanelJSON(coreJobPath(directory, id), &job); err != nil {
		return nil, err
	}
	if job.ID != id {
		return nil, fmt.Errorf("Core restart task ID does not match its record")
	}
	return &job, nil
}

func latestCoreRestart(directory string) (*CoreRestartJob, error) {
	data, err := os.ReadFile(filepath.Join(coreRuntimeDir(directory), "latest"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	job, err := readCoreRestart(directory, string(data))
	if err == nil && job.active() && time.Since(job.RequestedAt) > 3*time.Minute {
		job.State, job.Error = "failed", "The restart task was interrupted. Check the sing-box logs before retrying."
	}
	return job, err
}

func (s *CoreService) Status(ctx context.Context) CoreStatus {
	status := CoreStatus{State: "unavailable", Reason: s.reason}
	if s.supported {
		probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		snapshot, err := s.host.Info(probeCtx)
		if err != nil {
			status.State, status.Reason = "unknown", "The local sing-box service status could not be read."
		} else {
			status = snapshot.CoreStatus
		}
	}
	job, err := latestCoreRestart(s.directory)
	if err != nil {
		status.Supported, status.Reason = false, "The core restart task state could not be read."
	} else {
		status.RestartJob = job
	}
	return status
}

func (s *CoreService) Job(id string) (*CoreRestartJob, error) {
	job, err := readCoreRestart(s.directory, id)
	if os.IsNotExist(err) {
		return nil, domain.NotFoundf("Core restart task does not exist")
	}
	if err == nil && job.active() && time.Since(job.RequestedAt) > 3*time.Minute {
		job.State, job.Error = "failed", "The restart task was interrupted. Check the sing-box logs before retrying."
	}
	return job, err
}

func (s *CoreService) Queue(ctx context.Context, actor string) (*CoreRestartJob, error) {
	if !s.supported {
		return nil, domain.Invalidf("%s", s.reason)
	}
	gate, err := maintenanceGate(s.directory, "core", "")
	if err != nil {
		return nil, err
	}
	defer gate()
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := acquirePrivateLock(filepath.Join(coreRuntimeDir(s.directory), "queue.lock"))
	if err != nil {
		return nil, err
	}
	defer unlock()
	if job, err := latestCoreRestart(s.directory); err != nil {
		return nil, err
	} else if job != nil && job.active() {
		return job, nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	snapshot, err := s.host.Info(probeCtx)
	if err != nil {
		return nil, domain.Invalidf("The local sing-box service status could not be read")
	}
	if !snapshot.Supported {
		return nil, domain.Invalidf("%s", snapshot.Reason)
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	job := &CoreRestartJob{ID: hex.EncodeToString(id), State: "queued", Actor: actor, RequestedAt: time.Now().UTC()}
	if err := writePanelJSON(coreJobPath(s.directory, job.ID), job); err != nil {
		return nil, err
	}
	if err := writePanelPrivate(filepath.Join(coreRuntimeDir(s.directory), "latest"), []byte(job.ID)); err != nil {
		return nil, err
	}
	if err := maintenanceReserve(s.directory, "core", job.ID); err != nil {
		return nil, err
	}
	if err := s.host.Schedule(ctx, s.directory, job.ID); err != nil {
		job.State, job.Error = "failed", "The restart task could not be scheduled; sing-box was not restarted."
		now := time.Now().UTC()
		job.FinishedAt = &now
		_ = writePanelJSON(coreJobPath(s.directory, job.ID), job)
		_ = os.Remove(filepath.Join(maintenanceDir(s.directory), "active.json"))
		return nil, domain.Invalidf("%s", job.Error)
	}
	if s.settings != nil {
		AuditCoreRestart(ctx, s.settings, job)
	}
	return job, nil
}

func (s *CoreService) Logs(ctx context.Context) ([]string, error) {
	if !s.supported {
		return nil, domain.Invalidf("%s", s.reason)
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	lines, err := s.host.Logs(probeCtx)
	if err != nil {
		return nil, domain.Invalidf("The sing-box logs could not be read")
	}
	return lines, nil
}

func AuditCoreRestart(ctx context.Context, settings *SettingService, job *CoreRestartJob) {
	logChange(ctx, settings.store, job.Actor, "core-restart", job.State, job.ID)
}

func ReadCoreRestartResult(directory, id string) (*CoreRestartJob, error) {
	return readCoreRestart(directory, id)
}

func RunCoreRestart(ctx context.Context, directory, id string) error {
	return runCoreRestart(ctx, directory, id, systemdCoreHost{})
}

func runCoreRestart(ctx context.Context, directory, id string, host coreHost) error {
	execution, err := maintenanceExecute(directory, "core", id)
	if err != nil {
		return err
	}
	defer execution()
	defer func() {
		if job, err := readCoreRestart(directory, id); err == nil && !job.active() {
			_ = maintenanceRelease(directory, "core", id)
		}
	}()
	unlock, err := acquirePrivateLock(filepath.Join(coreRuntimeDir(directory), "execution.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	job, err := readCoreRestart(directory, id)
	if err != nil || !job.active() {
		return err
	}
	latest, err := latestCoreRestart(directory)
	if err != nil || latest == nil || latest.ID != id {
		return fmt.Errorf("Core restart task is not current")
	}
	write := func() error { return writePanelJSON(coreJobPath(directory, id), job) }
	finish := func(state, message string) error {
		now := time.Now().UTC()
		job.State, job.Error, job.FinishedAt = state, message, &now
		return write()
	}
	snapshot, err := host.Info(ctx)
	if err != nil || !snapshot.Supported {
		return finish("failed", "The local sing-box service cannot be managed. Check its installation and logs.")
	}
	// The agent's reload script holds the same lock before replacing the file
	// sing-box reads. Configuration downloads and traffic reports keep running.
	var configUnlock func()
	for {
		configUnlock, err = acquirePrivateLock(snapshot.Launch.LockPath)
		if err == nil {
			break
		}
		if !errors.Is(err, domain.ErrConflict) {
			return finish("failed", "The core configuration lock could not be acquired; sing-box was not restarted.")
		}
		select {
		case <-ctx.Done():
			return finish("failed", "The core configuration remained busy; sing-box was not restarted.")
		case <-time.After(250 * time.Millisecond):
		}
	}
	defer configUnlock()
	current, err := host.Info(ctx)
	if err != nil || !current.Supported || !reflect.DeepEqual(current.Launch, snapshot.Launch) {
		return finish("failed", "The sing-box launch configuration changed before the restart. Refresh before retrying.")
	}
	if job.State == "queued" || job.State == "checking" {
		job.State, job.BeforePID = "checking", current.PID
		if err := write(); err != nil {
			return err
		}
		if err := host.Validate(ctx, current.Launch); err != nil {
			return finish("failed", "The current sing-box configuration failed validation; the service was not restarted. View the sing-box logs or run its configuration check on the server.")
		}
		job.State = "restarting"
		if err := write(); err != nil {
			return err
		}
		if err := host.Restart(ctx); err != nil {
			return finish("failed", "sing-box could not be restarted. Check the core logs and service status.")
		}
	} else if current.PID == job.BeforePID {
		// A helper interrupted between persisting intent and calling systemctl
		// must not cause an additional disconnect or claim a restart happened.
		return finish("failed", "The restart task was interrupted before a new core process was confirmed. Check the logs before retrying.")
	}
	job.State = "verifying"
	if err := write(); err != nil {
		return err
	}
	for {
		probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		running, err := host.Info(probeCtx)
		ready := err == nil && running.State == "active" && running.PID > 0 && running.PID != job.BeforePID && reflect.DeepEqual(running.Launch, current.Launch)
		if ready {
			ready = host.Healthy(probeCtx) == nil
		}
		cancel()
		if ready {
			job.AfterPID = running.PID
			return finish("succeeded", "")
		}
		select {
		case <-ctx.Done():
			return finish("failed", "A new sing-box process and its statistics API could not be confirmed. Check the core logs and service status.")
		case <-time.After(500 * time.Millisecond):
		}
	}
}
