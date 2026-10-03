package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/op/go-logging"
	"gopkg.in/yaml.v3"
)

// PanelSettings contains only the options the Panel form may change. In
// particular, neither database credentials nor the session secret belong here.
type PanelSettings struct {
	Listen                string   `json:"listen"`
	Port                  int      `json:"port"`
	BasePath              string   `json:"basePath"`
	Domain                string   `json:"domain"`
	KeyFile               string   `json:"keyFile"`
	CertFile              string   `json:"certFile"`
	TrustedProxies        []string `json:"trustedProxies"`
	MaxAgeSeconds         int64    `json:"maxAgeSeconds"`
	StatsRetentionSeconds int64    `json:"statsRetentionSeconds"`
	StatsBucketSeconds    int64    `json:"statsBucketSeconds"`
	TimeLocation          string   `json:"timeLocation"`
	ResetSpec             string   `json:"resetSpec"`
	DepleteSpec           string   `json:"depleteSpec"`
	CleanupSpec           string   `json:"cleanupSpec"`
	LogLevel              string   `json:"logLevel"`
}

// A save replaces the full form. Missing or null fields must not silently
// clear optional listener settings when a caller sends a partial object.
func (p *PanelSettings) UnmarshalJSON(data []byte) error {
	type plain PanelSettings
	var values plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&values); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, field := range PanelSettings(values).fields() {
		if len(fields[field.name]) == 0 || bytes.Equal(bytes.TrimSpace(fields[field.name]), []byte("null")) {
			return fmt.Errorf("%s is required and cannot be null", field.name)
		}
	}
	*p = PanelSettings(values)
	return nil
}

type PanelSettingsState struct {
	Saved                    PanelSettings        `json:"saved"`
	Running                  PanelSettings        `json:"running"`
	Revision                 string               `json:"revision"`
	Overrides                map[string]string    `json:"overrides"`
	RestartRequired          bool                 `json:"restartRequired"`
	RestartSupported         bool                 `json:"restartSupported"`
	RestartUnavailableReason string               `json:"restartUnavailableReason,omitempty"`
	RestartJob               *PanelRestartJob     `json:"restartJob,omitempty"`
	PendingScopes            []string             `json:"pendingScopes"`
	SavedSubscription        SubscriptionSettings `json:"savedSubscription"`
	RunningSubscription      SubscriptionSettings `json:"runningSubscription"`
}

type panelField struct {
	name, section, key, env string
	value                   any
}

func (p PanelSettings) fields() []panelField {
	return []panelField{
		{"listen", "server", "listen", "X_UI_SERVER_LISTEN", p.Listen},
		{"port", "server", "port", "X_UI_SERVER_PORT", p.Port},
		{"basePath", "server", "base_path", "X_UI_SERVER_BASE_PATH", p.BasePath},
		{"domain", "server", "domain", "X_UI_SERVER_DOMAIN", p.Domain},
		{"keyFile", "server", "key_file", "X_UI_SERVER_KEY_FILE", p.KeyFile},
		{"certFile", "server", "cert_file", "X_UI_SERVER_CERT_FILE", p.CertFile},
		{"trustedProxies", "server", "trusted_proxies", "X_UI_SERVER_TRUSTED_PROXIES", p.TrustedProxies},
		{"maxAgeSeconds", "session", "max_age", "X_UI_SESSION_MAX_AGE", fmt.Sprintf("%ds", p.MaxAgeSeconds)},
		{"statsRetentionSeconds", "worker", "stats_retention", "X_UI_WORKER_STATS_RETENTION", fmt.Sprintf("%ds", p.StatsRetentionSeconds)},
		{"statsBucketSeconds", "worker", "stats_bucket", "X_UI_WORKER_STATS_BUCKET", fmt.Sprintf("%ds", p.StatsBucketSeconds)},
		{"timeLocation", "worker", "time_location", "X_UI_WORKER_TIME_LOCATION", p.TimeLocation},
		{"resetSpec", "worker", "reset_spec", "X_UI_WORKER_RESET_SPEC", p.ResetSpec},
		{"depleteSpec", "worker", "deplete_spec", "X_UI_WORKER_DEPLETE_SPEC", p.DepleteSpec},
		{"cleanupSpec", "worker", "cleanup_spec", "X_UI_WORKER_CLEANUP_SPEC", p.CleanupSpec},
		{"logLevel", "log", "level", "X_UI_LOG_LEVEL", p.LogLevel},
	}
}

