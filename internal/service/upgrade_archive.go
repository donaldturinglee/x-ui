package service

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func allowedUpgradeEntry(name string, directory bool) bool {
	if directory {
		return name == "x-ui" || name == "x-ui/bin" || name == "x-ui/migrations" || name == "x-ui/web" || name == "x-ui/web/build" || strings.HasPrefix(name, "x-ui/web/build/")
	}
	switch name {
	case "x-ui/bin/x-ui-api", "x-ui/bin/x-ui-worker", "x-ui/bin/x-ui-cli", "x-ui/bin/x-ui-agent", "x-ui/bin/x-ui-core-reload",
		"x-ui/x-ui.sh", "x-ui/x-ui-api.service", "x-ui/x-ui-worker.service", "x-ui/x-ui-agent.service", "x-ui/release.json":
		return true
	}
	return strings.HasPrefix(name, "x-ui/web/build/") || strings.HasPrefix(name, "x-ui/migrations/") && path.Dir(name) == "x-ui/migrations" && strings.HasSuffix(name, ".sql")
}

// The release is verified before opening tar, and tar is never allowed to
// create links, devices or paths outside a fresh staging directory.
func stageUpgrade(ctx context.Context, source upgradeReleaseSource, root string, record *upgradeRecord) (string, error) {
	directory := upgradeJobDir(root, record.Job.ID)
	archive := filepath.Join(directory, "release.tar.gz")
	file, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	err = source.Download(ctx, record.Release.AssetURL, io.MultiWriter(file, hash), record.Release.AssetSize)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	info, err := os.Stat(archive)
	if err != nil {
		return "", err
	}
	if info.Size() != record.Release.AssetSize || hex.EncodeToString(hash.Sum(nil)) != record.Release.SHA256 {
		return "", fmt.Errorf("The release package failed SHA256 verification")
	}
	stage := filepath.Join(directory, "stage")
	if err := os.Mkdir(stage, 0o700); err != nil {
		return "", err
	}
	if err := extractUpgrade(ctx, archive, stage); err != nil {
		return "", err
	}
	return filepath.Join(stage, "x-ui"), nil
}

func extractUpgrade(ctx context.Context, archive, directory string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	seen := make(map[string]bool)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		isDirectory := header.Typeflag == tar.TypeDir
		if name != path.Clean(name) || strings.ContainsAny(name, "\\\x00") || path.IsAbs(name) || seen[name] || len(seen) >= 65536 || !allowedUpgradeEntry(name, isDirectory) {
			return fmt.Errorf("The release contains an invalid or unexpected path")
		}
		seen[name] = true
		if !isDirectory && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return fmt.Errorf("Release links and special files are not supported")
		}
		total += header.Size
		if header.Size < 0 || header.Size > 512<<20 || total > 2<<30 {
			return fmt.Errorf("The unpacked release exceeds the size limit")
		}
		target := filepath.Join(directory, filepath.FromSlash(name))
		if isDirectory {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasPrefix(name, "x-ui/bin/") || name == "x-ui/x-ui.sh" {
			mode = 0o755
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, reader)
		if copyErr == nil {
			copyErr = output.Sync()
		}
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for _, name := range []string{"x-ui/bin/x-ui-api", "x-ui/bin/x-ui-worker", "x-ui/bin/x-ui-cli", "x-ui/bin/x-ui-agent", "x-ui/bin/x-ui-core-reload", "x-ui/x-ui.sh", "x-ui/x-ui-api.service", "x-ui/x-ui-worker.service", "x-ui/x-ui-agent.service", "x-ui/release.json", "x-ui/web/build/index.html"} {
		if !seen[name] {
			return fmt.Errorf("The release is missing a required file")
		}
	}
	return nil
}

func copyUpgradeFile(source, target string, mode os.FileMode) error {
	if err := rejectUpgradeLinks(filepath.Dir(target)); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Upgrade files must be regular files")
	}
	if info, err := os.Lstat(target); err == nil && !info.Mode().IsRegular() {
		return fmt.Errorf("Upgrade target must be a regular file")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	output, err := os.CreateTemp(filepath.Dir(target), ".x-ui-upgrade-*")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	defer output.Close()
	if err := output.Chmod(mode.Perm()); err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	if err := os.Rename(output.Name(), target); err != nil {
		return err
	}
	return syncPanelDirectory(filepath.Dir(target))
}

func rejectUpgradeLinks(directory string) error {
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	for {
		info, err := os.Lstat(absolute)
		if err == nil && !info.IsDir() {
			return fmt.Errorf("Upgrade paths must not pass through links or files")
		}
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(absolute)
		if parent == absolute {
			return nil
		}
		absolute = parent
	}
}

func copyUpgradeTree(source, target string) error {
	return filepath.WalkDir(source, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, filename)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(target, relative), info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("Upgrade directories must not contain links or special files")
		}
		return copyUpgradeFile(filename, filepath.Join(target, relative), info.Mode())
	})
}
