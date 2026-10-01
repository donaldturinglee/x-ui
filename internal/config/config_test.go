package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeConfig lays out a config directory holding the one file the loader reads
// and points it there. An empty body writes nothing, which is how the case of a
// deployment with no file at all is set up.
func writeConfig(t *testing.T, body string) string {
	t.Helper()

	dir := t.TempDir()
	if body != "" {
		if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o600); err != nil {
			t.Fatalf("write config.yaml: %v", err)
		}
	}
	t.Setenv(envPrefix+"CONFIG_DIR", dir)
	return dir
}

func TestLoadUsesDefaultsWhenNoFileExists(t *testing.T) {
	writeConfig(t, "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// A missing file is not an error: the defaults are a complete
	// configuration, which is what lets a container run on environment
	// variables alone.
	if cfg.Server.Port != 8000 {
		t.Errorf("port = %d, want 8000", cfg.Server.Port)
	}
	if cfg.Database.MigrationsDir != "migrations" {
		t.Errorf("migrations dir = %q, want %q", cfg.Database.MigrationsDir, "migrations")
	}
}

func TestLoadReplacesOnlyTheKeysTheFileNames(t *testing.T) {
	writeConfig(t, "server:\n  port: 2222\nlog:\n  level: debug\n")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Server.Port != 2222 {
		t.Errorf("port = %d, want the file's 2222", cfg.Server.Port)
	}
	// The file says nothing about base_path, so the default has to survive: a
	// file overrides the keys it names rather than blanking the rest.
	if cfg.Server.BasePath != "/" {
		t.Errorf("base_path = %q, want the default %q", cfg.Server.BasePath, "/")
	}
}

func TestEnvironmentOverridesTheFile(t *testing.T) {
	writeConfig(t, "server:\n  port: 1111\ndatabase:\n  password: from-file\n")
	t.Setenv(envPrefix+"SERVER_PORT", "3333")
	t.Setenv(envPrefix+"DATABASE_PASSWORD", "from-env")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Server.Port != 3333 {
		t.Errorf("port = %d, want 3333 from the environment", cfg.Server.Port)
	}
	// This is the whole point of the precedence order: a secret can be
	// supplied at deploy time without ever being written to a file.
	if cfg.Database.Password != "from-env" {
		t.Errorf("password = %q, want %q", cfg.Database.Password, "from-env")
	}
}

func TestDurationsParseAsText(t *testing.T) {
	writeConfig(t, "server:\n  read_timeout: 45s\nworker:\n  stats_retention: 48h\n")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if got := cfg.Server.ReadTimeout.Duration(); got != 45*time.Second {
		t.Errorf("read_timeout = %v, want 45s", got)
	}
	if got := cfg.Worker.StatsRetention.Duration(); got != 48*time.Hour {
		t.Errorf("stats_retention = %v, want 48h", got)
	}
}

func TestLoadRejectsAnUnreadableDuration(t *testing.T) {
	writeConfig(t, "server:\n  read_timeout: soon\n")

	if _, err := Load(); err == nil {
		t.Fatal("Load accepted read_timeout: soon, want an error")
	}
}

func TestValidate(t *testing.T) {
	cases := map[string]struct {
		mutate func(*Config)
		want   string
	}{
		"a certificate without a key": {
			mutate: func(c *Config) { c.Server.CertFile = "cert.pem" },
			want:   "must be set together",
		},
		"a key without a certificate": {
			mutate: func(c *Config) { c.Server.KeyFile = "key.pem" },
			want:   "must be set together",
		},
		"a port out of range": {
			mutate: func(c *Config) { c.Server.Port = 70000 },
			want:   "out of range",
		},
		"no database name": {
			mutate: func(c *Config) { c.Database.Name = "" },
			want:   "database.name is required",
		},
		"an unknown time zone": {
			mutate: func(c *Config) { c.Worker.TimeLocation = "Mars/Olympus" },
			want:   "worker.time_location",
		},
		"an unencrypted remote database": {
			mutate: func(c *Config) {
				c.Database.Host = "db.example.com"
				c.Database.SSLMode = "disable"
			},
			want: "ssl_mode",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := Default()
			tc.mutate(cfg)

			err := cfg.Validate()
			if err == nil {
				t.Fatal("Validate accepted the configuration, want an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestValidateAcceptsAPortOfZero(t *testing.T) {
	cfg := Default()
	cfg.Server.Port = 0

	// 0 means "any free port", which is how a test run avoids colliding with a
	// parallel one.
	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate rejected port 0: %v", err)
	}
}

func TestValidateAcceptsAnUnencryptedLocalDatabase(t *testing.T) {
	cfg := Default()
	cfg.Database.Host = "127.0.0.1"
	cfg.Database.SSLMode = "disable"

	// A unix-local connection never leaves the host, so requiring TLS there
	// would only push operators into turning the check off entirely.
	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate rejected a local database: %v", err)
	}
}

func TestDSN(t *testing.T) {
	t.Run("built from parts", func(t *testing.T) {
		cfg := Default()
		cfg.Database.Password = "hunter2"

		dsn := cfg.Database.DSN()
		for _, want := range []string{"host=127.0.0.1", "port=5432", "dbname=x_ui", "password=hunter2"} {
			if !strings.Contains(dsn, want) {
				t.Errorf("DSN = %q, want it to contain %q", dsn, want)
			}
		}
	})

	t.Run("a URL wins over the parts", func(t *testing.T) {
		cfg := Default()
		cfg.Database.URL = "postgres://u:p@example.com:5432/db"

		if got := cfg.Database.DSN(); got != cfg.Database.URL {
			t.Errorf("DSN = %q, want the configured URL", got)
		}
	})
}

func TestRedactedHidesThePassword(t *testing.T) {
	t.Run("parts", func(t *testing.T) {
		cfg := Default()
		cfg.Database.Password = "hunter2"

		// A connection error is exactly the kind of thing that ends up pasted
		// into an issue, so the form that goes into one carries no secret.
		if got := cfg.Database.Redacted(); strings.Contains(got, "hunter2") {
			t.Errorf("Redacted = %q, want the password removed", got)
		}
	})

	t.Run("URL", func(t *testing.T) {
		cfg := Default()
		cfg.Database.URL = "postgres://user:hunter2@example.com:5432/db"

		got := cfg.Database.Redacted()
		if strings.Contains(got, "hunter2") {
			t.Errorf("Redacted = %q, want the password removed", got)
		}
		if !strings.Contains(got, "user") {
			t.Errorf("Redacted = %q, want the user kept -- it is half of what a connection error is about", got)
		}
	})
}

func TestBaseNormalisesThePath(t *testing.T) {
	cases := map[string]string{
		"/app/": "/app/",
		"/app":  "/app/",
		"app/":  "/app/",
		"app":   "/app/",
		"/":     "/",
	}

	for given, want := range cases {
		cfg := Default()
		cfg.Server.BasePath = given
		// Route registration, redirects and the asset prefix all build on this,
		// so they have to agree about where the panel lives.
		if got := cfg.Server.Base(); got != want {
			t.Errorf("Base(%q) = %q, want %q", given, got, want)
		}
	}
}

func TestLogDebugDecidesTheNoisyMachinery(t *testing.T) {
	cases := map[string]bool{
		"debug": true,
		"DEBUG": true,
		"info":  false,
		"":      false,
	}

	for level, want := range cases {
		cfg := Default()
		cfg.Log.Level = level
		// SQL logging and gin's mode both hang off this. It is the one switch
		// left where the environment name used to decide.
		if got := cfg.Log.Debug(); got != want {
			t.Errorf("Debug(%q) = %v, want %v", level, got, want)
		}
	}
}

func TestPublicBaseIsWhatAnOperatorHandsOver(t *testing.T) {
	cfg := Default()

	// Nothing configured: the request's own host, the port it listens on, and
	// the path it is mounted at.
	if got := cfg.Subscription.PublicBase("panel.example.com"); got != "http://panel.example.com:8443/sub/" {
		t.Errorf("PublicBase = %q", got)
	}

	// A certificate makes it https, and a domain replaces the request's host --
	// which is the whole point of having configured one.
	cfg.Subscription.CertFile = "cert.pem"
	cfg.Subscription.KeyFile = "key.pem"
	cfg.Subscription.Domain = "sub.example.com"
	if got := cfg.Subscription.PublicBase("panel.example.com"); got != "https://sub.example.com:8443/sub/" {
		t.Errorf("PublicBase = %q", got)
	}
}

func TestPublicBaseLeavesOffThePortTheSchemeImplies(t *testing.T) {
	cfg := Default()
	cfg.Subscription.Port = 80

	// An ordinary deployment hands out a URL without a port rather than one
	// ending :80, which reads as something gone wrong.
	if got := cfg.Subscription.PublicBase("sub.example.com"); got != "http://sub.example.com/sub/" {
		t.Errorf("PublicBase = %q", got)
	}

	cfg.Subscription.Port = 443
	cfg.Subscription.CertFile = "cert.pem"
	cfg.Subscription.KeyFile = "key.pem"
	if got := cfg.Subscription.PublicBase("sub.example.com"); got != "https://sub.example.com/sub/" {
		t.Errorf("PublicBase = %q", got)
	}
}

func TestPublicBasePrefersWhatWasConfigured(t *testing.T) {
	cfg := Default()
	cfg.Subscription.PublicURL = "https://cdn.example.com"

	// Behind something that rewrites Host, nothing about the request is worth
	// reading -- which is why this setting exists. The mount point is still
	// appended: it is where this panel serves, not where the proxy forwards.
	if got := cfg.Subscription.PublicBase("internal-1.local"); got != "https://cdn.example.com/sub/" {
		t.Errorf("PublicBase = %q", got)
	}

	// A trailing slash on the configured value must not double up.
	cfg.Subscription.PublicURL = "https://cdn.example.com/"
	if got := cfg.Subscription.PublicBase("internal-1.local"); got != "https://cdn.example.com/sub/" {
		t.Errorf("PublicBase = %q", got)
	}
}

func TestTLSEnabledNeedsBothHalves(t *testing.T) {
	cfg := Default()
	if cfg.Server.TLSEnabled() {
		t.Error("TLSEnabled with neither file set")
	}
	cfg.Server.CertFile = "cert.pem"
	if cfg.Server.TLSEnabled() {
		t.Error("TLSEnabled with only a certificate")
	}
	cfg.Server.KeyFile = "key.pem"
	if !cfg.Server.TLSEnabled() {
		t.Error("not TLSEnabled with both files set")
	}
}
