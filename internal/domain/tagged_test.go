package domain

import (
	"encoding/json"
	"testing"
)

// outbound_test.go checks the rules of the round trip one at a time; this checks
// it whole for the shape furthest from a plain outbound, a WireGuard route, which
// is written as the endpoint the core takes it as.

func TestWireGuardOutboundRoundTrips(t *testing.T) {
	const incoming = `{"id": 5, "type": "wireguard", "tag": "wg0", "mtu": 1408, "peers": [{"address": "203.0.113.1"}]}`

	var outbound Outbound
	if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if outbound.Id != 5 || outbound.Type != "wireguard" || outbound.Tag != "wg0" {
		t.Fatalf("fields = %d/%q/%q", outbound.Id, outbound.Type, outbound.Tag)
	}

	// Written out as the endpoint the core takes it as, options and all.
	core := coreOf(t, outbound)
	if core["mtu"] != float64(1408) || core["peers"] == nil {
		t.Errorf("core shape = %v, want the options flattened out", core)
	}
	// The core has no use for the panel's id and refuses unknown keys.
	if _, present := core["id"]; present {
		t.Error("core shape carries the panel's id")
	}

	full, err := outbound.MarshalFull()
	if err != nil {
		t.Fatalf("MarshalFull: %v", err)
	}
	if full["id"] != uint(5) {
		t.Errorf("panel shape id = %v, want 5", full["id"])
	}
}

func coreOf(t *testing.T, value interface{}) map[string]interface{} {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var core map[string]interface{}
	if err := json.Unmarshal(encoded, &core); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}
	return core
}
