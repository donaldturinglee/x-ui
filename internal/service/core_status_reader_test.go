package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func coreStatusUnit(executable, state string) []byte {
	return []byte(fmt.Sprintf("LoadState=loaded\nActiveState=%s\nMainPID=77\nExecStart={ path=%s ; argv[]=%s run -c /etc/sing-box/config.json ; }\nWorkingDirectory=/var/lib/sing-box\nExecMainStartTimestampMonotonic=0\n", state, executable, executable))
}

func TestCoreStatusReaderKeepsIndependentReadings(t *testing.T) {
	for _, tc := range []struct {
		name        string
		unit        []byte
		showErr     error
		version     string
		versionErr  error
		wantState   string
		wantVersion string
		wantCommand string
	}{
		{name: "running stable core", unit: coreStatusUnit("/usr/bin/sing-box", "active"), version: "sing-box version 1.14.2\nEnvironment: go1.27.1\n", wantState: "active", wantVersion: "1.14.2", wantCommand: "/usr/bin/sing-box"},
		{name: "prerelease with restart-ineligible arguments", unit: coreStatusUnit("/usr/local/bin/sing-box", "active"), version: "sing-box version 1.14.0-beta.12\n", wantState: "active", wantVersion: "1.14.0-beta.12", wantCommand: "/usr/local/bin/sing-box"},
		{name: "stopped core", unit: coreStatusUnit("/usr/bin/sing-box", "inactive"), version: "sing-box version 1.14.2\n", wantState: "inactive", wantVersion: "1.14.2", wantCommand: "/usr/bin/sing-box"},
		{name: "failed version command", unit: coreStatusUnit("/usr/bin/sing-box", "active"), versionErr: errors.New("a private executable error"), wantState: "active", wantCommand: "/usr/bin/sing-box"},
		{name: "invalid version output", unit: coreStatusUnit("/usr/bin/sing-box", "failed"), version: "a private invalid output", wantState: "failed", wantCommand: "/usr/bin/sing-box"},
		{name: "unsupported executable", unit: coreStatusUnit("/bin/sh", "active"), wantState: "active"},
		{name: "ambiguous executable", unit: coreStatusUnit("/usr/bin/sing-box", "active"), wantState: "active"},
		{name: "service missing", unit: []byte("LoadState=not-found\nActiveState=inactive\nMainPID=0\n"), wantState: "unknown"},
		{name: "unreadable service", showErr: errors.New("private service details"), wantState: "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "ambiguous executable" {
				tc.unit = append(tc.unit, []byte("ExecStart={ path=/usr/bin/sing-box ; } { path=/usr/local/bin/sing-box ; }\n")...)
			}
			reader := NewCoreStatusReader()
			var versionCommand string
			reader.run = func(ctx context.Context, executable string, args ...string) ([]byte, error) {
				if executable == "systemctl" {
					if len(args) < 2 || args[0] != "show" || args[1] != "sing-box.service" {
						t.Fatalf("status reader used a management or API command: %v", args)
					}
					return tc.unit, tc.showErr
				}
				if len(args) != 1 || args[0] != "version" {
					t.Fatalf("status reader executed arguments other than version: %v", args)
				}
				versionCommand = executable
				return []byte(tc.version), tc.versionErr
			}
			status := reader.Status(context.Background())
			if status.State != tc.wantState || status.CurrentVersion != tc.wantVersion || versionCommand != tc.wantCommand {
				t.Fatalf("status = %+v, version command = %q", status, versionCommand)
			}
			if status.Supported || strings.Contains(status.Reason, "private") {
				t.Fatalf("read-only status granted management or exposed command output: %+v", status)
			}
			report := formatTelegramStatus(time.Now(), time.UTC, telegramStatusData{core: &status})
			if status.State == "active" && !strings.Contains(report.Text, "Status: running") {
				t.Fatalf("available running state was lost: %s", report.Text)
			}
			if tc.wantVersion == "" && !strings.Contains(report.Text, "Sing-Box Version: N/A") {
				t.Fatalf("unavailable version was not reported as N/A: %s", report.Text)
			}
		})
	}
}