func panelSettingsOf(cfg *config.Config) PanelSettings {
	shown := cfg.Shown()
	return normalisePanelSettings(PanelSettings{
		Listen: shown.Panel.Listen, Port: shown.Panel.Port, BasePath: shown.Panel.BasePath,
		Domain: shown.Panel.Domain, KeyFile: shown.Panel.KeyFile, CertFile: shown.Panel.CertFile,
		TrustedProxies: shown.Panel.TrustedProxies, MaxAgeSeconds: shown.Session.MaxAgeSeconds,
		StatsRetentionSeconds: shown.Worker.StatsRetentionSeconds, StatsBucketSeconds: shown.Worker.StatsBucketSeconds,
		TimeLocation: shown.Worker.TimeLocation, ResetSpec: shown.Worker.ResetSpec,
		DepleteSpec: shown.Worker.DepleteSpec, CleanupSpec: shown.Worker.CleanupSpec, LogLevel: shown.LogLevel,
	})
}

func normalisePanelSettings(p PanelSettings) PanelSettings {
	p.Listen = strings.TrimSpace(p.Listen)
	p.BasePath = strings.TrimSpace(p.BasePath)
	if p.BasePath != "" {
		p.BasePath = "/" + strings.Trim(p.BasePath, "/")
		if p.BasePath != "/" {
			p.BasePath += "/"
		}
	}
	p.Domain = strings.TrimSpace(p.Domain)
	p.KeyFile = strings.TrimSpace(p.KeyFile)
	p.CertFile = strings.TrimSpace(p.CertFile)
	p.TimeLocation = strings.TrimSpace(p.TimeLocation)
	p.LogLevel = strings.ToLower(strings.TrimSpace(p.LogLevel))
	p.TrustedProxies = append([]string{}, p.TrustedProxies...)
	for i := range p.TrustedProxies {
		p.TrustedProxies[i] = strings.TrimSpace(p.TrustedProxies[i])
	}
	for _, spec := range []*string{&p.ResetSpec, &p.DepleteSpec, &p.CleanupSpec} {
		*spec = strings.TrimSpace(*spec)
		if strings.EqualFold(*spec, "off") {
			*spec = ""
		}
	}
	return p
}

var panelBasePath = regexp.MustCompile(`^/(?:[A-Za-z0-9_-]+/)*$`)

func validatePanelSettings(p PanelSettings) error {
	if p.Port < 1 || p.Port > 65535 {
		return domain.Invalidf("Port must be between 1 and 65535")
	}
	if !panelBasePath.MatchString(p.BasePath) {
		return domain.Invalidf("Web path must be / or slash-separated names using letters, numbers, - and _")
	}
	if p.Listen != "" {
		if _, err := net.ResolveTCPAddr("tcp", fmt.Sprintf("%s:%d", p.Listen, p.Port)); err != nil {
			return domain.Invalidf("Address cannot be used to listen: %v", err)
		}
	}
	if strings.ContainsAny(p.Domain, "/\\?# \t\r\n:") {
		return domain.Invalidf("Domain must be a host name without a scheme, port or path")
	}
	if (p.CertFile == "") != (p.KeyFile == "") {
		return domain.Invalidf("Set both SSL certificate and key paths, or leave both empty")
	}
	if p.CertFile != "" {
		if _, err := tls.LoadX509KeyPair(p.CertFile, p.KeyFile); err != nil {
			return domain.Invalidf("SSL certificate and key cannot be loaded together: %v", err)
		}
	}
	for _, proxy := range p.TrustedProxies {
		if net.ParseIP(proxy) == nil {
			if _, _, err := net.ParseCIDR(proxy); err != nil {
				return domain.Invalidf("Trusted proxies must be IP addresses or CIDR ranges")
			}
		}
	}
	const maxSeconds = int64((1<<63 - 1) / time.Second)
	if p.MaxAgeSeconds < 0 || p.MaxAgeSeconds > maxSeconds || p.StatsRetentionSeconds < 0 || p.StatsRetentionSeconds > maxSeconds {
		return domain.Invalidf("Session length and traffic retention must be non-negative durations")
	}
	if p.StatsBucketSeconds < 1 || p.StatsBucketSeconds > maxSeconds {
		return domain.Invalidf("Traffic bucket must be a positive number of seconds")
	}
	if _, err := time.LoadLocation(p.TimeLocation); err != nil {
		return domain.Invalidf("Time zone is not recognised")
	}
	parser := config.CronParser()
	for _, spec := range []string{p.ResetSpec, p.DepleteSpec, p.CleanupSpec} {
		if spec != "" {
			if _, err := parser.Parse(spec); err != nil {
				return domain.Invalidf("Invalid schedule %q: %v", spec, err)
			}
		}
	}
	if _, err := logging.LogLevel(p.LogLevel); err != nil {
		return domain.Invalidf("Log level is not recognised")
	}
	return nil
}

