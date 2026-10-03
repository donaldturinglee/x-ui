package main

import (
	"context"
	"flag"
	"fmt"
	"path/filepath"
	"time"

	"github.com/donaldturinglee/x-ui/internal/service"
)

func upgradeCommand(args []string) error {
	flags := flag.NewFlagSet("upgrade-run", flag.ContinueOnError)
	directory := flags.String("directory", "", "configuration directory")
	id := flags.String("job", "", "queued upgrade task")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *directory == "" || !filepath.IsAbs(*directory) || *id == "" || len(flags.Args()) != 0 {
		return fmt.Errorf("usage: x-ui-cli upgrade-run -directory absolute-path -job task-id")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	return service.RunUpgrade(ctx, *directory, *id)
}
