package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Name and Version identify the build. Version is overridden at link time by
// scripts/build.sh (-X), so a binary can report what it actually is.
const Name = "x-ui"

var Version = "dev"

// envPrefix namespaces every environment override, so a generic name such as
// PORT belonging to some other process on the host cannot reconfigure the
// panel by accident.
const envPrefix = "X_UI_"

// RootUsernameEnv and RootPasswordEnv name the credentials the first account is
// created from. The API reads them when it bootstraps at startup and the CLI's
// seed reads them too, so the pair is named once here rather than spelled out
// in each -- renaming one and missing the other would leave a panel that
// silently never gets an account.
const (
	RootUsernameEnv = envPrefix + "ROOT_USERNAME"
	RootPasswordEnv = envPrefix + "ROOT_PASSWORD"
)

// Duration is a time.Duration that reads as "30s" or "5m" in YAML. The plain
// type decodes only as an integer count of nanoseconds, which is unreadable in
// a configuration file.
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

func (d Duration) String() string {
	return time.Duration(d).String()
}

type Config struct {
	Log          LogConfig          `yaml:"log"`
	Server       ServerConfig       `yaml:"server"`
	Subscription SubscriptionConfig `yaml:"subscription"`
	Database     DatabaseConfig     `yaml:"database"`
	Session      SessionConfig      `yaml:"session"`
	Worker       WorkerConfig       `yaml:"worker"`
}

type LogConfig struct {
	Level string `yaml:"level"`
}

type ServerConfig struct {
	Listen   string `yaml:"listen"`
	Port     int    `yaml:"port"`
	BasePath string `yaml:"base_path"`
	// Domain, when set, is the only Host header the server answers on. It shuts
	// the panel to anyone who found the address by scanning rather than by
	// being told the name.
	Domain   string `yaml:"domain"`
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
	// TrustedProxies are the peers whose X-Forwarded-* headers are believed.
	// Left empty, no proxy is trusted and every client is identified by the
	// address it actually connected from.
	TrustedProxies []string `yaml:"trusted_proxies"`
	// WebDir holds the panel, in build/ below it.
	WebDir            string   `yaml:"web_dir"`
	ReadHeaderTimeout Duration `yaml:"read_header_timeout"`
	ReadTimeout       Duration `yaml:"read_timeout"`
	WriteTimeout      Duration `yaml:"write_timeout"`
	IdleTimeout       Duration `yaml:"idle_timeout"`
	ShutdownTimeout   Duration `yaml:"shutdown_timeout"`
}

