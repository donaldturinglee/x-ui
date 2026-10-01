// Package agent is the side of x-ui that runs on a node rather than on
// the panel.
//
// It does two things on a loop: fetch the configuration the panel says this
// node should be serving and apply it, and report back the traffic the core
// measured. Everything else about the node -- which proxy core, how it is
// supervised -- is left to the operator, because those are decisions a panel
// has no business making on a machine it does not own.
package agent

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// envPrefix namespaces every environment override.
const envPrefix = "X_UI_AGENT_"

// Duration reads as "30s" or "5m" in YAML.
type Duration time.Duration

func (d *Duration) UnmarshalYAML(value *yaml.Node) error {
	var raw string
	if err := value.Decode(&raw); err != nil {
		return err
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", raw, err)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) Duration() time.Duration {
	return time.Duration(d)
}

type Config struct {
	// Panel is where this node takes its orders from.
	Panel PanelConfig `yaml:"panel"`
	// Core is the proxy process this node runs.
	Core CoreConfig `yaml:"core"`
	// Stats says where the traffic figures come from.
	Stats StatsConfig `yaml:"stats"`
	Log   LogConfig   `yaml:"log"`
}

type PanelConfig struct {
	// URL is the panel's base address, including its path: the agent talks to
	// the token API, not the cookie one.
	URL string `yaml:"url"`
	// Host is the panel's required HTTP Host and TLS certificate name when the
	// URL dials a local interface on a combined panel and node host.
	Host string `yaml:"host"`
	// Token authenticates every request. It is the node's only credential.
	Token string `yaml:"token"`
	// SyncInterval is how often the configuration is refetched. A node that
	// misses a change serves the old one until the next poll, so this is the
	// worst-case delay on an operator's edit taking effect.
	SyncInterval Duration `yaml:"sync_interval"`
	// ReportInterval is how often measured traffic is sent back.
	ReportInterval Duration `yaml:"report_interval"`
	// Timeout bounds a single request to the panel.
	Timeout Duration `yaml:"timeout"`
	// InsecureSkipVerify disables certificate checking. It exists for a panel
	// behind a self-signed certificate during setup and is refused by Validate
	// unless the address is a loopback one.
	InsecureSkipVerify bool `yaml:"insecure_skip_verify"`
}

type CoreConfig struct {
	// ConfigPath is where the fetched configuration is written.
	ConfigPath string `yaml:"config_path"`
	// AppliedConfigPath identifies the file the core actually reads when a
	// reload helper copies the agent's private staging file into place.
	AppliedConfigPath string `yaml:"applied_config_path"`
	// CheckCommand validates a temporary candidate before ConfigPath changes.
	// The literal {config} argument is replaced with the candidate's path.
	CheckCommand []string `yaml:"check_command"`
	// ReloadCommand is run after the configuration changes. It is a command and
	// its arguments, not a shell line: the agent runs it directly, so nothing
	// here is interpreted by a shell.
	ReloadCommand []string `yaml:"reload_command"`
	// ReloadTimeout bounds that command.
	ReloadTimeout Duration `yaml:"reload_timeout"`
}

type StatsConfig struct {
	// Source selects the core API. "sing-box" uses its native API (1.14+),
	// "clash" uses an API with user metadata, and "none" disables reporting.
	Source string `yaml:"source"`
	// URL is the selected API's base address.
	URL string `yaml:"url"`
	// Secret is the API's bearer token, when it has one.
	Secret string `yaml:"secret"`
	// Timeout bounds a single read.
	Timeout Duration `yaml:"timeout"`
}

type LogConfig struct {
	Level string `yaml:"level"`
}

// Stats sources.
const (
	StatsSourceNone    = "none"
	StatsSourceClash   = "clash"
	StatsSourceSingBox = "sing-box"
)

func Default() *Config {
	return &Config{
		Panel: PanelConfig{
			SyncInterval:   Duration(30 * time.Second),
			ReportInterval: Duration(10 * time.Second),
			Timeout:        Duration(15 * time.Second),
		},
		Core: CoreConfig{
			ConfigPath:    "/etc/x-ui/config.json",
			ReloadTimeout: Duration(30 * time.Second),
		},
		Stats: StatsConfig{
			Source:  StatsSourceClash,
			URL:     "http://127.0.0.1:9090",
			Timeout: Duration(10 * time.Second),
		},
		Log: LogConfig{Level: "info"},
	}
}

// Load reads the agent's configuration file and applies environment overrides.
func Load(path string) (*Config, error) {
	return loadWithEnvironment(path, os.LookupEnv)
}

// LoadWithEnvironment applies a service EnvironmentFile without evaluating it
// as shell code or changing this process's environment.
func LoadWithEnvironment(path string, environment map[string]string) (*Config, error) {
	return loadWithEnvironment(path, func(key string) (string, bool) {
		value, present := environment[key]
		return value, present
	})
}

func loadWithEnvironment(path string, lookup func(string) (string, bool)) (*Config, error) {
	cfg := Default()

	if path == "" {
		path, _ = lookup(envPrefix + "CONFIG")
	}
	if path == "" {
		path = "configs/agent.yaml"
	}

	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	case !os.IsNotExist(err):
		return nil, err
		// A missing file is not an error: an agent in a container is usually
		// configured entirely by environment variables.
	}

	cfg.applyEnvironment(lookup)

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) applyEnv() {
	c.applyEnvironment(os.LookupEnv)
}

