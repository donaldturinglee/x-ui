package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/agent"
	"github.com/donaldturinglee/x-ui/internal/config"
	"gopkg.in/yaml.v3"
)

func TestNativeStatsPreservesBaseAndReusesSecret(t *testing.T) {
	base := []byte(`{"route":{"final":"direct"},"dns":{"servers":[]},"services":[{"type":"resolved","tag":"other","listen":"127.0.0.1"}]}`)
	first, statsURL, secret, err := prepareNativeStats(base, "")
	if err != nil || statsURL != "http://127.0.0.1:9091" || len(secret) != 64 {
		t.Fatalf("bootstrap: %s %v", statsURL, err)
	}
	second, _, reused, err := prepareNativeStats(first, "different-saved-secret")
	if err != nil || reused != secret || !reflect.DeepEqual(jsonValue(first), jsonValue(second)) {
		t.Fatalf("repeated bootstrap changed native API or secret: %v", err)
	}
	var before, after map[string]json.RawMessage
	_ = json.Unmarshal(base, &before)
	_ = json.Unmarshal(first, &after)
	for _, key := range []string{"route", "dns"} {
		if !reflect.DeepEqual(jsonValue(before[key]), jsonValue(after[key])) {
			t.Fatalf("bootstrap changed %s", key)
		}
	}
	var services []map[string]interface{}
	_ = json.Unmarshal(after["services"], &services)
	if len(services) != 2 || services[0]["tag"] != "other" || services[1]["secret"] != secret {
		t.Fatal("bootstrap discarded existing core services")
	}
}

func TestNativeStatsRefusesUnsafeManagedService(t *testing.T) {
	for _, base := range []string{
		`{"services":[{"tag":"x-ui-stats-api","type":"api","listen":"0.0.0.0","listen_port":9091}]}`,
		`{"services":[{"tag":"x-ui-stats-api","type":"resolved","listen":"127.0.0.1","listen_port":9091}]}`,
		`{"services":[{"tag":"x-ui-stats-api","type":"api","listen":"127.0.0.1","listen_port":9091,"tls":{"enabled":true}}]}`,
	} {
		if _, _, _, err := prepareNativeStats([]byte(base), ""); err == nil {
			t.Fatal("unsafe managed API service accepted")
		}
	}
}

func TestNodeDocumentRefreshesPanelAndPreservesCustomSettings(t *testing.T) {
	document := map[string]interface{}{
		"panel": map[string]interface{}{"url": "http://127.0.0.1:8000/apiv2", "sync_interval": "45s", "report_interval": "7s"},
		"log":   map[string]interface{}{"level": "debug"},
	}
	panel := config.Default()
	panel.Server.Port, panel.Server.Domain, panel.Server.BasePath = 8088, "panel.example.com", "/panel/"
	panel.Server.CertFile, panel.Server.KeyFile = "cert.pem", "key.pem"
	updated, state, err := prepareNodeDocument(document, nodeInstallState{}, panel, "http://127.0.0.1:9091", t.TempDir())
	if err != nil || state.PanelURL != "https://127.0.0.1:8088/panel/apiv2" {
		t.Fatalf("panel refresh: %v %v", state, err)
	}
	section := updated["panel"].(map[string]interface{})
	if section["host"] != "panel.example.com" || section["insecure_skip_verify"] != false || section["sync_interval"] != "45s" || section["report_interval"] != "7s" || updated["log"].(map[string]interface{})["level"] != "debug" {
		t.Fatal("node setup discarded operator settings")
	}
	content, err := yaml.Marshal(updated)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "agent.yaml")
	_ = os.WriteFile(path, content, 0o600)
	cfg, err := agent.LoadWithEnvironment(path, map[string]string{"X_UI_AGENT_PANEL_TOKEN": "token", "X_UI_AGENT_STATS_SECRET": "secret"})
	if err != nil || cfg.Stats.Source != "sing-box" || len(cfg.Core.CheckCommand) == 0 || cfg.Panel.SyncInterval.Duration().Seconds() != 45 {
		t.Fatalf("generated agent configuration cannot load: %v", err)
	}
}