// SubscriptionConfig is the second listener: the one subscribers reach, rather
// than operators.
//
// It is separate from the panel in every way that matters — its own port, its
// own certificate, its own host check — because the two have different
// audiences. The panel should be reachable by a handful of people; this has to
// be reachable by everyone who was sold a subscription.
type SubscriptionConfig struct {
	// Enabled off serves no subscriptions at all, for a deployment that
	// distributes configurations some other way.
	Enabled  bool   `yaml:"enabled"`
	Listen   string `yaml:"listen"`
	Port     int    `yaml:"port"`
	BasePath string `yaml:"base_path"`
	Domain   string `yaml:"domain"`
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`
	// PublicURL is the address subscribers reach this on, when the panel cannot
	// work it out from the request — behind a proxy that rewrites the Host, or
	// on a port that is mapped elsewhere.
	PublicURL         string   `yaml:"public_url"`
	TrustedProxies    []string `yaml:"trusted_proxies"`
	ReadHeaderTimeout Duration `yaml:"read_header_timeout"`
	ReadTimeout       Duration `yaml:"read_timeout"`
	WriteTimeout      Duration `yaml:"write_timeout"`
	IdleTimeout       Duration `yaml:"idle_timeout"`
}

type DatabaseConfig struct {
	// URL is a full postgres:// DSN. When set it wins over the parts below, so
	// a deployment that is handed a connection string does not have to take it
	// apart.
	URL      string `yaml:"url"`
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	Name     string `yaml:"name"`
	SSLMode  string `yaml:"ssl_mode"`
	TimeZone string `yaml:"time_zone"`

	MaxOpenConns    int      `yaml:"max_open_conns"`
	MaxIdleConns    int      `yaml:"max_idle_conns"`
	ConnMaxLifetime Duration `yaml:"conn_max_lifetime"`
	ConnMaxIdleTime Duration `yaml:"conn_max_idle_time"`

	MigrationsDir string `yaml:"migrations_dir"`
}

type SessionConfig struct {
	// Secret signs the session cookie. An empty value is generated at startup,
	// which logs every operator out on restart: an inconvenience while
	// developing, and a defect anywhere else, so the API warns about it loudly
	// rather than leaving it to be noticed.
	Secret string `yaml:"secret"`
	// MaxAge of 0 means a session cookie that lives until the browser closes.
	MaxAge Duration `yaml:"max_age"`
}

type WorkerConfig struct {
	// TimeLocation is the zone every cron spec below is interpreted in, so a
	// "reset at midnight" means midnight where the operator is.
	TimeLocation string `yaml:"time_location"`
	// DepleteSpec disables clients that ran out of quota or time.
	DepleteSpec string `yaml:"deplete_spec"`
	// ResetSpec is the periodic per-client traffic reset. Empty disables it.
	ResetSpec string `yaml:"reset_spec"`
	// CleanupSpec drops traffic samples past the retention window.
	CleanupSpec string `yaml:"cleanup_spec"`
	// StatsRetention is how long traffic samples are kept. Zero keeps none:
	// samples are still counted against a client's total, but nothing is
	// stored per bucket and the traffic charts stay empty.
	StatsRetention Duration `yaml:"stats_retention"`
	// StatsBucket is the resolution traffic samples are rounded down to before
	// being stored. Larger buckets mean fewer rows and a coarser chart.
	StatsBucket Duration `yaml:"stats_bucket"`
}

// Default returns the configuration used when no file supplies a value. Every
// field is set here, so a partial config file overrides rather than blanks.
func Default() *Config {
	return &Config{
		Log: LogConfig{Level: "info"},
		Server: ServerConfig{
			Listen:            "",
			Port:              8000,
			BasePath:          "/",
			TrustedProxies:    nil,
			WebDir:            "web",
			ReadHeaderTimeout: Duration(20 * time.Second),
			ReadTimeout:       Duration(5 * time.Minute),
			WriteTimeout:      Duration(5 * time.Minute),
			IdleTimeout:       Duration(2 * time.Minute),
			ShutdownTimeout:   Duration(30 * time.Second),
		},
		Subscription: SubscriptionConfig{
			Enabled:           true,
			Listen:            "",
			Port:              8443,
			BasePath:          "/sub/",
			ReadHeaderTimeout: Duration(20 * time.Second),
			ReadTimeout:       Duration(30 * time.Second),
			WriteTimeout:      Duration(60 * time.Second),
			IdleTimeout:       Duration(2 * time.Minute),
		},
		Database: DatabaseConfig{
			Host:            "127.0.0.1",
			Port:            5432,
			User:            "x_ui",
			Name:            "x_ui",
			SSLMode:         "disable",
			TimeZone:        "UTC",
			MaxOpenConns:    25,
			MaxIdleConns:    5,
			ConnMaxLifetime: Duration(time.Hour),
			ConnMaxIdleTime: Duration(5 * time.Minute),
			MigrationsDir:   "migrations",
		},
		Session: SessionConfig{MaxAge: 0},
		Worker: WorkerConfig{
			TimeLocation:   "UTC",
			DepleteSpec:    "@every 1m",
			ResetSpec:      "",
			CleanupSpec:    "@daily",
			StatsRetention: Duration(30 * 24 * time.Hour),
			StatsBucket:    Duration(time.Minute),
		},
	}
}

// Load reads the config file, then applies environment variables. Later sources
// win, so a container can set a password without a file and a developer can
// keep one in a file without setting anything.
//
// There is one configuration and no environment selecting between several. What
// differs between a laptop and a deployment is a handful of values -- an
// address, a password, a session secret -- and those come from the environment,
// where they can differ without a file having to describe every place the panel
// might run.
func Load() (*Config, error) {
	cfg := Default()

	if err := cfg.mergeFile(filepath.Join(Dir(), "config.yaml")); err != nil {
		return nil, err
	}

	cfg.applyEnv()

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Dir reports where the config file lives.
func Dir() string {
	if dir := os.Getenv(envPrefix + "CONFIG_DIR"); dir != "" {
		return dir
	}
	return "configs"
}

// mergeFile decodes a file over the config already built, replacing the keys it
// names and leaving the rest of the defaults standing. A missing file is not an
// error: the defaults are a complete configuration on their own, which is what
// lets a container run on environment variables alone.
func (c *Config) mergeFile(path string) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := yaml.Unmarshal(data, c); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

func (c *Config) applyEnv() {
	envString(&c.Log.Level, "LOG_LEVEL")

	envString(&c.Server.Listen, "SERVER_LISTEN")
	envInt(&c.Server.Port, "SERVER_PORT")
	envString(&c.Server.BasePath, "SERVER_BASE_PATH")
	envString(&c.Server.Domain, "SERVER_DOMAIN")
	envString(&c.Server.CertFile, "SERVER_CERT_FILE")
	envString(&c.Server.KeyFile, "SERVER_KEY_FILE")
	envList(&c.Server.TrustedProxies, "SERVER_TRUSTED_PROXIES")
	envString(&c.Server.WebDir, "SERVER_WEB_DIR")

	envBool(&c.Subscription.Enabled, "SUBSCRIPTION_ENABLED")
	envString(&c.Subscription.Listen, "SUBSCRIPTION_LISTEN")
	envInt(&c.Subscription.Port, "SUBSCRIPTION_PORT")
	envString(&c.Subscription.BasePath, "SUBSCRIPTION_BASE_PATH")
	envString(&c.Subscription.Domain, "SUBSCRIPTION_DOMAIN")
	envString(&c.Subscription.CertFile, "SUBSCRIPTION_CERT_FILE")
	envString(&c.Subscription.KeyFile, "SUBSCRIPTION_KEY_FILE")
	envString(&c.Subscription.PublicURL, "SUBSCRIPTION_PUBLIC_URL")
	envList(&c.Subscription.TrustedProxies, "SUBSCRIPTION_TRUSTED_PROXIES")

	envString(&c.Database.URL, "DATABASE_URL")
	envString(&c.Database.Host, "DATABASE_HOST")
	envInt(&c.Database.Port, "DATABASE_PORT")
	envString(&c.Database.User, "DATABASE_USER")
	envString(&c.Database.Password, "DATABASE_PASSWORD")
	envString(&c.Database.Name, "DATABASE_NAME")
	envString(&c.Database.SSLMode, "DATABASE_SSL_MODE")
	envString(&c.Database.MigrationsDir, "DATABASE_MIGRATIONS_DIR")

	envString(&c.Session.Secret, "SESSION_SECRET")
	envDuration(&c.Session.MaxAge, "SESSION_MAX_AGE")

	envString(&c.Worker.TimeLocation, "WORKER_TIME_LOCATION")
	envString(&c.Worker.DepleteSpec, "WORKER_DEPLETE_SPEC")
	envString(&c.Worker.ResetSpec, "WORKER_RESET_SPEC")
	envString(&c.Worker.CleanupSpec, "WORKER_CLEANUP_SPEC")
	envDuration(&c.Worker.StatsRetention, "WORKER_STATS_RETENTION")
	envDuration(&c.Worker.StatsBucket, "WORKER_STATS_BUCKET")
}

func envString(target *string, key string) {
	if v, ok := os.LookupEnv(envPrefix + key); ok {
		*target = v
	}
}

func envInt(target *int, key string) {
	v, ok := os.LookupEnv(envPrefix + key)
	if !ok {
		return
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return
	}
	*target = n
}

func envBool(target *bool, key string) {
	v, ok := os.LookupEnv(envPrefix + key)
	if !ok {
		return
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return
	}
	*target = parsed
}

func envDuration(target *Duration, key string) {
	v, ok := os.LookupEnv(envPrefix + key)
	if !ok {
		return
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return
	}
	*target = Duration(d)
}

func envList(target *[]string, key string) {
	v, ok := os.LookupEnv(envPrefix + key)
	if !ok {
		return
	}
	if strings.TrimSpace(v) == "" {
		*target = nil
		return
	}
	parts := strings.Split(v, ",")
	list := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			list = append(list, p)
		}
	}
	*target = list
}

// Validate rejects a configuration the process cannot serve, at startup rather
// than on the first request that trips over it.
func (c *Config) Validate() error {
	// 0 is allowed and means "any free port": a test run binds that way so
	// parallel runs do not collide.
	if c.Server.Port < 0 || c.Server.Port > 65535 {
		return fmt.Errorf("server.port %d is out of range", c.Server.Port)
	}
	// Both or neither: one alone puts the server into TLS mode with half a
	// configuration and fails to start with an error naming neither setting.
	if (c.Server.CertFile == "") != (c.Server.KeyFile == "") {
		return fmt.Errorf("server.cert_file and server.key_file must be set together")
	}
	if c.Subscription.Enabled {
		if c.Subscription.Port < 0 || c.Subscription.Port > 65535 {
			return fmt.Errorf("subscription.port %d is out of range", c.Subscription.Port)
		}
		// Two listeners on one port is a startup failure with a confusing
		// message; saying it here names both settings. Port 0 is exempt: it
		// means "any free port", so two of them never land on the same one.
		if c.Subscription.Port != 0 && c.Subscription.Port == c.Server.Port && c.Subscription.Listen == c.Server.Listen {
			return fmt.Errorf("subscription.port %d collides with server.port on the same address", c.Subscription.Port)
		}
		if (c.Subscription.CertFile == "") != (c.Subscription.KeyFile == "") {
			return fmt.Errorf("subscription.cert_file and subscription.key_file must be set together")
		}
	}
	if c.Database.URL == "" && c.Database.Name == "" {
		return fmt.Errorf("database.name is required when database.url is not set")
	}
	if _, err := time.LoadLocation(c.Worker.TimeLocation); err != nil {
		return fmt.Errorf("worker.time_location %q: %w", c.Worker.TimeLocation, err)
	}
	// Checked everywhere rather than only where an environment name said to: a
	// database reached across a network without TLS is wrong wherever it
	// happens, and the host is what says whether it is being reached across
	// one. A connection that never leaves the machine is exempt, because
	// requiring TLS there would only push operators into turning the check off.
	if c.Database.SSLMode == "disable" && !isLocal(c.Database.Host) {
		return fmt.Errorf("database.ssl_mode must not be disable for a remote database")
	}
	return nil
}

func isLocal(host string) bool {
	return host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// Debug reports whether the log level asks for the machinery underneath to
// speak up too: the SQL behind every query, and gin's route table. An operator
// who turns the log up is asking what the process is actually doing, and those
// are the parts of it the panel's own log never covers. It used to be the
// development environment that decided this, which meant the only way to see a
// query was to be running the environment that talks to a laptop's database.
func (l LogConfig) Debug() bool {
	return strings.EqualFold(l.Level, "debug")
}

// DSN renders the connection string for the postgres driver.
func (d DatabaseConfig) DSN() string {
	if d.URL != "" {
		return d.URL
	}
	timeZone := d.TimeZone
	if timeZone == "" {
		timeZone = "UTC"
	}
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s TimeZone=%s",
		d.Host, d.Port, d.User, d.Password, d.Name, d.SSLMode, timeZone,
	)
}

// Redacted renders the DSN with the password removed, for logs and for the
// error a failed connection reports.
func (d DatabaseConfig) Redacted() string {
	if d.URL != "" {
		u, err := url.Parse(d.URL)
		if err != nil {
			return "postgres://<unparsable url>"
		}
		if u.User != nil {
			u.User = url.User(u.User.Username())
		}
		return u.String()
	}
	return fmt.Sprintf("host=%s port=%d user=%s dbname=%s sslmode=%s",
		d.Host, d.Port, d.User, d.Name, d.SSLMode)
}

// BasePath normalises the panel's mount point to a leading and trailing slash,
// so route registration and redirects agree about where the panel lives.
func (s ServerConfig) Base() string {
	path := s.BasePath
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if !strings.HasSuffix(path, "/") {
		path += "/"
	}
	return path
}

// Addr is the host:port the server listens on.
func (s ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Listen, s.Port)
}

// TLSEnabled reports whether the server should serve HTTPS itself.
func (s ServerConfig) TLSEnabled() bool {
	return s.CertFile != "" && s.KeyFile != ""
}

// Base normalises the subscription mount point to a leading and trailing slash.
func (s SubscriptionConfig) Base() string {
	path := s.BasePath
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if !strings.HasSuffix(path, "/") {
		path += "/"
	}
	return path
}

func (s SubscriptionConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Listen, s.Port)
}

func (s SubscriptionConfig) TLSEnabled() bool {
	return s.CertFile != "" && s.KeyFile != ""
}

// PublicBase is the address a subscription is fetched from, written the way an
// operator would hand it to a subscriber: a subscriber's own URL is this with
// their name on the end.
//
// PublicURL wins when it is set, because a deployment behind something that
// rewrites Host cannot be worked out from the request -- which is the whole
// reason that setting exists. Otherwise it is assembled from what the listener
// was configured with, falling back to the host the request arrived on for the
// one part a panel cannot know about itself.
func (s SubscriptionConfig) PublicBase(host string) string {
	if s.PublicURL != "" {
		base := strings.TrimSuffix(s.PublicURL, "/")

		return base + s.Base()
	}

	scheme := "http"
	if s.TLSEnabled() {
		scheme = "https"
	}
	if s.Domain != "" {
		host = s.Domain
	}

	// The port is left off when it is the one the scheme implies, so an
	// ordinary deployment hands out a URL without one rather than :443.
	authority := host
	if !(s.Port == 80 && scheme == "http") && !(s.Port == 443 && scheme == "https") {
		authority = net.JoinHostPort(host, strconv.Itoa(s.Port))
	}

	return scheme + "://" + authority + s.Base()
}
