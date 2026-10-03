package service

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

// SubscriptionSettings is the editable startup configuration of the
// subscriber-facing listener. Runtime content options remain in the database.
type SubscriptionSettings struct {
	Enabled        bool     `json:"enabled"`
	Listen         string   `json:"listen"`
	Port           int      `json:"port"`
	BasePath       string   `json:"basePath"`
	Domain         string   `json:"domain"`
	CertFile       string   `json:"certFile"`
	KeyFile        string   `json:"keyFile"`
	PublicURL      string   `json:"publicUrl"`
	TrustedProxies []string `json:"trustedProxies"`
}

func (s *SubscriptionSettings) UnmarshalJSON(data []byte) error {
	type plain SubscriptionSettings
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
	for _, field := range SubscriptionSettings(values).fields() {
		if len(fields[field.name]) == 0 || bytes.Equal(bytes.TrimSpace(fields[field.name]), []byte("null")) {
			return fmt.Errorf("%s is required and cannot be null", field.name)
		}
	}
	*s = SubscriptionSettings(values)
	return nil
}

func (s SubscriptionSettings) fields() []panelField {
	return []panelField{
		{"enabled", "subscription", "enabled", "X_UI_SUBSCRIPTION_ENABLED", s.Enabled},
		{"listen", "subscription", "listen", "X_UI_SUBSCRIPTION_LISTEN", s.Listen},
		{"port", "subscription", "port", "X_UI_SUBSCRIPTION_PORT", s.Port},
		{"basePath", "subscription", "base_path", "X_UI_SUBSCRIPTION_BASE_PATH", s.BasePath},
		{"domain", "subscription", "domain", "X_UI_SUBSCRIPTION_DOMAIN", s.Domain},
		{"certFile", "subscription", "cert_file", "X_UI_SUBSCRIPTION_CERT_FILE", s.CertFile},
		{"keyFile", "subscription", "key_file", "X_UI_SUBSCRIPTION_KEY_FILE", s.KeyFile},
		{"publicUrl", "subscription", "public_url", "X_UI_SUBSCRIPTION_PUBLIC_URL", s.PublicURL},
		{"trustedProxies", "subscription", "trusted_proxies", "X_UI_SUBSCRIPTION_TRUSTED_PROXIES", s.TrustedProxies},
	}
}

func subscriptionSettingsOf(cfg *config.Config) SubscriptionSettings {
	s := cfg.Subscription
	return normaliseSubscriptionSettings(SubscriptionSettings{
		Enabled: s.Enabled, Listen: s.Listen, Port: s.Port, BasePath: s.Base(),
		Domain: s.Domain, CertFile: s.CertFile, KeyFile: s.KeyFile,
		PublicURL: s.PublicURL, TrustedProxies: s.TrustedProxies,
	})
}

func normaliseSubscriptionSettings(s SubscriptionSettings) SubscriptionSettings {
	s.Listen = strings.TrimSpace(s.Listen)
	if ip := net.ParseIP(s.Listen); ip != nil && strings.Contains(s.Listen, ":") {
		s.Listen = "[" + s.Listen + "]"
	}
	s.BasePath = strings.TrimSpace(s.BasePath)
	if s.BasePath != "" {
		s.BasePath = "/" + strings.Trim(s.BasePath, "/")
		if s.BasePath != "/" {
			s.BasePath += "/"
		}
	}
	s.Domain = strings.TrimSpace(s.Domain)
	s.CertFile = strings.TrimSpace(s.CertFile)
	s.KeyFile = strings.TrimSpace(s.KeyFile)
	s.PublicURL = strings.TrimRight(strings.TrimSpace(s.PublicURL), "/")
	s.TrustedProxies = append([]string{}, s.TrustedProxies...)
	for i := range s.TrustedProxies {
		s.TrustedProxies[i] = strings.TrimSpace(s.TrustedProxies[i])
	}
	return s
}

var subscriptionBasePath = regexp.MustCompile(`^/(?:[A-Za-z0-9._~-]+/)*$`)
var subscriptionHostLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func validSubscriptionHost(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	host = strings.TrimSuffix(host, ".")
	if host == "" || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if !subscriptionHostLabel.MatchString(label) {
			return false
		}
	}
	return true
}

func validateSubscriptionSettings(s SubscriptionSettings) error {
	if s.Port < 1 || s.Port > 65535 {
		return domain.Invalidf("Subscription port must be between 1 and 65535")
	}
	if !subscriptionBasePath.MatchString(s.BasePath) {
		return domain.Invalidf("Subscription path must contain slash-separated names using letters, numbers, . _ ~ and -")
	}
	for _, part := range strings.Split(s.BasePath, "/") {
		if part == "." || part == ".." {
			return domain.Invalidf("Subscription path cannot contain . or .. segments")
		}
	}
	if s.Listen != "" {
		if _, err := net.ResolveTCPAddr("tcp", net.JoinHostPort(strings.Trim(s.Listen, "[]"), strconv.Itoa(s.Port))); err != nil {
			return domain.Invalidf("Subscription address cannot be used to listen: %v", err)
		}
	}
	if s.Domain != "" && (strings.ContainsAny(s.Domain, "/\\?# \t\r\n:") || !validSubscriptionHost(s.Domain)) {
		return domain.Invalidf("Subscription domain must be a host name without a scheme, port or path")
	}
	if (s.CertFile == "") != (s.KeyFile == "") {
		return domain.Invalidf("Set both subscription SSL certificate and key paths, or leave both empty")
	}
	if s.CertFile != "" {
		if _, err := tls.LoadX509KeyPair(s.CertFile, s.KeyFile); err != nil {
			return domain.Invalidf("Subscription SSL certificate and key cannot be loaded together: %v", err)
		}
	}
	if s.PublicURL != "" {
		u, err := url.Parse(s.PublicURL)
		if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || !validSubscriptionHost(u.Hostname()) || strings.HasSuffix(u.Host, ":") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(s.PublicURL, "\\ \t\r\n?#") {
			return domain.Invalidf("Public URL must be an HTTP or HTTPS base address without credentials, query or fragment")
		}
		if port := u.Port(); port != "" {
			n, err := strconv.Atoi(port)
			if err != nil || n < 1 || n > 65535 {
				return domain.Invalidf("Public URL port must be between 1 and 65535")
			}
		}
	}
	for _, proxy := range s.TrustedProxies {
		if net.ParseIP(proxy) == nil {
			if _, _, err := net.ParseCIDR(proxy); err != nil {
				return domain.Invalidf("Trusted proxies must be IP addresses or CIDR ranges")
			}
		}
	}
	return nil
}

