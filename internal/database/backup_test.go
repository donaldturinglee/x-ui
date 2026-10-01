package database

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestABackedUpListenerKeepsItsTLSWhole(t *testing.T) {
	listener := domain.Inbound{
		Id:      7,
		Type:    "vless",
		Tag:     "edge",
		Addrs:   domain.JSON(`[{"server": "edge.example.com", "server_port": 443}]`),
		OutJson: domain.JSON(`{"tls": {"reality": {"public_key": "PUBKEY"}}}`),
		Options: domain.JSON(`{"listen_port": 443, "tls": {"enabled": true, "reality": {"enabled": true}}}`),
	}

	raw, err := inboundRecords([]domain.Inbound{listener})
	if err != nil {
		t.Fatalf("inboundRecords: %v", err)
	}

	// Read back the way a restore reads it.
	var restored []domain.Inbound
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatalf("the export does not read back: %v", err)
	}
	if len(restored) != 1 {
		t.Fatalf("restored %d listeners, want 1", len(restored))
	}

	server, client, err := restored[0].TLS()
	if err != nil {
		t.Fatalf("TLS: %v", err)
	}
	// Both halves: what the core terminates with, and what a client is handed
	// to meet it, which the core's own shape leaves out.
	if !strings.Contains(string(server), `"reality"`) || !strings.Contains(string(client), "PUBKEY") {
		t.Errorf("tls = %s / %s, want both halves carried", server, client)
	}
	if !strings.Contains(string(restored[0].Addrs), "edge.example.com") {
		t.Errorf("addrs = %s, want where it is published carried", restored[0].Addrs)
	}
	// Numbered afresh, as a restored listener always has been.
	if restored[0].Id != 0 {
		t.Errorf("id = %d, want it left behind", restored[0].Id)
	}
}
