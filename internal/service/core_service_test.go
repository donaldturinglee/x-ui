package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

type fakeCoreHost struct {
	snapshot      coreSnapshot
	restarts      int
	schedules     int
	validationErr bool
	scheduleErr   bool
	restartErr    bool
	stalePID      bool
	unhealthy     bool
}

func (*fakeCoreHost) Available() (bool, string) { return true, "" }
func (host *fakeCoreHost) Info(context.Context) (coreSnapshot, error) {
	return host.snapshot, nil
}
func (host *fakeCoreHost) Schedule(context.Context, string, string) error {
	host.schedules++
	if host.scheduleErr {
		return errors.New("scheduling failed")
	}
	return nil
}
func (host *fakeCoreHost) Validate(context.Context, coreLaunch) error {
	if host.validationErr {
		return errors.New("a private config value must not reach the API")
	}
	return nil
}
func (host *fakeCoreHost) Restart(context.Context) error {
	host.restarts++
	if host.restartErr {
		return errors.New("service failed")
	}
	if !host.stalePID {
		host.snapshot.PID++
		host.snapshot.StartedMicro++
	}
	return nil
}
func (host *fakeCoreHost) Healthy(context.Context) error {
	if host.unhealthy {
		return errors.New("statistics not ready")
	}
	return nil
}
func (*fakeCoreHost) Logs(context.Context) ([]string, error) { return []string{"core log"}, nil }

func coreFixture(t *testing.T) (*CoreService, *fakeCoreHost) {
	t.Helper()
	directory := t.TempDir()
	host := &fakeCoreHost{snapshot: coreSnapshot{CoreStatus: CoreStatus{Supported: true, State: "active", PID: 77, UptimeSeconds: 60},
		Launch: coreLaunch{Executable: "/usr/bin/sing-box", Arguments: []string{"-C", "/etc/sing-box", "run"}, LockPath: filepath.Join(directory, "core", ".x-ui-core.lock")}, StartedMicro: 100}}
	return &CoreService{directory: directory, supported: true, host: host}, host
}

