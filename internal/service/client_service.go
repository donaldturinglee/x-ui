package service

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
	"github.com/donaldturinglee/x-ui/pkg/validator"
)

// maxResetDays bounds the reset period. A year is already well past anything
// an operator means by "periodic", and the bound keeps reset_days * 86400 from
// running off into a timestamp nothing will ever reach.
const maxResetDays = 365

// ClientService owns subscribers: their quotas, their expiry, and the two
// background passes that enforce both.
type ClientService struct {
	store *repository.Store
}

func NewClientService(store *repository.Store) *ClientService {
	return &ClientService{store: store}
}

func (s *ClientService) List(ctx context.Context, filter repository.ClientFilter) ([]domain.Client, error) {
	return s.store.Clients.List(ctx, filter)
}

func (s *ClientService) Count(ctx context.Context, filter repository.ClientFilter) (int64, error) {
	return s.store.Clients.Count(ctx, filter)
}

func (s *ClientService) Get(ctx context.Context, id uint) (*domain.Client, error) {
	return s.store.Clients.FindById(ctx, id)
}

func (s *ClientService) GetByName(ctx context.Context, name string) (*domain.Client, error) {
	return s.store.Clients.FindByName(ctx, name)
}

func (s *ClientService) Groups(ctx context.Context) ([]string, error) {
	return s.store.Clients.Groups(ctx)
}

// Create stores a new client and records who made it.
func (s *ClientService) Create(ctx context.Context, actor string, client *domain.Client) error {
	client.Name = strings.TrimSpace(client.Name)
	if err := s.validate(ctx, client); err != nil {
		return err
	}

	// Server-owned from the start: a caller that sends traffic counters or a
	// creation time on a new client is either confused or trying something.
	now := time.Now().Unix()
	client.Id = 0
	client.CreatedAt = now
	client.OnlineAt = 0
	client.Up, client.Down = 0, 0
	client.TotalUp, client.TotalDown = 0, 0
	if client.AutoReset && client.NextReset == 0 && !client.DelayStart {
		client.NextReset = now + int64(client.ResetDays)*86400
	}

	// Credentials are minted here rather than asked for. A subscriber cannot
	// connect without one, and an operator who has to supply a uuid by hand for
	// every protocol will eventually reuse one.
	if err := s.provisionIdentities(ctx, client); err != nil {
		return err
	}

	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Clients.Create(ctx, client); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "clients", "new", clientRef(client))
	})
}

// Update rewrites a client, keeping the fields the server owns.
func (s *ClientService) Update(ctx context.Context, actor string, client *domain.Client) error {
	client.Name = strings.TrimSpace(client.Name)
	if client.Id == 0 {
		return domain.Invalidf("client id is required")
	}
	if err := s.validate(ctx, client); err != nil {
		return err
	}

	existing, err := s.store.Clients.FindById(ctx, client.Id)
	if err != nil {
		return err
	}
	// Traffic counters and timestamps are the server's to write. Taking them
	// from the request would let an edit -- or a stale form posted back --
	// hand a client its quota again.
	client.CreatedAt = existing.CreatedAt
	client.OnlineAt = existing.OnlineAt
	client.Up = existing.Up
	client.Down = existing.Down
	client.TotalUp = existing.TotalUp
	client.TotalDown = existing.TotalDown

	// A caller that sends no config keeps the one already stored: an edit that
	// only changes a quota must not blank the credentials every client
	// application of theirs is holding.
	if len(client.Config) == 0 {
		client.Config = existing.Config
	}
	// Newly assigned protocols get credentials, and the display names follow a
	// rename. Nothing already set is regenerated.
	if err := s.provisionIdentities(ctx, client); err != nil {
		return err
	}

	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Clients.Save(ctx, client); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "clients", "edit", clientRef(client))
	})
}

// provisionIdentities mints whatever credentials the client's assigned inbounds
// need, and keeps the display names in step with the client's own name.
func (s *ClientService) provisionIdentities(ctx context.Context, client *domain.Client) error {
	ids, err := clientInboundIds(client)
	if err != nil {
		return err
	}
	inbounds, err := s.store.Inbounds.ListByIds(ctx, ids)
	if err != nil {
		return err
	}

	var keys []string
	seen := map[string]bool{}
	for i := range inbounds {
		options, err := decodeObject(inbounds[i].Options, "inbound options")
		if err != nil {
			// An unreadable inbound is not the client's fault and must not
			// block their edit; they simply get no credential for it.
			logger.Warning("skipping identities for inbound ", inbounds[i].Tag, ": ", err)
			continue
		}
		for _, key := range identityKeysFor(inbounds[i].Type, options) {
			if !seen[key] {
				seen[key] = true
				keys = append(keys, key)
			}
		}
	}

	return ensureIdentities(client, keys)
}

func (s *ClientService) Delete(ctx context.Context, actor string, id uint) error {
	client, err := s.store.Clients.FindById(ctx, id)
	if err != nil {
		return err
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Clients.Delete(ctx, id); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "clients", "del", clientRef(client))
	})
}

// ResetTraffic zeroes one client's current period.
func (s *ClientService) ResetTraffic(ctx context.Context, actor string, id uint) error {
	client, err := s.store.Clients.FindById(ctx, id)
	if err != nil {
		return err
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Clients.ResetTraffic(ctx, id); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "clients", "reset", clientRef(client))
	})
}

// ResetAllTraffic zeroes every client's current period and re-enables everyone.
func (s *ClientService) ResetAllTraffic(ctx context.Context, actor string) (int64, error) {
	var affected int64
	err := s.store.Tx(ctx, func(tx *repository.Store) error {
		var err error
		affected, err = tx.Clients.ResetAllTraffic(ctx)
		if err != nil {
			return err
		}
		if affected == 0 {
			return nil
		}
		return recordChange(ctx, tx, actor, "clients", "reset", "all")
	})
	return affected, err
}