// PanelSettingsService edits the startup file without changing a running
// listener. A file revision prevents a stale browser from overwriting edits.
type PanelSettingsService struct {
	mu                  sync.Mutex
	path                string
	running             PanelSettings
	runningSubscription SubscriptionSettings
	settings            *SettingService
	restart             *PanelRestartService
}

func NewPanelSettingsService(settings *SettingService, cfg *config.Config) *PanelSettingsService {
	return &PanelSettingsService{
		path: filepath.Join(config.Dir(), "config.yaml"), running: panelSettingsOf(cfg), runningSubscription: subscriptionSettingsOf(cfg), settings: settings,
	}
}

func (s *PanelSettingsService) state(data []byte, cfg *config.Config) PanelSettingsState {
	saved := panelSettingsOf(cfg)
	overrides := make(map[string]string)
	for _, field := range saved.fields() {
		if _, exists := os.LookupEnv(field.env); exists {
			overrides[field.name] = field.env
		}
	}
	var worker PanelProcessRuntime
	if readPanelJSON(filepath.Join(panelRuntimeDir(filepath.Dir(s.path)), "worker.json"), &worker) == nil {
		for _, field := range saved.fields() {
			if (field.section == "worker" || field.section == "log") && worker.Overrides[field.name] != "" {
				overrides[field.name] = worker.Overrides[field.name] + " (worker)"
			}
		}
	}
	state := PanelSettingsState{
		Saved: saved, Running: s.running, Revision: panelRevision(data),
		Overrides: overrides, RestartRequired: !reflect.DeepEqual(saved, s.running),
	}
	state.SavedSubscription, state.RunningSubscription = subscriptionSettingsOf(cfg), s.runningSubscription
	state.PendingScopes = []string{}
	if !reflect.DeepEqual(saved, s.running) {
		state.PendingScopes = append(state.PendingScopes, "panel")
	}
	if !reflect.DeepEqual(state.SavedSubscription, s.runningSubscription) {
		state.PendingScopes = append(state.PendingScopes, "subscription")
	}
	state.RestartRequired = len(state.PendingScopes) > 0
	if s.restart != nil {
		s.restart.decorate(&state)
	}
	return state
}

func (s *PanelSettingsService) read() (PanelSettingsState, []byte, error) {
	data, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return PanelSettingsState{}, nil, err
	}
	cfg, err := config.Parse(data)
	if err != nil {
		return PanelSettingsState{}, nil, err
	}
	return s.state(data, cfg), data, nil
}

func (s *PanelSettingsService) Read() (PanelSettingsState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, _, err := s.read()
	return state, err
}

func (s *PanelSettingsService) Save(ctx context.Context, actor, revision string, values PanelSettings) (PanelSettingsState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	values = normalisePanelSettings(values)
	if err := validatePanelSettings(values); err != nil {
		return PanelSettingsState{}, err
	}
	cfg, data, err := s.saveFields(ctx, actor, revision, values.fields(), func(cfg *config.Config) []panelField {
		return panelSettingsOf(cfg).fields()
	}, "panel-settings")
	if err != nil {
		return PanelSettingsState{}, err
	}
	return s.state(data, cfg), nil
}