func TestCoreRestartQueuesOnceVerifiesNewProcessAndKeepsConfiguration(t *testing.T) {
	s, host := coreFixture(t)
	path := filepath.Join(s.directory, "config.yaml")
	contents := []byte("server:\n  port: 8001 # saved but not applied\n")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	job, err := s.Queue(context.Background(), "operator")
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Queue(context.Background(), "another operator")
	if err != nil || again.ID != job.ID || host.schedules != 1 {
		t.Fatal("duplicate request scheduled another restart", err)
	}
	if err := runCoreRestart(context.Background(), s.directory, job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := s.Job(job.ID)
	if finished.State != "succeeded" || finished.BeforePID != 77 || finished.AfterPID != 78 || finished.FinishedAt == nil || host.restarts != 1 {
		t.Fatalf("restart = %+v, count = %d", finished, host.restarts)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(contents) {
		t.Fatal("core restart changed pending Panel configuration")
	}
	if err := runCoreRestart(context.Background(), s.directory, job.ID, host); err != nil || host.restarts != 1 {
		t.Fatal("completed task restarted the service again")
	}
}

func TestCoreRestartValidationFailureLeavesRunningProcessAlone(t *testing.T) {
	s, host := coreFixture(t)
	job, _ := s.Queue(context.Background(), "operator")
	host.validationErr = true
	if err := runCoreRestart(context.Background(), s.directory, job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := s.Job(job.ID)
	if finished.State != "failed" || host.restarts != 0 || host.snapshot.PID != 77 || strings.Contains(finished.Error, "private config value") {
		t.Fatalf("validation failure = %+v", finished)
	}
}

func TestCoreRestartCoordinatesWithAgentApplication(t *testing.T) {
	s, host := coreFixture(t)
	job, _ := s.Queue(context.Background(), "operator")
	unlock, err := acquirePrivateLock(host.snapshot.Launch.LockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := runCoreRestart(ctx, s.directory, job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := s.Job(job.ID)
	if finished.State != "failed" || host.restarts != 0 {
		t.Fatal("agent configuration lock did not block restart")
	}
}

func TestCoreRestartRequiresPIDChangeAndNativeAPIReadiness(t *testing.T) {
	for _, mode := range []string{"stale", "unhealthy", "restart-error"} {
		t.Run(mode, func(t *testing.T) {
			s, host := coreFixture(t)
			job, _ := s.Queue(context.Background(), "operator")
			host.stalePID, host.unhealthy, host.restartErr = mode == "stale", mode == "unhealthy", mode == "restart-error"
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
			defer cancel()
			if err := runCoreRestart(ctx, s.directory, job.ID, host); err != nil {
				t.Fatal(err)
			}
			finished, _ := s.Job(job.ID)
			if finished.State != "failed" || host.restarts != 1 {
				t.Fatalf("unready process = %+v", finished)
			}
		})
	}
}

func TestCoreRestartInterruptedHelperDoesNotDisconnectTwice(t *testing.T) {
	for _, alreadyRestarted := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-command", true: "after-command"}[alreadyRestarted], func(t *testing.T) {
			s, host := coreFixture(t)
			job, _ := s.Queue(context.Background(), "operator")
			job.State, job.BeforePID = "restarting", 77
			_ = writePanelJSON(coreJobPath(s.directory, job.ID), job)
			if alreadyRestarted {
				host.snapshot.PID = 78
			}
			if err := runCoreRestart(context.Background(), s.directory, job.ID, host); err != nil {
				t.Fatal(err)
			}
			finished, _ := s.Job(job.ID)
			if host.restarts != 0 || (finished.State == "succeeded") != alreadyRestarted {
				t.Fatalf("interrupted restart = %+v, count = %d", finished, host.restarts)
			}
		})
	}
}

func TestCoreRestartSchedulingFailureCanBeRetriedAndRejectsUnsafeIDs(t *testing.T) {
	s, host := coreFixture(t)
	host.scheduleErr = true
	if _, err := s.Queue(context.Background(), "operator"); err == nil {
		t.Fatal("schedule failure accepted")
	}
	if status := s.Status(context.Background()); status.RestartJob == nil || status.RestartJob.State != "failed" {
		t.Fatal("failed scheduling left the card busy")
	}
	host.scheduleErr = false
	if _, err := s.Queue(context.Background(), "operator"); err != nil {
		t.Fatal("schedule failure prevented retry", err)
	}
	if _, err := s.Job("../../config.yaml"); !errors.Is(err, domain.ErrInvalid) {
		t.Fatal("unsafe task path accepted", err)
	}
	if _, err := s.Job(strings.Repeat("a", 32)); !errors.Is(err, domain.ErrNotFound) {
		t.Fatal("missing task was not a 404", err)
	}
}

func TestCoreLaunchUsesExactServiceConfigurationAndRejectsOtherCommands(t *testing.T) {
	value := "{ path=/usr/bin/sing-box ; argv[]=/usr/bin/sing-box -D /var/lib/sing-box -C /etc/sing-box run ; ignore_errors=no ; }"
	launch, err := parseCoreLaunch(value, "")
	if err != nil || launch.LockPath != "/etc/sing-box/.x-ui-core.lock" || !reflect.DeepEqual(launch.Arguments, []string{"-D", "/var/lib/sing-box", "-C", "/etc/sing-box", "run"}) {
		t.Fatal("actual service arguments were not retained", launch, err)
	}
	for _, args := range []string{
		"/bin/sh -c /tmp/script run", "/usr/bin/sing-box -C relative run",
		"/usr/bin/sing-box -C /etc/../private run", "/usr/bin/sing-box -C /etc/sing-box;touch /tmp/file run",
		"/usr/bin/sing-box -C /etc/sing-box -c /tmp/another.json run", "/usr/bin/sing-box -C /etc/sing-box check",
	} {
		if _, err := parseCoreLaunch("{ argv[]="+args+" ; }", ""); err == nil {
			t.Fatalf("unsupported command accepted: %s", args)
		}
	}
}
