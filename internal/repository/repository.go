package repository

import (
	"context"
	"database/sql"

	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
)

// Store bundles every repository over one connection.
//
// It exists so a service can change two aggregates atomically -- disabling a
// client and writing the audit entry that says why -- without taking a
// *gorm.DB parameter and leaking the ORM into its signature. Tx hands back a
// Store whose repositories all run inside the same transaction.
type Store struct {
	db *gorm.DB

	Users     *UserRepository
	Clients   *ClientRepository
	Inbounds  *InboundRepository
	Outbounds *OutboundRepository
	Settings  *SettingRepository
	Stats     *StatsRepository
}

func NewStore(db *gorm.DB) *Store {
	return &Store{
		db:        db,
		Users:     &UserRepository{db: db},
		Clients:   &ClientRepository{db: db},
		Inbounds:  &InboundRepository{db: db},
		Outbounds: &OutboundRepository{taggedRepository[domain.Outbound]{db: db, label: "outbound"}},
		Settings:  &SettingRepository{db: db},
		Stats:     &StatsRepository{db: db},
	}
}

// DB exposes the handle, for the migrator and for health checks. Business code
// should go through a repository instead.
func (s *Store) DB() *gorm.DB {
	return s.db
}

// Tx runs fn against a Store bound to a single transaction, committing when it
// returns nil and rolling back on any error or panic.
//
// Nesting is safe: GORM turns an inner transaction into a savepoint, so a
// service that calls another service's transactional method still commits once.
func (s *Store) Tx(ctx context.Context, fn func(*Store) error) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(NewStore(tx))
	})
}

// LockTags coordinates tag edits with traffic ingestion across API processes.
// Take it before any row locks, inside a transaction. Reports share the lock;
// edits take it exclusively so a migrated tag cannot receive another old sample.
func (s *Store) LockTags(ctx context.Context, exclusive bool) error {
	const tagLockKey int64 = 8_101_974_233_002
	query := "SELECT pg_advisory_xact_lock_shared(?)"
	if exclusive {
		query = "SELECT pg_advisory_xact_lock(?)"
	}
	return s.db.WithContext(ctx).Exec(query, tagLockKey).Error
}

// ReadSnapshot keeps a configuration assembled from several tables on one
// committed version. Otherwise a rename can commit between reading the base
// rules and the outbound list, pairing an old reference with a new tag.
func (s *Store) ReadSnapshot(ctx context.Context, fn func(*Store) error) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(NewStore(tx))
	}, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
}
