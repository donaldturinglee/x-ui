package agent

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// StatsSource reads traffic from the proxy core.
//
// Different core APIs expose counters differently; the reporting loop does not
// need to depend on their wire formats.
type StatsSource interface {
	// Read returns the traffic measured since the previous call. Deltas, never
	// running totals: the panel adds what it is sent.
	Read(ctx context.Context) ([]domain.TrafficReport, error)
}

// Reporter moves measurements from the core to the panel.
type Reporter struct {
	client *PanelClient
	source StatsSource

	// pending holds what a failed send could not deliver. Read is destructive
	// -- the counters it drained are gone from the core -- so dropping a failed
	// batch loses that traffic permanently, and a subscriber's quota silently
	// stops counting for as long as the panel is unreachable.
	pending []domain.TrafficReport
}

func NewReporter(client *PanelClient, source StatsSource) *Reporter {
	return &Reporter{client: client, source: source}
}

// Report reads the core and sends what it found, together with anything a
// previous attempt could not deliver.
func (r *Reporter) Report(ctx context.Context) error {
	measured, err := r.source.Read(ctx)
	if err != nil {
		return err
	}

	batch := append(r.pending, measured...)
	r.pending = nil
	if len(batch) == 0 {
		return nil
	}

	if err := r.client.ReportTraffic(ctx, batch); err != nil {
		r.pending = batch
		logger.Warning("holding ", len(batch), " traffic report(s) for the next attempt: ", err)
		return err
	}
	return nil
}

// Pending reports how much is waiting to be delivered, for the shutdown log.
func (r *Reporter) Pending() int {
	return len(r.pending)
}

// noStats is the source for a node that serves configuration but measures
// nothing.
type noStats struct{}

func (noStats) Read(context.Context) ([]domain.TrafficReport, error) { return nil, nil }

// NewStatsSource builds the configured source.
func NewStatsSource(cfg StatsConfig) StatsSource {
	if cfg.Source == StatsSourceSingBox {
		return NewSingBoxStats(cfg)
	}
	if cfg.Source == StatsSourceClash {
		return NewClashStats(cfg)
	}
	return noStats{}
}
