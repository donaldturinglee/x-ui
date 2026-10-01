package repository

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// InboundRepository persists inbounds. A listener's TLS is one of its options,
// so it is read and written with the rest of the listener rather than resolved
// from anywhere else.
type InboundRepository struct {
	db *gorm.DB
}

func (r *InboundRepository) List(ctx context.Context) ([]domain.Inbound, error) {
	var inbounds []domain.Inbound
	err := r.db.WithContext(ctx).
		Order("id ASC").
		Find(&inbounds).Error
	if err != nil {
		return nil, err
	}
	return inbounds, nil
}

func (r *InboundRepository) ListForUpdate(ctx context.Context) ([]domain.Inbound, error) {
	var inbounds []domain.Inbound
	err := r.db.WithContext(ctx).Clauses(clause.Locking{Strength: "UPDATE"}).
		Order("id ASC").Find(&inbounds).Error
	return inbounds, err
}

func (r *InboundRepository) ListByIds(ctx context.Context, ids []uint) ([]domain.Inbound, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var inbounds []domain.Inbound
	err := r.db.WithContext(ctx).
		Where("id IN ?", ids).
		Order("id ASC").
		Find(&inbounds).Error
	if err != nil {
		return nil, err
	}
	return inbounds, nil
}

func (r *InboundRepository) FindById(ctx context.Context, id uint) (*domain.Inbound, error) {
	var inbound domain.Inbound
	err := r.db.WithContext(ctx).First(&inbound, id).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("inbound %d", id)
	}
	if err != nil {
		return nil, err
	}
	return &inbound, nil
}

func (r *InboundRepository) FindByTag(ctx context.Context, tag string) (*domain.Inbound, error) {
	var inbound domain.Inbound
	err := r.db.WithContext(ctx).Where("tag = ?", tag).First(&inbound).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("inbound %q", tag)
	}
	if err != nil {
		return nil, err
	}
	return &inbound, nil
}

// TagTaken reports whether another inbound already uses this tag.
func (r *InboundRepository) TagTaken(ctx context.Context, tag string, excludeId uint) (bool, error) {
	query := r.db.WithContext(ctx).Model(&domain.Inbound{}).Where("tag = ?", tag)
	if excludeId != 0 {
		query = query.Where("id <> ?", excludeId)
	}
	var count int64
	if err := query.Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

// TagReserved prevents a former name being assigned to a different listener.
// A listener may return to one of its own names without creating an alias chain.
func (r *InboundRepository) TagReserved(ctx context.Context, tag string, excludeId uint) (bool, error) {
	var count int64
	query := r.db.WithContext(ctx).Table("inbound_tag_aliases").Where("tag = ?", tag)
	if excludeId != 0 {
		query = query.Where("inbound_id <> ?", excludeId)
	}
	err := query.Count(&count).Error
	return count > 0, err
}

func (r *InboundRepository) ReserveTag(ctx context.Context, tag string, inboundId uint) error {
	if err := r.db.WithContext(ctx).Exec(
		"INSERT INTO inbound_tag_aliases (tag, inbound_id) VALUES (?, ?) ON CONFLICT (tag) DO NOTHING",
		tag, inboundId).Error; err != nil {
		return err
	}
	reserved, err := r.TagReserved(ctx, tag, inboundId)
	if err != nil {
		return err
	}
	if reserved {
		return domain.Conflictf("inbound tag %q is reserved by another inbound", tag)
	}
	return nil
}

// ResolveTags translates old names to the current name of the same inbound.
// Unknown names, including a deleted listener's, retain their original value.
func (r *InboundRepository) ResolveTags(ctx context.Context, tags []string) (map[string]string, error) {
	resolved := make(map[string]string)
	if len(tags) == 0 {
		return resolved, nil
	}
	var rows []struct {
		Tag          string
		CanonicalTag string
	}
	err := r.db.WithContext(ctx).Table("inbound_tag_aliases AS aliases").
		Select("aliases.tag, inbounds.tag AS canonical_tag").
		Joins("JOIN inbounds ON inbounds.id = aliases.inbound_id").
		Where("aliases.tag IN ?", tags).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		resolved[row.Tag] = row.CanonicalTag
	}
	return resolved, nil
}

func (r *InboundRepository) Create(ctx context.Context, inbound *domain.Inbound) error {
	return r.db.WithContext(ctx).Create(inbound).Error
}

func (r *InboundRepository) Save(ctx context.Context, inbound *domain.Inbound) error {
	return r.db.WithContext(ctx).Save(inbound).Error
}

func (r *InboundRepository) Delete(ctx context.Context, id uint) error {
	res := r.db.WithContext(ctx).Delete(&domain.Inbound{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.NotFoundf("inbound %d", id)
	}
	return nil
}
