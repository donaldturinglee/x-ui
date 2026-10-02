package service

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"runtime"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"
)

// Usage is a current-against-total pair, in bytes.
type Usage struct {
	Current uint64 `json:"current"`
	Total   uint64 `json:"total"`
}

// SystemStatus is what the host and the process are doing.
//
// Every section is optional. A reading that cannot be taken -- a container with
// no access to the host's disks, a platform gopsutil does not cover -- is
// omitted rather than reported as zero, because zero disk usage and unknown
// disk usage look identical to whoever is reading the page and mean opposite
// things.
type SystemStatus struct {
	App      AppStatus        `json:"app"`
	Host     *HostStatus      `json:"host,omitempty"`
	CPU      *float64         `json:"cpuPercent,omitempty"`
	Memory   *Usage           `json:"memory,omitempty"`
	Swap     *Usage           `json:"swap,omitempty"`
	Disk     *Usage           `json:"disk,omitempty"`
	Network  *NetworkStatus   `json:"network,omitempty"`
	Database map[string]int64 `json:"database,omitempty"`
	Warnings []string         `json:"warnings,omitempty"`
}

type AppStatus struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Go          string `json:"go"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	Goroutines  int    `json:"goroutines"`
	HeapBytes   uint64 `json:"heapBytes"`
	UptimeSecs  int64  `json:"uptimeSeconds"`
	Maintenance bool   `json:"maintenance"`
}

type HostStatus struct {
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	CPUs     int    `json:"cpus"`
	CPUModel string `json:"cpuModel,omitempty"`
	BootTime uint64 `json:"bootTime"`
}

type NetworkStatus struct {
	BytesSent   uint64 `json:"bytesSent"`
	BytesRecv   uint64 `json:"bytesRecv"`
	PacketsSent uint64 `json:"packetsSent"`
	PacketsRecv uint64 `json:"packetsRecv"`
}

// SystemService answers what the panel and its host are doing, and runs the
// backup and restore an operator reaches for when something has gone wrong.
type SystemService struct {
	store     *repository.Store
	settings  *SettingService
	startedAt time.Time
}

func NewSystemService(store *repository.Store, settings *SettingService) *SystemService {
	return &SystemService{store: store, settings: settings, startedAt: time.Now()}
}

func (s *SystemService) Settings() *SettingService {
	if s == nil {
		return nil
	}
	return s.settings
}

// Status gathers everything that can be read, and names what could not.
func (s *SystemService) Status(ctx context.Context) *SystemStatus {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	status := &SystemStatus{
		App: AppStatus{
			Name:       config.Name,
			Version:    config.Version,
			Go:         runtime.Version(),
			OS:         runtime.GOOS,
			Arch:       runtime.GOARCH,
			Goroutines: runtime.NumGoroutine(),
			HeapBytes:  memStats.HeapAlloc,
			UptimeSecs: int64(time.Since(s.startedAt).Seconds()),
		},
	}

	note := func(what string, err error) {
		status.Warnings = append(status.Warnings, what+": "+err.Error())
	}

	if maintenance, err := s.settings.Maintenance(ctx); err != nil {
		note("maintenance", err)
	} else {
		status.App.Maintenance = maintenance
	}

	if info, err := host.InfoWithContext(ctx); err != nil {
		note("host", err)
	} else {
		hostStatus := &HostStatus{
			Hostname: info.Hostname,
			Platform: info.Platform + " " + info.PlatformVersion,
			CPUs:     runtime.NumCPU(),
			BootTime: info.BootTime,
		}
		if models, err := cpu.InfoWithContext(ctx); err == nil && len(models) > 0 {
			hostStatus.CPUModel = models[0].ModelName
		}
		status.Host = hostStatus
	}

	// Zero interval means "since boot" and returns immediately. Sampling over a
	// window would hold the request open for the length of that window, on an
	// endpoint a dashboard polls every few seconds.
	if percents, err := cpu.PercentWithContext(ctx, 0, false); err != nil {
		note("cpu", err)
	} else if len(percents) > 0 {
		status.CPU = &percents[0]
	}

	if virtual, err := mem.VirtualMemoryWithContext(ctx); err != nil {
		note("memory", err)
	} else {
		status.Memory = &Usage{Current: virtual.Used, Total: virtual.Total}
	}
	if swap, err := mem.SwapMemoryWithContext(ctx); err == nil && swap.Total > 0 {
		status.Swap = &Usage{Current: swap.Used, Total: swap.Total}
	}

	if usage, err := disk.UsageWithContext(ctx, rootPath()); err != nil {
		note("disk", err)
	} else {
		status.Disk = &Usage{Current: usage.Used, Total: usage.Total}
	}

	if counters, err := psnet.IOCountersWithContext(ctx, false); err != nil {
		note("network", err)
	} else if len(counters) > 0 {
		status.Network = &NetworkStatus{
			BytesSent:   counters[0].BytesSent,
			BytesRecv:   counters[0].BytesRecv,
			PacketsSent: counters[0].PacketsSent,
			PacketsRecv: counters[0].PacketsRecv,
		}
	}

	if counts, err := database.Counts(ctx, s.store.DB()); err != nil {
		note("database", err)
	} else {
		status.Database = counts
	}

	return status
}

// rootPath is the filesystem whose usage is reported: the volume the process
// itself lives on, which on Windows is a drive letter rather than "/".
func rootPath() string {
	if runtime.GOOS == "windows" {
		if volume := os.Getenv("SystemDrive"); volume != "" {
			return volume + `\`
		}
		return `C:\`
	}
	return "/"
}

// Backup exports the panel's data, optionally leaving tables out.
func (s *SystemService) Backup(ctx context.Context, actor string, exclude []string) ([]byte, error) {
	backup, err := database.Export(ctx, s.store.DB(), exclude)
	if err != nil {
		return nil, err
	}

	encoded, err := json.Marshal(backup)
	if err != nil {
		return nil, err
	}
	// Recorded because a backup is a copy of every credential the panel holds,
	// and who took one is exactly what an audit log is for.
	logChange(ctx, s.store, actor, "backup", "export", map[string]interface{}{
		"excluded": backup.Excluded,
		"bytes":    len(encoded),
	})
	return encoded, nil
}

// Restore replaces the panel's data with a backup's.
//
// The audit entry is written after the import, because the import truncates the
// audit log along with everything else -- an entry written first would be
// erased by the thing it describes.
func (s *SystemService) Restore(ctx context.Context, actor string, reader io.Reader) error {
	backup, err := database.Import(ctx, s.store.DB(), reader)
	if err != nil {
		return err
	}
	logger.Warning("data restored from a backup taken at ", time.Unix(backup.TakenAt, 0).Format(time.RFC3339), " by ", actor)
	logChange(ctx, s.store, actor, "backup", "restore", map[string]interface{}{
		"takenAt":  backup.TakenAt,
		"excluded": backup.Excluded,
	})
	return nil
}

// Keypair mints key material.
func (s *SystemService) Keypair(kind string, options string) (*Keypair, error) {
	return GenerateKeypair(kind, options)
}

// ProbeCertificate reports what a server presents.
func (s *SystemService) ProbeCertificate(ctx context.Context, domainName string, port string) (*CertificateProbe, error) {
	return ProbeCertificate(ctx, domainName, port)
}
