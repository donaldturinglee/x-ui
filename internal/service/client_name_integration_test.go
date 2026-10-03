//go:build integration

package service

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"

	"gopkg.in/yaml.v3"
)

func TestClientNameIntegration(t *testing.T) {
	for _, test := range []struct {
		name string
		want []string
	}{
		{"alice", []string{"alice", "alice-2"}},
		{"Proxy", []string{"Proxy-2", "Proxy-3"}},
		{"direct", []string{"direct-2", "direct-3"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := inboundRenameTestStore(t)
			first, client := seedInboundRename(t, store)
			ctx := context.Background()
			second := &domain.Inbound{Type: "socks", Tag: "another-inbound", Options: domain.JSON(`{"listen_port":1081}`)}
			if err := store.Inbounds.Create(ctx, second); err != nil {
				t.Fatal(err)
			}
			ids, _ := json.Marshal([]uint{first.Id, second.Id})
			client.Name, client.Inbounds = test.name, domain.JSON(ids)
			if err := store.Clients.Save(ctx, client); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{domain.SettingSubEncode, domain.SettingSubShowInfo} {
				if err := store.Settings.Set(ctx, key, "false"); err != nil {
					t.Fatal(err)
				}
			}
			service := NewSubscriptionService(store, NewSettingService(store), NewLinkService(store))
			for _, format := range []string{FormatLinks, FormatSingBox, FormatClash} {
				subscription, err := service.Render(ctx, client.Name, format, "node.example.com")
				if err != nil {
					t.Fatal(format, err)
				}
				if subscription.Title != client.Name {
					t.Fatalf("%s title = %q, want %q", format, subscription.Title, client.Name)
				}
				var names []string
				switch format {
				case FormatLinks:
					for _, link := range strings.Split(subscription.Body, "\n") {
						names = append(names, parseLink(t, link).Fragment)
					}
				case FormatSingBox:
					var config struct {
						Outbounds []struct{ Type, Tag string }
					}
					if err := json.Unmarshal([]byte(subscription.Body), &config); err != nil {
						t.Fatal(err)
					}
					for _, outbound := range config.Outbounds {
						if outbound.Type == "socks" {
							names = append(names, outbound.Tag)
						}
					}
				case FormatClash:
					var config struct {
						Proxies []struct{ Name string }
					}
					if err := yaml.Unmarshal([]byte(subscription.Body), &config); err != nil {
						t.Fatal(err)
					}
					for _, proxy := range config.Proxies {
						names = append(names, proxy.Name)
					}
				}
				if !reflect.DeepEqual(names, test.want) {
					t.Errorf("%s names = %v, want %v", format, names, test.want)
				}
			}
		})
	}
}

func TestRemoveClientRemarkMigrationIntegration(t *testing.T) {
	store := inboundRenameTestStore(t)
	_, client := seedInboundRename(t, store)
	ctx := context.Background()
	client.Desc = "searchable description"
	if err := store.Clients.Save(ctx, client); err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec(`ALTER TABLE clients ADD COLUMN remark text NOT NULL DEFAULT ''; UPDATE clients SET remark = 'legacy-alias'`).Error; err != nil {
		t.Fatal(err)
	}
	up, err := os.ReadFile(filepath.Join("..", "..", "migrations", "003_remove_client_remark.up.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec(string(up)).Error; err != nil {
		t.Fatal(err)
	}
	var count int64
	if err := store.DB().Raw(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'clients'::regclass AND attname = 'remark' AND NOT attisdropped`).Scan(&count).Error; err != nil || count != 0 {
		t.Fatalf("remark columns = %d, %v", count, err)
	}
	saved, err := store.Clients.FindById(ctx, client.Id)
	if err != nil {
		t.Fatal(err)
	}
	// PostgreSQL canonicalizes jsonb whitespace and key order on storage.
	want, got := *client, *saved
	want.Config = domain.JSON(canonicalJSON(t, string(want.Config)))
	got.Config = domain.JSON(canonicalJSON(t, string(got.Config)))
	want.Inbounds = domain.JSON(canonicalJSON(t, string(want.Inbounds)))
	got.Inbounds = domain.JSON(canonicalJSON(t, string(got.Inbounds)))
	if !reflect.DeepEqual(got, want) {
		t.Fatal("migration changed subscriber data")
	}
	for search, want := range map[string]int{"ALICE": 1, "description": 1, "legacy-alias": 0} {
		rows, err := store.Clients.List(ctx, repository.ClientFilter{Search: search})
		if err != nil || len(rows) != want {
			t.Errorf("search %q = %d rows, %v; want %d", search, len(rows), err, want)
		}
	}
	down, err := os.ReadFile(filepath.Join("..", "..", "migrations", "003_remove_client_remark.down.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DB().Exec(string(down)).Error; err != nil {
		t.Fatal(err)
	}
	var alias string
	if err := store.DB().Raw("SELECT remark FROM clients WHERE id = ?", client.Id).Scan(&alias).Error; err != nil || alias != "" {
		t.Fatalf("restored schema alias = %q, %v; want an empty default", alias, err)
	}
}
