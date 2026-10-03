package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
)

// The root-owned copy of x-ui-cli runs independently of the API it replaces.
// A resumed task always recovers its checkpoint rather than repeating a
// migration whose outcome cannot be inferred from the last persisted phase.
func RunUpgrade(ctx context.Context, directory, id string) error {
	if filepath.Clean(directory) != installedConfigDir {
		return fmt.Errorf("Automatic upgrade requires the standard installation directory")
	}
	return runUpgrade(ctx, directory, id, systemdUpgradeHost{}, newGithubUpgradeSource())
}

func runUpgrade(ctx context.Context, directory, id string, host upgradeHost, source upgradeReleaseSource) error {
	root := upgradeRoot(directory)
	record, err := readUpgradeRecord(root, id)
	if err != nil {
		return err
	}
	if !record.Job.active() && !record.Job.NeedsRecovery {
		return nil
	}
	unlock, err := maintenanceExecute(directory, "upgrade", id)
	if err != nil {
		return err
	}
	defer unlock()
	for key, value := range record.Environment {
		if strings.HasPrefix(key, "X_UI_") && key != "X_UI_MAINTENANCE_OWNER" {
			_ = os.Setenv(key, value)
		}
	}
	_ = os.Setenv("X_UI_CONFIG_DIR", directory)
	latest, err := latestUpgrade(root)
	if err != nil || latest == nil || latest.Job.ID != id {
		return fmt.Errorf("Upgrade task is not current")
	}
	write := func() error { return writePanelJSON(upgradeRecordPath(root, id), record) }
	finish := func(state, message string, recovery bool) error {
		now := time.Now().UTC()
		record.Job.State, record.Job.Error, record.Job.NeedsRecovery, record.Job.FinishedAt = state, message, recovery, &now
		if err := write(); err != nil {
			return err
		}
		if !recovery {
			_ = host.Cleanup(context.Background(), directory, record)
			return maintenanceRelease(directory, "upgrade", id)
		}
		return nil
	}
	phase := func(value string) error { record.Job.State, record.Job.Phase = "running", value; return write() }
	recover := func() error {
		record.Job.State, record.Job.Phase = "rolling_back", "recovering"
		record.Job.Error = "The upgrade did not complete; restoring the previous installation."
		if err := write(); err != nil {
			return err
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
		defer cancel()
		if record.StopRequested {
			if err := host.Stop(recoveryCtx, record); err != nil {
				return finish("failed", "The services could not be stopped for recovery. The backup was retained; recover the installation from the command line.", true)
			}
		}
		if record.DatabaseChanged {
			if !record.DatabaseBackedUp || host.RestoreDatabase(recoveryCtx, directory, record) != nil {
				return finish("failed", "Database recovery failed. Services remain stopped and the backup was retained; recover the installation from the command line.", true)
			}
		}
		if record.FilesChanged {
			if !record.FilesBackedUp || host.RestoreFiles(recoveryCtx, directory, record) != nil {
				return finish("failed", "Program recovery failed. Services remain stopped and the backup was retained; recover the installation from the command line.", true)
			}
		}
		if record.StopRequested {
			record.RestartedAt = time.Now().UTC()
			if err := write(); err != nil {
				return err
			}
			if host.Start(recoveryCtx, record) != nil || host.Verify(recoveryCtx, directory, record, record.Job.FromVersion) != nil {
				_ = host.Stop(recoveryCtx, record)
				return finish("failed", "The previous installation was restored, but its services did not recover. Check the services and retained backup from the command line.", true)
			}
		}
		return finish("rolled_back", "The upgrade failed. The previous version and database have been restored.", false)
	}
	if record.Job.State != "queued" {
		if record.StopRequested || record.DatabaseChanged || record.FilesChanged {
			return recover()
		}
		return finish("failed", "The task was interrupted before the installation changed. Check for updates and retry.", false)
	}
	data, err := os.ReadFile(filepath.Join(directory, "config.yaml"))
	if err != nil || panelRevision(data) != record.Revision {
		return finish("failed", "Configuration changed before upgrading; no services were stopped.", false)
	}
	if err := checkUpgradeSpace(upgradeJobDir(root, id), uint64(record.Release.AssetSize)*5+128<<20); err != nil {
		return finish("failed", "There is insufficient free space to stage the release; no services were stopped.", false)
	}
	if err := phase("downloading"); err != nil {
		return err
	}
	checkCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	release, err := source.Resolve(checkCtx, record.Release.ID, record.Platform)
	cancel()
	if err != nil || !reflect.DeepEqual(release, &record.Release) {
		return finish("failed", "The confirmed release changed or could not be verified; check for updates again.", false)
	}
	stage, err := stageUpgrade(ctx, source, root, record)
	if err != nil {
		return finish("failed", "The release could not be downloaded, verified or unpacked. The installed version was preserved.", false)
	}
	if err := phase("checking"); err != nil {
		return err
	}
	if err := host.Preflight(ctx, directory, record, stage); err != nil {
		return finish("failed", "Upgrade preflight failed. Check installation permissions, disk space, release compatibility and PostgreSQL backup tools.", false)
	}
	data, err = os.ReadFile(filepath.Join(directory, "config.yaml"))
	if err != nil || panelRevision(data) != record.Revision {
		return finish("failed", "Configuration changed during preparation; no services were stopped.", false)
	}
	if err := phase("backing_up"); err != nil {
		return err
	}
	if err := host.BackupFiles(ctx, directory, record); err != nil {
		return finish("failed", "The program and configuration backup failed; no services were stopped.", false)
	}
	record.FilesBackedUp = true
	if err := write(); err != nil {
		return err
	}
	record.StopRequested = true // Persist intent before stopping anything.
	if err := phase("stopping"); err != nil {
		return err
	}
	if err := host.Stop(ctx, record); err != nil {
		return recover()
	}
	if err := host.BackupDatabase(ctx, directory, record); err != nil {
		return recover()
	}
	record.DatabaseBackedUp = true
	if err := write(); err != nil {
		return err
	}
	record.DatabaseChanged = true
	if err := phase("migrating"); err != nil {
		return err
	}
	if err := host.Migrate(ctx, directory, record, stage); err != nil {
		return recover()
	}
	record.FilesChanged = true
	if err := phase("installing"); err != nil {
		return err
	}
	if err := host.Install(ctx, directory, record, stage); err != nil {
		return recover()
	}
	record.RestartedAt = time.Now().UTC()
	if err := phase("restarting"); err != nil {
		return err
	}
	if err := host.Start(ctx, record); err != nil {
		return recover()
	}
	if err := phase("verifying"); err != nil {
		return err
	}
	if err := host.Verify(ctx, directory, record, record.Job.ToVersion); err != nil {
		return recover()
	}
	return finish("succeeded", "", false)
}

func ResumeUpgrade(ctx context.Context) error {
	record, err := latestUpgrade(upgradeRoot(installedConfigDir))
	if err != nil || record == nil {
		return err
	}
	return RunUpgrade(ctx, installedConfigDir, record.Job.ID)
}