func validateStartupListeners(cfg *config.Config) error {
	if !cfg.Subscription.Enabled || cfg.Server.Port != cfg.Subscription.Port {
		return nil
	}
	a, b := strings.Trim(cfg.Server.Listen, "[]"), strings.Trim(cfg.Subscription.Listen, "[]")
	wildcard := func(host string) bool { return host == "" || host == "0.0.0.0" || host == "::" }
	overlap := a == b || wildcard(a) || wildcard(b)
	if !overlap {
		left, leftErr := net.ResolveTCPAddr("tcp", net.JoinHostPort(a, strconv.Itoa(cfg.Server.Port)))
		right, rightErr := net.ResolveTCPAddr("tcp", net.JoinHostPort(b, strconv.Itoa(cfg.Subscription.Port)))
		overlap = leftErr == nil && rightErr == nil && left.IP.Equal(right.IP)
	}
	if overlap {
		return domain.Invalidf("Panel and Subscription cannot listen on overlapping addresses with the same port")
	}
	return nil
}

func (s SubscriptionSettings) PublicBase(host string) string {
	return (config.SubscriptionConfig{
		Enabled: s.Enabled, Listen: s.Listen, Port: s.Port, BasePath: s.BasePath,
		Domain: s.Domain, CertFile: s.CertFile, KeyFile: s.KeyFile, PublicURL: s.PublicURL,
	}).PublicBase(host)
}

type SubscriptionSettingsState struct {
	Saved                    SubscriptionSettings `json:"saved"`
	Running                  SubscriptionSettings `json:"running"`
	SavedPanel               PanelSettings        `json:"savedPanel"`
	RunningPanel             PanelSettings        `json:"runningPanel"`
	Revision                 string               `json:"revision"`
	Overrides                map[string]string    `json:"overrides"`
	PendingScopes            []string             `json:"pendingScopes"`
	RestartRequired          bool                 `json:"restartRequired"`
	RestartSupported         bool                 `json:"restartSupported"`
	RestartUnavailableReason string               `json:"restartUnavailableReason,omitempty"`
	RestartJob               *PanelRestartJob     `json:"restartJob,omitempty"`
	SavedURI                 string               `json:"savedUri"`
	RunningURI               string               `json:"runningUri"`
}

// Both forms share the same mutex, file lock, revision and apply checkpoint.
type SubscriptionSettingsService struct{ panel *PanelSettingsService }

func NewSubscriptionSettingsService(panel *PanelSettingsService) *SubscriptionSettingsService {
	return &SubscriptionSettingsService{panel: panel}
}

func (s *SubscriptionSettingsService) state(data []byte, cfg *config.Config) SubscriptionSettingsState {
	panel := s.panel.state(data, cfg)
	saved := subscriptionSettingsOf(cfg)
	overrides := make(map[string]string)
	for _, field := range saved.fields() {
		if _, exists := os.LookupEnv(field.env); exists {
			overrides[field.name] = field.env
		}
	}
	return SubscriptionSettingsState{
		Saved: saved, Running: s.panel.runningSubscription, SavedPanel: panel.Saved, RunningPanel: panel.Running,
		Revision: panel.Revision, Overrides: overrides, PendingScopes: panel.PendingScopes,
		RestartRequired: panel.RestartRequired, RestartSupported: panel.RestartSupported,
		RestartUnavailableReason: panel.RestartUnavailableReason, RestartJob: panel.RestartJob,
	}
}

func (s *SubscriptionSettingsService) Read() (SubscriptionSettingsState, error) {
	s.panel.mu.Lock()
	defer s.panel.mu.Unlock()
	_, data, err := s.panel.read()
	if err != nil {
		return SubscriptionSettingsState{}, err
	}
	cfg, err := config.Parse(data)
	if err != nil {
		return SubscriptionSettingsState{}, err
	}
	return s.state(data, cfg), nil
}

func (s *SubscriptionSettingsService) Save(ctx context.Context, actor, revision string, values SubscriptionSettings) (SubscriptionSettingsState, error) {
	s.panel.mu.Lock()
	defer s.panel.mu.Unlock()
	values = normaliseSubscriptionSettings(values)
	if err := validateSubscriptionSettings(values); err != nil {
		return SubscriptionSettingsState{}, err
	}
	cfg, data, err := s.panel.saveFields(ctx, actor, revision, values.fields(), func(cfg *config.Config) []panelField {
		return subscriptionSettingsOf(cfg).fields()
	}, "subscription-settings")
	if err != nil {
		return SubscriptionSettingsState{}, err
	}
	return s.state(data, cfg), nil
}
