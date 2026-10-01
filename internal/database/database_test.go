package database

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtures is the shared migration directory under test/data.
const fixtures = "../../test/data/migrations"

func TestLoadMigrationsOrdersNumerically(t *testing.T) {
	migrations, err := LoadMigrations(fixtures)
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}

	got := make([]int64, 0, len(migrations))
	for _, m := range migrations {
		got = append(got, m.Version)
	}
	want := []int64{1, 2, 10}
	if len(got) != len(want) {
		t.Fatalf("got %d migrations %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		// Sorting the file names as strings would put 010 between 001 and 002,
		// which applies a later migration before an earlier one.
		if got[i] != want[i] {
			t.Fatalf("version order = %v, want %v", got, want)
		}
	}
}

func TestLoadMigrationsPairsUpAndDown(t *testing.T) {
	migrations, err := LoadMigrations(fixtures)
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}

	byVersion := map[int64]Migration{}
	for _, m := range migrations {
		byVersion[m.Version] = m
	}

	first := byVersion[1]
	if first.Name != "create_widgets" {
		t.Errorf("name = %q, want %q", first.Name, "create_widgets")
	}
	if first.UpPath == "" || first.DownPath == "" {
		t.Errorf("migration 1 should have both files, got up=%q down=%q", first.UpPath, first.DownPath)
	}

	// A migration with no down file is legitimate, and has to be reported as
	// such rather than dropped: a rollback that reaches it must refuse instead
	// of stepping over it and leaving the schema half reverted.
	if down := byVersion[10].DownPath; down != "" {
		t.Errorf("migration 10 should have no down file, got %q", down)
	}
}

// The migrations the panel ships load as the API will load them at startup:
// the initialization first, numbered without a gap after it, each with the file
// that rolls it back. A file named wrongly is otherwise found by a deploy that
// refuses to start.
func TestShippedMigrationsLoad(t *testing.T) {
	migrations, err := LoadMigrations("../../migrations")
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	if len(migrations) == 0 {
		t.Fatal("no migrations shipped")
	}
	// An empty database is set up whole by the initialization, and everything
	// after it changes what that made. A change written into the initialization
	// itself never reaches a database that has already run it.
	if first := migrations[0]; first.Name != "init" {
		t.Errorf("migration %d_%s comes first, want the initialization, 1_init", first.Version, first.Name)
	}
	for i, m := range migrations {
		if m.Version != int64(i+1) {
			t.Errorf("migration %d_%s is number %d in the order, want the numbers without a gap", m.Version, m.Name, i+1)
		}
		if m.DownPath == "" {
			t.Errorf("migration %d_%s has no down file", m.Version, m.Name)
		}
	}
}

func TestLoadMigrationsRejectsMalformedNames(t *testing.T) {
	cases := map[string]struct {
		files []string
		want  string
	}{
		"no version separator": {
			files: []string{"widgets.up.sql"},
			want:  "expected",
		},
		"version is not a number": {
			files: []string{"v1_create_widgets.up.sql"},
			want:  "not a number",
		},
		"two names for one version": {
			files: []string{"001_widgets.up.sql", "001_gadgets.up.sql"},
			want:  "used by both",
		},
		"down file with no up file": {
			files: []string{"001_widgets.down.sql"},
			want:  "no up file",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			for _, file := range tc.files {
				path := filepath.Join(dir, file)
				if err := os.WriteFile(path, []byte("SELECT 1;"), 0o600); err != nil {
					t.Fatalf("write fixture: %v", err)
				}
			}

			_, err := LoadMigrations(dir)
			if err == nil {
				t.Fatalf("LoadMigrations accepted %v, want an error", tc.files)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestLoadMigrationsIgnoresUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	for _, file := range []string{"001_widgets.up.sql", "README.md", "notes.txt", ".keep"} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte("SELECT 1;"), 0o600); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}

	migrations, err := LoadMigrations(dir)
	if err != nil {
		t.Fatalf("LoadMigrations: %v", err)
	}
	if len(migrations) != 1 {
		t.Fatalf("got %d migrations, want 1", len(migrations))
	}
}

func TestLoadMigrationsReportsAMissingDirectory(t *testing.T) {
	_, err := LoadMigrations(filepath.Join(t.TempDir(), "nowhere"))
	if err == nil {
		t.Fatal("LoadMigrations accepted a missing directory, want an error")
	}
	// The path belongs in the message: this is what a deployment run from the
	// wrong working directory hits, and the fix is obvious once it is named.
	if !strings.Contains(err.Error(), "nowhere") {
		t.Errorf("error = %q, want it to name the directory", err)
	}
}
