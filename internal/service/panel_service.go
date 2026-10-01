package service

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// Snapshot is everything a panel needs to render itself, in one response.
//
// It exists because the alternative is a frontend polling eight endpoints and
// diffing the results: more requests, more round trips, and no cheap way to ask
// "has anything changed at all".
type Snapshot struct {
	// Cursor identifies the state this snapshot was taken at. A client sends it
	// back as `lu` on the next poll.
	Cursor uint64 `json:"lu"`
	// Changed is false when nothing has happened since the cursor the client
	// sent, in which case everything below Onlines is omitted.
	Changed bool `json:"changed"`

	// Onlines is always present: it is what the panel updates between changes,
	// and it is the reason a poll that found nothing changed still returns
	// something worth having.
	Onlines *Onlines `json:"onlines,omitempty"`

	Clients   []domain.Client          `json:"clients,omitempty"`
	Inbounds  []map[string]interface{} `json:"inbounds,omitempty"`
	Outbounds []map[string]interface{} `json:"outbounds,omitempty"`
	Settings  map[string]string        `json:"settings,omitempty"`
	Config    domain.JSON              `json:"config,omitempty"`

	// Maintenance is carried on every poll, changed or not, so the panel can
	// keep saying service is stopped on purpose wherever the operator happens
	// to be looking.
	Maintenance bool `json:"maintenance"`
}

// PanelService assembles the snapshot the panel polls for.
type PanelService struct {
	store     *repository.Store
	clients   *ClientService
	inbounds  *InboundService
	outbounds *OutboundService
	settings  *SettingService
	configs   *ConfigService
	stats     *StatsService
}

func NewPanelService(
	store *repository.Store,
	clients *ClientService,
	inbounds *InboundService,
	outbounds *OutboundService,
	settings *SettingService,
	configs *ConfigService,
	stats *StatsService,
) *PanelService {
	return &PanelService{
		store:     store,
		clients:   clients,
		inbounds:  inbounds,
		outbounds: outbounds,
		settings:  settings,
		configs:   configs,
		stats:     stats,
	}
}

// Load returns a snapshot, or just the cursor and what moves between changes
// when nothing has happened since the client's last poll.
//
// The cursor is the highest audit-log id, read from the database rather than
// held in memory. An in-process counter would be wrong here: the API and the
// worker are separate processes, and the worker disabling a depleted client is
// exactly the kind of change the panel has to notice.
func (s *PanelService) Load(ctx context.Context, since uint64) (*Snapshot, error) {
	cursor, err := s.store.Stats.LatestChangeId(ctx)
	if err != nil {
		return nil, err
	}

	snapshot := &Snapshot{
		Cursor: cursor,
		// A first poll sends no cursor and gets everything; after that, only a
		// cursor behind the current one does.
		Changed: since == 0 || since != cursor,
	}

	if maintenance, err := s.settings.Maintenance(ctx); err == nil {
		snapshot.Maintenance = maintenance
	}

	onlines, err := s.stats.Onlines(ctx)
	if err != nil {
		return nil, err
	}
	snapshot.Onlines = onlines

	if !snapshot.Changed {
		return snapshot, nil
	}

	if snapshot.Clients, err = s.clients.List(ctx, repository.ClientFilter{Limit: snapshotClientLimit}); err != nil {
		return nil, err
	}
	if snapshot.Inbounds, err = s.inbounds.List(ctx); err != nil {
		return nil, err
	}
	if snapshot.Outbounds, err = s.outbounds.List(ctx); err != nil {
		return nil, err
	}
	if snapshot.Settings, err = s.settings.All(ctx); err != nil {
		return nil, err
	}
	if snapshot.Config, err = s.configs.Base(ctx); err != nil {
		return nil, err
	}

	return snapshot, nil
}

// snapshotClientLimit bounds the client list a snapshot carries.
//
// Everything else in a snapshot is configuration an operator wrote, and there
// is never much of it. Clients are the one collection that grows without
// bound, and a panel with fifty thousand subscribers should not send all of
// them on every poll -- past this, the paged listing is the right endpoint.
const snapshotClientLimit = 1000
