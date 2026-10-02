package service

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type fakePanelHost struct {
	directory     string
	scheduled     int
	units         []string
	failPort      int
	failSchedule  bool
	duringRestart func()
}

func (*fakePanelHost) Available() (bool, string) { return true, "" }
func (host *fakePanelHost) Schedule(context.Context, string, string) error {
	host.scheduled++
	if host.failSchedule {
		return errors.New("supervisor unavailable")
	}
	return nil
}
func (host *fakePanelHost) Restart(_ context.Context, unit string) error {
	host.units = append(host.units, unit)
	if host.duringRestart != nil {
		host.duringRestart()
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if unit == "x-ui-api" && cfg.Server.Port == host.failPort {
		return errors.New("address in use")
	}
	kind := strings.TrimPrefix(unit, "x-ui-")
	return writePanelJSON(filepath.Join(panelRuntimeDir(host.directory), kind+".json"), PanelProcessRuntime{
		PID: 100 + len(host.units), StartedAt: time.Now().UTC(), Settings: panelSettingsOf(cfg),
	})
}
func (host *fakePanelHost) PID(_ context.Context, unit string) (int, error) {
	var process PanelProcessRuntime
	err := readPanelJSON(filepath.Join(panelRuntimeDir(host.directory), strings.TrimPrefix(unit, "x-ui-")+".json"), &process)
	return process.PID, err
}
func (*fakePanelHost) Healthy(context.Context, *config.Config) error { return nil }
func (host *fakePanelHost) RefreshAgent(context.Context) error {
	for _, name := range []string{"agent.yaml", "agent.env", "install-state.json"} {
		if err := writePanelPrivate(filepath.Join(host.AgentDirectory(), name), []byte("updated")); err != nil {
			return err
		}
	}
	return nil
}
func (*fakePanelHost) CheckAgent(context.Context) error { return nil }
func (host *fakePanelHost) AgentDirectory() string      { return filepath.Join(host.directory, "node") }

func restartFixture(t *testing.T) (*PanelSettingsService, *PanelRestartService, *fakePanelHost, string) {
	t.Helper()
	panel, path := panelSettingsFixture(t, "# retained\nserver:\n  port: 8000\ndatabase:\n  password: original-private-password\nsession:\n  secret: original-private-session\ncustom:\n  marker: keep\n")
	directory := filepath.Dir(path)
	cfg, _ := config.Load()
	for _, kind := range []string{"api", "worker"} {
		if err := RecordPanelProcess(kind, cfg); err != nil {
			t.Fatal(err)
		}
	}
	if err := CheckpointPanelConfiguration(cfg); err != nil {
		t.Fatal(err)
	}
	host := &fakePanelHost{directory: directory}
	restart := NewPanelRestartService(panel)
	restart.host, restart.supported, restart.reason = host, true, ""
	return panel, restart, host, path
}

func saveRestartFixture(t *testing.T, panel *PanelSettingsService, port int) PanelSettingsState {
	t.Helper()
	state, err := panel.Read()
	if err != nil {
		t.Fatal(err)
	}
	values := state.Saved
	values.Port = port
	state, err = panel.Save(context.Background(), "operator", state.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestPanelRestartQueuesOnceLocksSavesAndAppliesBothProcesses(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	state := saveRestartFixture(t, panel, 8001)
	job, err := restart.Queue(context.Background(), "operator", state.Revision)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := restart.Queue(context.Background(), "operator", state.Revision)
	if err != nil || duplicate.ID != job.ID || host.scheduled != 1 {
		t.Fatalf("duplicate task: %+v, %v", duplicate, err)
	}
	if _, err := panel.Save(context.Background(), "operator", state.Revision, state.Saved); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("save during queue = %v", err)
	}
	host.duringRestart = func() {
		if _, err := panel.Save(context.Background(), "operator", state.Revision, state.Saved); !errors.Is(err, domain.ErrConflict) {
			t.Errorf("cross-process save during restart = %v", err)
		}
	}
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, err := restart.Get(job.ID)
	if err != nil || finished.State != "succeeded" {
		t.Fatalf("result = %+v, %v", finished, err)
	}
	if !reflect.DeepEqual(host.units, []string{"x-ui-worker", "x-ui-api"}) {
		t.Fatalf("restarted services = %v", host.units)
	}
	cfg, _ := config.Load()
	if cfg.Server.Port != 8001 {
		t.Fatal("saved port was not applied")
	}
	if data, _ := os.ReadFile(filepath.Join(panelRuntimeDir(filepath.Dir(path)), "applied.yaml")); !strings.Contains(string(data), "8001") {
		t.Fatal("success did not advance checkpoint")
	}
	public, _ := json.Marshal(finished)
	if strings.Contains(string(public), "original-private") || strings.Contains(string(public), "environment") || strings.Contains(string(public), "before") {
		t.Fatal("restart response leaked private state")
	}
	before := len(host.units)
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil || len(host.units) != before {
		t.Fatal("completed task ran twice")
	}
}

func TestPanelRestartFailureRestoresOnlyPanelKeysAndKeepsLastAppliedCheckpoint(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	saveRestartFixture(t, panel, 8001)
	// An independently edited database credential must survive Panel rollback.
	data, _ := os.ReadFile(path)
	data = []byte(strings.ReplaceAll(string(data), "original-private-password", "new-private-password"))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	state, _ := panel.Read()
	values := state.Saved
	values.StatsRetentionSeconds = 86400
	state, err := panel.Save(context.Background(), "operator", state.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	job, err := restart.Queue(context.Background(), "operator", state.Revision)
	if err != nil {
		t.Fatal(err)
	}
	host.failPort = 8001
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := restart.Get(job.ID)
	if finished.State != "rolled_back" {
		t.Fatalf("result = %+v", finished)
	}
	cfg, _ := config.Load()
	if cfg.Server.Port != 8000 || cfg.Database.Password != "new-private-password" || cfg.Session.Secret != "original-private-session" {
		t.Fatal("rollback changed unrelated configuration or did not restore Panel")
	}
	if !reflect.DeepEqual(host.units, []string{"x-ui-worker", "x-ui-api", "x-ui-worker", "x-ui-api"}) {
		t.Fatalf("recovery services = %v", host.units)
	}
	contents, _ := os.ReadFile(path)
	if !strings.Contains(string(contents), "# retained") || !strings.Contains(string(contents), "marker: keep") {
		t.Fatal("recovery lost unrelated YAML")
	}
}

func TestPanelRestartRejectsStaleRevisionAndPreservesExternalEdits(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	state := saveRestartFixture(t, panel, 8001)
	if _, err := restart.Queue(context.Background(), "operator", strings.Repeat("0", 64)); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("stale queue = %v", err)
	}
	job, err := restart.Queue(context.Background(), "operator", state.Revision)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	data = []byte(strings.ReplaceAll(string(data), "8001", "8002"))
	_ = os.WriteFile(path, data, 0o600)
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := restart.Get(job.ID)
	if finished.State != "failed" || len(host.units) != 0 {
		t.Fatalf("external edit restarted services: %+v %v", finished, host.units)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(data) {
		t.Fatal("external edit was overwritten")
	}
	if _, err := restart.Get("../../config.yaml"); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("unsafe task ID = %v", err)
	}
}

func TestPanelRestartSchedulingFailureAllowsFurtherSaves(t *testing.T) {
	panel, restart, host, _ := restartFixture(t)
	state := saveRestartFixture(t, panel, 8001)
	host.failSchedule = true
	if _, err := restart.Queue(context.Background(), "operator", state.Revision); err == nil {
		t.Fatal("schedule failure accepted")
	}
	state.Saved.Port = 8002
	if _, err := panel.Save(context.Background(), "operator", state.Revision, state.Saved); err != nil {
		t.Fatal("schedule failure left form locked", err)
	}
}

func TestPanelRestartInterruptedHelperResumesRecovery(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	state := saveRestartFixture(t, panel, 8001)
	job, err := restart.Queue(context.Background(), "operator", state.Revision)
	if err != nil {
		t.Fatal(err)
	}
	record, _ := readPanelRestart(filepath.Dir(path), job.ID)
	record.Job.State = "running"
	_ = writePanelJSON(panelJobPath(filepath.Dir(path), job.ID), record)
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := restart.Get(job.ID)
	if finished.State != "rolled_back" {
		t.Fatalf("interrupted helper = %+v", finished)
	}
	cfg, _ := config.Load()
	if cfg.Server.Port != 8000 {
		t.Fatal("interrupted helper reapplied unsafe candidate")
	}
}

func TestPanelRestartRejectsStaleReadinessFiles(t *testing.T) {
	panel, _, host, path := restartFixture(t)
	cfg, _ := config.Load()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := waitPanelProcesses(ctx, filepath.Dir(path), host, cfg, time.Now().Add(time.Hour), false); err == nil {
		t.Fatal("old runtime files counted as restarted")
	}
	if _, err := panel.Read(); err != nil {
		t.Fatal(err)
	}
}

func TestPanelRestartRecoversLocalAgentConnectionFilesAndSkipsRemoteAgent(t *testing.T) {
	for _, mode := range []string{"local", "remote", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			remote := mode == "remote"
			panel, restart, host, path := restartFixture(t)
			nodeDir := host.AgentDirectory()
			_ = os.MkdirAll(nodeDir, 0o700)
			target := "http://127.0.0.1:8000/apiv2"
			if remote {
				target = "https://remote.example/apiv2"
			}
			files := map[string]string{"agent.yaml": "panel:\n  url: " + target + "\n", "agent.env": "X_UI_AGENT_PANEL_TOKEN=private-unchanged\n", "install-state.json": `{"panel_url":"http://127.0.0.1:8000/apiv2"}`}
			if mode == "legacy" {
				delete(files, "install-state.json")
			}
			for name, data := range files {
				_ = os.WriteFile(filepath.Join(nodeDir, name), []byte(data), 0o600)
			}
			state := saveRestartFixture(t, panel, 8001)
			job, err := restart.Queue(context.Background(), "operator", state.Revision)
			if err != nil {
				t.Fatal(err)
			}
			host.failPort = 8001
			if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
				t.Fatal(err)
			}
			finished, _ := restart.Get(job.ID)
			if finished.State != "rolled_back" {
				t.Fatalf("agent recovery = %+v", finished)
			}
			for name, data := range files {
				after, _ := os.ReadFile(filepath.Join(nodeDir, name))
				if string(after) != data {
					t.Fatalf("agent %s was not preserved", name)
				}
			}
			if mode == "legacy" {
				if _, err := os.Stat(filepath.Join(nodeDir, "install-state.json")); !os.IsNotExist(err) {
					t.Fatal("recovery left installer state that the legacy agent never had")
				}
			}
			foundAgent := false
			for _, unit := range host.units {
				if unit == "x-ui-agent" {
					foundAgent = true
				}
				if unit == "sing-box" {
					t.Fatal("core restarted")
				}
			}
			if foundAgent == remote {
				t.Fatal("agent restart scope did not respect the managed connection")
			}
		})
	}
}

