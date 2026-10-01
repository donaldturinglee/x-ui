package repository

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// taggedRepository is the persistence of a row the core identifies by a type and
// a tag -- an id, a type, a tag and an options blob -- which is what an outbound
// is. The queries are written for the row rather than for the outbound, so a tag
// is unique among its own table and nothing more is asked of it.
type taggedRepository[T any] struct {
	db *gorm.DB
	// label names the kind in a not-found error, which is the one place these
	// queries say what they are operating on.
	label string
}

func (r *taggedRepository[T]) List(ctx context.Context) ([]T, error) {
	var records []T
	if err := r.db.WithContext(ctx).Order("id ASC").Find(&records).Error; err != nil {
		return nil, err
	}
	return records, nil
}

// ListForUpdate serializes edits in id order, including edits to routes whose
// options reference the route being renamed. Use it inside a transaction.
func (r *taggedRepository[T]) ListForUpdate(ctx context.Context) ([]T, error) {
	var records []T
	err := r.db.WithContext(ctx).Clauses(clause.Locking{Strength: "UPDATE"}).
		Order("id ASC").Find(&records).Error
	return records, err
}

func (r *taggedRepository[T]) FindById(ctx context.Context, id uint) (*T, error) {
	var record T
	err := r.db.WithContext(ctx).First(&record, id).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("%s %d", r.label, id)
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (r *taggedRepository[T]) FindByTag(ctx context.Context, tag string) (*T, error) {
	var record T
	err := r.db.WithContext(ctx).Where("tag = ?", tag).First(&record).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("%s %q", r.label, tag)
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

// TagTaken reports whether another record of this kind already uses the tag.
func (r *taggedRepository[T]) TagTaken(ctx context.Context, tag string, excludeId uint) (bool, error) {
	var record T
	query := r.db.WithContext(ctx).Model(&record).Where("tag = ?", tag)
	if excludeId != 0 {
		query = query.Where("id <> ?", excludeId)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func (r *taggedRepository[T]) Count(ctx context.Context) (int64, error) {
	var record T
	var count int64
	err := r.db.WithContext(ctx).Model(&record).Count(&count).Error
	return count, err
}

func (r *taggedRepository[T]) Create(ctx context.Context, record *T) error {
	return r.db.WithContext(ctx).Create(record).Error
}

func (r *taggedRepository[T]) Save(ctx context.Context, record *T) error {
	return r.db.WithContext(ctx).Save(record).Error
}

func (r *taggedRepository[T]) Delete(ctx context.Context, id uint) error {
	var record T
	res := r.db.WithContext(ctx).Delete(&record, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.NotFoundf("%s %d", r.label, id)
	}
	return nil
}

// OutboundRepository persists the routes out of a node, the WireGuard ones among
// them.
type OutboundRepository struct {
	taggedRepository[domain.Outbound]
}
