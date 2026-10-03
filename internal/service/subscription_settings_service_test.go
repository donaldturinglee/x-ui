package service

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
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

func TestSubscriptionSettingsSavePreservesOtherConfigurationAndTracksPendingChanges(t *testing.T) {
	panel, path := panelSettingsFixture(t, "# retained\nserver:\n  port: 8000\nsubscription:\n  port: 8443 # subscription port\n  read_timeout: 17s\ndatabase:\n  password: private-database\nsession:\n  secret: private-session\ncustom:\n  marker: keep\n")
	sub := NewSubscriptionSettingsService(panel)
	before, err := sub.Read()
	if err != nil {
		t.Fatal(err)
	}
	values := before.Saved
	values.Port, values.BasePath = 9443, "nested/sub"
	values.PublicURL, values.TrustedProxies = " https://sub.example/proxy/ ", []string{" 127.0.0.1 ", "10.0.0.0/8"}
	after, err := sub.Save(context.Background(), "operator", before.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	if after.Running.Port != 8443 || after.Saved.Port != 9443 || after.Saved.BasePath != "/nested/sub/" || after.Revision == before.Revision || !reflect.DeepEqual(after.PendingScopes, []string{"subscription"}) {
		t.Fatalf("state = %+v", after)
	}
	if after.Saved.PublicBase("panel.example") != "https://sub.example/proxy/nested/sub/" {
		t.Fatal("public URI does not preserve proxy prefix")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 8000 || cfg.Database.Password != "private-database" || cfg.Session.Secret != "private-session" || cfg.Subscription.ReadTimeout.Duration() != 17*time.Second {
		t.Fatal("save changed unrelated values")
	}
	data, _ := os.ReadFile(path)
	for _, text := range []string{"# retained", "# subscription port", "marker: keep"} {
		if !strings.Contains(string(data), text) {
			t.Fatalf("lost %s", text)
		}
	}
	public, _ := json.Marshal(after)
	if strings.Contains(string(public), "private-") {
		t.Fatal("response leaked private configuration")
	}
	panelState, _ := panel.Read()
	if panelState.Revision != after.Revision || !panelState.RestartRequired {
		t.Fatal("forms do not share revision/pending state")
	}
	if _, err := panel.Save(context.Background(), "operator", before.Revision, panelState.Saved); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("stale cross-page revision = %v", err)
	}
}

func TestSubscriptionSettingsRejectInvalidOrEnvironmentControlledValues(t *testing.T) {
	panel, path := panelSettingsFixture(t, "server:\n  listen: 127.0.0.1\n  port: 8000\n")
	sub := NewSubscriptionSettingsService(panel)
	state, _ := sub.Read()
	original, _ := os.ReadFile(path)
	cases := map[string]func(*SubscriptionSettings){
		"invalid hostname":      func(s *SubscriptionSettings) { s.Domain = "sub..example" },
		"empty fragment":        func(s *SubscriptionSettings) { s.PublicURL = "https://sub.example#" },
		"port":                  func(s *SubscriptionSettings) { s.Port = 0 },
		"path":                  func(s *SubscriptionSettings) { s.BasePath = "/sub/../" },
		"domain":                func(s *SubscriptionSettings) { s.Domain = "https://sub.example" },
		"public query":          func(s *SubscriptionSettings) { s.PublicURL = "https://sub.example?token=x" },
		"public credentials":    func(s *SubscriptionSettings) { s.PublicURL = "https://user:pass@sub.example" },
		"public scheme":         func(s *SubscriptionSettings) { s.PublicURL = "ftp://sub.example" },
		"public port":           func(s *SubscriptionSettings) { s.PublicURL = "https://sub.example:65536" },
		"partial TLS":           func(s *SubscriptionSettings) { s.CertFile = "missing.pem" },
		"unreadable TLS":        func(s *SubscriptionSettings) { s.CertFile, s.KeyFile = "missing.pem", "missing.key" },
		"proxy":                 func(s *SubscriptionSettings) { s.TrustedProxies = []string{"all"} },
		"overlapping listeners": func(s *SubscriptionSettings) { s.Listen, s.Port = "0.0.0.0", 8000 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			values := state.Saved
			change(&values)
			if _, err := sub.Save(context.Background(), "operator", state.Revision, values); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("invalid settings = %v", err)
			}
			data, _ := os.ReadFile(path)
			if string(data) != string(original) {
				t.Fatal("invalid save changed file")
			}
		})
	}
	t.Setenv("X_UI_SUBSCRIPTION_PORT", "9443")
	state, _ = sub.Read()
	if state.Saved.Port != 9443 || state.Overrides["port"] != "X_UI_SUBSCRIPTION_PORT" {
		t.Fatal("environment override missing")
	}
	values := state.Saved
	values.Port = 9444
	if _, err := sub.Save(context.Background(), "operator", state.Revision, values); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("override changed = %v", err)
	}
	// A Panel override with the same field name must not lock Subscription.
	t.Setenv("X_UI_SERVER_LISTEN", "127.0.0.1")
	values = state.Saved
	values.Listen = "127.0.0.2"
	if _, err := sub.Save(context.Background(), "operator", state.Revision, values); err != nil {
		t.Fatal(err)
	}
}

