package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func RunCoreVersion(ctx context.Context, directory, id string) error {
	if filepath.Clean(directory) != installedConfigDir {
		return fmt.Errorf("Version management requires the standard x-ui installation")
	}
	return runCoreVersion(ctx, directory, id, systemdCoreVersionHost{}, newCoreVersionSource(), false)
}

func ResumeCoreVersion(ctx context.Context, boot bool) error {
	if err := os.Setenv("X_UI_CONFIG_DIR", installedConfigDir); err != nil {
		return err
	}
	record, err := latestCoreVersion(coreVersionRoot(installedConfigDir))
	if err != nil || record == nil || (!record.Job.active() && !record.Job.NeedsRecovery) {
		return err
	}
	return runCoreVersion(ctx, installedConfigDir, record.Job.ID, systemdCoreVersionHost{}, newCoreVersionSource(), boot)
}

func runCoreVersion(ctx context.Context, directory, id string, host coreVersionHost, source coreVersionSource, boot bool) error {
	root := coreVersionRoot(directory)
	record, err := readCoreVersionRecord(root, id)
	if err != nil || (!record.Job.active() && !record.Job.NeedsRecovery) {
		return err
	}
	execution, err := maintenanceExecute(directory, "core-version", id)
	if err != nil {
		return err
	}
	defer execution()
	jobDir := coreVersionJobDir(root, id)
	write := func() error { return writePanelJSON(filepath.Join(jobDir, "job.json"), record) }
	finish := func(state, message string, recovery bool) error {
		now := time.Now().UTC()
		record.Job.State, record.Job.Error, record.Job.NeedsRecovery, record.Job.FinishedAt = state, message, recovery, &now
		if err := write(); err != nil {
			return err
		}
		if !recovery {
			return maintenanceRelease(directory, "core-version", id)
		}
		return nil
	}
	phase := func(name string) error {
		record.Job.State, record.Job.Phase = "running", name
		return write()
	}
	snapshot := record.Check.Snapshot
	var configUnlock func()
	lockConfig := func() error {
		for {
			configUnlock, err = acquirePrivateLock(snapshot.Launch.LockPath)
			if err == nil || !errors.Is(err, domain.ErrConflict) {
				return err
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	defer func() {
		if configUnlock != nil {
			configUnlock()
		}
	}()
	completeRecovery := func(recoveryCtx context.Context) error {
		if boot {
			// The boot recovery unit precedes sing-box. Starting it synchronously
			// here would deadlock systemd's ordering; verify from a later task.
			record.RecoveryReady, record.Job.Phase = true, "recovery_ready"
			if err := write(); err != nil {
				return err
			}
			if host.Unmask(recoveryCtx) != nil || host.ScheduleRecovery(recoveryCtx, directory, id) != nil {
				_ = host.Stop(recoveryCtx)
				return finish("failed", "The previous package was restored but recovery verification could not be scheduled. Run x-ui-cli core-version-resume.", true)
			}
			return nil
		}
		if host.Start(recoveryCtx) != nil || host.Verify(recoveryCtx, snapshot, record.Job.FromVersion) != nil {
			_ = host.Stop(recoveryCtx)
			return finish("failed", "The previous version was restored but its service did not recover. The backup is retained; run x-ui-cli core-version-resume.", true)
		}
		return finish("rolled_back", "The version change failed or was interrupted. The previous sing-box package, configuration and state were restored.", false)
	}
	recover := func() error {
		record.Job.State, record.Job.Phase, record.Job.NeedsRecovery = "rolling_back", "recovering", true
		if err := write(); err != nil {
			return err
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
		defer cancel()
		if record.RecoveryReady {
			return completeRecovery(recoveryCtx)
		}
		if record.StopRequested && host.Stop(recoveryCtx) != nil {
			return finish("failed", "The local service could not be stopped for recovery. The backup is retained; run x-ui-cli core-version-resume.", true)
		}
		if record.InstallRequested {
			oldPackage := filepath.Join(jobDir, "packages", record.Check.Previous.Version, record.Check.Previous.AssetName)
			if !record.BackupComplete || host.Install(recoveryCtx, snapshot, oldPackage) != nil || host.Restore(recoveryCtx, jobDir, snapshot) != nil {
				return finish("failed", "Package or state recovery failed. sing-box remains stopped and its backup is retained; run x-ui-cli core-version-resume.", true)
			}
		}
		if record.StopRequested {
			return completeRecovery(recoveryCtx)
		}
		return finish("failed", "The task was interrupted before sing-box changed. Check the selected version and retry.", false)
	}
	if record.Job.State != "queued" {
		if err := lockConfig(); err != nil {
			return finish("failed", "The core configuration is busy. Retry recovery with x-ui-cli core-version-resume.", record.StopRequested)
		}
		return recover()
	}
	current, err := host.Info(ctx)
	if err != nil || current.Revision != snapshot.Revision || current.Version != snapshot.Version || !sameCoreInstallation(current, snapshot) {
		return finish("failed", "The installed version or configuration changed before execution; sing-box was not stopped.", false)
	}
	if err := phase("downloading"); err != nil {
		return err
	}
	for _, pinned := range []*UpgradeRelease{&record.Check.Target, &record.Check.Previous} {
		resolved, err := source.Resolve(ctx, pinned.Version, snapshot.Platform, snapshot.Manager)
		if err != nil || !reflect.DeepEqual(resolved, pinned) {
			return finish("failed", "An official package changed or could not be verified; sing-box was not stopped.", false)
		}
	}
	// Prepare the exact recovery package before touching the running service.
	_, _, err = host.Prepare(ctx, jobDir, snapshot, record.Check.Previous)
	if err != nil {
		return finish("failed", "The exact installed recovery package could not be prepared. sing-box was not stopped.", false)
	}
	packageFile, executable, err := host.Prepare(ctx, jobDir, snapshot, record.Check.Target)
	if err != nil {
		return finish("failed", "The target package could not be downloaded, verified or staged. sing-box was not stopped.", false)
	}
	if err := phase("checking"); err != nil {
		return err
	}
	if err := lockConfig(); err != nil {
		return finish("failed", "The core configuration remained busy; sing-box was not stopped.", false)
	}
	if err := host.Validate(ctx, snapshot, executable, record.Job.ToVersion); err != nil {
		return finish("failed", "The selected version failed configuration or native API validation. sing-box was not stopped; review its compatibility on the server.", false)
	}
	current, err = host.Info(ctx)
	if err != nil || current.Revision != snapshot.Revision || current.Version != snapshot.Version || !sameCoreInstallation(current, snapshot) {
		return finish("failed", "The installed version or configuration changed during preparation; sing-box was not stopped.", false)
	}
	record.StopRequested = true
	if err := phase("stopping"); err != nil {
		return err
	}
	if err := host.Stop(ctx); err != nil {
		return recover()
	}
	if err := phase("backing_up"); err != nil {
		return err
	}
	if err := host.Backup(ctx, jobDir, snapshot); err != nil {
		return recover()
	}
	record.BackupComplete = true
	if err := write(); err != nil {
		return err
	}
	record.InstallRequested = true // Persist intent before a package transaction.
	if err := phase("installing"); err != nil {
		return err
	}
	if err := host.Install(ctx, snapshot, packageFile); err != nil {
		return recover()
	}
	if err := phase("restarting"); err != nil {
		return err
	}
	if err := host.Start(ctx); err != nil {
		return recover()
	}
	if err := phase("verifying"); err != nil {
		return err
	}
	if err := host.Verify(ctx, snapshot, record.Job.ToVersion); err != nil {
		return recover()
	}
	return finish("succeeded", "", false)
}