func TestPanelSettingsLocksWorkerEnvironmentOverrides(t *testing.T) {
	panel, _, _, path := restartFixture(t)
	var worker PanelProcessRuntime
	_ = readPanelJSON(filepath.Join(panelRuntimeDir(filepath.Dir(path)), "worker.json"), &worker)
	worker.Overrides = map[string]string{"logLevel": "X_UI_LOG_LEVEL", "port": "X_UI_SERVER_PORT"}
	_ = writePanelJSON(filepath.Join(panelRuntimeDir(filepath.Dir(path)), "worker.json"), worker)
	state, _ := panel.Read()
	if state.Overrides["logLevel"] != "X_UI_LOG_LEVEL (worker)" || state.Overrides["port"] != "" {
		t.Fatalf("worker overrides = %v", state.Overrides)
	}
	values := state.Saved
	values.LogLevel = "warning"
	if _, err := panel.Save(context.Background(), "operator", state.Revision, values); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("worker override changed: %v", err)
	}
}

func TestPanelRestartHealthUsesRootPathWithCustomWebPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/healthz" || req.Host != "panel.example" {
			t.Errorf("health probe = %s %s", req.Host, req.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	cfg := config.Default()
	cfg.Server.Listen, cfg.Server.Domain, cfg.Server.BasePath = host, "panel.example", "/control/"
	cfg.Server.Port, _ = strconv.Atoi(port)
	if err := (systemdPanelHost{}).Healthy(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
}
