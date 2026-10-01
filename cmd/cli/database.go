package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
)

func databaseCommand(args []string) error {
	fs := flag.NewFlagSet("database", flag.ContinueOnError)
	backup := fs.String("backup", "", "write a complete pg_dump archive, including the schema")
	restore := fs.String("restore", "", "restore a complete pg_dump archive")
	check := fs.Bool("check", false, "verify the database and compatible PostgreSQL backup tools")
	yes := fs.Bool("yes", false, "confirm restoring an installation backup")
	if err := fs.Parse(args); err != nil {
		return err
	}
	actions := 0
	for _, selected := range []bool{*backup != "", *restore != "", *check} {
		if selected {
			actions++
		}
	}
	if actions != 1 || len(fs.Args()) != 0 || *restore != "" && !*yes {
		return errors.New("usage: x-ui-cli database -check|-backup path|-restore path -yes")
	}
	cfg := config.Default()
	var err error
	if *restore != "" {
		content, readErr := os.ReadFile(*restore + ".connection.json")
		if readErr != nil {
			return fmt.Errorf("read installation backup connection: %w", readErr)
		}
		if err := json.Unmarshal(content, &cfg.Database); err != nil {
			return errors.New("invalid installation backup connection file")
		}
	} else {
		cfg, err = config.Load()
		if err != nil {
			return err
		}
	}
	db, err := open(cfg)
	if err != nil {
		return err
	}
	defer database.Close(db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := database.Ping(ctx, db); err != nil {
		return err
	}
	var version int
	if err := db.WithContext(ctx).Raw("SHOW server_version_num").Scan(&version).Error; err != nil {
		return err
	}
	for _, tool := range []string{"pg_dump", "pg_restore", "psql"} {
		output, err := exec.CommandContext(ctx, tool, "--version").CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s is required for installation backups: %w", tool, err)
		}
		fields := strings.Fields(string(output))
		if len(fields) < 3 {
			return fmt.Errorf("cannot read %s version", tool)
		}
		major, err := strconv.Atoi(strings.Split(fields[2], ".")[0])
		if err != nil || major < version/10000 {
			return fmt.Errorf("%s must be at least PostgreSQL %d", tool, version/10000)
		}
	}
	if *check {
		fmt.Println("database and PostgreSQL backup tools ready")
		return nil
	}
	connection, password, err := backupConnection(cfg.Database)
	if err != nil {
		return err
	}
	if *restore != "" {
		if info, err := os.Stat(*restore); err != nil || !info.Mode().IsRegular() {
			return errors.New("installation database backup is not a regular file")
		}
		if err := restoreDatabase(ctx, connection, password, *restore); err != nil {
			return err
		}
		fmt.Println("installation database backup restored")
		return nil
	}
	file, err := os.OpenFile(*backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := runPostgreSQL(ctx, "pg_dump", password, "--no-password", "--format=custom", "--file="+*backup, "--dbname="+connection); err != nil {
		_ = os.Remove(*backup)
		return err
	}
	encoded, err := json.Marshal(cfg.Database)
	if err != nil {
		return err
	}
	metadata, err := os.OpenFile(*backup+".connection.json", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		_ = os.Remove(*backup)
		return err
	}
	_, writeErr := metadata.Write(encoded)
	closeErr := metadata.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(*backup)
		_ = os.Remove(*backup + ".connection.json")
		return errors.Join(writeErr, closeErr)
	}
	fmt.Println("complete database backup written to", filepath.Clean(*backup))
	return nil
}

// pg_restore --clean only removes objects present in the archive. A newer
// migration can introduce a foreign key that prevents even an old constraint
// from being dropped. Reset user schemas and restore in the same transaction;
// any failed SQL rolls the reset back as well. No CREATEDB privilege is needed.
func restoreDatabase(ctx context.Context, connection, password, archive string) error {
	script, err := os.CreateTemp(filepath.Dir(archive), ".x-ui-database-restore-*.sql")
	if err != nil {
		return err
	}
	defer os.Remove(script.Name())
	if err := script.Close(); err != nil {
		return err
	}
	// Fully decode the archive before connecting to or resetting the database.
	if err := runPostgreSQL(ctx, "pg_restore", password, "--clean", "--if-exists", "--no-owner", "--exit-on-error", "--file="+script.Name(), archive); err != nil {
		return err
	}
	const resetSchemas = `DO $x_ui_restore$
DECLARE schema_name text;
BEGIN
  FOR schema_name IN SELECT nspname FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
  LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', schema_name);
  END LOOP;
END $x_ui_restore$;
CREATE SCHEMA IF NOT EXISTS public;`
	return runPostgreSQL(ctx, "psql", password, "-X", "--no-password", "--set=ON_ERROR_STOP=1", "--single-transaction", "--dbname="+connection, "--command="+resetSchemas, "--file="+script.Name())
}

func runPostgreSQL(ctx context.Context, tool, password string, arguments ...string) error {
	command := exec.CommandContext(ctx, tool, arguments...)
	command.Env = append(os.Environ(), "PGPASSWORD="+password)
	output, err := command.CombinedOutput()
	if err == nil {
		return nil
	}
	message := string(output)
	if password != "" {
		message = strings.ReplaceAll(message, password, "[redacted]")
	}
	return fmt.Errorf("%s failed: %w: %s", tool, err, message)
}

// Keep the password out of pg_dump/pg_restore arguments and their errors.
func backupConnection(cfg config.DatabaseConfig) (string, string, error) {
	var target *url.URL
	var password string
	if cfg.URL != "" {
		parsed, err := url.Parse(cfg.URL)
		if err != nil || parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
			return "", "", errors.New("installation backups require a postgres:// or postgresql:// database URL")
		}
		target = parsed
		if target.User != nil {
			password, _ = target.User.Password()
			target.User = url.User(target.User.Username())
		}
		query := target.Query()
		if value := query.Get("password"); value != "" {
			password = value
		}
		query.Del("password")
		query.Del("TimeZone")
		target.RawQuery = query.Encode()
	} else {
		password = cfg.Password
		target = &url.URL{Scheme: "postgresql", Host: net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), Path: "/" + cfg.Name, User: url.User(cfg.User)}
		query := target.Query()
		query.Set("sslmode", cfg.SSLMode)
		target.RawQuery = query.Encode()
	}
	return target.String(), password, nil
}
