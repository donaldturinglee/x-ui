package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncOnceRequiresAWorkingPanelAndWritesItsConfig(t *testing.T) {
	ready := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "node-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if !ready {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"inbounds":[],"outbounds":[]}`))
	}))
	defer server.Close()

	dir := t.TempDir()
	corePath := filepath.Join(dir, "config.json")
	configPath := filepath.Join(dir, "agent.yaml")
	contents := "panel:\n  url: " + server.URL + "/apiv2\n  token: node-token\ncore:\n  config_path: " + corePath + "\nstats:\n  source: none\n"
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run(configPath, true); err == nil {
		t.Fatal("sync-once accepted a failed initial fetch")
	}
	ready = true
	if err := run(configPath, true); err != nil {
		t.Fatalf("sync-once: %v", err)
	}
	got, err := os.ReadFile(corePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), `"inbounds":[]`) {
		t.Errorf("core config = %s", got)
	}
}
