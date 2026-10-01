//go:build integration

package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

func inboundRenameTestStore(t *testing.T) *repository.Store {
	t.Helper()
	store := outboundRenameTestStore(t)
	if err := store.DB().Exec(`CREATE TEMP TABLE inbound_tag_aliases (tag text PRIMARY KEY, inbound_id bigint NOT NULL) ON COMMIT DROP`).Error; err != nil {
		t.Fatal(err)
	}
	// Like the other fixture tables, these live in pg_temp and the outer
	// transaction rolls them back. No application rows are touched.
	if err := store.DB().Migrator().CreateTable(&domain.Client{}); err != nil {
		t.Fatal(err)
	}
	return store
}

const inboundRenameBase = `{"route":{"final":"old","rules":[{"inbound":["old"],"outbound":"old"},{"type":"logical","rules":[{"inbound":"old"}]}]},"dns":{"rules":[{"inbound":["old"],"server":"old"}]},"experimental":{"v2ray_api":{"stats":{"inbounds":["old"],"outbounds":["old"]}}}}`

func seedInboundRename(t *testing.T, store *repository.Store) (*domain.Inbound, *domain.Client) {
	t.Helper()
	ctx := context.Background()
	inbound := &domain.Inbound{Type: "socks", Tag: "old", Options: domain.JSON(`{"listen":"127.0.0.1","listen_port":1080}`)}
	dependent := &domain.Inbound{Type: "direct", Tag: "forward", Options: domain.JSON(`{"detour":"old","tls":{"acme":{"http_client":{"detour":"old"}}}}`)}
	for _, err := range []error{
		store.Inbounds.Create(ctx, inbound),
		store.Inbounds.Create(ctx, dependent),
		store.Outbounds.Create(ctx, &domain.Outbound{Type: "direct", Tag: "old"}),
		store.Settings.Set(ctx, domain.SettingCoreConfig, inboundRenameBase),
		store.Stats.AddSamples(ctx, []domain.Stat{
			{Resource: "inbound", Tag: "old", DateTime: 100, Direction: domain.DirectionUp, Traffic: 100},
			{Resource: "inbound", Tag: "new", DateTime: 100, Direction: domain.DirectionUp, Traffic: 40},
			{Resource: "outbound", Tag: "old", DateTime: 100, Direction: domain.DirectionUp, Traffic: 77},
		}),
	} {
		if err != nil {
			t.Fatal(err)
		}
	}
	ids, err := json.Marshal([]uint{inbound.Id})
	if err != nil {
		t.Fatal(err)
	}
	client := &domain.Client{Name: "alice", Enable: true, Inbounds: domain.JSON(ids), Up: 11, Down: 22}
	if err := ensureIdentities(client, identityKeysFor(inbound.Type, map[string]interface{}{})); err != nil {
		t.Fatal(err)
	}
	if err := store.Clients.Create(ctx, client); err != nil {
		t.Fatal(err)
	}
	return inbound, client
}

func inboundHistory(t *testing.T, store *repository.Store, tag string) int64 {
	t.Helper()
	samples, err := store.Stats.Query(context.Background(), []string{"inbound"}, tag, 0, time.Now().Unix()+1)
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, sample := range samples {
		total += sample.Traffic
	}
	return total
}

