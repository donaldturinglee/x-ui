package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
)

func coreRestartCommand(args []string) error {
	flags := flag.NewFlagSet("core-restart", flag.ContinueOnError)
	directory := flags.String("directory", "", "configuration directory containing the queued task")
	id := flags.String("job", "", "queued core restart task ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *directory == "" || !filepath.IsAbs(*directory) || *id == "" || len(flags.Args()) != 0 {
		return fmt.Errorf("usage: x-ui-cli core-restart -directory absolute-path -job task-id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if err := os.Setenv("X_UI_CONFIG_DIR", *directory); err != nil {
		return err
	}
	if err := service.RunCoreRestart(ctx, *directory, *id); err != nil {
		return err
	}
	job, err := service.ReadCoreRestartResult(*directory, *id)
	if err != nil {
		return err
	}
	if err := withStore(func(ctx context.Context, store *repository.Store) error {
		service.AuditCoreRestart(ctx, service.NewSettingService(store), job)
		return nil
	}); err != nil {
		// The actor and terminal result are already in the private task record.
		// An audit database outage must not trigger another core restart.
		fmt.Fprintln(os.Stderr, "core restart finished; the database audit could not be written")
	}
	return nil
}
