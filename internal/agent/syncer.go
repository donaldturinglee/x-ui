package agent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// Syncer keeps the node's configuration file in step with the panel.
type Syncer struct {
	client *PanelClient
	cfg    CoreConfig

	// lastHash is what was successfully applied. Comparing hashes rather than always
	// reloading is the whole point: a reload drops connections, and polling
	// every thirty seconds would otherwise drop them every thirty seconds.
	lastHash [sha256.Size]byte
	loaded   bool
	// A failed reload must be retried even when the staging file already
	// contains the candidate, including on the very first synchronization.
	retry bool
}

func NewSyncer(client *PanelClient, cfg CoreConfig) *Syncer {
	return &Syncer{client: client, cfg: cfg}
}

// Sync fetches the configuration and applies it when it has changed. It reports
// whether anything was applied.
func (s *Syncer) Sync(ctx context.Context) (bool, error) {
	fetched, err := s.client.FetchConfig(ctx)
	if err != nil {
		return false, err
	}
	document := fetched.Document

	hash := sha256.Sum256(document)
	if s.loaded && hash == s.lastHash {
		return false, nil
	}
	// On the first run the file on disk is compared too, so restarting the
	// agent does not reload a core that is already serving the right thing.
	if !s.loaded && !s.retry {
		appliedPath := s.cfg.AppliedConfigPath
		if appliedPath == "" {
			appliedPath = s.cfg.ConfigPath
		}
		if existing, err := os.ReadFile(appliedPath); err == nil {
			if sha256.Sum256(existing) == hash {
				if appliedPath != s.cfg.ConfigPath {
					staged, err := os.ReadFile(s.cfg.ConfigPath)
					if err != nil && !os.IsNotExist(err) {
						return false, err
					}
					if err != nil || sha256.Sum256(staged) != hash {
						if err := writeAtomic(s.cfg.ConfigPath, document); err != nil {
							return false, err
						}
					}
				}
				s.lastHash, s.loaded = hash, true
				logger.Info("configuration already current, nothing to reload")
				return false, nil
			}
		}
	}

	if err := s.check(ctx, document); err != nil {
		return false, err
	}
	previous, previousErr := os.ReadFile(s.cfg.ConfigPath)
	if previousErr != nil && !os.IsNotExist(previousErr) {
		return false, previousErr
	}
	if err := writeAtomic(s.cfg.ConfigPath, document); err != nil {
		return false, err
	}
	logger.Info("wrote a new configuration to ", s.cfg.ConfigPath)

	// Said out loud, because a node that has just stopped accepting clients
	// otherwise looks broken. The panel withheld the listeners on purpose, and
	// only the panel knows that.
	if fetched.Maintenance {
		logger.Warning("the panel is in maintenance: this node is now serving no listeners, and clients cannot connect")
	}

	if err := s.reload(ctx); err != nil {
		s.retry = true
		var restoreErr error
		if previousErr == nil {
			restoreErr = writeAtomic(s.cfg.ConfigPath, previous)
		} else {
			restoreErr = os.Remove(s.cfg.ConfigPath)
		}
		if restoreErr != nil {
			return true, fmt.Errorf("%w; restore staging configuration: %v", err, restoreErr)
		}
		return true, err
	}
	s.lastHash, s.loaded, s.retry = hash, true, false
	return true, nil
}

func (s *Syncer) check(ctx context.Context, document []byte) error {
	if len(s.cfg.CheckCommand) == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.cfg.ConfigPath), 0o755); err != nil {
		return err
	}
	candidate, err := os.CreateTemp(filepath.Dir(s.cfg.ConfigPath), ".x-ui-check-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(candidate.Name())
	if _, err = candidate.Write(document); err != nil {
		candidate.Close()
		return err
	}
	if err = candidate.Close(); err != nil {
		return err
	}
	arguments := append([]string(nil), s.cfg.CheckCommand...)
	for i := range arguments {
		if arguments[i] == "{config}" {
			arguments[i] = candidate.Name()
		}
	}
	if err := s.runCommand(ctx, arguments); err != nil {
		return fmt.Errorf("configuration check failed: %w", err)
	}
	return nil
}

// reload runs the operator's reload command.
func (s *Syncer) reload(ctx context.Context) error {
	if len(s.cfg.ReloadCommand) == 0 {
		logger.Warning("no reload command configured: the new configuration is on disk but nothing was told to read it")
		return nil
	}

	if err := s.runCommand(ctx, s.cfg.ReloadCommand); err != nil {
		return fmt.Errorf("reload command failed: %w", err)
	}
	logger.Info("reloaded the core")
	return nil
}

func (s *Syncer) runCommand(ctx context.Context, arguments []string) error {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.ReloadTimeout.Duration())
	defer cancel()
	cmd := exec.CommandContext(ctx, arguments[0], arguments[1:]...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, summarise(output))
	}
	return nil
}

// writeAtomic writes through a temporary file in the same directory and
// renames it into place.
//
// A core reading its configuration while the agent is halfway through writing
// it gets a truncated document and refuses to start. Rename is atomic within a
// filesystem, so the core sees either the old file or the new one.
func writeAtomic(path string, content []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Removed on every failure path below. Without this a failed write leaves a
	// temporary file behind on every poll.
	defer os.Remove(tmpName)

	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	// Flushed before the rename: a rename that lands before the contents reach
	// the disk leaves an empty file after a power loss.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// The configuration carries every subscriber's credentials.
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}