func TestInboundRenameIntegration(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, client := seedInboundRename(t, store)
	ctx := context.Background()
	inbound.Tag = "new"
	if err := NewInboundService(store).Update(ctx, "operator", inbound); err != nil {
		t.Fatal(err)
	}
	saved, err := store.Inbounds.FindById(ctx, inbound.Id)
	if err != nil || saved.Tag != "new" || canonicalJSON(t, string(saved.Options)) != canonicalJSON(t, string(inbound.Options)) {
		t.Fatalf("saved inbound = %+v, %v", saved, err)
	}
	base, err := store.Settings.Get(ctx, domain.SettingCoreConfig)
	want := `{"route":{"final":"old","rules":[{"inbound":["new"],"outbound":"old"},{"type":"logical","rules":[{"inbound":"new"}]}]},"dns":{"rules":[{"inbound":["new"],"server":"old"}]},"experimental":{"v2ray_api":{"stats":{"inbounds":["new"],"outbounds":["old"]}}}}`
	if err != nil || canonicalJSON(t, base) != canonicalJSON(t, want) {
		t.Fatalf("base = %s, %v", base, err)
	}
	dependent, err := store.Inbounds.FindByTag(ctx, "forward")
	if err != nil || canonicalJSON(t, string(dependent.Options)) != canonicalJSON(t, `{"detour":"new","tls":{"acme":{"http_client":{"detour":"old"}}}}`) {
		t.Fatalf("dependent = %+v, %v", dependent, err)
	}
	if got := inboundHistory(t, store, "new"); got != 140 {
		t.Fatalf("new history = %d, want 140", got)
	}
	if got := inboundHistory(t, store, "old"); got != 0 {
		t.Fatalf("old history = %d, want 0", got)
	}
	unchanged, err := store.Clients.FindById(ctx, client.Id)
	if err != nil || string(unchanged.Inbounds) != string(client.Inbounds) || canonicalJSON(t, string(unchanged.Config)) != canonicalJSON(t, string(client.Config)) || unchanged.Up != 11 || unchanged.Down != 22 {
		t.Fatalf("subscriber changed: %+v, %v", unchanged, err)
	}
	outboundStats, err := store.Stats.Query(ctx, []string{"outbound"}, "old", 0, 200)
	if err != nil || len(outboundStats) != 1 || outboundStats[0].Traffic != 77 {
		t.Fatalf("outbound stats changed: %+v, %v", outboundStats, err)
	}
	generated, err := NewConfigService(store, NewSettingService(store), NewInboundService(store), NewOutboundService(store)).Generate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var config domain.CoreConfig
	if err := json.Unmarshal(generated.Document, &config); err != nil {
		t.Fatal(err)
	}
	var first struct{ Tag string }
	if err := json.Unmarshal(config.Inbounds[0], &first); err != nil || first.Tag != "new" {
		t.Fatalf("generated inbound = %+v, %v", first, err)
	}
	changes, err := store.Stats.ListChanges(ctx, repository.ChangeFilter{})
	if err != nil || len(changes) != 1 {
		t.Fatalf("audit = %+v, %v", changes, err)
	}
	var audit map[string]interface{}
	if err := json.Unmarshal(changes[0].Obj, &audit); err != nil || audit["oldTag"] != "old" || audit["newTag"] != "new" {
		t.Fatalf("rename audit = %+v, %v", audit, err)
	}
}

func TestInboundRenameIntegrationDelayedReportsAndRepeatedRenames(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, _ := seedInboundRename(t, store)
	ctx := context.Background()
	service := NewInboundService(store)
	stats := NewStatsService(store, time.Minute, time.Hour)
	inbound.Tag = "new"
	if err := service.Update(ctx, "operator", inbound); err != nil {
		t.Fatal(err)
	}
	if err := stats.Ingest(ctx, []domain.TrafficReport{
		{Resource: "inbound", Tag: "old", Up: 7},
		{Resource: "inbound", Tag: "new", Up: 3},
	}); err != nil {
		t.Fatal(err)
	}
	inbound.Tag = "latest"
	if err := service.Update(ctx, "operator", inbound); err != nil {
		t.Fatal(err)
	}
	if err := stats.Ingest(ctx, []domain.TrafficReport{
		{Resource: "inbound", Tag: "old", Up: 2},
		{Resource: "inbound", Tag: "new", Up: 4},
		{Resource: "inbound", Tag: "latest", Up: 6},
	}); err != nil {
		t.Fatal(err)
	}
	if got := inboundHistory(t, store, "latest"); got != 162 {
		t.Fatalf("history after retried names = %d, want 162", got)
	}
	for _, tag := range []string{"old", "new"} {
		if got := inboundHistory(t, store, tag); got != 0 {
			t.Fatalf("retired %s acquired new history: %d", tag, got)
		}
		if err := service.Create(ctx, "operator", &domain.Inbound{Type: "direct", Tag: tag}, nil); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("reserved name %s was accepted: %v", tag, err)
		}
	}
	// Returning to one's own reserved name resolves every alias to that name.
	inbound.Tag = "old"
	if err := service.Update(ctx, "operator", inbound); err != nil {
		t.Fatal(err)
	}
	if err := stats.Ingest(ctx, []domain.TrafficReport{{Resource: "inbound", Tag: "latest", Up: 8}}); err != nil {
		t.Fatal(err)
	}
	if got := inboundHistory(t, store, "old"); got != 170 {
		t.Fatalf("history after returning to original name = %d, want 170", got)
	}
}

func TestInboundRenameIntegrationRejectsDuplicateAndWhitespace(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, _ := seedInboundRename(t, store)
	for _, tag := range []string{"forward", "two words", "two\twords"} {
		inbound.Tag = tag
		if err := NewInboundService(store).Update(context.Background(), "operator", inbound); err == nil {
			t.Fatalf("invalid rename %q was accepted", tag)
		}
	}
	saved, err := store.Inbounds.FindById(context.Background(), inbound.Id)
	if err != nil || saved.Tag != "old" || inboundHistory(t, store, "old") != 100 {
		t.Fatalf("rejected edit changed data: %+v, %v", saved, err)
	}
}

