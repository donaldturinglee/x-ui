package repository

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
)

// ClientFilter narrows a client listing. A zero filter lists everything.
type ClientFilter struct {
	// Group, when set, restricts the listing to one group.
	Group string
	// Search matches the name, description or remark, case-insensitively.
	Search string
	// Enabled, when set, restricts to enabled or disabled clients.
	Enabled *bool
	// Limit of 0 means no limit.
	Limit  int
	Offset int
}

type ClientRepository struct {
	db *gorm.DB
}

// listColumns is what a listing selects. Config holds the clients' credentials,
// so it is not sent to build a table of several hundred rows.
//
// Inbounds is. The table shows how many listeners each client may use, a
// listener's card counts the clients that may use it, and an edit opened from a
// row sends the set back whole -- the API replaces it rather than merging -- so
// a listing without it is an edit that cuts the client off from every listener.
var listColumns = []string{
	"id", "enable", "name", "description", "group_name", "remark", "inbounds",
	"volume", "expiry", "up", "down", "total_up", "total_down",
	"created_at", "online_at", "delay_start", "auto_reset", "reset_days", "next_reset",
}

// filtered narrows a query the way a ClientFilter says, apart from paging. The
// listing and its count share it, so the total a page is counted against is the
// total of what was searched for rather than of everyone.
func filtered(query *gorm.DB, filter ClientFilter) *gorm.DB {
	if filter.Group != "" {
		query = query.Where("group_name = ?", filter.Group)
	}
	if filter.Search != "" {
		// ILIKE rather than LIKE: an operator looking for a client by name
		// should not have to reproduce its capitalisation.
		pattern := "%" + filter.Search + "%"
		query = query.Where("name ILIKE ? OR description ILIKE ? OR remark ILIKE ?", pattern, pattern, pattern)
	}
	if filter.Enabled != nil {
		query = query.Where("enable = ?", *filter.Enabled)
	}
	return query
}

func (r *ClientRepository) List(ctx context.Context, filter ClientFilter) ([]domain.Client, error) {
	query := filtered(r.db.WithContext(ctx).Model(&domain.Client{}).Select(listColumns), filter)

	if filter.Limit > 0 {
		query = query.Limit(filter.Limit)
	}
	if filter.Offset > 0 {
		query = query.Offset(filter.Offset)
	}

	var clients []domain.Client
	if err := query.Order("id ASC").Find(&clients).Error; err != nil {
		return nil, err
	}
	return clients, nil
}

func (r *ClientRepository) Count(ctx context.Context, filter ClientFilter) (int64, error) {
	query := filtered(r.db.WithContext(ctx).Model(&domain.Client{}), filter)
	var count int64
	err := query.Count(&count).Error
	return count, err
}

func (r *ClientRepository) FindById(ctx context.Context, id uint) (*domain.Client, error) {
	var client domain.Client
	err := r.db.WithContext(ctx).First(&client, id).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("client %d", id)
	}
	if err != nil {
		return nil, err
	}
	return &client, nil
}

func (r *ClientRepository) FindByName(ctx context.Context, name string) (*domain.Client, error) {
	var client domain.Client
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&client).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("client %q", name)
	}
	if err != nil {
		return nil, err
	}
	return &client, nil
}

