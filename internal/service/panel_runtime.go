package service

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
)

type PanelProcessRuntime struct {
	Version          string                `json:"version,omitempty"`
	DatabaseRevision string                `json:"databaseRevision,omitempty"`
	PID              int                   `json:"pid"`
	StartedAt        time.Time             `json:"startedAt"`
	Settings         PanelSettings         `json:"settings"`
	Overrides        map[string]string     `json:"overrides,omitempty"`
	Subscription     *SubscriptionSettings `json:"subscription,omitempty"`
}

func panelRuntimeDir(directory string) string { return filepath.Join(directory, ".panel-runtime") }

func ensurePanelRuntimeDir(directory string) error {
	if info, err := os.Lstat(directory); err == nil && !info.IsDir() {
		return fmt.Errorf("Panel runtime directory must not be a symlink or file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(directory, 0o700)
}

func acquirePanelLock(directory string) (func(), error) {
	return acquirePrivateLock(filepath.Join(panelRuntimeDir(directory), "lock"))
}

func acquirePrivateLock(path string) (func(), error) {
	return acquirePrivateFileLock(path, false)
}

func acquirePrivateSharedLock(path string) (func(), error) {
	return acquirePrivateFileLock(path, true)
}

func acquirePrivateFileLock(path string, shared bool) (func(), error) {
	if err := ensurePanelRuntimeDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("Panel lock must be a regular file")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	lock := lockPanelFile
	if shared {
		lock = lockPanelFileShared
	}
	unlock, err := lock(file)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return func() { unlock(); _ = file.Close() }, nil
}

func writePanelPrivate(path string, data []byte) error {
	if err := ensurePanelRuntimeDir(filepath.Dir(path)); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("Panel state must be a regular file")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".panel-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return syncPanelDirectory(filepath.Dir(path))
}

func syncPanelDirectory(directory string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func writePanelJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writePanelPrivate(path, data)
}

func readPanelJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return fmt.Errorf("Invalid Panel state file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

func panelRevision(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

// Written only after startup has completed. The restart helper checks the PID
// against systemd, so an old file cannot make a crashed worker look ready.
func RecordPanelProcess(kind string, cfg *config.Config) error {
	if kind != "api" && kind != "worker" {
		return fmt.Errorf("Unknown Panel process")
	}
	values := panelSettingsOf(cfg)
	overrides := make(map[string]string)
	for _, field := range values.fields() {
		if _, exists := os.LookupEnv(field.env); exists {
			overrides[field.name] = field.env
		}
	}
	var subscription *SubscriptionSettings
	if kind == "api" {
		values := subscriptionSettingsOf(cfg)
		subscription = &values
	}
	return writePanelJSON(filepath.Join(panelRuntimeDir(config.Dir()), kind+".json"), PanelProcessRuntime{
		Version: config.Version, DatabaseRevision: upgradeDatabaseRevision(cfg),
		PID: os.Getpid(), StartedAt: time.Now().UTC(), Settings: values, Overrides: overrides,
		Subscription: subscription,
	})
}

func startupProcessesAgree(directory string, panel PanelSettings, subscription SubscriptionSettings) bool {
	if !panelProcessesAgree(directory, panel) {
		return false
	}
	var process PanelProcessRuntime
	return readPanelJSON(filepath.Join(panelRuntimeDir(directory), "api.json"), &process) == nil && process.Subscription != nil && reflect.DeepEqual(*process.Subscription, subscription)
}

func panelProcessSettingsAgree(kind string, a, b PanelSettings) bool {
	if kind == "api" {
		return reflect.DeepEqual(a, b)
	}
	return a.StatsRetentionSeconds == b.StatsRetentionSeconds && a.StatsBucketSeconds == b.StatsBucketSeconds &&
		a.TimeLocation == b.TimeLocation && a.ResetSpec == b.ResetSpec && a.DepleteSpec == b.DepleteSpec &&
		a.CleanupSpec == b.CleanupSpec && a.LogLevel == b.LogLevel
}

func panelProcessesAgree(directory string, values PanelSettings) bool {
	for _, kind := range []string{"api", "worker"} {
		var process PanelProcessRuntime
		if readPanelJSON(filepath.Join(panelRuntimeDir(directory), kind+".json"), &process) != nil || !panelProcessSettingsAgree(kind, process.Settings, values) {
			return false
		}
	}
	return true
}
