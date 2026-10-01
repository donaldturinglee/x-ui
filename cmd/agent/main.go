// Command agent runs on a node rather than on the panel.
//
// It pulls the configuration the panel says this node should serve, writes it
// where the proxy core reads it, and pushes back the traffic the core measured.
// It never carries traffic itself and knows nothing about the core beyond a
// file path, a reload command and where to read counters — which is what lets
// the panel and the data plane be deployed, restarted and upgraded separately.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/donaldturinglee/x-ui/internal/agent"
	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

func main() {
	var (
		configPath  string
		envFile     string
		showVersion bool
		syncOnce    bool
	)
	flag.StringVar(&configPath, "config", "", "path to the agent configuration (default: configs/agent.yaml)")
	flag.StringVar(&envFile, "env-file", "", "read a service environment file without executing shell code")
	flag.BoolVar(&showVersion, "v", false, "print the version")
	flag.BoolVar(&syncOnce, "sync-once", false, "fetch and apply one configuration, then exit")
	flag.Parse()

	if showVersion {
		fmt.Println(config.Name, "agent", config.Version)
		return
	}

	if err := runWithEnvironment(configPath, syncOnce, envFile); err != nil {
		logger.Error(err)
		os.Exit(1)
	}
}

func run(configPath string, syncOnce bool) error {
	return runWithEnvironment(configPath, syncOnce, "")
}

func runWithEnvironment(configPath string, syncOnce bool, envFile string) error {
	cfg, err := agent.Load(configPath)
	if envFile != "" {
		environment, readErr := agent.ReadEnvironment(envFile)
		if readErr != nil {
			return readErr
		}
		cfg, err = agent.LoadWithEnvironment(configPath, environment)
	}
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))
	if syncOnce {
		budget := cfg.Panel.Timeout.Duration() + cfg.Core.ReloadTimeout.Duration() + 5*time.Second
		if len(cfg.Core.CheckCommand) != 0 {
			budget += cfg.Core.ReloadTimeout.Duration()
		}
		ctx, cancel := context.WithTimeout(context.Background(), budget)
		defer cancel()
		_, err := agent.NewSyncer(agent.NewPanelClient(cfg.Panel), cfg.Core).Sync(ctx)
		return err
	}
	logger.Info(config.Name, " agent ", config.Version, " starting")

	// Cancelled on the first signal, which stops both loops and lets whatever
	// is in flight finish rather than being cut off mid-write.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return agent.Run(ctx, cfg)
}