func (c *Config) applyEnvironment(lookup func(string) (string, bool)) {
	envString(&c.Panel.URL, "PANEL_URL", lookup)
	envString(&c.Panel.Host, "PANEL_HOST", lookup)
	envString(&c.Panel.Token, "PANEL_TOKEN", lookup)
	envDuration(&c.Panel.SyncInterval, "SYNC_INTERVAL", lookup)
	envDuration(&c.Panel.ReportInterval, "REPORT_INTERVAL", lookup)
	envBool(&c.Panel.InsecureSkipVerify, "INSECURE_SKIP_VERIFY", lookup)

	envString(&c.Core.ConfigPath, "CORE_CONFIG_PATH", lookup)
	envString(&c.Core.AppliedConfigPath, "CORE_APPLIED_CONFIG_PATH", lookup)
	envList(&c.Core.CheckCommand, "CORE_CHECK_COMMAND", lookup)
	envList(&c.Core.ReloadCommand, "CORE_RELOAD_COMMAND", lookup)

	envString(&c.Stats.Source, "STATS_SOURCE", lookup)
	envString(&c.Stats.URL, "STATS_URL", lookup)
	envString(&c.Stats.Secret, "STATS_SECRET", lookup)

	envString(&c.Log.Level, "LOG_LEVEL", lookup)
}

// Validate refuses a configuration the agent cannot run on.
func (c *Config) Validate() error {
	if c.Panel.URL == "" {
		return fmt.Errorf("panel.url is required")
	}
	if c.Panel.Token == "" {
		return fmt.Errorf("panel.token is required: the agent authenticates with the token API")
	}
	if c.Core.ConfigPath == "" {
		return fmt.Errorf("core.config_path is required")
	}
	if len(c.Core.CheckCommand) > 0 {
		found := false
		for _, argument := range c.Core.CheckCommand {
			found = found || argument == "{config}"
		}
		if !found {
			return fmt.Errorf("core.check_command must contain a {config} argument")
		}
	}
	if c.Panel.SyncInterval.Duration() < time.Second {
		return fmt.Errorf("panel.sync_interval must be at least 1s")
	}
	if c.Panel.ReportInterval.Duration() < time.Second {
		return fmt.Errorf("panel.report_interval must be at least 1s")
	}
	switch c.Stats.Source {
	case StatsSourceNone, StatsSourceClash, StatsSourceSingBox:
	default:
		return fmt.Errorf("stats.source %q is not one of %q, %q or %q", c.Stats.Source, StatsSourceNone, StatsSourceClash, StatsSourceSingBox)
	}
	if c.Stats.Source != StatsSourceNone && c.Stats.URL == "" {
		return fmt.Errorf("stats.url is required when stats.source is %q", c.Stats.Source)
	}
	// The token is the node's only credential and travels on every request.
	// Skipping verification against a remote panel hands it to whoever is in
	// the middle, which is exactly the position this setting invites.
	if c.Panel.InsecureSkipVerify && !isLoopbackURL(c.Panel.URL) {
		return fmt.Errorf("panel.insecure_skip_verify is only allowed against a loopback panel")
	}
	return nil
}

func isLoopbackURL(raw string) bool {
	lowered := strings.ToLower(raw)
	for _, prefix := range []string{"http://127.0.0.1", "https://127.0.0.1", "http://localhost", "https://localhost", "http://[::1]", "https://[::1]"} {
		if strings.HasPrefix(lowered, prefix) {
			return true
		}
	}
	return false
}

func envString(target *string, key string, lookup func(string) (string, bool)) {
	if value, ok := lookup(envPrefix + key); ok {
		*target = value
	}
}

func envBool(target *bool, key string, lookup func(string) (string, bool)) {
	value, ok := lookup(envPrefix + key)
	if !ok {
		return
	}
	if parsed, err := strconv.ParseBool(value); err == nil {
		*target = parsed
	}
}

func envDuration(target *Duration, key string, lookup func(string) (string, bool)) {
	value, ok := lookup(envPrefix + key)
	if !ok {
		return
	}
	if parsed, err := time.ParseDuration(value); err == nil {
		*target = Duration(parsed)
	}
}

// envList reads a command as space-separated words. A reload command is run
// directly rather than through a shell, so there is nothing here that quoting
// would change.
func envList(target *[]string, key string, lookup func(string) (string, bool)) {
	value, ok := lookup(envPrefix + key)
	if !ok {
		return
	}
	*target = strings.Fields(value)
}
