package domain

import "testing"

const day = int64(86400)

func TestOverQuota(t *testing.T) {
	cases := map[string]struct {
		client Client
		want   bool
	}{
		"unlimited never runs out": {
			client: Client{Volume: 0, Up: 1 << 40, Down: 1 << 40},
			want:   false,
		},
		"under the quota": {
			client: Client{Volume: 100, Up: 40, Down: 40},
			want:   false,
		},
		"exactly at the quota is still allowed": {
			// The quota is what the subscriber bought, so spending all of it is
			// not yet grounds for cutting them off.
			client: Client{Volume: 100, Up: 60, Down: 40},
			want:   false,
		},
		"over the quota": {
			client: Client{Volume: 100, Up: 60, Down: 41},
			want:   true,
		},
		"both directions count": {
			client: Client{Volume: 100, Up: 0, Down: 101},
			want:   true,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.client.OverQuota(); got != tc.want {
				t.Errorf("OverQuota() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExpired(t *testing.T) {
	const now = int64(1_700_000_000)

	cases := map[string]struct {
		client Client
		want   bool
	}{
		"no expiry":            {client: Client{Expiry: 0}, want: false},
		"in the future":        {client: Client{Expiry: now + day}, want: false},
		"in the past":          {client: Client{Expiry: now - 1}, want: true},
		"exactly now is alive": {client: Client{Expiry: now}, want: false},
		"held clock does not expire": {
			// A subscription sold but never used has an expiry that has not
			// started counting. Reading it literally would expire subscribers
			// who never connected.
			client: Client{Expiry: now - day, DelayStart: true},
			want:   false,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.client.Expired(now); got != tc.want {
				t.Errorf("Expired(%d) = %v, want %v", now, got, tc.want)
			}
		})
	}
}

func TestDepleted(t *testing.T) {
	const now = int64(1_700_000_000)

	cases := map[string]struct {
		client Client
		want   bool
	}{
		"healthy":     {client: Client{Enable: true, Volume: 100, Up: 1}, want: false},
		"over quota":  {client: Client{Enable: true, Volume: 100, Up: 101}, want: true},
		"expired":     {client: Client{Enable: true, Expiry: now - 1}, want: true},
		"both limits": {client: Client{Enable: true, Volume: 1, Up: 2, Expiry: now - 1}, want: true},
		"already disabled is not depleted again": {
			// The deplete pass writes an audit entry for everything it matches.
			// Without this, every disabled subscriber would produce one on
			// every run, forever.
			client: Client{Enable: false, Volume: 100, Up: 101},
			want:   false,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.client.Depleted(now); got != tc.want {
				t.Errorf("Depleted(%d) = %v, want %v", now, got, tc.want)
			}
		})
	}
}

func TestDueForReset(t *testing.T) {
	const now = int64(1_700_000_000)

	cases := map[string]struct {
		client Client
		want   bool
	}{
		"due":          {client: Client{AutoReset: true, ResetDays: 30, NextReset: now - 1}, want: true},
		"not yet":      {client: Client{AutoReset: true, ResetDays: 30, NextReset: now + 1}, want: false},
		"not periodic": {client: Client{AutoReset: false, ResetDays: 30, NextReset: now - 1}, want: false},
		"clock not started": {
			client: Client{AutoReset: true, ResetDays: 30, NextReset: now - 1, DelayStart: true},
			want:   false,
		},
		"zero period is never due": {
			// At zero days the next reset is computed as now + 0, so the row
			// matches again on the very next pass and the quota is never
			// reached.
			client: Client{AutoReset: true, ResetDays: 0, NextReset: now - 1},
			want:   false,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.client.DueForReset(now); got != tc.want {
				t.Errorf("DueForReset(%d) = %v, want %v", now, got, tc.want)
			}
		})
	}
}

func TestResetPeriodKeepsLifetimeTotals(t *testing.T) {
	const now = int64(1_700_000_000)

	client := Client{
		Up: 300, Down: 700,
		TotalUp: 1000, TotalDown: 2000,
		AutoReset: true, ResetDays: 30,
	}
	before := client.LifetimeUsed()

	client.ResetPeriod(now)

	if client.Up != 0 || client.Down != 0 {
		t.Errorf("current period = %d/%d, want 0/0", client.Up, client.Down)
	}
	if client.TotalUp != 1300 || client.TotalDown != 2700 {
		t.Errorf("lifetime = %d/%d, want 1300/2700", client.TotalUp, client.TotalDown)
	}
	// A reset moves traffic between counters; it must not destroy any. The
	// lifetime figure is what an operator reconciles against.
	if after := client.LifetimeUsed(); after != before {
		t.Errorf("lifetime used = %d after reset, want %d", after, before)
	}
	if want := now + 30*day; client.NextReset != want {
		t.Errorf("NextReset = %d, want %d", client.NextReset, want)
	}
}

func TestStartClock(t *testing.T) {
	const now = int64(1_700_000_000)

	t.Run("one-off subscription starts its expiry", func(t *testing.T) {
		client := Client{DelayStart: true, ResetDays: 7}
		client.StartClock(now)

		if client.DelayStart {
			t.Error("DelayStart should be cleared once the clock has started")
		}
		if want := now + 7*day; client.Expiry != want {
			t.Errorf("Expiry = %d, want %d", client.Expiry, want)
		}
		if client.NextReset != 0 {
			t.Errorf("NextReset = %d, want 0 for a non-periodic subscription", client.NextReset)
		}
	})

	t.Run("periodic subscription starts its period", func(t *testing.T) {
		client := Client{DelayStart: true, AutoReset: true, ResetDays: 30}
		client.StartClock(now)

		if client.DelayStart {
			t.Error("DelayStart should be cleared once the clock has started")
		}
		if want := now + 30*day; client.NextReset != want {
			t.Errorf("NextReset = %d, want %d", client.NextReset, want)
		}
		// A periodic subscription renews rather than ending, so starting it
		// must not also set an expiry that would cut it off after one period.
		if client.Expiry != 0 {
			t.Errorf("Expiry = %d, want 0 for a periodic subscription", client.Expiry)
		}
	})
}

func TestAwaitingFirstByte(t *testing.T) {
	cases := map[string]struct {
		client Client
		want   bool
	}{
		"used, clock held":   {client: Client{Enable: true, DelayStart: true, Up: 1}, want: true},
		"unused, clock held": {client: Client{Enable: true, DelayStart: true}, want: false},
		"clock already started": {
			client: Client{Enable: true, DelayStart: false, Up: 1},
			want:   false,
		},
		"disabled": {client: Client{Enable: false, DelayStart: true, Up: 1}, want: false},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := tc.client.AwaitingFirstByte(); got != tc.want {
				t.Errorf("AwaitingFirstByte() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBucket(t *testing.T) {
	cases := []struct {
		at      int64
		seconds int64
		want    int64
	}{
		{at: 1_700_000_059, seconds: 60, want: 1_700_000_040},
		{at: 1_700_000_040, seconds: 60, want: 1_700_000_040},
		{at: 1_700_000_061, seconds: 60, want: 1_700_000_040},
		{at: 1_700_000_061, seconds: 1, want: 1_700_000_061},
		// A non-positive width would be a division by zero, and the callers
		// that pass one are reading it from configuration.
		{at: 1_700_000_061, seconds: 0, want: 1_700_000_061},
		{at: 1_700_000_061, seconds: -5, want: 1_700_000_061},
	}

	for _, tc := range cases {
		if got := Bucket(tc.at, tc.seconds); got != tc.want {
			t.Errorf("Bucket(%d, %d) = %d, want %d", tc.at, tc.seconds, got, tc.want)
		}
	}
}
