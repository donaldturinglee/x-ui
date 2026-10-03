// Command worker runs the scheduled work the panel depends on but no request
// triggers: taking depleted clients offline, rolling periodic quotas over, and
// keeping the traffic history inside its retention window.
//
// It is a separate process from the API so that a panel under load, or one
// being restarted, does not stop enforcing quotas -- and so a deployment can
// run exactly one worker while running several API instances.
package main

import (
	"context"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/robfig/cron/v3"
)

// jobTimeout bounds a single run. A job that cannot finish in this long is
// waiting on something that is not coming back, and holding its database
// transaction open makes everything else worse.
const jobTimeout = 5 * time.Minute

// cronParser accepts standard five-field cron, an optional leading seconds
// field, and descriptors (@daily, @every 10s, ...).
var cronParser = config.CronParser()

func main() {
	if err := run(); err != nil {
		logger.Error(err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))
	logger.Info(config.Name, " worker ", config.Version, " starting")

	db, err := database.Open(cfg.Database, cfg.Log.Debug())
	if err != nil {
		return err
	}
	defer func() {
		if err := database.Close(db); err != nil {
			logger.Warning("unable to close the database: ", err)
		}
	}()

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()

	if err := database.Ping(startupCtx, db); err != nil {
		return err
	}
	// Both processes migrate, both take the advisory lock first, so whichever
	// starts second finds the work already done.
	if err := database.Migrate(startupCtx, db, cfg.Database.MigrationsDir); err != nil {
		return err
	}

	location, err := time.LoadLocation(cfg.Worker.TimeLocation)
	if err != nil {
		return err
	}

	store := repository.NewStore(db)
	clients := service.NewClientService(store)
	settings := service.NewSettingService(store)
	users := service.NewUserService(store)
	telegram := service.NewTelegramService(settings)
	stats := service.NewStatsService(store, cfg.Worker.StatsBucket.Duration(), cfg.Worker.StatsRetention.Duration())

	// Recover: robfig/cron does not recover panics, and one panicking job would
	// otherwise take the whole worker down with it.
	//
	// SkipIfStillRunning: these jobs contend for the same rows. Overlapping
	// runs of the deplete pass would each read the same clients and write the
	// same disable, and the second one waits on the first one's locks to do it.
	scheduler := cron.New(
		cron.WithLocation(location),
		cron.WithParser(cronParser),
		cron.WithChain(
			cron.Recover(cron.DefaultLogger),
			cron.SkipIfStillRunning(cron.DefaultLogger),
		),
	)

	schedule(scheduler, cfg.Worker.DepleteSpec, "quota enforcement", func(ctx context.Context) error {
		reset, err := clients.RunPeriodicResets(ctx)
		if err != nil {
			return err
		}
		if reset > 0 {
			logger.Info("started or reset ", reset, " client period(s)")
		}
		disabled, err := clients.Deplete(ctx)
		if err != nil {
			return err
		}
		if len(disabled) > 0 {
			logger.Info("disabled ", len(disabled), " depleted client(s)")
			// Said once, when they are taken offline, rather than on every pass
			// while they stay so: the pass after this one finds them disabled
			// already and has nobody to name.
			telegram.Notify(ctx, domain.SettingTgNotifyDeplete,
				"x-ui: taken offline for running out of quota or time: "+strings.Join(disabled, ", ")+".")
		}
		return nil
	})

	schedule(scheduler, cfg.Worker.ResetSpec, "global traffic reset", func(ctx context.Context) error {
		affected, err := clients.ResetAllTraffic(ctx, domain.ActorResetJob)
		if err != nil {
			return err
		}
		logger.Info("global traffic reset touched ", affected, " client(s)")
		return settings.SetGlobalResetLast(ctx, time.Now().Unix())
	})

	schedule(scheduler, cfg.Worker.CleanupSpec, "retention cleanup", func(ctx context.Context) error {
		purged, err := stats.Purge(ctx)
		if err != nil {
			return err
		}
		if purged > 0 {
			logger.Info("purged ", purged, " traffic sample(s) past the retention window")
		}
		// Expired tokens authenticate nothing, but they are still credentials
		// sitting in a table, and they are what a stolen backup is read for.
		revoked, err := users.PurgeExpiredTokens(ctx)
		if err != nil {
			return err
		}
		if revoked > 0 {
			logger.Info("removed ", revoked, " expired API token(s)")
		}
		return nil
	})

	if len(scheduler.Entries()) == 0 {
		logger.Warning("no jobs are scheduled: check the worker section of the configuration")
	}

	scheduler.Start()
	if err := service.RecordPanelProcess("worker", cfg); err != nil {
		logger.Warning("unable to record Panel restart readiness: ", err)
	}
	if err := service.CheckpointPanelConfiguration(cfg); err != nil {
		logger.Warning("unable to checkpoint Panel configuration: ", err)
	}
	logger.Info("worker running with ", len(scheduler.Entries()), " scheduled job(s)")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	sig := <-sigCh
	logger.Info("received ", sig, ", shutting down")

	// Stop returns a context that closes once every running job has finished,
	// so a job mid-transaction is not cut off by the process exiting.
	<-scheduler.Stop().Done()
	logger.Info("stopped")
	return nil
}

// schedule registers one job, giving it a timeout and turning a returned error
// into a log line. An empty spec disables the job, which is how the
// configuration switches one off.
func schedule(scheduler *cron.Cron, spec string, name string, job func(context.Context) error) {
	if spec == "" || spec == "off" {
		logger.Info("job ", name, " is disabled")
		return
	}
	_, err := scheduler.AddFunc(spec, func() {
		unlock, err := service.BeginHostWrite(config.Dir())
		if err != nil {
			logger.Debug("job ", name, " deferred during host maintenance")
			return
		}
		defer unlock()
		ctx, cancel := context.WithTimeout(context.Background(), jobTimeout)
		defer cancel()

		started := time.Now()
		if err := job(ctx); err != nil {
			logger.Error("job ", name, " failed after ", time.Since(started).Round(time.Millisecond), ": ", err)
			return
		}
		logger.Debug("job ", name, " finished in ", time.Since(started).Round(time.Millisecond))
	})
	if err != nil {
		logger.Warning("unable to schedule ", name, " <", spec, ">: ", err)
		return
	}
	logger.Info("scheduled ", name, " <", spec, ">")
}
