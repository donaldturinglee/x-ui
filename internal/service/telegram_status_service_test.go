package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

type telegramStatusFunc func(context.Context) TelegramStatusSnapshot

func (f telegramStatusFunc) Report(ctx context.Context) TelegramStatusSnapshot { return f(ctx) }

type telegramSystemFunc func(context.Context) *SystemStatus

func (f telegramSystemFunc) Status(ctx context.Context) *SystemStatus { return f(ctx) }

type telegramCoreFunc func(context.Context) CoreStatus

func (f telegramCoreFunc) Status(ctx context.Context) CoreStatus { return f(ctx) }

type telegramOnlineFunc func(context.Context) (*Onlines, error)

func (f telegramOnlineFunc) Onlines(ctx context.Context) (*Onlines, error) { return f(ctx) }

func TestTelegramStatusReportFormatAndTimeZone(t *testing.T) {
	captured := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	online := 6
	report := formatTelegramStatus(captured, location, telegramStatusData{
		ip: "203.0.113.7", core: &CoreStatus{CurrentVersion: "1.14.2", State: "active"}, online: &online,
		system: &SystemStatus{
			Host:    &HostStatus{BootTime: uint64(captured.Add(-37 * 24 * time.Hour).Unix())},
			Memory:  &Usage{Current: 100535 * (1 << 20) / 100, Total: 377 * (1 << 30) / 100},
			Network: &NetworkStatus{BytesSent: 118 * (1 << 40) / 100, BytesRecv: 118 * (1 << 40) / 100},
		},
	})
	want := fmt.Sprintf("IP: 203.0.113.7\nX-UI Version: %s\nSing-Box Version: 1.14.2\nUptime: 37 Days\nRAM: 1005.35MB/3.77GB\nOnline Clients: 6\nTraffic: 2.36TB (↑1.18TB,↓1.18TB)\nStatus: running\nDateTime: 2026-10-11 08:00:00", config.Version)
	if report.Text != want || !report.CapturedAt.Equal(captured) {
		t.Fatalf("report = %+v, want %s", report, want)
	}
}