func TestSubscriptionSettingsRequiresCompleteStrictJSON(t *testing.T) {
	values := subscriptionSettingsOf(config.Default())
	data, _ := json.Marshal(values)
	var fields map[string]any
	_ = json.Unmarshal(data, &fields)
	for _, key := range []string{"enabled", "listen", "port", "basePath", "domain", "certFile", "keyFile", "publicUrl", "trustedProxies"} {
		for _, null := range []bool{false, true} {
			copy := map[string]any{}
			for k, v := range fields {
				copy[k] = v
			}
			if null {
				copy[key] = nil
			} else {
				delete(copy, key)
			}
			raw, _ := json.Marshal(copy)
			if json.Unmarshal(raw, new(SubscriptionSettings)) == nil {
				t.Fatalf("accepted missing/null %s", key)
			}
		}
	}
	fields["database"] = "forbidden"
	data, _ = json.Marshal(fields)
	if json.Unmarshal(data, new(SubscriptionSettings)) == nil {
		t.Fatal("accepted unknown field")
	}
}

func saveSubscriptionRestartFixture(t *testing.T, panel *PanelSettingsService, port int) SubscriptionSettingsState {
	t.Helper()
	sub := NewSubscriptionSettingsService(panel)
	state, err := sub.Read()
	if err != nil {
		t.Fatal(err)
	}
	values := state.Saved
	values.Port = port
	state, err = sub.Save(context.Background(), "operator", state.Revision, values)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestStartupApplyRequiresAllPendingScopesAndLocksBothForms(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	saveRestartFixture(t, panel, 8001)
	state := saveSubscriptionRestartFixture(t, panel, 9443)
	if _, err := restart.Queue(context.Background(), "operator", state.Revision); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("legacy Panel request applied unconfirmed Subscription = %v", err)
	}
	if _, err := restart.QueueScopes(context.Background(), "operator", state.Revision, []string{"subscription"}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("partial confirmation = %v", err)
	}
	job, err := restart.QueueScopes(context.Background(), "operator", state.Revision, []string{"subscription", "panel"})
	if err != nil {
		t.Fatal(err)
	}
	if job.Subscription == nil || job.Subscription.Port != 9443 || !reflect.DeepEqual(job.Scopes, []string{"panel", "subscription"}) {
		t.Fatal("job does not record both targets")
	}
	if _, err := NewSubscriptionSettingsService(panel).Save(context.Background(), "operator", state.Revision, state.Saved); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("Subscription save during task = %v", err)
	}
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	finished, _ := restart.Get(job.ID)
	if finished.State != "succeeded" {
		t.Fatalf("result = %+v", finished)
	}
	if !reflect.DeepEqual(host.units, []string{"x-ui-worker", "x-ui-api"}) {
		t.Fatalf("unnecessary services restarted: %v", host.units)
	}
	cfg, _ := config.Load()
	if cfg.Server.Port != 8001 || cfg.Subscription.Port != 9443 {
		t.Fatal("both settings were not applied")
	}
}

func TestSubscriptionApplyFailureRollsBackWithoutChangingPanelOrSecrets(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	state := saveSubscriptionRestartFixture(t, panel, 9443)
	job, err := restart.QueueScopes(context.Background(), "operator", state.Revision, []string{"subscription"})
	if err != nil {
		t.Fatal(err)
	}
	host.failSubscriptionPort = 9443
	if err := runPanelRestart(context.Background(), filepath.Dir(path), job.ID, host); err != nil {
		t.Fatal(err)
	}
	result, _ := restart.Get(job.ID)
	if result.State != "rolled_back" {
		t.Fatalf("result = %+v", result)
	}
	cfg, _ := config.Load()
	if cfg.Subscription.Port != 8443 || cfg.Server.Port != 8000 || cfg.Database.Password != "original-private-password" || cfg.Session.Secret != "original-private-session" {
		t.Fatal("rollback did not preserve unrelated values")
	}
}

func TestStartupCheckpointDoesNotAdvanceOverPendingSubscription(t *testing.T) {
	panel, _, _, path := restartFixture(t)
	directory := filepath.Dir(path)
	before, _ := os.ReadFile(filepath.Join(panelRuntimeDir(directory), "applied.yaml"))
	saveSubscriptionRestartFixture(t, panel, 9443)
	cfg, _ := config.Load()
	// The worker can start with the new file while the API still uses the old subscription listener.
	if err := RecordPanelProcess("worker", cfg); err != nil {
		t.Fatal(err)
	}
	if err := CheckpointPanelConfiguration(cfg); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(panelRuntimeDir(directory), "applied.yaml"))
	if string(after) != string(before) {
		t.Fatal("checkpoint advanced without the matching API listener")
	}
}

