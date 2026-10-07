package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// This directory survives replacement of the installation and its config tree.
const installedConfigDir = "/usr/local/x-ui/configs"

type maintenanceOperation struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

func maintenanceDir(directory string) string {
	absolute, _ := filepath.Abs(directory)
	if filepath.Clean(absolute) == installedConfigDir {
		return "/var/lib/x-ui/maintenance"
	}
	// Development and tests coordinate only their own configuration directory.
	return filepath.Join(absolute, ".host-maintenance")
}

func maintenanceActive(directory string) (*maintenanceOperation, error) {
	var operation maintenanceOperation
	err := readPanelJSON(filepath.Join(maintenanceDir(directory), "active.json"), &operation)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !panelJobID.MatchString(operation.ID) || (operation.Kind != "panel" && operation.Kind != "core" && operation.Kind != "upgrade" && operation.Kind != "core-version") {
		return nil, fmt.Errorf("Invalid host maintenance record")
	}
	return &operation, nil
}

// Called with the gate held. A queued operation reserves the host before its
// independent helper starts; an execution lock alone would leave a race there.
func maintenanceReserve(directory, kind, id string) error {
	return writePanelJSON(filepath.Join(maintenanceDir(directory), "active.json"), maintenanceOperation{Kind: kind, ID: id})
}

func maintenancePrune(directory string, operation *maintenanceOperation) bool {
	if operation == nil {
		return false
	}
	unlock, err := acquirePrivateLock(filepath.Join(maintenanceDir(directory), "execution.lock"))
	if err != nil {
		return false
	}
	defer unlock()
	if operation.Kind == "upgrade" {
		record, err := readUpgradeRecord(upgradeRoot(directory), operation.ID)
		return err == nil && !record.Job.active() && !record.Job.NeedsRecovery
	}
	if operation.Kind == "core-version" {
		record, err := readCoreVersionRecord(coreVersionRoot(directory), operation.ID)
		return err == nil && !record.Job.active() && !record.Job.NeedsRecovery
	}
	if operation.Kind == "panel" {
		record, err := readPanelRestart(directory, operation.ID)
		return err == nil && (!record.Job.active() || time.Since(record.Job.RequestedAt) > 15*time.Minute)
	}
	job, err := readCoreRestart(directory, operation.ID)
	return err == nil && (!job.active() || time.Since(job.RequestedAt) > 3*time.Minute)
}

func maintenanceGate(directory, queueKind, owner string) (func(), error) {
	unlock, err := acquirePrivateLock(filepath.Join(maintenanceDir(directory), "gate.lock"))
	if err != nil {
		return nil, err
	}
	operation, err := maintenanceActive(directory)
	if err == nil && maintenancePrune(directory, operation) {
		err = os.Remove(filepath.Join(maintenanceDir(directory), "active.json"))
		operation = nil
	}
	if err == nil && operation != nil && operation.Kind != queueKind && operation.Kind+":"+operation.ID != owner {
		err = domain.Conflictf("Host maintenance is in progress; wait for the %s task to finish", operation.Kind)
	}
	if err != nil {
		unlock()
		return nil, err
	}
	return unlock, nil
}

// BeginHostWrite holds the queue gate through a write, so an upgrade cannot
// take its database checkpoint while an already admitted request is writing.
func BeginHostWrite(directory string) (func(), error) {
	return maintenanceWrite(directory, "")
}

// Normal writes share the gate. Reserving or releasing maintenance takes the
// exclusive gate, without serializing unrelated requests during normal use.
func maintenanceWrite(directory, owner string) (func(), error) {
	unlock, err := acquirePrivateSharedLock(filepath.Join(maintenanceDir(directory), "gate.lock"))
	if err != nil {
		return nil, err
	}
	operation, err := maintenanceActive(directory)
	if err == nil && operation != nil && operation.Kind+":"+operation.ID != owner && !maintenancePrune(directory, operation) {
		err = domain.Conflictf("Host maintenance is in progress; wait for the %s task to finish", operation.Kind)
	}
	if err != nil {
		unlock()
		return nil, err
	}
	return unlock, nil
}

// Used only by CLI subprocesses of the root-owned runner, never by HTTP.
func BeginHostCLIWrite(directory string) (func(), error) {
	// The installer holds the gate in its parent shell and passes the open
	// descriptor to its CLI children. Verify that descriptor instead of taking
	// a second lock on the same inode.
	if fd := os.Getenv("X_UI_INSTALLER_LOCK_FD"); fd != "" && os.Geteuid() == 0 {
		if target, err := os.Readlink("/proc/self/fd/" + fd); err == nil && target == filepath.Join(maintenanceDir(directory), "gate.lock") {
			return func() {}, nil
		}
	}
	return maintenanceWrite(directory, os.Getenv("X_UI_MAINTENANCE_OWNER"))
}

func maintenanceExecute(directory, kind, id string) (func(), error) {
	gate, err := maintenanceGate(directory, "", kind+":"+id)
	if err != nil {
		return nil, err
	}
	defer gate()
	operation, err := maintenanceActive(directory)
	if err != nil {
		return nil, err
	}
	if operation == nil {
		// Permit tasks queued by an earlier release of the panel.
		if err := maintenanceReserve(directory, kind, id); err != nil {
			return nil, err
		}
	}
	return acquirePrivateLock(filepath.Join(maintenanceDir(directory), "execution.lock"))
}

func maintenanceRelease(directory, kind, id string) error {
	gate, err := acquirePrivateLock(filepath.Join(maintenanceDir(directory), "gate.lock"))
	if err != nil {
		return err
	}
	defer gate()
	operation, err := maintenanceActive(directory)
	if err != nil || operation == nil {
		return err
	}
	if operation.Kind == kind && operation.ID == id {
		return os.Remove(filepath.Join(maintenanceDir(directory), "active.json"))
	}
	return nil
}

func capturedUpgradeEnvironment() map[string]string {
	result := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "X_UI_") && key != "X_UI_MAINTENANCE_OWNER" {
			result[key] = value
		}
	}
	return result
}
