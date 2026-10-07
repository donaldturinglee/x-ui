package service

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

const maxCoreExecutableSize = 256 << 20

func extractCoreTar(reader io.Reader, target string) error {
	archive := tar.NewReader(io.LimitReader(reader, 512<<20))
	found := false
	for {
		header, err := archive.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(header.Name, "./")
		if (name == "" || name == ".") && header.Typeflag == tar.TypeDir {
			continue
		}
		if path.IsAbs(name) || path.Clean(name) != strings.TrimSuffix(name, "/") || strings.HasPrefix(name, "../") {
			return fmt.Errorf("Invalid package path")
		}
		if name != "usr/bin/sing-box" {
			continue
		}
		if found || header.Typeflag != tar.TypeReg || header.Size < 1 || header.Size > maxCoreExecutableSize {
			return fmt.Errorf("Invalid package executable")
		}
		if err := writeCoreExecutable(archive, target, header.Size); err != nil {
			return err
		}
		found = true
	}
	if !found {
		return fmt.Errorf("The package contains no sing-box executable")
	}
	return nil
}

// RPM payloads use the newc format. Only the executable is written; package
// paths, symlinks, devices and scripts are never extracted into the host here.
func extractCoreCPIO(reader io.Reader, target string) error {
	reader = io.LimitReader(reader, 512<<20)
	found := false
	for {
		header := make([]byte, 110)
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		if string(header[:6]) != "070701" && string(header[:6]) != "070702" {
			return fmt.Errorf("Unsupported RPM payload format")
		}
		mode, err := strconv.ParseUint(string(header[14:22]), 16, 32)
		if err != nil {
			return err
		}
		size, err := strconv.ParseInt(string(header[54:62]), 16, 64)
		if err != nil || size < 0 || size > maxCoreExecutableSize {
			return fmt.Errorf("Invalid RPM payload size")
		}
		nameSize, err := strconv.ParseInt(string(header[94:102]), 16, 64)
		if err != nil || nameSize < 1 || nameSize > 4096 {
			return fmt.Errorf("Invalid RPM payload name")
		}
		nameData := make([]byte, nameSize)
		if _, err := io.ReadFull(reader, nameData); err != nil || nameData[len(nameData)-1] != 0 {
			return fmt.Errorf("Invalid RPM payload name")
		}
		if _, err := io.CopyN(io.Discard, reader, (4-(110+nameSize)%4)%4); err != nil {
			return err
		}
		name := strings.TrimPrefix(string(nameData[:len(nameData)-1]), "./")
		if name == "TRAILER!!!" {
			if !found || size != 0 {
				return fmt.Errorf("Invalid RPM payload trailer")
			}
			_, err := io.Copy(io.Discard, reader)
			return err
		}
		if path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") {
			return fmt.Errorf("Invalid RPM package path")
		}
		if name == "usr/bin/sing-box" {
			if found || mode&0170000 != 0100000 || size < 1 {
				return fmt.Errorf("Invalid RPM executable")
			}
			if err := writeCoreExecutable(reader, target, size); err != nil {
				return err
			}
			found = true
		} else if _, err := io.CopyN(io.Discard, reader, size); err != nil {
			return err
		}
		if _, err := io.CopyN(io.Discard, reader, (4-size%4)%4); err != nil {
			return err
		}
	}
}

func writeCoreExecutable(reader io.Reader, target string, size int64) error {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	_, copyErr := io.CopyN(file, reader, size)
	if copyErr == nil {
		copyErr = file.Sync()
	}
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func unpackCoreExecutable(ctx context.Context, manager, packageFile, candidate string) error {
	var command *exec.Cmd
	if manager == "apt" {
		command = exec.CommandContext(ctx, "dpkg-deb", "--fsys-tarfile", packageFile)
	} else {
		command = exec.CommandContext(ctx, "rpm2cpio", packageFile)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	if manager == "apt" {
		err = extractCoreTar(output, candidate)
	} else {
		err = extractCoreCPIO(output, candidate)
	}
	if err != nil {
		_ = command.Process.Kill()
	}
	waitErr := command.Wait()
	if err != nil {
		return err
	}
	return waitErr
}

func inspectCorePackage(ctx context.Context, manager, packageFile string) (string, string, error) {
	var command *exec.Cmd
	if manager == "apt" {
		command = exec.CommandContext(ctx, "dpkg-deb", "--show", "--showformat=${Package}\n${Version}\n${Architecture}\n", packageFile)
	} else {
		command = exec.CommandContext(ctx, "rpm", "-qp", "--qf", "%{NAME}\n%{VERSION}-%{RELEASE}\n%{ARCH}\n", packageFile)
	}
	output, err := command.Output()
	fields := strings.Split(strings.TrimSpace(string(output)), "\n")
	if err != nil || len(fields) != 3 || fields[0] != "sing-box" {
		return "", "", fmt.Errorf("The official package metadata could not be verified")
	}
	return fields[1], fields[2], nil
}

func validateCorePackageTransaction(ctx context.Context, manager, packageFile string) error {
	if !filepath.IsAbs(packageFile) {
		return fmt.Errorf("Invalid package path")
	}
	if manager == "dnf" {
		return fixedPanelCommand(ctx, "rpm", "--upgrade", "--test", "--oldpackage", packageFile)
	}
	command := exec.CommandContext(ctx, "apt-get", "--simulate", "--no-install-recommends", "--allow-downgrades", "install", packageFile)
	output, err := command.Output()
	if err != nil {
		return fmt.Errorf("Package dependencies could not be verified")
	}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || (fields[0] != "Inst" && fields[0] != "Remv" && fields[0] != "Conf") {
			continue
		}
		if fields[0] == "Remv" || strings.Split(fields[1], ":")[0] != "sing-box" {
			return fmt.Errorf("The transaction would change another package; install dependencies separately")
		}
	}
	return nil
}
