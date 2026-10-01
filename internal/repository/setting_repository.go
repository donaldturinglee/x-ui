package repository

import (
	"context"

	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type SettingRepository struct {
	db *gorm.DB
}

// All returns every stored setting. Keys the operator has never touched are
// absent: the service fills them in from the defaults, so a new key added in a
// release takes effect without a migration.
func (r *SettingRepository) All(ctx context.Context) (map[string]string, error) {
	var settings []domain.Setting
	if err := r.db.WithContext(ctx).Find(&settings).Error; err != nil {
		return nil, err
	}
	values := make(map[string]string, len(settings))
	for _, setting := range settings {
		values[setting.Key] = setting.Value
	}
	return values, nil
}

func (r *SettingRepository) Get(ctx context.Context, key string) (string, error) {
	return r.get(ctx, key, false)
}

func (r *SettingRepository) GetForUpdate(ctx context.Context, key string) (string, error) {
	return r.get(ctx, key, true)
}

func (r *SettingRepository) get(ctx context.Context, key string, lock bool) (string, error) {
	var setting domain.Setting
	query := r.db.WithContext(ctx).Where("key = ?", key)
	if lock {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := query.First(&setting).Error
	if database.IsNotFound(err) {
		return "", domain.NotFoundf("setting %q", key)
	}
	if err != nil {
		return "", err
	}
	return setting.Value, nil
}

// Set writes one setting, creating it if it is not there yet.
//
// It is an upsert rather than an UPDATE because rows are created lazily: a
// plain UPDATE affects nothing and reports success when the key has never been
// written, so on a fresh install the settings form could report a save that
// stored nothing.
func (r *SettingRepository) Set(ctx context.Context, key string, value string) error {
	return r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value"}),
		}).
		Create(&domain.Setting{Key: key, Value: value}).Error
}

// SetMany writes several settings at once.
func (r *SettingRepository) SetMany(ctx context.Context, values map[string]string) error {
	if len(values) == 0 {
		return nil
	}
	settings := make([]domain.Setting, 0, len(values))
	for key, value := range values {
		settings = append(settings, domain.Setting{Key: key, Value: value})
	}
	return r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value"}),
		}).
		Create(&settings).Error
}

func (r *SettingRepository) Delete(ctx context.Context, key string) error {
	return r.db.WithContext(ctx).Where("key = ?", key).Delete(&domain.Setting{}).Error
}

// DeleteMany drops the named settings, which puts each back to its default:
// a key with no row reads as its default.
func (r *SettingRepository) DeleteMany(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Where("key IN ?", keys).Delete(&domain.Setting{}).Error
}

// ResetOperatorSettings drops the settings an operator can change, leaving the
// bookkeeping rows.
//
// Keeping those is the point: they are not settings anyone set, and without
// the version row the data reads as a fresh install to whatever runs next.
func (r *SettingRepository) ResetOperatorSettings(ctx context.Context) error {
	protected := make([]string, 0, len(domain.ProtectedSettings))
	for key := range domain.ProtectedSettings {
		protected = append(protected, key)
	}
	return r.db.WithContext(ctx).
		Where("key NOT IN ?", protected).
		Delete(&domain.Setting{}).Error
}
