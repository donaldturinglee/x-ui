package agent

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"google.golang.org/protobuf/encoding/protowire"
)

// Native ConnectionEvents fixture: connection c1 belongs to zxc, inbound test,
// outbound direct. The total fields are 16 and 17, not rate fields 14 and 15.
var nativeSnapshot = []byte("\x0a\x21\x1a\x1f\x0a\x02c1\x12\x04test\x52\x03zxc\x9a\x01\x06direct\x80\x01\x64\x88\x01\x84\x07")

func grpcWebFrame(flags byte, payload []byte) []byte {
	frame := make([]byte, 5, 5+len(payload))
	frame[0] = flags
	binary.BigEndian.PutUint32(frame[1:], uint32(len(payload)))
	return append(frame, payload...)
}

func nativeStatsServer(t *testing.T, frame *[]byte) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/daemon.StartedService/SubscribeConnections" {
			t.Errorf("unexpected native API request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer stats-secret" ||
			r.Header.Get("Content-Type") != "application/grpc-web+proto" {
			t.Error("native API request has no authentication or protobuf content type")
		}
		request, err := io.ReadAll(r.Body)
		if err != nil || len(request) < 7 || request[0] != 0 ||
			int(binary.BigEndian.Uint32(request[1:])) != len(request)-5 || request[5] != 8 {
			t.Errorf("invalid native API request frame: %x, %v", request, err)
			return
		}
		interval, consumed := protowire.ConsumeVarint(request[6:])
		if consumed < 0 || interval != uint64(time.Second) {
			t.Errorf("invalid native API interval: %d", interval)
		}
		w.Header().Set("Content-Type", "application/grpc-web+proto")
		_, _ = w.Write(*frame)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestSingBoxNativeStatsUserTagsAndDeltas(t *testing.T) {
	frame := grpcWebFrame(0, nativeSnapshot)
	server := nativeStatsServer(t, &frame)
	stats := NewStatsSource(StatsConfig{
		Source: StatsSourceSingBox, URL: server.URL, Secret: "stats-secret", Timeout: Duration(time.Second),
	})
	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []struct{ resource, tag string }{
		{domain.ResourceClient, "zxc"},
		{domain.ResourceInbound, "test"},
		{domain.ResourceOutbound, "direct"},
	} {
		report := find(reports, expected.resource, expected.tag)
		if report == nil || report.Up != 100 || report.Down != 900 {
			t.Errorf("%s/%s report = %v, want 100 / 900", expected.resource, expected.tag, report)
		}
	}

	frame = grpcWebFrame(0, []byte("\x0a\x22\x1a\x20\x0a\x02c1\x12\x04test\x52\x03zxc\x9a\x01\x06direct\x80\x01\x96\x01\x88\x01\xb0\x09"))
	reports, err = stats.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	report := find(reports, domain.ResourceClient, "zxc")
	if report == nil || report.Up != 50 || report.Down != 300 {
		t.Fatalf("second native report = %v, want deltas 50 / 300", report)
	}
	reports, err = stats.Read(context.Background())
	if err != nil || len(reports) != 0 {
		t.Fatalf("unchanged native snapshot = %v, %v; want no duplicate traffic", reports, err)
	}
}

func TestSingBoxReadinessProbeDoesNotConsumeReporterMeasurements(t *testing.T) {
	frame := grpcWebFrame(0, nativeSnapshot)
	server := nativeStatsServer(t, &frame)
	cfg := StatsConfig{Source: StatsSourceSingBox, URL: server.URL, Secret: "stats-secret", Timeout: Duration(time.Second)}
	if err := ProbeSingBoxStats(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	reports, err := NewStatsSource(cfg).Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	report := find(reports, domain.ResourceClient, "zxc")
	if report == nil || report.Up != 100 || report.Down != 900 {
		t.Fatal("readiness probe consumed traffic counters", report)
	}
}

func TestSingBoxNativeStatsRejectsInvalidFrames(t *testing.T) {
	oversized := make([]byte, 5)
	binary.BigEndian.PutUint32(oversized[1:], maxResponseBytes+1)
	for name, frame := range map[string][]byte{
		"truncated frame": []byte{0, 0},
		"truncated body":  {0, 0, 0, 0, 8},
		"oversized body":  oversized,
		"compressed":      grpcWebFrame(1, nil),
		"grpc error":      grpcWebFrame(0x80, []byte("grpc-status: 7\r\ngrpc-message: denied\r\n")),
		"invalid proto":   grpcWebFrame(0, []byte{0x0a, 8}),
	} {
		t.Run(name, func(t *testing.T) {
			server := nativeStatsServer(t, &frame)
			stats := NewSingBoxStats(StatsConfig{URL: server.URL, Secret: "stats-secret", Timeout: Duration(time.Second)})
			if _, err := stats.Read(context.Background()); err == nil {
				t.Fatal("invalid native API response must fail instead of dropping traffic silently")
			}
		})
	}
}

func TestSingBoxNativeStatsAllowsEmptyAndExtendedSnapshots(t *testing.T) {
	empty, err := decodeSingBoxConnections(nil)
	if err != nil || len(empty.Connections) != 0 {
		t.Fatalf("empty native snapshot = %v, %v", empty, err)
	}
	extended := append(append([]byte(nil), nativeSnapshot...), 0x98, 0x06, 0x01)
	snapshot, err := decodeSingBoxConnections(extended)
	if err != nil || len(snapshot.Connections) != 1 || snapshot.Connections[0].Metadata.User != "zxc" {
		t.Fatalf("unknown optional protobuf field lost the connection: %v, %v", snapshot, err)
	}
}

func TestSingBoxNativeStatsConfiguration(t *testing.T) {
	cfg := Default()
	cfg.Panel.URL = "http://127.0.0.1:8000/apiv2"
	cfg.Panel.Token = "node-token"
	cfg.Stats.Source = StatsSourceSingBox
	cfg.Stats.URL = "http://127.0.0.1:9091"
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.Stats.URL = ""
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "stats.url") {
		t.Fatalf("native stats with no endpoint must be refused: %v", err)
	}
}
