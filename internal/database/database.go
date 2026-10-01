package database

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// migrationLockKey is the advisory lock every migrating process takes first.
// The API and the worker are separate processes that both migrate on startup,
// and without it a deploy that starts them together runs the same CREATE TABLE
// twice.
const migrationLockKey int64 = 8_101_974_233_001

// migrationsTable records what has already been applied.
const migrationsTable = "schema_migrations"

// Open connects to PostgreSQL and configures the pool.
func Open(cfg config.DatabaseConfig, debug bool) (*gorm.DB, error) {
	gormCfg := &gorm.Config{
		Logger: gormlogger.Discard,
		// The panel stores unix seconds, not timestamps, so GORM's automatic
		// CreatedAt/UpdatedAt handling has nothing to write and would only
		// surprise a reader of the generated SQL.
		SkipDefaultTransaction: true,
	}
	if debug {
		gormCfg.Logger = gormlogger.Default.LogMode(gormlogger.Info)
	}

	db, err := gorm.Open(postgres.Open(cfg.DSN()), gormCfg)
	if err != nil {
		// The DSN carries the password, so the redacted form is what gets
		// reported -- a connection error is exactly the kind of thing that ends
		// up pasted into an issue.
		return nil, fmt.Errorf("connect to %s: %w", cfg.Redacted(), err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(cfg.ConnMaxLifetime.Duration())
	sqlDB.SetConnMaxIdleTime(cfg.ConnMaxIdleTime.Duration())

	return db, nil
}

// Ping checks the connection is usable. Open only builds the pool: it does not
// dial, so without this a bad address is first reported by whichever request
// happens to arrive.
func Ping(ctx context.Context, db *gorm.DB) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	return sqlDB.PingContext(ctx)
}

// Health answers whether the datastore is reachable, for the liveness
// endpoint. It is a type rather than a bare function so the handler can depend
// on a small interface instead of on GORM.
type Health struct {
	db *gorm.DB
}

func NewHealth(db *gorm.DB) *Health {
	return &Health{db: db}
}

func (h *Health) Ping(ctx context.Context) error {
	return Ping(ctx, h.db)
}

// Close releases the pool.
func Close(db *gorm.DB) error {
	if db == nil {
		return nil
	}
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// IsNotFound reports whether an error is GORM's "no rows" and not a real
// failure.
func IsNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}

// Migration is one versioned pair of .up.sql / .down.sql files.
type Migration struct {
	Version int64
	Name    string
	UpPath  string
	// DownPath is empty for a migration with no rollback.
	DownPath string
	Applied  bool
	// AppliedAt is a unix time, zero when the migration is still pending.
	AppliedAt int64
}

// LoadMigrations reads the migration directory and returns every migration it
// finds, in version order.
//
// A file is named <version>_<name>.up.sql, with a matching .down.sql. A version
// used twice is rejected rather than resolved: two people adding a migration on
// the same day is routine, and picking one of them silently would apply
// different schemas in different places.
func LoadMigrations(dir string) ([]Migration, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations from %s: %w", dir, err)
	}

	byVersion := map[int64]*Migration{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		direction := ""
		switch {
		case strings.HasSuffix(name, ".up.sql"):
			direction = "up"
		case strings.HasSuffix(name, ".down.sql"):
			direction = "down"
		default:
			continue
		}

		base := strings.TrimSuffix(name, "."+direction+".sql")
		versionText, label, found := strings.Cut(base, "_")
		if !found {
			return nil, fmt.Errorf("migration %s: expected <version>_<name>.%s.sql", name, direction)
		}
		version, err := strconv.ParseInt(versionText, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("migration %s: version %q is not a number", name, versionText)
		}

		m := byVersion[version]
		if m == nil {
			m = &Migration{Version: version, Name: label}
			byVersion[version] = m
		}
		if m.Name != label {
			return nil, fmt.Errorf("migration version %d is used by both %q and %q", version, m.Name, label)
		}

		path := filepath.Join(dir, name)
		if direction == "up" {
			if m.UpPath != "" {
				return nil, fmt.Errorf("migration version %d has more than one up file", version)
			}
			m.UpPath = path
		} else {
			m.DownPath = path
		}
	}

	migrations := make([]Migration, 0, len(byVersion))
	for _, m := range byVersion {
		if m.UpPath == "" {
			return nil, fmt.Errorf("migration version %d has a down file but no up file", m.Version)
		}
		migrations = append(migrations, *m)
	}
	sort.Slice(migrations, func(i, j int) bool {
		return migrations[i].Version < migrations[j].Version
	})
	return migrations, nil
}

