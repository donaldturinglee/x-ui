package config

// Shown is what the panel's settings page shows of the configuration the
// process started with.
//
// All of it is read from configs/config.yaml and the X_UI_* environment
// at startup and takes effect at the next one, which is why it is shown rather
// than edited: a panel that wrote its own listener's port could leave itself
// unreachable, and the file is the one place an operator can always put right.
// Nothing secret is in it. The session secret is said to be set or not, and the
// database is left out altogether.
//
// Durations are whole seconds, for the page to show in whichever unit reads
// best.
type Shown struct {
	Panel        ShownListener     `json:"panel"`
	Subscription ShownSubscription `json:"subscription"`
	Session      ShownSession      `json:"session"`
	Worker       ShownWorker       `json:"worker"`
	LogLevel     string            `json:"logLevel"`
}

// ShownListener is where one of the two listeners is reached.
type ShownListener struct {
	Listen         string   `json:"listen"`
	Port           int      `json:"port"`
	BasePath       string   `json:"basePath"`
	Domain         string   `json:"domain"`
	CertFile       string   `json:"certFile"`
	KeyFile        string   `json:"keyFile"`
	TrustedProxies []string `json:"trustedProxies"`
}

// ShownSubscription is the listener subscribers reach, and the address they are
// told to reach it on.
type ShownSubscription struct {
	ShownListener
	Enabled   bool   `json:"enabled"`
	PublicURL string `json:"publicUrl"`
}

// ShownSession is how long a sign-in lasts, and whether it outlives a restart.
type ShownSession struct {
	// MaxAgeSeconds of 0 keeps a session until the browser closes.
	MaxAgeSeconds int64 `json:"maxAgeSeconds"`
	// SecretSet is whether the session cookie is signed with a configured
	// secret. Without one a secret is generated at every start, and every
	// session ends with the process.
	SecretSet bool `json:"secretSet"`
}

// ShownWorker is when the worker's jobs run, and how much traffic it keeps.
type ShownWorker struct {
	TimeLocation          string `json:"timeLocation"`
	DepleteSpec           string `json:"depleteSpec"`
	ResetSpec             string `json:"resetSpec"`
	CleanupSpec           string `json:"cleanupSpec"`
	StatsRetentionSeconds int64  `json:"statsRetentionSeconds"`
	StatsBucketSeconds    int64  `json:"statsBucketSeconds"`
}

// Shown returns what the settings page shows of this configuration.
func (c *Config) Shown() Shown {
	return Shown{
		Panel: ShownListener{
			Listen:         c.Server.Listen,
			Port:           c.Server.Port,
			BasePath:       c.Server.Base(),
			Domain:         c.Server.Domain,
			CertFile:       c.Server.CertFile,
			KeyFile:        c.Server.KeyFile,
			TrustedProxies: listOrEmpty(c.Server.TrustedProxies),
		},
		Subscription: ShownSubscription{
			ShownListener: ShownListener{
				Listen:         c.Subscription.Listen,
				Port:           c.Subscription.Port,
				BasePath:       c.Subscription.Base(),
				Domain:         c.Subscription.Domain,
				CertFile:       c.Subscription.CertFile,
				KeyFile:        c.Subscription.KeyFile,
				TrustedProxies: listOrEmpty(c.Subscription.TrustedProxies),
			},
			Enabled:   c.Subscription.Enabled,
			PublicURL: c.Subscription.PublicURL,
		},
		Session: ShownSession{
			MaxAgeSeconds: int64(c.Session.MaxAge.Duration().Seconds()),
			SecretSet:     c.Session.Secret != "",
		},
		Worker: ShownWorker{
			TimeLocation:          c.Worker.TimeLocation,
			DepleteSpec:           c.Worker.DepleteSpec,
			ResetSpec:             c.Worker.ResetSpec,
			CleanupSpec:           c.Worker.CleanupSpec,
			StatsRetentionSeconds: int64(c.Worker.StatsRetention.Duration().Seconds()),
			StatsBucketSeconds:    int64(c.Worker.StatsBucket.Duration().Seconds()),
		},
		LogLevel: c.Log.Level,
	}
}

// listOrEmpty writes an unset list as an empty one, so the page is always
// handed a list to show rather than sometimes null.
func listOrEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}