func TestStartupHealthChecksSubscriptionTLSPathHostAndDisabledState(t *testing.T) {
	panel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer panel.Close()
	count := 0
	sub := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count++
		if r.Method != http.MethodHead || r.Host != "sub.example" || !strings.HasPrefix(r.URL.Path, "/nested/sub/x-ui-apply-probe-") {
			t.Errorf("probe = %s %s %s", r.Method, r.Host, r.URL.Path)
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer sub.Close()
	cfg := config.Default()
	cfg.Server.Listen, cfg.Server.Port = testListener(t, panel.URL)
	cfg.Subscription.Listen, cfg.Subscription.Port = testListener(t, sub.URL)
	cfg.Subscription.Domain, cfg.Subscription.BasePath = "sub.example", "/nested/sub/"
	cfg.Subscription.CertFile, cfg.Subscription.KeyFile = "configured.pem", "configured.key"
	if err := (systemdPanelHost{}).Healthy(context.Background(), cfg); err != nil || count != 1 {
		t.Fatalf("TLS health = %v, calls=%d", err, count)
	}
	cfg.Subscription.Enabled = false
	if err := (systemdPanelHost{}).Healthy(context.Background(), cfg); err != nil || count != 1 {
		t.Fatalf("disabled health = %v", err)
	}
	cfg.Subscription.Enabled, cfg.Subscription.BasePath = true, "/wrong/"
	// A different service returning 200 must never count as a healthy subscription listener.
	cfg.Subscription.Listen, cfg.Subscription.Port = cfg.Server.Listen, cfg.Server.Port
	cfg.Subscription.CertFile, cfg.Subscription.KeyFile = "", ""
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := (systemdPanelHost{}).Healthy(ctx, cfg); err == nil {
		t.Fatal("accepted incorrect subscription response")
	}
}

func TestSubscriptionSettingsValidatesMatchingCertificateAndKey(t *testing.T) {
	panel, _ := panelSettingsFixture(t, "")
	sub := NewSubscriptionSettingsService(panel)
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	certificate := server.TLS.Certificates[0]
	key, err := x509.MarshalPKCS8PrivateKey(certificate.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath := filepath.Join(t.TempDir(), "cert.pem"), filepath.Join(t.TempDir(), "key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Certificate[0]}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0o600); err != nil {
		t.Fatal(err)
	}
	state, _ := sub.Read()
	values := state.Saved
	values.CertFile, values.KeyFile = certPath, keyPath
	if _, err := sub.Save(context.Background(), "operator", state.Revision, values); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("invalid key"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, _ = sub.Read()
	if _, err := sub.Save(context.Background(), "operator", state.Revision, state.Saved); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("changed certificate files were not rechecked: %v", err)
	}
}

func TestStartupApplyRejectsLegacyReadinessAndQueuedJobs(t *testing.T) {
	panel, restart, host, path := restartFixture(t)
	directory := filepath.Dir(path)
	state := saveSubscriptionRestartFixture(t, panel, 9443)
	var process PanelProcessRuntime
	if err := readPanelJSON(filepath.Join(panelRuntimeDir(directory), "api.json"), &process); err != nil {
		t.Fatal(err)
	}
	process.Subscription = nil
	if err := writePanelJSON(filepath.Join(panelRuntimeDir(directory), "api.json"), process); err != nil {
		t.Fatal(err)
	}
	if _, err := restart.QueueScopes(context.Background(), "operator", state.Revision, []string{"subscription"}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("legacy API snapshot accepted: %v", err)
	}
	process.Subscription = &state.Running
	if err := writePanelJSON(filepath.Join(panelRuntimeDir(directory), "api.json"), process); err != nil {
		t.Fatal(err)
	}
	job, err := restart.QueueScopes(context.Background(), "operator", state.Revision, []string{"subscription"})
	if err != nil {
		t.Fatal(err)
	}
	record, _ := readPanelRestart(directory, job.ID)
	record.Job.Subscription, record.Job.PreviousSubscription, record.Job.Scopes = nil, nil, nil
	if err := writePanelJSON(panelJobPath(directory, job.ID), record); err != nil {
		t.Fatal(err)
	}
	if err := runPanelRestart(context.Background(), directory, job.ID, host); err != nil {
		t.Fatal(err)
	}
	result, _ := restart.Get(job.ID)
	if result.State != "failed" || len(host.units) != 0 {
		t.Fatal("legacy queued job applied an unconfirmed listener")
	}
}

func testListener(t *testing.T, address string) (string, int) {
	t.Helper()
	host, rawPort, err := net.SplitHostPort(strings.TrimPrefix(strings.TrimPrefix(address, "https://"), "http://"))
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(rawPort)
	return host, port
}
