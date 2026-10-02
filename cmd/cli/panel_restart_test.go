package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
)

func TestRefreshNodePanelPreservesTokenCoreAndStatistics(t *testing.T) {
	directory := t.TempDir()
	original := "panel:\n  url: http://127.0.0.1:8000/apiv2\n  sync_interval: 45s\ncore:\n  config_path: keep-core.json\nstats:\n  source: sing-box\n  url: http://127.0.0.1:9091\nlog:\n  level: debug\n"
	environment := "X_UI_AGENT_PANEL_TOKEN=keep-private-token\nX_UI_AGENT_STATS_SECRET=keep-private-secret\nX_UI_AGENT_CORE_CONFIG_PATH=keep-override.json\nX_UI_AGENT_PANEL_URL=http://127.0.0.1:8000/apiv2\n"
	for name, value := range map[string]string{"agent.yaml": original, "agent.env": environment, "install-state.json": `{}`} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.Default()
	cfg.Server.Port, cfg.Server.BasePath, cfg.Server.Domain = 8088, "/control/", "panel.example"
	if err := refreshNodePanel(directory, cfg); err != nil {
		t.Fatal(err)
	}
	yaml, _ := os.ReadFile(filepath.Join(directory, "agent.yaml"))
	env, _ := os.ReadFile(filepath.Join(directory, "agent.env"))
	for _, expected := range []string{"http://127.0.0.1:8088/control/apiv2", "host: panel.example", "sync_interval: 45s", "keep-core.json", "http://127.0.0.1:9091", "level: debug"} {
		if !strings.Contains(string(yaml), expected) {
			t.Errorf("connection refresh lost %s", expected)
		}
	}
	for _, expected := range []string{"keep-private-token", "keep-private-secret", "X_UI_AGENT_CORE_CONFIG_PATH=keep-override.json"} {
		if !strings.Contains(string(env), expected) {
			t.Errorf("connection refresh changed %s", expected)
		}
	}
	if strings.Contains(string(env), "X_UI_AGENT_PANEL_URL=") {
		t.Fatal("old environment connection still overrides new URL")
	}
}

func TestRefreshNodePanelPreservesRemoteAgent(t *testing.T) {
	directory := t.TempDir()
	files := map[string]string{"agent.yaml": "panel:\n  url: https://remote.example/apiv2\n", "agent.env": "", "install-state.json": "{}"}
	for name, data := range files {
		_ = os.WriteFile(filepath.Join(directory, name), []byte(data), 0o600)
	}
	if err := refreshNodePanel(directory, config.Default()); err == nil {
		t.Fatal("remote agent overwritten")
	}
	for name, data := range files {
		after, _ := os.ReadFile(filepath.Join(directory, name))
		if string(after) != data {
			t.Fatalf("remote %s changed", name)
		}
	}
}

func TestRefreshNodePanelSupportsLegacyLocalAgentWithoutInstallState(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "agent.yaml"), []byte("panel:\n  url: http://127.0.0.1:8000/apiv2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := "X_UI_AGENT_PANEL_TOKEN=legacy-token\n"
	if err := os.WriteFile(filepath.Join(directory, "agent.env"), []byte(environment), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Server.BasePath = "/control/"
	if err := refreshNodePanel(directory, cfg); err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(filepath.Join(directory, "agent.yaml"))
	env, _ := os.ReadFile(filepath.Join(directory, "agent.env"))
	if !strings.Contains(string(contents), "/control/apiv2") || string(env) != environment {
		t.Fatal("legacy connection was not updated without changing its token")
	}
	if _, err := os.Stat(filepath.Join(directory, "install-state.json")); err != nil {
		t.Fatal("installer state was not created", err)
	}
}

func TestCLIHealthProbeUsesRootForCustomWebPath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/healthz" {
			t.Errorf("health probe path %s", req.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	cfg := config.Default()
	cfg.Server.Listen, cfg.Server.BasePath = host, "/control/"
	cfg.Server.Port, _ = strconv.Atoi(port)
	if err := probe(context.Background(), cfg.Server); err != nil {
		t.Fatal(err)
	}
}

func TestCheckNodePanelVerifiesConnectionWithoutCoreOrStatisticsSetup(t *testing.T) {
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Token") != "existing-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if req.URL.Path != "/control/apiv2/config/download" {
			t.Errorf("panel probe path = %s", req.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"services":[],"outbounds":[]}`))
	}))
	defer panel.Close()
	directory := t.TempDir()
	yaml := "panel:\n  url: " + panel.URL + "/control/apiv2\ncore:\n  config_path: missing-core.json\n"
	if err := os.WriteFile(filepath.Join(directory, "agent.yaml"), []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	envPath := filepath.Join(directory, "agent.env")
	if err := os.WriteFile(envPath, []byte("X_UI_AGENT_PANEL_TOKEN=existing-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkNodePanel(directory); err != nil {
		t.Fatal("legacy agent panel check failed", err)
	}
	if err := os.WriteFile(envPath, []byte("X_UI_AGENT_PANEL_TOKEN=wrong-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := checkNodePanel(directory); err == nil {
		t.Fatal("unauthenticated panel connection accepted")
	}
}