// Deplete takes offline every client that has spent its quota or passed its
// expiry, records why for each one, and names them.
//
// The rows are read before the bulk update rather than after, because after it
// they no longer match the condition and there would be nothing left to name
// in the audit log -- or in the notification the worker sends about them.
func (s *ClientService) Deplete(ctx context.Context) ([]string, error) {
	now := time.Now().Unix()

	var names []string
	err := s.store.Tx(ctx, func(tx *repository.Store) error {
		depleted, err := tx.Clients.ListDepleted(ctx, now)
		if err != nil {
			return err
		}
		if len(depleted) == 0 {
			return nil
		}

		changes := make([]domain.Change, 0, len(depleted))
		disabling := make([]string, 0, len(depleted))
		for _, client := range depleted {
			logger.Debug("client ", client.Name, " is going to be disabled")
			obj, err := json.Marshal(clientRef(&client))
			if err != nil {
				return err
			}
			changes = append(changes, domain.Change{
				DateTime: now,
				Actor:    domain.ActorDepleteJob,
				Key:      "clients",
				Action:   "disable",
				Obj:      domain.JSON(obj),
			})
			disabling = append(disabling, client.Name)
		}

		if _, err := tx.Clients.DisableDepleted(ctx, now); err != nil {
			return err
		}
		if err := tx.Stats.AddChanges(ctx, changes); err != nil {
			return err
		}
		names = disabling
		return nil
	})
	return names, err
}

// RunPeriodicResets starts the clock for clients waiting on their first byte,
// and rolls over the ones whose period has come round.
func (s *ClientService) RunPeriodicResets(ctx context.Context) (int64, error) {
	now := time.Now().Unix()

	var updated int64
	err := s.store.Tx(ctx, func(tx *repository.Store) error {
		waiting, err := tx.Clients.ListAwaitingFirstByte(ctx)
		if err != nil {
			return err
		}
		due, err := tx.Clients.ListDueForReset(ctx, now)
		if err != nil {
			return err
		}
		if len(waiting) == 0 && len(due) == 0 {
			return nil
		}

		changes := make([]domain.Change, 0, len(waiting)+len(due))
		appendChange := func(client *domain.Client, action string) error {
			obj, err := json.Marshal(clientRef(client))
			if err != nil {
				return err
			}
			changes = append(changes, domain.Change{
				DateTime: now,
				Actor:    domain.ActorResetJob,
				Key:      "clients",
				Action:   action,
				Obj:      domain.JSON(obj),
			})
			return nil
		}

		for i := range waiting {
			client := &waiting[i]
			client.StartClock(now)
			if err := tx.Clients.Save(ctx, client); err != nil {
				return err
			}
			if err := appendChange(client, "start"); err != nil {
				return err
			}
			updated++
		}

		for i := range due {
			client := &due[i]
			client.ResetPeriod(now)
			// A client disabled for running out of quota comes back when its
			// quota does; one disabled by an operator stays off, which is why
			// this looks at the quota rather than just re-enabling everything.
			if !client.Enable && !client.Expired(now) {
				client.Enable = true
			}
			if err := tx.Clients.Save(ctx, client); err != nil {
				return err
			}
			if err := appendChange(client, "reset"); err != nil {
				return err
			}
			updated++
		}

		return tx.Stats.AddChanges(ctx, changes)
	})
	return updated, err
}

func (s *ClientService) validate(ctx context.Context, client *domain.Client) error {
	v := validator.New()
	v.Required("name", client.Name)
	v.MaxLen("name", client.Name, 64)
	v.MaxLen("desc", client.Desc, 500)
	v.MaxLen("group", client.Group, 64)
	v.MaxLen("remark", client.Remark, 500)
	v.NonNegative("volume", client.Volume)
	v.NonNegative("expiry", client.Expiry)
	v.Range("resetDays", int64(client.ResetDays), 0, maxResetDays)
	if client.AutoReset {
		v.Check(client.ResetDays > 0, "resetDays", "must be set when autoReset is on")
	}
	if err := v.Err(); err != nil {
		return err
	}

	taken, err := s.store.Clients.NameTaken(ctx, client.Name, client.Id)
	if err != nil {
		return err
	}
	if taken {
		return domain.Conflictf("client name %q is already in use", client.Name)
	}

	return s.validateInbounds(ctx, client.Inbounds)
}

// validateInbounds rejects a client pointed at an inbound that does not exist.
// Left unchecked, the client is stored, appears configured, and never works.
func (s *ClientService) validateInbounds(ctx context.Context, raw domain.JSON) error {
	if len(raw) == 0 {
		return nil
	}
	var ids []uint
	if err := json.Unmarshal(raw.Raw(), &ids); err != nil {
		return domain.Invalidf("inbounds must be a JSON array of inbound ids")
	}
	if len(ids) == 0 {
		return nil
	}

	found, err := s.store.Inbounds.ListByIds(ctx, ids)
	if err != nil {
		return err
	}
	known := make(map[uint]bool, len(found))
	for _, inbound := range found {
		known[inbound.Id] = true
	}
	for _, id := range ids {
		if !known[id] {
			return domain.Invalidf("inbound %d does not exist", id)
		}
	}
	return nil
}

// clientRef is what the audit log stores for a client: enough to identify it
// later, and nothing that would put its credentials in a table anyone with
// read access to the log can see.
func clientRef(client *domain.Client) map[string]interface{} {
	return map[string]interface{}{
		"id":   client.Id,
		"name": client.Name,
	}
}
