package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// connection is one entry in a faked Clash API snapshot.
type connection struct {
	id       string
	user     string
	inbound  string
	outbound string
	up       int64
	down     int64
}

// clashServer serves a snapshot that the test can replace between polls.
func clashServer(t *testing.T, snapshot *[]connection) *httptest.Server {
	t.Helper()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connections" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body := map[string]interface{}{"connections": []interface{}{}}
		entries := make([]interface{}, 0, len(*snapshot))
		for _, c := range *snapshot {
			entries = append(entries, map[string]interface{}{
				"id":       c.id,
				"upload":   c.up,
				"download": c.down,
				"metadata": map[string]interface{}{
					"user":         c.user,
					"inboundName":  c.inbound,
					"outboundName": c.outbound,
				},
			})
		}
		body["connections"] = entries
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func newStats(t *testing.T, url string) *ClashStats {
	t.Helper()
	return NewClashStats(StatsConfig{Source: StatsSourceClash, URL: url, Timeout: Duration(5 * time.Second)})
}

// find returns the report for one resource and tag.
func find(reports []domain.TrafficReport, resource string, tag string) *domain.TrafficReport {
	for i := range reports {
		if reports[i].Resource == resource && reports[i].Tag == tag {
			return &reports[i]
		}
	}
	return nil
}

func TestFirstPollCountsTheWholeTotal(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "alice", inbound: "edge", outbound: "direct", up: 100, down: 900}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	// Nothing has been counted before, so the connection's whole total is the
	// first delta.
	client := find(reports, domain.ResourceClient, "alice")
	if client == nil || client.Up != 100 || client.Down != 900 {
		t.Fatalf("client report = %v, want up 100 / down 900", client)
	}
	// The same traffic is attributed to the inbound and outbound it went
	// through, which is what the panel's per-node charts are built from.
	if inbound := find(reports, domain.ResourceInbound, "edge"); inbound == nil || inbound.Up != 100 {
		t.Errorf("inbound report = %v, want the same traffic attributed", inbound)
	}
	if outbound := find(reports, domain.ResourceOutbound, "direct"); outbound == nil || outbound.Down != 900 {
		t.Errorf("outbound report = %v, want the same traffic attributed", outbound)
	}
}

func TestSecondPollReportsOnlyTheDifference(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "alice", up: 100, down: 900}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	if _, err := stats.Read(context.Background()); err != nil {
		t.Fatalf("first Read: %v", err)
	}

	// The same connection, having moved more.
	snapshot[0].up, snapshot[0].down = 150, 1200

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("second Read: %v", err)
	}
	client := find(reports, domain.ResourceClient, "alice")
	// The API reports cumulative totals; sending those to the panel would make
	// the subscriber's quota grow quadratically.
	if client == nil || client.Up != 50 || client.Down != 300 {
		t.Fatalf("client report = %v, want the difference (up 50 / down 300)", client)
	}
}

func TestAnIdleConnectionReportsNothing(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "alice", up: 100, down: 900}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	if _, err := stats.Read(context.Background()); err != nil {
		t.Fatalf("first Read: %v", err)
	}

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("second Read: %v", err)
	}
	// A zero delta is not a report. Sending one every ten seconds per live
	// connection would be most of the panel's write load and none of its data.
	if len(reports) != 0 {
		t.Errorf("reports = %v, want none for an idle connection", reports)
	}
}

func TestAClosedConnectionIsNotCountedAgain(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "alice", up: 100, down: 900}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	if _, err := stats.Read(context.Background()); err != nil {
		t.Fatalf("first Read: %v", err)
	}

	// The connection closes and stops being reported.
	snapshot = snapshot[:0]

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("second Read: %v", err)
	}
	if len(reports) != 0 {
		t.Errorf("reports = %v, want none: what it moved was counted while it was open", reports)
	}
	// And it stops being remembered, so the map does not grow for the life of
	// the process.
	if _, remembered := stats.seen["c1"]; remembered {
		t.Error("a closed connection is still being tracked")
	}
}

func TestAReusedIdWithASmallerTotalIsNotSubtracted(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "alice", up: 1000, down: 5000}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	if _, err := stats.Read(context.Background()); err != nil {
		t.Fatalf("first Read: %v", err)
	}

	// The core restarted and reissued the id with a fresh, lower counter.
	snapshot[0].up, snapshot[0].down = 10, 20

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("second Read: %v", err)
	}
	client := find(reports, domain.ResourceClient, "alice")
	if client == nil {
		t.Fatal("no client report")
	}
	// Counting the negative would subtract from the subscriber's usage, which
	// hands back quota they already spent.
	if client.Up != 10 || client.Down != 20 {
		t.Errorf("client report = %v, want the new totals (up 10 / down 20), never a negative", client)
	}
}

func TestTrafficIsAggregatedPerSubscriber(t *testing.T) {
	snapshot := []connection{
		{id: "c1", user: "alice", inbound: "edge", up: 10, down: 20},
		{id: "c2", user: "alice", inbound: "edge", up: 5, down: 7},
		{id: "c3", user: "bob", inbound: "edge", up: 1, down: 2},
	}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	// A busy subscriber has hundreds of live connections; one report each would
	// be hundreds of rows for what is a single number to the panel.
	alice := find(reports, domain.ResourceClient, "alice")
	if alice == nil || alice.Up != 15 || alice.Down != 27 {
		t.Fatalf("alice = %v, want her connections summed (up 15 / down 27)", alice)
	}
	if bob := find(reports, domain.ResourceClient, "bob"); bob == nil || bob.Up != 1 {
		t.Errorf("bob = %v, want his own total", bob)
	}
	if inbound := find(reports, domain.ResourceInbound, "edge"); inbound == nil || inbound.Up != 16 {
		t.Errorf("inbound = %v, want every connection through it summed", inbound)
	}
}

func TestUnauthenticatedTrafficIsNotAttributed(t *testing.T) {
	snapshot := []connection{{id: "c1", user: "", inbound: "edge", up: 10, down: 20}}
	stats := newStats(t, clashServer(t, &snapshot).URL)

	reports, err := stats.Read(context.Background())
	if err != nil {
		t.Fatalf("Read: %v", err)
	}

	// Traffic that did not come through an authenticated inbound is not
	// anyone's quota, and an empty tag would be rejected by the panel anyway.
	if client := find(reports, domain.ResourceClient, ""); client != nil {
		t.Errorf("reports = %v, want no client report for an empty user", reports)
	}
	if inbound := find(reports, domain.ResourceInbound, "edge"); inbound == nil {
		t.Error("the inbound's own traffic should still be counted")
	}
}

func TestReadReportsACoreThatIsNotAnswering(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("nope"))
	}))
	t.Cleanup(server.Close)

	stats := newStats(t, server.URL)
	if _, err := stats.Read(context.Background()); err == nil {
		t.Fatal("Read accepted a failing core")
	}
}
