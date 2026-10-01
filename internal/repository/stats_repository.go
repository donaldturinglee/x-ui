package repository

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// purgeChunk caps how many rows one retention DELETE removes, so the table is
// not locked for the length of a backlog. One unbounded DELETE over a month of
// samples holds its locks long enough to make the cleanup itself a cause of
// lost traffic accounting.
const purgeChunk = 5000

// ChangeFilter narrows the audit log.
type ChangeFilter struct {
	Actor string
	Key   string
	Limit int
}

type StatsRepository struct {
	db *gorm.DB
}

// RenameTag carries the resource's history to its new name. A previously used
// name can already have buckets, so merge those rather than lose either count
// or fail on the unique bucket index. The caller owns the transaction.
func (r *StatsRepository) RenameTag(ctx context.Context, resource, oldTag, newTag string) error {
	if oldTag == newTag {
		return nil
	}
	if err := r.db.WithContext(ctx).Exec(`
		INSERT INTO stats (resource, tag, date_time, direction, traffic)
		SELECT resource, ?, date_time, direction, traffic FROM stats
		WHERE resource = ? AND tag = ?
		FOR UPDATE
		ON CONFLICT (resource, tag, date_time, direction)
		DO UPDATE SET traffic = stats.traffic + excluded.traffic`,
		newTag, resource, oldTag).Error; err != nil {
		return err
	}
	return r.db.WithContext(ctx).Where("resource = ? AND tag = ?", resource, oldTag).
		Delete(&domain.Stat{}).Error
}

// AddSamples accumulates traffic into its buckets.
//
// Each row is added onto whatever is already in that bucket rather than
// inserted beside it, so a node reporting more often than the bucket width
// produces one row per bucket instead of one per report.
func (r *StatsRepository) AddSamples(ctx context.Context, samples []domain.Stat) error {
	if len(samples) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{
				{Name: "resource"}, {Name: "tag"}, {Name: "date_time"}, {Name: "direction"},
			},
			DoUpdates: clause.Assignments(map[string]interface{}{
				"traffic": gorm.Expr("stats.traffic + excluded.traffic"),
			}),
		}).
		Create(&samples).Error
}

// Query returns the samples for one resource and tag inside a time range,
// oldest first.
func (r *StatsRepository) Query(ctx context.Context, resources []string, tag string, start int64, end int64) ([]domain.Stat, error) {
	var stats []domain.Stat
	err := r.db.WithContext(ctx).
		Where("resource IN ? AND tag = ? AND date_time > ? AND date_time <= ?", resources, tag, start, end).
		Order("date_time ASC").
		Find(&stats).Error
	if err != nil {
		return nil, err
	}
	return stats, nil
}

// ListRecentTags returns the tags of one kind of resource that moved traffic
// since the given time, which is what "currently online" means here.
func (r *StatsRepository) ListRecentTags(ctx context.Context, resource string, since int64) ([]string, error) {
	var tags []string
	err := r.db.WithContext(ctx).
		Model(&domain.Stat{}).
		Distinct().
		Where("resource = ? AND date_time >= ? AND traffic > 0", resource, since).
		Order("tag ASC").
		Pluck("tag", &tags).Error
	if err != nil {
		return nil, err
	}
	return tags, nil
}

// DeleteOlderThan drops samples from before a cutoff, in bounded chunks, and
// reports how many rows went.
func (r *StatsRepository) DeleteOlderThan(ctx context.Context, before int64) (int64, error) {
	var total int64
	for {
		res := r.db.WithContext(ctx).
			Where("id IN (?)",
				r.db.Model(&domain.Stat{}).Select("id").Where("date_time < ?", before).Limit(purgeChunk),
			).
			Delete(&domain.Stat{})
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
		if res.RowsAffected < purgeChunk {
			return total, nil
		}
	}
}

// AddChange records one audit entry.
func (r *StatsRepository) AddChange(ctx context.Context, change *domain.Change) error {
	return r.db.WithContext(ctx).Create(change).Error
}

// AddChanges records several audit entries at once.
func (r *StatsRepository) AddChanges(ctx context.Context, changes []domain.Change) error {
	if len(changes) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Create(&changes).Error
}

// LatestChangeId returns the highest audit-log id, which is the cursor a panel
// polls against. Zero means nothing has ever been recorded.
//
// An id rather than a timestamp: it is strictly monotonic, so two changes in
// the same second are still distinguishable, and it cannot go backwards if the
// host's clock does.
func (r *StatsRepository) LatestChangeId(ctx context.Context) (uint64, error) {
	var latest *uint64
	err := r.db.WithContext(ctx).
		Model(&domain.Change{}).
		Select("MAX(id)").
		Scan(&latest).Error
	if err != nil {
		return 0, err
	}
	if latest == nil {
		return 0, nil
	}
	return *latest, nil
}

// ListChanges returns audit entries newest first.
func (r *StatsRepository) ListChanges(ctx context.Context, filter ChangeFilter) ([]domain.Change, error) {
	query := r.db.WithContext(ctx).Model(&domain.Change{})
	if filter.Actor != "" {
		query = query.Where("actor = ?", filter.Actor)
	}
	if filter.Key != "" {
		query = query.Where("key = ?", filter.Key)
	}
	// Always bounded: the audit log only grows, and an unbounded read of it is
	// a request that gets slower every week until it stops finishing.
	limit := filter.Limit
	if limit < 1 || limit > 1000 {
		limit = 100
	}

	var changes []domain.Change
	err := query.Order("date_time DESC, id DESC").Limit(limit).Find(&changes).Error
	if err != nil {
		return nil, err
	}
	return changes, nil
}
