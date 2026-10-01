package database

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
)

// BackupFormatVersion is the shape of the document Export writes. Import
// refuses anything else rather than guessing: a restore that half-understands
// a file is worse than one that declines it.
const BackupFormatVersion = 1

// maxBackupBytes caps an uploaded backup. It is read into memory to be parsed,
// so the upload has to be bounded by something other than trust.
const maxBackupBytes = 256 << 20

// Backup is a logical export of the panel's data.
//
// Logical rather than a file copy, because the database is PostgreSQL and the
// panel does not own the server it runs on. `pg_dump` remains the right tool
// for an operational backup; this is the one the panel can offer through its
// own API, and the one that restores into a fresh install of a different
// version.
type Backup struct {
	Version  int                        `json:"version"`
	AppName  string                     `json:"app"`
	TakenAt  int64                      `json:"takenAt"`
	Tables   map[string]json.RawMessage `json:"tables"`
	Excluded []string                   `json:"excluded,omitempty"`
}

// backupTable ties a table name to the model that reads and writes it.
type backupTable struct {
	name  string
	read  func(ctx context.Context, db *gorm.DB) (json.RawMessage, error)
	write func(ctx context.Context, db *gorm.DB, rows json.RawMessage) error
}

// backupSchema is every table an export carries, in an order a restore can
// replay: a table that references another comes after it.
func backupSchema() []backupTable {
	return []backupTable{
		table[domain.Setting]("settings"),
		table[domain.User]("users"),
		table[domain.Token]("tokens"),
		inboundTable(),
		table[domain.Outbound]("outbounds"),
		table[domain.Client]("clients"),
		table[domain.Stat]("stats"),
		table[domain.Change]("changes"),
	}
}

func table[T any](name string) backupTable {
	return backupTable{
		name: name,
		read: func(ctx context.Context, db *gorm.DB) (json.RawMessage, error) {
			var rows []T
			if err := db.WithContext(ctx).Find(&rows).Error; err != nil {
				return nil, err
			}
			return json.Marshal(rows)
		},
		write: func(ctx context.Context, db *gorm.DB, raw json.RawMessage) error {
			var rows []T
			if err := json.Unmarshal(raw, &rows); err != nil {
				return fmt.Errorf("table %s: %w", name, err)
			}
			if len(rows) == 0 {
				return nil
			}
			// In batches: a panel with a year of traffic samples has hundreds
			// of thousands of rows, and one statement carrying all of them
			// exceeds what the driver will send.
			return db.WithContext(ctx).CreateInBatches(rows, 500).Error
		},
	}
}

// inboundTable exports the listeners with what the panel keeps beside the core's
// options: where each is published, and what a client is handed -- the client's
// half of its TLS among that. The core's own shape, which the table would be
// written in otherwise, leaves both out, and a restored Reality listener would
// hand out links without the public key they are dialled with.
//
// The id is left behind as that shape left it, so a restored listener is
// numbered as it always has been.
func inboundTable() backupTable {
	inbounds := table[domain.Inbound]("inbounds")
	inbounds.read = func(ctx context.Context, db *gorm.DB) (json.RawMessage, error) {
		var rows []domain.Inbound
		if err := db.WithContext(ctx).Find(&rows).Error; err != nil {
			return nil, err
		}
		return inboundRecords(rows)
	}
	return inbounds
}

// inboundRecords writes listeners as a backup carries them, which is the shape
// they are read back in as well.
func inboundRecords(rows []domain.Inbound) (json.RawMessage, error) {
	records := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		record, err := row.MarshalFull()
		if err != nil {
			return nil, err
		}
		delete(record, "id")
		records = append(records, record)
	}
	return json.Marshal(records)
}

// Export writes a backup. Named tables are left out, which is how an operator
// takes a copy of the configuration without a year of traffic samples.
func Export(ctx context.Context, db *gorm.DB, exclude []string) (*Backup, error) {
	excluded := map[string]bool{}
	for _, name := range exclude {
		excluded[name] = true
	}

	backup := &Backup{
		Version: BackupFormatVersion,
		AppName: "x-ui",
		TakenAt: time.Now().Unix(),
		Tables:  map[string]json.RawMessage{},
	}

	for _, t := range backupSchema() {
		if excluded[t.name] {
			backup.Excluded = append(backup.Excluded, t.name)
			continue
		}
		rows, err := t.read(ctx, db)
		if err != nil {
			return nil, fmt.Errorf("export %s: %w", t.name, err)
		}
		backup.Tables[t.name] = rows
	}
	return backup, nil
}

// Import replaces the panel's data with a backup's.
//
// Everything happens in one transaction, so a file that turns out to be
// unreadable halfway through leaves the existing data untouched rather than
// half-replaced. A table the backup does not carry is left alone: excluding
// stats from an export should not empty the stats table on restore.
func Import(ctx context.Context, db *gorm.DB, reader io.Reader) (*Backup, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, maxBackupBytes))
	if err != nil {
		return nil, err
	}

	var backup Backup
	if err := json.Unmarshal(raw, &backup); err != nil {
		return nil, domain.Invalidf("that is not an x-ui backup: %v", err)
	}
	if backup.Version != BackupFormatVersion {
		return nil, domain.Invalidf("backup format version %d, this build reads version %d",
			backup.Version, BackupFormatVersion)
	}

	err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		schema := backupSchema()

		// Cleared newest-first so a table is emptied before whatever it
		// references. RESTART IDENTITY puts the sequences back, or every
		// restored row with an explicit id would collide with the next insert.
		for i := len(schema) - 1; i >= 0; i-- {
			if _, present := backup.Tables[schema[i].name]; !present {
				continue
			}
			if err := tx.Exec("TRUNCATE TABLE " + schema[i].name + " RESTART IDENTITY CASCADE").Error; err != nil {
				return fmt.Errorf("clear %s: %w", schema[i].name, err)
			}
		}

		for _, t := range schema {
			rows, present := backup.Tables[t.name]
			if !present {
				continue
			}
			if err := t.write(ctx, tx, rows); err != nil {
				return fmt.Errorf("import %s: %w", t.name, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &backup, nil
}

// Counts reports how many rows each table holds, for the status page.
func Counts(ctx context.Context, db *gorm.DB) (map[string]int64, error) {
	counts := map[string]int64{}
	for _, t := range backupSchema() {
		var count int64
		if err := db.WithContext(ctx).Table(t.name).Count(&count).Error; err != nil {
			return nil, err
		}
		counts[t.name] = count
	}
	return counts, nil
}
