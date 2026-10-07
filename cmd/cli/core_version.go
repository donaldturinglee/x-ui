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

func coreVersionCommand(args []string) error {
	flags := flag.NewFlagSet("core-version-run", flag.ContinueOnError)
	directory := flags.String("directory", "", "configuration directory containing the queued task")
	id := flags.String("job", "", "queued sing-box version task ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *directory == "" || !filepath.IsAbs(*directory) || *id == "" || len(flags.Args()) != 0 {
		return fmt.Errorf("usage: x-ui-cli core-version-run -directory absolute-path -job task-id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Minute)
	defer cancel()
	if err := os.Setenv("X_UI_CONFIG_DIR", *directory); err != nil {
		return err
	}
	if err := service.RunCoreVersion(ctx, *directory, *id); err != nil {
		return err
	}
	job, err := service.NewCoreVersionService(nil).Job(*id)
	if err != nil {
		return err
	}
	if err := withStore(func(ctx context.Context, store *repository.Store) error {
		service.AuditCoreVersion(ctx, service.NewSettingService(store), job)
		return nil
	}); err != nil {
		fmt.Fprintln(os.Stderr, "core version task finished; its persisted result could not be written to the database audit")
	}
	return nil
}

func coreVersionResumeCommand(args []string) error {
	flags := flag.NewFlagSet("core-version-resume", flag.ContinueOnError)
	boot := flags.Bool("boot", false, "restore before systemd starts sing-box and verify asynchronously")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if len(flags.Args()) != 0 {
		return fmt.Errorf("usage: x-ui-cli core-version-resume [-boot]")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Minute)
	defer cancel()
	return service.ResumeCoreVersion(ctx, *boot)
}
