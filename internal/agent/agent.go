package agent

import (
	"context"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// Agent runs the two loops a node needs: pull the configuration, push the
// traffic.
//
// They are separate loops on separate intervals because they fail differently.
// A configuration fetch that fails leaves the node serving what it already had,
// which is fine for a while. A traffic report that fails loses measurements the
// core has already discarded, which is not — so it runs more often and holds
// what it could not deliver.
type Agent struct {
	cfg      *Config
	syncer   *Syncer
	reporter *Reporter
}

func New(cfg *Config) *Agent {
	client := NewPanelClient(cfg.Panel)
	return &Agent{
		cfg:      cfg,
		syncer:   NewSyncer(client, cfg.Core),
		reporter: NewReporter(client, NewStatsSource(cfg.Stats)),
	}
}

// Run builds an agent from a configuration and works until the context is
// cancelled. It is what the command calls, so the command stays a flag parser.
func Run(ctx context.Context, cfg *Config) error {
	return New(cfg).Run(ctx)
}

// Run works until the context is cancelled.
func (a *Agent) Run(ctx context.Context) error {
	logger.Info("agent started: panel ", a.cfg.Panel.URL, ", core config ", a.cfg.Core.ConfigPath)

	// Both run once immediately. Waiting a full interval on startup means a
	// node that was restarted to pick up a change sits there not having it.
	if _, err := a.syncer.Sync(ctx); err != nil {
		// Not fatal: the panel may still be starting. The loop retries.
		logger.Error("initial configuration sync failed: ", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		a.loop(ctx, a.cfg.Panel.SyncInterval.Duration(), "configuration sync", func(ctx context.Context) error {
			_, err := a.syncer.Sync(ctx)
			return err
		})
	}()

	go func() {
		defer wg.Done()
		a.loop(ctx, a.cfg.Panel.ReportInterval.Duration(), "traffic report", a.reporter.Report)
	}()

	wg.Wait()

	if pending := a.reporter.Pending(); pending > 0 {
		// Said out loud rather than swallowed: this is traffic the core has
		// already forgotten and the panel never received.
		logger.Warning("stopping with ", pending, " traffic report(s) undelivered")
	}
	logger.Info("agent stopped")
	return nil
}

// loop runs work on an interval until the context is cancelled.
//
// Each run is bounded by the interval itself, so a hung request cannot stall
// the loop behind it: the next tick finds the previous one already abandoned
// rather than still waiting.
func (a *Agent) loop(ctx context.Context, interval time.Duration, name string, work func(context.Context) error) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runCtx, cancel := context.WithTimeout(ctx, interval)
			err := work(runCtx)
			cancel()
			if err != nil {
				// Logged, never fatal. A node that stops working because the
				// panel was briefly unreachable is worse than one that keeps
				// serving the configuration it already has.
				logger.Warning(name, " failed: ", err)
			}
		}
	}
}