func TestNodeEnvironmentPreservesOverridesAndTreatsSecretsLiterally(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	_ = os.WriteFile(path, []byte("# operator setting\nX_UI_AGENT_SYNC_INTERVAL=45s\nX_UI_AGENT_PANEL_TOKEN=old\nX_UI_AGENT_PANEL_URL=http://127.0.0.1:8000/apiv2\nX_UI_AGENT_STATS_SOURCE=none\nX_UI_AGENT_CORE_RELOAD_COMMAND=old-command\n"), 0o600)
	secret := `literal $(touch never) "quoted" + value`
	if err := updateNodeEnvironment(path, map[string]string{"X_UI_AGENT_PANEL_TOKEN": "new", "X_UI_AGENT_STATS_SECRET": secret}); err != nil {
		t.Fatal(err)
	}
	values, err := readNodeEnvironment(path)
	if err != nil || values["X_UI_AGENT_STATS_SECRET"] != secret || values["X_UI_AGENT_PANEL_TOKEN"] != "new" || values["X_UI_AGENT_SYNC_INTERVAL"] != "45s" {
		t.Fatalf("environment round trip failed: %v", err)
	}
	for _, key := range []string{"X_UI_AGENT_PANEL_URL", "X_UI_AGENT_STATS_SOURCE", "X_UI_AGENT_CORE_RELOAD_COMMAND"} {
		if _, present := values[key]; present {
			t.Fatalf("stale managed environment override retained: %s", key)
		}
	}
	content, _ := os.ReadFile(path)
	if !strings.Contains(string(content), "# operator setting") {
		t.Fatal("operator environment comments discarded")
	}
}

func TestNodeCheckAcceptsEmptyStatisticsWithoutTraffic(t *testing.T) {
	document := []byte(`{"services":[],"outbounds":[]}`)
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Token") != "test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write(document)
	}))
	defer panel.Close()
	stats := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" || r.URL.Path != "/daemon.StartedService/SubscribeConnections" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/grpc-web+proto")
		_, _ = w.Write([]byte{0, 0, 0, 0, 0})
	}))
	defer stats.Close()
	directory := t.TempDir()
	staging, applied := filepath.Join(directory, "config.json"), filepath.Join(directory, "applied.json")
	_ = os.WriteFile(staging, document, 0o600)
	_ = os.WriteFile(applied, document, 0o600)
	config := map[string]interface{}{
		"panel": map[string]interface{}{"url": panel.URL},
		"core":  map[string]interface{}{"config_path": staging, "applied_config_path": applied},
		"stats": map[string]interface{}{"source": "sing-box", "url": stats.URL},
	}
	content, _ := yaml.Marshal(config)
	_ = os.WriteFile(filepath.Join(directory, "agent.yaml"), content, 0o600)
	if err := updateNodeEnvironment(filepath.Join(directory, "agent.env"), map[string]string{"X_UI_AGENT_PANEL_TOKEN": "test-token", "X_UI_AGENT_STATS_SECRET": "test-secret"}); err != nil {
		t.Fatal(err)
	}
	if err := checkNode(directory); err != nil {
		t.Fatalf("empty statistics check requires proxy traffic: %v", err)
	}
	_ = os.WriteFile(applied, []byte(`{"different":true}`), 0o600)
	if err := checkNode(directory); err == nil {
		t.Fatal("configuration mismatch accepted")
	}
}

func TestBackupConnectionKeepsPasswordsOutOfArguments(t *testing.T) {
	for _, database := range []config.DatabaseConfig{
		{URL: "postgres://operator:private%2Bpassword@db.example.com/x_ui?sslmode=require"},
		{URL: "postgres://operator@db.example.com/x_ui?password=private%2Bpassword&sslmode=require"},
		{Host: "::1", Port: 5432, User: "operator", Password: "private+password", Name: "x_ui", SSLMode: "require"},
	} {
		connection, password, err := backupConnection(database)
		if err != nil || password != "private+password" || strings.Contains(connection, "password") || !strings.Contains(connection, "sslmode=require") {
			t.Fatalf("unsafe backup connection: %s %v", connection, err)
		}
	}
}
