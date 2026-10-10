package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func testOutboundChecker(server *httptest.Server) *outboundChecker {
	checker := newOutboundChecker(func(_ context.Context, id uint) (*domain.Outbound, error) {
		return &domain.Outbound{Id: id, Type: "direct", Tag: "route /?+#"}, nil
	})
	checker.endpoint = func() (clashCheckEndpoint, error) {
		return clashCheckEndpoint{URL: server.URL, Secret: "private-test-secret"}, nil
	}
	return checker
}

func TestOutboundCheckRoutesTheProbeAndKeepsSecretsPrivate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/proxies/route%20%2F%3F+%23/delay" || r.URL.Query().Get("url") != outboundCheckURL || r.URL.Query().Get("timeout") != "15000" {
			t.Errorf("incorrect probe URL: %s", r.URL)
		}
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer private-test-secret" {
			t.Error("probe must use an authenticated GET")
		}
		w.Write([]byte(`{"delay":128}`))
	}))
	defer server.Close()
	result, err := testOutboundChecker(server).check(context.Background(), 7)
	if err != nil || !result.OK || result.Delay != 128 || result.Error != "" {
		t.Fatalf("result = %+v, error = %v", result, err)
	}
}

func TestOutboundCheckFailures(t *testing.T) {
	for _, tc := range []struct {
		name          string
		status        int
		body, message string
	}{
		{"timeout", 504, "private-test-secret", "timed out"},
		{"failed", 503, "private-test-secret", "Connection check failed"},
		{"missing tag", 404, "private-test-secret", "not active"},
		{"auth", 401, "private-test-secret", "authentication failed"},
		{"forbidden", 403, "private-test-secret", "authentication failed"},
		{"bad json", 200, "private-test-secret", "invalid delay"},
		{"missing delay", 200, `{}`, "invalid delay"},
		{"zero delay", 200, `{"delay":0}`, "invalid delay"},
		{"overflow", 200, `{"delay":65536}`, "invalid delay"},
		{"negative", 200, `{"delay":-1}`, "invalid delay"},
		{"unexpected status", 500, "private-test-secret", "HTTP 500"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer server.Close()
			result, err := testOutboundChecker(server).check(context.Background(), 1)
			if err != nil || result.OK || !strings.Contains(result.Error, tc.message) || strings.Contains(result.Error, "private-test-secret") {
				t.Fatalf("result = %+v, error = %v", result, err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	checker := testOutboundChecker(server)
	checker.client.Timeout = 20 * time.Millisecond
	result, err := checker.check(context.Background(), 1)
	if err != nil || !strings.Contains(result.Error, "timed out") {
		t.Fatalf("HTTP deadline: %+v, %v", result, err)
	}
}

func TestOutboundCheckDoesNotFollowRedirects(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Store(true) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	result, _ := testOutboundChecker(server).check(context.Background(), 1)
	if result.OK || leaked.Load() || !strings.Contains(result.Error, "HTTP 302") {
		t.Fatalf("redirect followed: %+v", result)
	}
}

func TestOutboundCheckSkipsBlockAndPreservesLookupErrors(t *testing.T) {
	checker := newOutboundChecker(func(_ context.Context, id uint) (*domain.Outbound, error) {
		if id == 99 {
			return nil, domain.ErrNotFound
		}
		return &domain.Outbound{Id: id, Type: domain.OutboundTypeBlock}, nil
	})
	checker.endpoint = func() (clashCheckEndpoint, error) {
		t.Fatal("block must not contact the core")
		return clashCheckEndpoint{}, nil
	}
	result, err := checker.check(context.Background(), 1)
	if err != nil || result.OK || !result.Skipped {
		t.Fatalf("block: %+v, %v", result, err)
	}
	_, err = checker.check(context.Background(), 99)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("lookup error: %v", err)
	}
	checker.find = func(context.Context, uint) (*domain.Outbound, error) { return &domain.Outbound{Type: "direct"}, nil }
	checker.endpoint = func() (clashCheckEndpoint, error) { return clashCheckEndpoint{}, errors.New("Clash API is disabled") }
	result, err = checker.check(context.Background(), 1)
	if err != nil || result.Error != "Clash API is disabled" {
		t.Fatalf("missing API: %+v, %v", result, err)
	}
}

func TestOutboundCheckConcurrencyAndDeduplication(t *testing.T) {
	started := make(chan struct{}, 8)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started <- struct{}{}
		<-release
		w.Write([]byte(`{"delay":100}`))
	}))
	defer func() { close(release); server.Close() }()
	checker := testOutboundChecker(server)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	firstCtx, cancelFirst := context.WithCancel(ctx)
	firstDone := make(chan error, 1)
	go func() { _, err := checker.check(firstCtx, 1); firstDone <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("probe did not start")
	}

	// A duplicate waiter can disconnect without starting a second core probe.
	duplicateCtx, cancelDuplicate := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancelDuplicate()
	_, err := checker.check(duplicateCtx, 1)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("duplicate: %v", err)
	}
	select {
	case <-started:
		t.Fatal("duplicate started another probe")
	default:
	}
	cancelFirst()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("owner cancellation: %v", err)
	}

	for id := uint(2); id <= 4; id++ {
		go checker.check(ctx, id)
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("parallel probe did not start")
		}
	}
	result, err := checker.check(ctx, 5)
	if err != nil || result.OK || !strings.Contains(result.Error, "Other outbound checks") {
		t.Fatalf("unbounded concurrency: %+v, %v", result, err)
	}
	// The original probe keeps its slot until completion even after its owner leaves.
}

func TestClashCheckEndpointFromAppliedConfig(t *testing.T) {
	for _, tc := range []struct{ controller, want string }{
		{"127.0.0.1:9090", "http://127.0.0.1:9090"},
		{"localhost:9090", "http://127.0.0.1:9090"},
		{"0.0.0.0:9090", "http://127.0.0.1:9090"},
		{"[::]:9090", "http://[::1]:9090"},
		{"[::1]:9090", "http://[::1]:9090"},
		{"66.42.108.29:9090", ""},
		{"example.com:9090", ""},
		{"127.0.0.1:0", ""},
		{"127.0.0.1:65536", ""},
		{"http://127.0.0.1:9090", ""},
		{"", ""},
	} {
		t.Run(tc.controller, func(t *testing.T) {
			endpoint, err := clashCheckEndpointFromConfig([]byte(`{"experimental":{"clash_api":{"external_controller":"` + tc.controller + `","secret":"private-test-secret"}}}`))
			if tc.want == "" {
				if err == nil {
					t.Fatal("invalid controller accepted")
				}
				return
			}
			if err != nil || endpoint.URL != tc.want || endpoint.Secret != "private-test-secret" {
				t.Fatalf("endpoint = %+v, error = %v", endpoint, err)
			}
		})
	}
}
