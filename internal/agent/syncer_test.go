package agent

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSyncerChildProcess(t *testing.T) {
	if os.Getenv("X_UI_TEST_SYNC_HELPER") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	args = args[1:]
	if args[0] == "check" {
		content, err := os.ReadFile(args[1])
		if err != nil || bytes.Contains(content, []byte(`"invalid"`)) {
			os.Exit(7)
		}
		os.Exit(0)
	}
	log, err := os.OpenFile(args[3], os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		os.Exit(8)
	}
	_, _ = log.WriteString("reload\n")
	_ = log.Close()
	if _, err := os.Stat(args[4]); err == nil {
		os.Exit(9)
	}
	content, err := os.ReadFile(args[1])
	if err != nil || os.WriteFile(args[2], content, 0o600) != nil {
		os.Exit(10)
	}
	os.Exit(0)
}

func syncFixture(t *testing.T, document string) (*Syncer, string, string, string, string) {
	t.Helper()
	t.Setenv("X_UI_TEST_SYNC_HELPER", "1")
	directory := t.TempDir()
	staging, applied := filepath.Join(directory, "staging.json"), filepath.Join(directory, "applied.json")
	log, fail := filepath.Join(directory, "reload.log"), filepath.Join(directory, "fail")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/config/download" || r.Header.Get("Token") != "test-token" {
			t.Errorf("unexpected configuration request: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(server.Close)
	command := []string{os.Args[0], "-test.run=^TestSyncerChildProcess$", "--"}
	cfg := CoreConfig{
		ConfigPath: staging, AppliedConfigPath: applied,
		CheckCommand:  append(append([]string{}, command...), "check", "{config}"),
		ReloadCommand: append(append([]string{}, command...), "reload", staging, applied, log, fail),
		ReloadTimeout: Duration(10 * time.Second),
	}
	return NewSyncer(NewPanelClient(PanelConfig{URL: server.URL, Token: "test-token", Timeout: Duration(time.Second)}), cfg), staging, applied, log, fail
}

func TestSyncerChecksBeforeReplacingConfiguration(t *testing.T) {
	syncer, staging, applied, log, _ := syncFixture(t, `{"invalid":true}`)
	previous := []byte(`{"previous":true}`)
	for _, path := range []string{staging, applied} {
		if err := os.WriteFile(path, previous, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := syncer.Sync(context.Background()); err == nil || !strings.Contains(err.Error(), "configuration check failed") {
		t.Fatalf("invalid candidate accepted: %v", err)
	}
	for _, path := range []string{staging, applied} {
		got, _ := os.ReadFile(path)
		if !bytes.Equal(got, previous) {
			t.Fatalf("invalid candidate replaced %s", path)
		}
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("reload ran before validation passed")
	}
}

func TestSyncerRestoresAndRetriesFailedReload(t *testing.T) {
	syncer, staging, applied, log, fail := syncFixture(t, `{"new":true}`)
	previous := []byte(`{"previous":true}`)
	_ = os.WriteFile(staging, previous, 0o600)
	_ = os.WriteFile(applied, previous, 0o600)
	_ = os.WriteFile(fail, nil, 0o600)
	if _, err := syncer.Sync(context.Background()); err == nil {
		t.Fatal("failed reload accepted")
	}
	for _, path := range []string{staging, applied} {
		got, _ := os.ReadFile(path)
		if !bytes.Equal(got, previous) {
			t.Fatal("failed reload discarded the previous configuration")
		}
	}
	_ = os.Remove(fail)
	if changed, err := syncer.Sync(context.Background()); err != nil || !changed {
		t.Fatalf("failed reload was not retried: changed=%v err=%v", changed, err)
	}
	if changed, err := syncer.Sync(context.Background()); err != nil || changed {
		t.Fatalf("unchanged configuration reloaded: changed=%v err=%v", changed, err)
	}
	got, _ := os.ReadFile(log)
	if string(got) != "reload\nreload\n" {
		t.Fatalf("reload attempts: %q", got)
	}
}

func TestSyncerStartupComparesAppliedConfiguration(t *testing.T) {
	syncer, staging, applied, log, _ := syncFixture(t, `{"new":true}`)
	_ = os.WriteFile(staging, []byte(`{"new":true}`), 0o600)
	_ = os.WriteFile(applied, []byte(`{"old":true}`), 0o600)
	if changed, err := syncer.Sync(context.Background()); err != nil || !changed {
		t.Fatalf("unapplied staging configuration skipped on restart: %v", err)
	}
	restarted := NewSyncer(syncer.client, syncer.cfg)
	if changed, err := restarted.Sync(context.Background()); err != nil || changed {
		t.Fatalf("successfully applied configuration reloaded on restart: %v", err)
	}
	got, _ := os.ReadFile(log)
	if string(got) != "reload\n" {
		t.Fatalf("reload attempts: %q", got)
	}
}

func TestSyncerRestoresMissingStagingFileWithoutReload(t *testing.T) {
	syncer, staging, applied, log, _ := syncFixture(t, `{"current":true}`)
	_ = os.WriteFile(applied, []byte(`{"current":true}`), 0o600)
	if changed, err := syncer.Sync(context.Background()); err != nil || changed {
		t.Fatalf("current core reloaded to repair staging: changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(staging)
	if err != nil || string(got) != `{"current":true}` {
		t.Fatal("missing staging configuration was not repaired")
	}
	if _, err := os.Stat(log); !os.IsNotExist(err) {
		t.Fatal("repairing staging unnecessarily reloaded the core")
	}
}