// Status returns every migration with whether it has been applied.
func Status(ctx context.Context, db *gorm.DB, dir string) ([]Migration, error) {
	migrations, err := LoadMigrations(dir)
	if err != nil {
		return nil, err
	}
	if err := ensureMigrationsTable(ctx, db); err != nil {
		return nil, err
	}
	applied, err := appliedVersions(ctx, db)
	if err != nil {
		return nil, err
	}
	for i := range migrations {
		if at, ok := applied[migrations[i].Version]; ok {
			migrations[i].Applied = true
			migrations[i].AppliedAt = at
		}
	}
	return migrations, nil
}

// Migrate applies every pending migration, in version order.
func Migrate(ctx context.Context, db *gorm.DB, dir string) error {
	return withMigrationLock(ctx, db, func() error {
		migrations, err := Status(ctx, db, dir)
		if err != nil {
			return err
		}

		pending := 0
		for _, m := range migrations {
			if m.Applied {
				continue
			}
			pending++
			if err := applyUp(ctx, db, m); err != nil {
				return fmt.Errorf("migration %d_%s: %w", m.Version, m.Name, err)
			}
			logger.Info("applied migration ", m.Version, "_", m.Name)
		}
		if pending == 0 {
			logger.Debug("database schema is up to date")
		}
		return nil
	})
}

// Rollback reverts the last `steps` applied migrations, newest first.
func Rollback(ctx context.Context, db *gorm.DB, dir string, steps int) error {
	if steps < 1 {
		return fmt.Errorf("rollback needs a positive number of steps, got %d", steps)
	}
	return withMigrationLock(ctx, db, func() error {
		migrations, err := Status(ctx, db, dir)
		if err != nil {
			return err
		}

		done := 0
		for i := len(migrations) - 1; i >= 0 && done < steps; i-- {
			m := migrations[i]
			if !m.Applied {
				continue
			}
			if m.DownPath == "" {
				return fmt.Errorf("migration %d_%s has no down file and cannot be rolled back", m.Version, m.Name)
			}
			if err := applyDown(ctx, db, m); err != nil {
				return fmt.Errorf("rollback %d_%s: %w", m.Version, m.Name, err)
			}
			logger.Info("rolled back migration ", m.Version, "_", m.Name)
			done++
		}
		if done == 0 {
			return errors.New("nothing to roll back")
		}
		return nil
	})
}

// withMigrationLock runs fn while holding the advisory lock, on one pinned
// connection. The lock is session-scoped, so it has to be taken and released on
// the same connection -- taking it through the pool would leave it held by
// whichever connection happened to serve the call.
func withMigrationLock(ctx context.Context, db *gorm.DB, fn func() error) error {
	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	conn, err := sqlDB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		return fmt.Errorf("take migration lock: %w", err)
	}
	defer func() {
		if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", migrationLockKey); err != nil {
			logger.Warning("unable to release migration lock: ", err)
		}
	}()

	return fn()
}

func ensureMigrationsTable(ctx context.Context, db *gorm.DB) error {
	return db.WithContext(ctx).Exec(`
		CREATE TABLE IF NOT EXISTS ` + migrationsTable + ` (
			version    bigint      PRIMARY KEY,
			name       text        NOT NULL,
			applied_at bigint      NOT NULL
		)`).Error
}

func appliedVersions(ctx context.Context, db *gorm.DB) (map[int64]int64, error) {
	type row struct {
		Version   int64
		AppliedAt int64
	}
	var rows []row
	err := db.WithContext(ctx).
		Raw("SELECT version, applied_at FROM " + migrationsTable).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	applied := make(map[int64]int64, len(rows))
	for _, r := range rows {
		applied[r.Version] = r.AppliedAt
	}
	return applied, nil
}

// applyUp runs one migration and records it, in a single transaction. Postgres
// makes DDL transactional, so a file that fails halfway leaves nothing behind
// and the version is not recorded.
func applyUp(ctx context.Context, db *gorm.DB, m Migration) error {
	statements, err := os.ReadFile(m.UpPath)
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(string(statements)).Error; err != nil {
			return err
		}
		return tx.Exec(
			"INSERT INTO "+migrationsTable+" (version, name, applied_at) VALUES ($1, $2, $3)",
			m.Version, m.Name, time.Now().Unix(),
		).Error
	})
}

func applyDown(ctx context.Context, db *gorm.DB, m Migration) error {
	statements, err := os.ReadFile(m.DownPath)
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(string(statements)).Error; err != nil {
			return err
		}
		return tx.Exec("DELETE FROM "+migrationsTable+" WHERE version = $1", m.Version).Error
	})
}
