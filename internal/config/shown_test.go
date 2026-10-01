package config

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestWhatIsShownHoldsNoSecret(t *testing.T) {
	cfg := Default()
	cfg.Session.Secret = "session-secret-value"
	cfg.Database.Password = "database-password-value"
	cfg.Database.URL = "postgres://tunnel:url-password-value@db.internal/tunnel"

	encoded, err := json.Marshal(cfg.Shown())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, secret := range []string{"session-secret-value", "database-password-value", "url-password-value", "db.internal"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("shown = %s, which gives %q away", encoded, secret)
		}
	}
	// Said to be there, which is what decides whether a session outlives a
	// restart.
	if !cfg.Shown().Session.SecretSet {
		t.Error("a configured session secret was shown as missing")
	}
}

func TestWhatIsShownIsWhatTheProcessRuns(t *testing.T) {
	cfg := Default()
	cfg.Server.BasePath = "panel"
	cfg.Session.MaxAge = Duration(90 * time.Minute)
	cfg.Worker.StatsRetention = Duration(48 * time.Hour)

	shown := cfg.Shown()

	// The base path as it is mounted, and every duration in seconds.
	if shown.Panel.BasePath != "/panel/" {
		t.Errorf("base path = %q, want it as the router mounts it", shown.Panel.BasePath)
	}
	if shown.Session.MaxAgeSeconds != 5400 || shown.Worker.StatsRetentionSeconds != 172800 || shown.Worker.StatsBucketSeconds != 60 {
		t.Errorf("durations = %d/%d/%d, want seconds", shown.Session.MaxAgeSeconds, shown.Worker.StatsRetentionSeconds, shown.Worker.StatsBucketSeconds)
	}
	if shown.Subscription.Port != 8443 || !shown.Subscription.Enabled {
		t.Errorf("subscription = %+v, want the defaults", shown.Subscription)
	}
	// A list that was never set is an empty one, never null.
	if shown.Panel.TrustedProxies == nil {
		t.Error("an unset proxy list was shown as null")
	}
}