func TestTelegramStatusReportKeepsAvailableFieldsWhenAProbeTimesOut(t *testing.T) {
	captured := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	service := &TelegramStatusService{location: time.UTC, now: func() time.Time { return captured },
		system: telegramSystemFunc(func(context.Context) *SystemStatus {
			return &SystemStatus{Memory: &Usage{Current: 1 << 30, Total: 4 << 30}}
		}),
		core:  telegramCoreFunc(func(ctx context.Context) CoreStatus { <-ctx.Done(); return CoreStatus{} }),
		stats: telegramOnlineFunc(func(context.Context) (*Onlines, error) { return nil, errors.New("database unavailable") }),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	report := service.Report(ctx)
	if time.Since(started) > time.Second {
		t.Fatal("a timed-out probe held the report open")
	}
	for _, part := range []string{"IP: N/A", "RAM: 1.00GB/4.00GB", "Online Clients: N/A", "Status: unknown", "DateTime: 2026-10-11 00:00:00"} {
		if !strings.Contains(report.Text, part) {
			t.Errorf("report lacks %q: %s", part, report.Text)
		}
	}
	if len(strings.Split(report.Text, "\n")) != 9 {
		t.Fatalf("report does not have nine lines: %s", report.Text)
	}
}

func TestTelegramPublicIPValidationCachingAndCancellation(t *testing.T) {
	var requests atomic.Int32
	var reply atomic.Value
	reply.Store(`{"ip":"203.0.113.7"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		body := reply.Load().(string)
		if body == "block" {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	ip := &telegramPublicIP{client: server.Client(), endpoint: server.URL}
	for range 2 {
		if got := ip.read(context.Background()); got != "203.0.113.7" {
			t.Fatalf("IP = %q", got)
		}
	}
	if requests.Load() != 1 {
		t.Fatal("a cached IP made a second request")
	}
	reply.Store(`{"ip":"127.0.0.1"}`)
	ip.mu.Lock()
	ip.expires = time.Time{}
	ip.mu.Unlock()
	if got := ip.read(context.Background()); got != "" {
		t.Fatalf("nonpublic IP accepted: %q", got)
	}
	if got := ip.read(context.Background()); got != "" || requests.Load() != 2 {
		t.Fatal("failed lookup was not cached")
	}
	reply.Store("block")
	ip.mu.Lock()
	ip.expires = time.Time{}
	ip.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if ip.read(ctx) != "" || time.Since(started) > time.Second {
		t.Fatal("IP lookup ignored cancellation")
	}
}

func TestTelegramPublicIPReportsOnlyPublicIPv4(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reply string
		want  string
	}{
		{name: "public IPv4", reply: `{"ip":"203.0.113.7"}`, want: "203.0.113.7"},
		{name: "IPv4 mapped address", reply: `{"ip":"::ffff:203.0.113.7"}`, want: "203.0.113.7"},
		{name: "public IPv6", reply: `{"ip":"2406:da18:10ff:d000:2d96:c9b5:dc5e:484b"}`},
		{name: "private IPv4", reply: `{"ip":"10.0.0.1"}`},
		{name: "loopback IPv4", reply: `{"ip":"127.0.0.1"}`},
		{name: "invalid address", reply: `{"ip":"not-an-ip"}`},
		{name: "invalid JSON", reply: `not-json`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(tc.reply))
			}))
			defer server.Close()
			ip := newTelegramPublicIP()
			if ip.endpoint != "https://api.ipify.org?format=json" {
				t.Fatalf("IPv4 discovery endpoint = %q", ip.endpoint)
			}
			ip.endpoint = server.URL
			defer ip.client.CloseIdleConnections()
			if got := ip.read(context.Background()); got != tc.want {
				t.Fatalf("public IPv4 = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTelegramPublicIPTransportRequiresIPv4(t *testing.T) {
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skip("IPv6 loopback is unavailable", err)
	}
	defer listener.Close()
	ip := newTelegramPublicIP()
	defer ip.client.CloseIdleConnections()
	transport := ip.client.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("public IPv4 discovery inherited a proxy")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if connection, err := transport.DialContext(ctx, "tcp", listener.Addr().String()); err == nil {
		connection.Close()
		t.Fatal("public IPv4 discovery connected over IPv6")
	}
}

func TestTelegramStatusCommandsAreAuthorizedAndCollectOnlyOncePerReply(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	bot.failSends = 1
	var reports atomic.Int32
	captured := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	provider := telegramStatusFunc(func(context.Context) TelegramStatusSnapshot {
		reports.Add(1)
		return formatTelegramStatus(captured, time.UTC, telegramStatusData{})
	})
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) { commands.status = provider })
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{
		commandUpdate(80, 1111, "private", "/status"), commandUpdate(81, 3333, "private", "/status"),
		commandUpdate(82, -100222, "supergroup", "/status"), commandUpdate(83, 1111, "private", "/statusful"),
		commandUpdate(84, 2222, "private", "/status@x_ui_bot"), commandUpdate(85, 1111, "private", "/status@other_bot"),
		commandUpdate(86, 1111, "private", "hello /status"),
	}
	awaitCommandCursor(t, settings, 87)
	if reports.Load() != 2 {
		t.Fatalf("collected %d reports, want two authorized queries", reports.Load())
	}
	sends := bot.called("sendMessage")
	if len(sends) != 3 || sends[0].body["chat_id"] != "1111" || sends[1].body["chat_id"] != "1111" || sends[2].body["chat_id"] != "2222" {
		t.Fatalf("replies = %+v", sends)
	}
	if sends[0].body["text"] != sends[1].body["text"] || !strings.Contains(sends[2].body["text"].(string), "DateTime: 2026-10-11 00:00:00") {
		t.Fatal("retry changed the report snapshot")
	}
	if menus := bot.called("setMyCommands"); !strings.Contains(fmt.Sprint(menus[0].body["commands"]), "command:status") {
		t.Fatal("/status missing from private command menu")
	}
}

func TestTelegramStatusRevocationDuringCollectionStopsTheReply(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	started, release := make(chan struct{}), make(chan struct{})
	provider := telegramStatusFunc(func(ctx context.Context) TelegramStatusSnapshot {
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return formatTelegramStatus(time.Now(), time.UTC, telegramStatusData{})
	})
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) { commands.status = provider })
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(90, 1111, "private", "/status")}
	awaitTelegramCommand(t, started, "status collection")
	settings.change(map[string]string{domain.SettingTgBotChatIds: "2222"})
	close(release)
	awaitCommandPoll(t, bot, testBotToken, 0)
	if len(bot.called("sendMessage")) != 0 {
		t.Fatal("revoked chat received a collected status report")
	}
}
