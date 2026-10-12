package repository

import (
	"context"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type telegramQueryStatement struct {
	sql  string
	args []interface{}
}

func telegramQueryDB(t *testing.T) (*gorm.DB, *[]telegramQueryStatement) {
	t.Helper()
	db, err := gorm.Open(postgres.Open("host=127.0.0.1 user=test dbname=test sslmode=disable"), &gorm.Config{DryRun: true, DisableAutomaticPing: true, Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	statements := new([]telegramQueryStatement)
	if err := db.Callback().Query().After("gorm:query").Register("telegram:capture", func(tx *gorm.DB) {
		*statements = append(*statements, telegramQueryStatement{sql: tx.Statement.SQL.String(), args: append([]interface{}(nil), tx.Statement.Vars...)})
	}); err != nil {
		t.Fatal(err)
	}
	return db, statements
}

func TestTelegramClientSearchIsLiteralAndNameOnly(t *testing.T) {
	db, statements := telegramQueryDB(t)
	r := &ClientRepository{db: db}
	filter := ClientFilter{NameSearch: "AL%_!", Limit: 10, Offset: 20}
	if _, err := r.List(context.Background(), filter); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Count(context.Background(), filter); err != nil {
		t.Fatal(err)
	}
	if len(*statements) != 2 {
		t.Fatal(*statements)
	}
	for _, statement := range *statements {
		where := strings.Split(statement.sql, "WHERE")[1]
		if !strings.Contains(where, "name ILIKE") || !strings.Contains(where, "ESCAPE '!'") || strings.Contains(where, "description") || statement.args[0] != "%AL!%!_!!%" {
			t.Fatal(statement)
		}
	}
	if !strings.Contains((*statements)[0].sql, "ORDER BY id ASC") || strings.Contains((*statements)[1].sql, "LIMIT") || strings.Contains((*statements)[1].sql, "OFFSET") {
		t.Fatal(*statements)
	}
	// Existing panel/API search continues to include descriptions.
	query := filtered(db.Model(&domain.Client{}), ClientFilter{Search: "Alice"}).Find(&[]domain.Client{})
	if !strings.Contains(query.Statement.SQL.String(), "OR description ILIKE") {
		t.Fatal(query.Statement.SQL.String())
	}
}

func TestTelegramOutboundPageDoesNotSelectOptions(t *testing.T) {
	db, statements := telegramQueryDB(t)
	r := &OutboundRepository{taggedRepository: taggedRepository[domain.Outbound]{db: db, label: "outbound"}}
	if _, _, err := r.ListSummaries(context.Background(), "hk%_!", 10, 20); err != nil {
		t.Fatal(err)
	}
	if len(*statements) != 2 {
		t.Fatal(*statements)
	}
	count, page := (*statements)[0], (*statements)[1]
	if !strings.Contains(count.sql, "count(*)") || strings.Contains(count.sql, "LIMIT") || strings.Contains(count.sql, "OFFSET") {
		t.Fatal(count)
	}
	if !strings.Contains(page.sql, `SELECT "id","type","tag"`) || strings.Contains(page.sql, "options") || strings.Contains(page.sql, "count(*)") || !strings.Contains(page.sql, "ORDER BY id ASC") || !strings.Contains(page.sql, "LIMIT") || !strings.Contains(page.sql, "OFFSET") {
		t.Fatal(page)
	}
	for _, statement := range *statements {
		if !strings.Contains(statement.sql, "tag ILIKE") || statement.args[0] != "%hk!%!_!!%" {
			t.Fatal(statement)
		}
	}
}
