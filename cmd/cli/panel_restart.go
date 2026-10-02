package main

import (
	"context"
	"flag"
	"fmt"
	"path/filepath"
	"time"

	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
)

func panelRestartCommand(args []string) error {
	flags := flag.NewFlagSet("panel-restart", flag.ContinueOnError)
	directory := flags.String("directory", "", "configuration directory for the queued task")
	id := flags.String("job", "", "queued task ID")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *directory == "" || !filepath.IsAbs(*directory) || *id == "" || len(flags.Args()) != 0 {
		return fmt.Errorf("usage: x-ui-cli panel-restart -directory absolute-path -job task-id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	if err := service.RunPanelRestart(ctx, *directory, *id); err != nil {
		return err
	}
	job, err := service.ReadPanelRestartResult(*directory, *id)
	if err != nil {
		return err
	}
	return withStore(func(ctx context.Context, store *repository.Store) error {
		service.AuditPanelRestart(ctx, service.NewSettingService(store), job)
		return nil
	})
}