func (s *PanelSettingsService) saveFields(ctx context.Context, actor, revision string, fields []panelField, currentFields func(*config.Config) []panelField, auditKind string) (*config.Config, []byte, error) {
	gate, err := BeginHostWrite(filepath.Dir(s.path))
	if err != nil {
		return nil, nil, err
	}
	defer gate()
	unlock, err := acquirePanelLock(filepath.Dir(s.path))
	if err != nil {
		return nil, nil, err
	}
	defer unlock()
	if job, err := latestPanelRestart(filepath.Dir(s.path)); err != nil {
		return nil, nil, err
	} else if job != nil && job.active() {
		return nil, nil, domain.Conflictf("Configuration application is in progress; wait before saving more changes")
	}
	state, data, err := s.read()
	if err != nil {
		return nil, nil, err
	}
	if revision != state.Revision {
		return nil, nil, domain.Conflictf("Configuration changed since you started editing. Discard changes and try again")
	}
	cfg, err := config.Parse(data)
	if err != nil {
		return nil, nil, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, nil, err
	}
	if len(document.Content) == 0 {
		document = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	changed := []string{}
	previous := currentFields(cfg)
	for i, field := range fields {
		if reflect.DeepEqual(field.value, previous[i].value) {
			continue
		}
		if env, overridden := state.Overrides[field.name]; overridden {
			if field.section != "subscription" {
				return nil, nil, domain.Invalidf("%s is controlled by %s; change the environment variable instead", field.name, env)
			}
		}
		if _, exists := os.LookupEnv(field.env); exists {
			return nil, nil, domain.Invalidf("%s is controlled by %s; change the environment variable instead", field.name, field.env)
		}
		section := yamlMappingEntry(document.Content[0], field.section)
		if section.Kind == 0 || section.Tag == "!!null" {
			*section = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		}
		if section.Kind != yaml.MappingNode {
			return nil, nil, domain.Invalidf("Configuration section %s must be a mapping", field.section)
		}
		target := yamlMappingEntry(section, field.key)
		head, line, foot := target.HeadComment, target.LineComment, target.FootComment
		if err := target.Encode(field.value); err != nil {
			return nil, nil, err
		}
		target.HeadComment, target.LineComment, target.FootComment = head, line, foot
		changed = append(changed, field.section+"."+field.key)
	}
	if len(changed) == 0 {
		return cfg, data, nil
	}
	// Preserve the last applied form across multiple saves. It must not be
	// replaced by a new API starting halfway through a restart operation.
	if !state.RestartRequired && startupProcessesAgree(filepath.Dir(s.path), s.running, s.runningSubscription) {
		if err := writePanelPrivate(filepath.Join(panelRuntimeDir(filepath.Dir(s.path)), "applied.yaml"), data); err != nil {
			return nil, nil, err
		}
	}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(&document); err != nil {
		return nil, nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, nil, err
	}
	cfg, err = config.Parse(output.Bytes())
	if err != nil {
		return nil, nil, domain.Invalidf("Configuration cannot be applied: %v", err)
	}
	if err := validateStartupListeners(cfg); err != nil {
		return nil, nil, err
	}
	if err := s.write(output.Bytes(), data); err != nil {
		return nil, nil, err
	}
	if s.settings != nil {
		logChange(ctx, s.settings.store, actor, auditKind, "edit", changed)
	}
	return cfg, output.Bytes(), nil
}

func yamlMappingEntry(mapping *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1]
		}
	}
	value := &yaml.Node{}
	mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, value)
	return value
}

func (s *PanelSettingsService) write(data, previous []byte) error {
	mode := os.FileMode(0o600)
	if info, err := os.Lstat(s.path); err == nil {
		if !info.Mode().IsRegular() {
			return domain.Invalidf("Configuration must be a regular, writable file")
		}
		mode = info.Mode().Perm()
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), ".x-ui-panel-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(mode); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	latest, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if !bytes.Equal(latest, previous) {
		return domain.Conflictf("Configuration changed while saving. Discard changes and try again")
	}
	return os.Rename(file.Name(), s.path)
}