func TestInboundRenameIntegrationRollsBackEverything(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, _ := seedInboundRename(t, store)
	if err := store.DB().Exec(`ALTER TABLE pg_temp.changes ADD CONSTRAINT reject_edit CHECK (action <> 'edit')`).Error; err != nil {
		t.Fatal(err)
	}
	inbound.Tag = "new"
	ctx := context.Background()
	if err := NewInboundService(store).Update(ctx, "operator", inbound); err == nil {
		t.Fatal("rename succeeded despite a failed audit write")
	}
	saved, err := store.Inbounds.FindById(ctx, inbound.Id)
	if err != nil || saved.Tag != "old" {
		t.Fatalf("inbound did not roll back: %+v, %v", saved, err)
	}
	base, err := store.Settings.Get(ctx, domain.SettingCoreConfig)
	if err != nil || canonicalJSON(t, base) != canonicalJSON(t, inboundRenameBase) {
		t.Fatalf("base did not roll back: %s, %v", base, err)
	}
	reserved, err := store.Inbounds.TagReserved(ctx, "new", 0)
	if err != nil || reserved || inboundHistory(t, store, "old") != 100 || inboundHistory(t, store, "new") != 40 {
		t.Fatalf("aliases or statistics did not roll back: %v, %v", reserved, err)
	}
	dependent, err := store.Inbounds.FindByTag(ctx, "forward")
	if err != nil || canonicalJSON(t, string(dependent.Options)) != canonicalJSON(t, `{"detour":"old","tls":{"acme":{"http_client":{"detour":"old"}}}}`) {
		t.Fatalf("dependent did not roll back: %+v, %v", dependent, err)
	}
}

func TestInboundRenameIntegrationDeletedNamesStayReserved(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, client := seedInboundRename(t, store)
	ctx := context.Background()
	service := NewInboundService(store)
	inbound.Tag = "new"
	if err := service.Update(ctx, "operator", inbound); err != nil {
		t.Fatal(err)
	}
	if err := service.Delete(ctx, "operator", inbound.Id); err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{"old", "new"} {
		if err := service.Create(ctx, "operator", &domain.Inbound{Type: "direct", Tag: tag}, nil); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("deleted listener's name %s was reused: %v", tag, err)
		}
	}
	saved, err := store.Clients.FindById(ctx, client.Id)
	if err != nil || string(saved.Inbounds) != "[]" {
		t.Fatalf("subscriber retained deleted inbound: %+v, %v", saved, err)
	}
}

func TestInboundRenameIntegrationMigrationBackfillsCurrentNames(t *testing.T) {
	store := inboundRenameTestStore(t)
	inbound, _ := seedInboundRename(t, store)
	dir := os.Getenv("X_UI_TEST_MIGRATIONS_DIR")
	if dir == "" {
		dir = filepath.Join("..", "..", "migrations")
	}
	up, err := os.ReadFile(filepath.Join(dir, "002_inbound_tag_aliases.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec("DROP TABLE pg_temp.inbound_tag_aliases").Error; err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec(string(up)).Error; err != nil {
		t.Fatal(err)
	}
	reserved, err := store.Inbounds.TagReserved(context.Background(), "old", 0)
	if err != nil || !reserved {
		t.Fatalf("migration did not reserve existing tag: %v, %v", reserved, err)
	}
	reserved, err = store.Inbounds.TagReserved(context.Background(), "old", inbound.Id)
	if err != nil || reserved {
		t.Fatalf("migration assigned tag to another inbound: %v, %v", reserved, err)
	}
	down, err := os.ReadFile(filepath.Join(dir, "002_inbound_tag_aliases.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec(string(down)).Error; err != nil {
		t.Fatal(err)
	}
}

func TestInboundRenameIntegrationCoordinatesConcurrentReportsAndEdits(t *testing.T) {
	dir := os.Getenv("X_UI_TEST_CONFIG_DIR")
	if dir == "" {
		t.Skip("set X_UI_TEST_CONFIG_DIR to run PostgreSQL integration tests")
	}
	t.Setenv("X_UI_CONFIG_DIR", dir)
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(cfg.Database, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close(db) })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	holder := db.WithContext(ctx).Begin()
	if holder.Error != nil {
		t.Fatal(holder.Error)
	}
	defer holder.Rollback()
	if err := repository.NewStore(holder).LockTags(ctx, true); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 2)
	// Neither an ingest nor another tag edit may pass the transaction currently
	// changing references and migrating buckets. Both release their lock on exit.
	for _, exclusive := range []bool{false, true} {
		go func() {
			tx := db.WithContext(ctx).Begin()
			if tx.Error != nil {
				finished <- tx.Error
				return
			}
			err := repository.NewStore(tx).LockTags(ctx, exclusive)
			tx.Rollback()
			finished <- err
		}()
	}
	select {
	case err := <-finished:
		t.Fatalf("operation passed an active rename: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := holder.Rollback().Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case err := <-finished:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("concurrent operations did not resume after rename")
		}
	}
}