// NameTaken reports whether another client already holds this name. excludeId
// is the client being edited, which is allowed to keep its own name.
func (r *ClientRepository) NameTaken(ctx context.Context, name string, excludeId uint) (bool, error) {
	query := r.db.WithContext(ctx).Model(&domain.Client{}).Where("name = ?", name)
	if excludeId != 0 {
		query = query.Where("id <> ?", excludeId)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func (r *ClientRepository) Create(ctx context.Context, client *domain.Client) error {
	return r.db.WithContext(ctx).Create(client).Error
}

func (r *ClientRepository) Save(ctx context.Context, client *domain.Client) error {
	return r.db.WithContext(ctx).Save(client).Error
}

func (r *ClientRepository) Delete(ctx context.Context, id uint) error {
	res := r.db.WithContext(ctx).Delete(&domain.Client{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.NotFoundf("client %d", id)
	}
	return nil
}

// AddTraffic adds a reporting period's bytes onto each named client and marks
// it as having been online.
//
// The counters are incremented in SQL rather than read, added to and written
// back: two nodes reporting for the same client at the same moment would
// otherwise each overwrite the other's contribution with a stale base.
func (r *ClientRepository) AddTraffic(ctx context.Context, traffic map[string]domain.Traffic, at int64) error {
	for name, t := range traffic {
		update := map[string]interface{}{"online_at": at}
		if t.Up > 0 {
			update["up"] = gorm.Expr("up + ?", t.Up)
		}
		if t.Down > 0 {
			update["down"] = gorm.Expr("down + ?", t.Down)
		}
		err := r.db.WithContext(ctx).
			Model(&domain.Client{}).
			Where("name = ?", name).
			Updates(update).Error
		if err != nil {
			return err
		}
	}
	return nil
}

// depletedCondition matches an enabled client that has spent its quota or
// passed its expiry. A client still waiting for its first byte is left alone:
// its expiry has not started counting.
const depletedCondition = `enable = true AND (
	(volume > 0 AND up + down > volume) OR
	(delay_start = false AND expiry > 0 AND expiry < ?)
)`

// ListDepleted returns the clients that should be taken offline.
func (r *ClientRepository) ListDepleted(ctx context.Context, now int64) ([]domain.Client, error) {
	var clients []domain.Client
	err := r.db.WithContext(ctx).
		Where(depletedCondition, now).
		Order("id ASC").
		Find(&clients).Error
	if err != nil {
		return nil, err
	}
	return clients, nil
}

// DisableDepleted takes every depleted client offline in one statement, and
// reports how many.
func (r *ClientRepository) DisableDepleted(ctx context.Context, now int64) (int64, error) {
	res := r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Where(depletedCondition, now).
		Update("enable", false)
	return res.RowsAffected, res.Error
}

// ListAwaitingFirstByte returns enabled clients whose clock is held and which
// have now moved traffic, so the worker can start their period.
func (r *ClientRepository) ListAwaitingFirstByte(ctx context.Context) ([]domain.Client, error) {
	var clients []domain.Client
	err := r.db.WithContext(ctx).
		Where("enable = true AND delay_start = true AND up + down > 0").
		Order("id ASC").
		Find(&clients).Error
	if err != nil {
		return nil, err
	}
	return clients, nil
}

// ListDueForReset returns the periodic clients whose next reset has arrived.
//
// reset_days > 0 is a backstop rather than a detail: at zero the next reset is
// computed as now + 0, so the row matches again on the worker's next pass and
// the client's quota is never reached.
func (r *ClientRepository) ListDueForReset(ctx context.Context, now int64) ([]domain.Client, error) {
	var clients []domain.Client
	err := r.db.WithContext(ctx).
		Where("delay_start = false AND auto_reset = true AND reset_days > 0 AND next_reset < ?", now).
		Order("id ASC").
		Find(&clients).Error
	if err != nil {
		return nil, err
	}
	return clients, nil
}

// ResetAllTraffic rolls every client's current period into its lifetime totals,
// zeroes the counters and re-enables everyone. Used by the global periodic
// reset.
func (r *ClientRepository) ResetAllTraffic(ctx context.Context) (int64, error) {
	res := r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Where("up + down > 0 OR enable = false").
		UpdateColumns(map[string]interface{}{
			"total_up":   gorm.Expr("total_up + up"),
			"total_down": gorm.Expr("total_down + down"),
			"up":         0,
			"down":       0,
			"enable":     true,
		})
	return res.RowsAffected, res.Error
}

// ResetTraffic does the same for one client.
func (r *ClientRepository) ResetTraffic(ctx context.Context, id uint) error {
	res := r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Where("id = ?", id).
		UpdateColumns(map[string]interface{}{
			"total_up":   gorm.Expr("total_up + up"),
			"total_down": gorm.Expr("total_down + down"),
			"up":         0,
			"down":       0,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.NotFoundf("client %d", id)
	}
	return nil
}

// ListByInbound returns the clients that reference an inbound.
func (r *ClientRepository) ListByInbound(ctx context.Context, inboundId uint) ([]domain.Client, error) {
	var clients []domain.Client
	err := r.db.WithContext(ctx).
		Where("inbounds @> to_jsonb(?::bigint)", inboundId).
		Order("id ASC").
		Find(&clients).Error
	if err != nil {
		return nil, err
	}
	return clients, nil
}

// ListEnabledByInbound returns the enabled clients that reference an inbound:
// the ones a node lets in through it. Ordered by id, so the generated document
// reads the same on every fetch until something in it changes.
func (r *ClientRepository) ListEnabledByInbound(ctx context.Context, inboundId uint) ([]domain.Client, error) {
	var clients []domain.Client
	err := r.db.WithContext(ctx).
		Where("enable = true AND inbounds @> to_jsonb(?::bigint)", inboundId).
		Order("id ASC").
		Find(&clients).Error
	if err != nil {
		return nil, err
	}
	return clients, nil
}

// SetConfig rewrites one client's identities and nothing else. A whole-row save
// from outside the client's own edit would write back traffic counters read
// before a node's report landed, and hand the subscriber that traffic again.
func (r *ClientRepository) SetConfig(ctx context.Context, id uint, config domain.JSON) error {
	return r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Where("id = ?", id).
		UpdateColumn("config", config).Error
}

// RemoveInboundReference drops an inbound from every client that referenced it,
// and reports how many were changed.
//
// Done in SQL over the jsonb array rather than by reading every client, editing
// and writing back: deleting one inbound on a panel with thousands of
// subscribers is otherwise thousands of round trips inside one transaction.
//
// Without this, a deleted inbound leaves its id in every list that named it.
// Nothing reports an error -- the id simply resolves to nothing -- and the
// subscriber's subscription silently comes back one node short.
func (r *ClientRepository) RemoveInboundReference(ctx context.Context, inboundId uint) (int64, error) {
	res := r.db.WithContext(ctx).Exec(`
		UPDATE clients
		SET inbounds = COALESCE(
			(SELECT jsonb_agg(entry)
			 FROM jsonb_array_elements(inbounds) AS entry
			 WHERE entry <> to_jsonb(?::bigint)),
			'[]'::jsonb)
		WHERE inbounds @> to_jsonb(?::bigint)`, inboundId, inboundId)
	return res.RowsAffected, res.Error
}

// AddInboundReference adds an inbound to the named clients, skipping any that
// already have it.
func (r *ClientRepository) AddInboundReference(ctx context.Context, inboundId uint, clientIds []uint) (int64, error) {
	if len(clientIds) == 0 {
		return 0, nil
	}
	res := r.db.WithContext(ctx).Exec(`
		UPDATE clients
		SET inbounds = COALESCE(inbounds, '[]'::jsonb) || to_jsonb(?::bigint)
		WHERE id IN ?
		  AND NOT (COALESCE(inbounds, '[]'::jsonb) @> to_jsonb(?::bigint))`,
		inboundId, clientIds, inboundId)
	return res.RowsAffected, res.Error
}

// ListOnlineNames returns the names of clients that moved traffic since the
// given time.
//
// "Online" is derived from the last traffic rather than tracked as a flag: a
// node that dies without saying so would otherwise leave its clients marked
// online for as long as the panel stayed up.
func (r *ClientRepository) ListOnlineNames(ctx context.Context, since int64) ([]string, error) {
	var names []string
	err := r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Where("online_at >= ?", since).
		Order("name ASC").
		Pluck("name", &names).Error
	if err != nil {
		return nil, err
	}
	return names, nil
}

// Groups returns the distinct group names in use, for the panel's filter.
func (r *ClientRepository) Groups(ctx context.Context) ([]string, error) {
	var groups []string
	err := r.db.WithContext(ctx).
		Model(&domain.Client{}).
		Distinct().
		Where("group_name <> ''").
		Order("group_name ASC").
		Pluck("group_name", &groups).Error
	if err != nil {
		return nil, err
	}
	return groups, nil
}
