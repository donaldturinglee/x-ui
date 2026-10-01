package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/validator"
)

func TestBlockOutboundWithOptionsIsRefusedByName(t *testing.T) {
	var outbound domain.Outbound
	incoming := `{"type": "block", "tag": "blocked", "server_port": 1080, "server": "10.0.0.2"}`
	if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	// Refused with the other field checks, before the tag is looked up, so the
	// service needs no store to say so.
	err := (&OutboundService{}).validate(context.Background(), &outbound)

	var fields *validator.Errors
	if !errors.As(err, &fields) {
		t.Fatalf("validate = %v, want the offending fields", err)
	}
	// Each option is a field of the request, and is named as one, so a client
	// can mark every one rather than find them a request at a time.
	const want = "server is not an option a block outbound takes; " +
		"server_port is not an option a block outbound takes"
	if fields.Error() != want {
		t.Errorf("validate = %q, want %q", fields.Error(), want)
	}
}

func TestWireGuardOutboundWrittenTheOldWayIsRefusedByName(t *testing.T) {
	var outbound domain.Outbound
	incoming := `{"type": "wireguard", "tag": "wg", "server": "vpn.example.com", "server_port": 51820,
		"private_key": "k", "peers": [{"public_key": "p"}]}`
	if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	// The endpoint it is written as reads the far end off its peer, and the core
	// would refuse every node's configuration over the old outbound's keys.
	err := (&OutboundService{}).validate(context.Background(), &outbound)

	var fields *validator.Errors
	if !errors.As(err, &fields) {
		t.Fatalf("validate = %v, want the offending fields", err)
	}
	const want = "server is not an option a wireguard outbound takes; " +
		"server_port is not an option a wireguard outbound takes"
	if fields.Error() != want {
		t.Errorf("validate = %q, want %q", fields.Error(), want)
	}
}
