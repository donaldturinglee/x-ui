package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
)

type TelegramStatusSnapshot struct {
	CapturedAt time.Time `json:"capturedAt"`
	Text       string    `json:"text"`
}

type telegramStatusProvider interface {
	Report(context.Context) TelegramStatusSnapshot
}

type telegramSystemStatusReader interface {
	Status(context.Context) *SystemStatus
}
type telegramCoreStatusReader interface {
	Status(context.Context) CoreStatus
}
type telegramOnlineReader interface {
	Onlines(context.Context) (*Onlines, error)
}

// One bounded collection supplies both interactive and scheduled reports.
type TelegramStatusService struct {
	system   telegramSystemStatusReader
	core     telegramCoreStatusReader
	stats    telegramOnlineReader
	location *time.Location
	publicIP func(context.Context) string
	now      func() time.Time
}

func NewTelegramStatusService(system *SystemService, core *CoreStatusReader, stats *StatsService, location *time.Location) *TelegramStatusService {
	if location == nil {
		location = time.UTC
	}
	ip := newTelegramPublicIP()
	s := &TelegramStatusService{location: location, publicIP: ip.read, now: time.Now}
	if system != nil {
		s.system = system
	}
	if core != nil {
		s.core = core
	}
	if stats != nil {
		s.stats = stats
	}
	return s
}

type telegramStatusData struct {
	system *SystemStatus
	core   *CoreStatus
	online *int
	ip     string
}

func (s *TelegramStatusService) Report(parent context.Context) TelegramStatusSnapshot {
	captured := s.now()
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	results := make(chan func(*telegramStatusData), 4)
	pending := 0
	submit := func(read func() func(*telegramStatusData)) {
		pending++
		go func() { results <- read() }()
	}
	if s.system != nil {
		submit(func() func(*telegramStatusData) {
			v := s.system.Status(ctx)
			return func(d *telegramStatusData) { d.system = v }
		})
	}
	if s.core != nil {
		submit(func() func(*telegramStatusData) {
			v := s.core.Status(ctx)
			return func(d *telegramStatusData) { d.core = &v }
		})
	}
	if s.stats != nil {
		submit(func() func(*telegramStatusData) {
			v, err := s.stats.Onlines(ctx)
			return func(d *telegramStatusData) {
				if err == nil && v != nil {
					n := len(v.Client)
					d.online = &n
				}
			}
		})
	}
	if s.publicIP != nil {
		submit(func() func(*telegramStatusData) {
			v := s.publicIP(ctx)
			return func(d *telegramStatusData) { d.ip = v }
		})
	}
	var data telegramStatusData
	for pending > 0 {
		select {
		case result := <-results:
			result(&data)
			pending--
		case <-ctx.Done():
			return formatTelegramStatus(captured, s.location, data)
		}
	}
	return formatTelegramStatus(captured, s.location, data)
}

func formatTelegramStatus(captured time.Time, location *time.Location, data telegramStatusData) TelegramStatusSnapshot {
	if location == nil {
		location = time.UTC
	}
	ip, coreVersion, uptime, ram, online, traffic, state := "N/A", "N/A", "N/A", "N/A", "N/A", "N/A", "unknown"
	if data.ip != "" {
		ip = data.ip
	}
	if data.core != nil {
		coreVersion = telegramStatusValue(data.core.CurrentVersion)
		switch data.core.State {
		case "active":
			state = "running"
		case "inactive":
			state = "stopped"
		case "failed":
			state = "failed"
		case "activating":
			state = "starting"
		case "deactivating":
			state = "stopping"
		case "reloading":
			state = "reloading"
		}
	}
	if data.system != nil {
		if host := data.system.Host; host != nil && host.BootTime > 0 && captured.Unix() >= 0 && uint64(captured.Unix()) >= host.BootTime {
			uptime = fmt.Sprintf("%d Days", (uint64(captured.Unix())-host.BootTime)/86400)
		}
		if memory := data.system.Memory; memory != nil && memory.Total > 0 {
			ram = telegramBytes(memory.Current) + "/" + telegramBytes(memory.Total)
		}
		if network := data.system.Network; network != nil && ^uint64(0)-network.BytesSent >= network.BytesRecv {
			traffic = fmt.Sprintf("%s (↑%s,↓%s)", telegramBytes(network.BytesSent+network.BytesRecv), telegramBytes(network.BytesSent), telegramBytes(network.BytesRecv))
		}
	}
	if data.online != nil {
		online = fmt.Sprint(*data.online)
	}
	text := fmt.Sprintf("IP: %s\nX-UI Version: %s\nSing-Box Version: %s\nUptime: %s\nRAM: %s\nOnline Clients: %s\nTraffic: %s\nStatus: %s\nDateTime: %s",
		ip, telegramStatusValue(config.Version), coreVersion, uptime, ram, online, traffic, state, captured.In(location).Format("2006-01-02 15:04:05"))
	return TelegramStatusSnapshot{CapturedAt: captured, Text: text}
}

func telegramStatusValue(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "N/A"
	}
	return value
}

func telegramBytes(bytes uint64) string {
	units := [...]string{"B", "KB", "MB", "GB", "TB", "PB", "EB"}
	value, unit := float64(bytes), 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	return fmt.Sprintf("%.2f%s", value, units[unit])
}

type telegramPublicIP struct {
	mu       sync.Mutex
	client   *http.Client
	endpoint string
	value    string
	expires  time.Time
}

func newTelegramPublicIP() *telegramPublicIP {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // Report this host's address rather than an HTTP proxy's.
	dialer := &net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, _, address string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp4", address)
	}
	return &telegramPublicIP{client: &http.Client{Transport: transport, Timeout: 2 * time.Second}, endpoint: "https://api.ipify.org?format=json"}
}

func (p *telegramPublicIP) read(ctx context.Context) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx.Err() != nil {
		return ""
	}
	if time.Now().Before(p.expires) {
		return p.value
	}
	value := ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.endpoint, nil)
	if err == nil {
		if response, err := p.client.Do(request); err == nil {
			defer response.Body.Close()
			var reply struct {
				IP string `json:"ip"`
			}
			if response.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&reply) == nil {
				if ip := net.ParseIP(reply.IP); ip != nil && ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() {
					value = ip.String()
				}
			}
		}
	}
	if ctx.Err() == nil {
		p.value, p.expires = value, time.Now().Add(time.Minute)
		if value != "" {
			p.expires = time.Now().Add(30 * time.Minute)
		}
	}
	return value
}

// Pending Panel settings do not describe the worker that is currently sending.
func TelegramStatusTimeZone(fallback string) string {
	var worker PanelProcessRuntime
	if readPanelJSON(filepath.Join(panelRuntimeDir(config.Dir()), "worker.json"), &worker) == nil {
		if _, err := time.LoadLocation(worker.Settings.TimeLocation); err == nil && worker.Settings.TimeLocation != "" {
			return worker.Settings.TimeLocation
		}
	}
	if _, err := time.LoadLocation(fallback); err == nil && fallback != "" {
		return fallback
	}
	return "UTC"
}
