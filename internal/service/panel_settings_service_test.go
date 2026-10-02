package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

func panelSettingsFixture(t *testing.T, body string) (*PanelSettingsService, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("X_UI_CONFIG_DIR", dir)
	path := filepath.Join(dir, "config.yaml")
	if body != "" {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	return NewPanelSettingsService(nil, cfg), path
}

func TestPanelSettingsSavePersistsOnlyEditsAndSeparatesRunningValues(t *testing.T) {
	s, path := panelSettingsFixture(t, "# keep this comment\ndatabase:\n  password: keep-database-secret\nsession:\n  secret: keep-session-secret\nserver:\n  port: 8000 # keep port comment\n  read_timeout: 17s\ncustom:\n  marker: untouched\n")
	before, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	values := before.Saved
	values.Port = 8001
	values.BasePath = "panel/nested"
	values.MaxAgeSeconds = 90
	values.StatsRetentionSeconds = 129600
	values.TrustedProxies = []string{"127.0.0.1", "10.0.0.0/8"}
	values.ResetSpec = "Off"
	after, err := s.Save(context.Background(), "operator", before.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	if !after.RestartRequired || after.Running.Port != 8000 || after.Saved.Port != 8001 || after.Saved.BasePath != "/panel/nested/" {
		t.Fatalf("saved/running state is wrong: %+v", after)
	}
	if before.Revision == after.Revision {
		t.Fatal("save did not advance the file revision")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Session.Secret != "keep-session-secret" || cfg.Database.Password != "keep-database-secret" || cfg.Server.ReadTimeout.Duration() != 17*time.Second {
		t.Fatal("save changed options outside the Panel form")
	}
	if cfg.Session.MaxAge.Duration() != 90*time.Second || cfg.Worker.StatsRetention.Duration() != 36*time.Hour {
		t.Fatal("durations did not survive a reload")
	}
	contents, _ := os.ReadFile(path)
	for _, want := range []string{"keep this comment", "keep port comment", "marker: untouched"} {
		if !strings.Contains(string(contents), want) {
			t.Errorf("file lost %q", want)
		}
	}
	encoded, _ := json.Marshal(after)
	if strings.Contains(string(encoded), "keep-database-secret") || strings.Contains(string(encoded), "keep-session-secret") {
		t.Fatal("Panel endpoint exposed a secret")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("file permissions = %o, want 600", info.Mode().Perm())
		}
	}
	restarted, err := NewPanelSettingsService(nil, cfg).Read()
	if err != nil || restarted.RestartRequired {
		t.Fatalf("restarted process still reports pending settings: %+v, %v", restarted, err)
	}
}

func TestPanelSettingsEnvironmentOverridesAreLockedAndNotWrittenBack(t *testing.T) {
	t.Setenv("X_UI_SERVER_PORT", "9000")
	s, path := panelSettingsFixture(t, "server:\n  port: 8000\n")
	before, _ := s.Read()
	if before.Saved.Port != 9000 || before.Overrides["port"] != "X_UI_SERVER_PORT" {
		t.Fatalf("override is not described: %+v", before)
	}
	values := before.Saved
	values.Port = 9001
	if _, err := s.Save(context.Background(), "operator", before.Revision, values); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("overridden field accepted: %v", err)
	}
	values.Port = 9000
	values.MaxAgeSeconds = 60
	if _, err := s.Save(context.Background(), "operator", before.Revision, values); err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(path)
	if !strings.Contains(string(contents), "port: 8000") || strings.Contains(string(contents), "9000") {
		t.Fatal("environment value was written into the file")
	}
}

func TestPanelSettingsInvalidInputDoesNotChangeTheFile(t *testing.T) {
	cases := map[string]func(*PanelSettings){
		"port":                        func(p *PanelSettings) { p.Port = 0 },
		"web path":                    func(p *PanelSettings) { p.BasePath = "/../panel/" },
		"domain":                      func(p *PanelSettings) { p.Domain = "https://panel.example" },
		"certificate pair":            func(p *PanelSettings) { p.KeyFile = "missing.key" },
		"unreadable certificate":      func(p *PanelSettings) { p.KeyFile, p.CertFile = "missing.key", "missing.pem" },
		"proxy":                       func(p *PanelSettings) { p.TrustedProxies = []string{"everyone"} },
		"session":                     func(p *PanelSettings) { p.MaxAgeSeconds = -1 },
		"duration overflow":           func(p *PanelSettings) { p.StatsRetentionSeconds = 1 << 62 },
		"bucket":                      func(p *PanelSettings) { p.StatsBucketSeconds = 0 },
		"zone":                        func(p *PanelSettings) { p.TimeLocation = "not/a/zone" },
		"cron":                        func(p *PanelSettings) { p.ResetSpec = "tomorrow morning" },
		"log":                         func(p *PanelSettings) { p.LogLevel = "silent" },
		"subscription port collision": func(p *PanelSettings) { p.Port = 8443 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, path := panelSettingsFixture(t, "server:\n  port: 8000\n")
			state, _ := s.Read()
			before, _ := os.ReadFile(path)
			values := state.Saved
			change(&values)
			if _, err := s.Save(context.Background(), "operator", state.Revision, values); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("invalid input accepted: %v", err)
			}
			after, _ := os.ReadFile(path)
			if string(after) != string(before) {
				t.Fatal("invalid save changed the file")
			}
		})
	}
}

func TestPanelSettingsRejectsStaleEditsAndSerialisesConcurrentSaves(t *testing.T) {
	s, path := panelSettingsFixture(t, "server:\n  port: 8000\n")
	state, _ := s.Read()
	if err := os.WriteFile(path, []byte("server:\n  port: 8100\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	values := state.Saved
	values.Port = 8200
	if _, err := s.Save(context.Background(), "operator", state.Revision, values); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("stale edit accepted: %v", err)
	}
	state, _ = s.Read()
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, port := range []int{8300, 8400} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			values := state.Saved
			values.Port = port
			_, err := s.Save(context.Background(), "operator", state.Revision, values)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, domain.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent saves: successes %d, conflicts %d", successes, conflicts)
	}
}

func TestPanelSettingsCanCreateAnAbsentConfigFile(t *testing.T) {
	s, _ := panelSettingsFixture(t, "")
	state, err := s.Read()
	if err != nil {
		t.Fatal(err)
	}
	values := state.Saved
	values.Port = 8100
	if _, err := s.Save(context.Background(), "operator", state.Revision, values); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil || cfg.Server.Port != 8100 {
		t.Fatalf("created config did not load: %v", err)
	}
}