func TestCoreStatusReaderPreservesStateWhenVersionTimesOut(t *testing.T) {
	reader := NewCoreStatusReader()
	reader.run = func(ctx context.Context, executable string, args ...string) ([]byte, error) {
		if executable == "systemctl" {
			return coreStatusUnit("/usr/bin/sing-box", "active"), nil
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	status := reader.Status(ctx)
	if time.Since(started) > time.Second || status.State != "active" || status.CurrentVersion != "" {
		t.Fatalf("version timeout lost state or blocked the reader: %+v", status)
	}
}

func TestCoreReportedVersionsKeepManagementStableOnly(t *testing.T) {
	for _, tc := range []struct {
		output  string
		version string
		stable  bool
	}{
		{output: "sing-box version 1.14.2\nEnvironment: go1.27.1\n", version: "1.14.2", stable: true},
		{output: "sing-box version v1.14.2+custom.build\r\n", version: "1.14.2+custom.build", stable: true},
		{output: "sing-box version 1.14.0-beta.12\n", version: "1.14.0-beta.12"},
		{output: "sing-box version v1.14.0-alpha.1+build.7\n", version: "1.14.0-alpha.1+build.7"},
		{output: "sing-box version 1.14.0-rc.1\n", version: "1.14.0-rc.1"},
		{output: "other version 1.14.2\n"},
		{output: "sing-box version unknown\n"},
		{output: "sing-box version 01.14.2\n"},
		{output: "sing-box version 1.14.2 extra\n"},
		{output: ""},
	} {
		t.Run(strings.TrimSpace(tc.output), func(t *testing.T) {
			version, err := parseCoreReportedVersion([]byte(tc.output))
			if version != tc.version || (err == nil) != (tc.version != "") {
				t.Fatalf("reported version = %q, %v", version, err)
			}
			managed, err := parseManagedCoreVersion([]byte(tc.output))
			if tc.stable {
				if err != nil || managed != tc.version {
					t.Fatalf("stable management version = %q, %v", managed, err)
				}
			} else if err == nil || managed != "" {
				t.Fatalf("management accepted a prerelease or malformed version: %q, %v", managed, err)
			}
		})
	}
}

func TestCoreStatusExecutableUsesOnlyActualAllowedServicePaths(t *testing.T) {
	for _, value := range []string{
		"{ path=/bin/sh ; argv[]=/usr/bin/sing-box run ; }",
		"{ path=/tmp/sing-box ; argv[]=/usr/bin/sing-box run ; }",
		"{ path=/usr/bin/../bin/sing-box ; }",
		"{ argv[]=/usr/bin/sing-box run ; }",
		"{ path=/usr/bin/sing-box ; } { path=/usr/local/bin/sing-box ; }",
	} {
		if executable, err := coreStatusExecutable(value); err == nil || executable != "" {
			t.Fatalf("unsupported actual service executable accepted: %q", value)
		}
	}
}

// The test runner represents the API process; a real child process collects the
// worker's report with a different PID and the production reader constructor.
func TestTelegramStatusInWorkerProcess(t *testing.T) {
	if apiPID := os.Getenv("X_UI_TEST_TELEGRAM_API_PID"); apiPID != "" {
		pid, err := strconv.Atoi(apiPID)
		if err != nil || pid == os.Getpid() {
			t.Fatalf("worker did not run independently of API PID %q", apiPID)
		}
		reader := NewCoreStatusReader()
		reader.run = func(ctx context.Context, executable string, args ...string) ([]byte, error) {
			if executable == "systemctl" {
				if len(args) < 2 || args[0] != "show" || args[1] != "sing-box.service" {
					return nil, fmt.Errorf("worker queried API identity or management capability: %v", args)
				}
				return coreStatusUnit("/usr/bin/sing-box", "active"), nil
			}
			if executable != "/usr/bin/sing-box" || len(args) != 1 || args[0] != "version" {
				return nil, fmt.Errorf("worker executed an unexpected command: %s %v", executable, args)
			}
			return []byte("sing-box version 1.14.0-beta.12\n"), nil
		}
		service := NewTelegramStatusService(nil, reader, nil, time.UTC)
		service.publicIP = nil
		report := service.Report(context.Background())
		if !strings.Contains(report.Text, "Sing-Box Version: 1.14.0-beta.12") || !strings.Contains(report.Text, "Status: running") {
			t.Fatalf("independent worker could not read the local core: %s", report.Text)
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestTelegramStatusInWorkerProcess$")
	command.Env = append(os.Environ(), "X_UI_TEST_TELEGRAM_API_PID="+strconv.Itoa(os.Getpid()))
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("independent worker report failed: %v\n%s", err, output)
	}
}
