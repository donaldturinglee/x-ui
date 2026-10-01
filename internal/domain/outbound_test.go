package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOutboundSplitsKnownFieldsFromOptions(t *testing.T) {
	const incoming = `{
		"id": 7,
		"type": "shadowsocks",
		"tag": "upstream",
		"server": "203.0.113.10",
		"server_port": 8388,
		"method": "aes-256-gcm"
	}`

	var outbound Outbound
	if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	if outbound.Id != 7 || outbound.Type != "shadowsocks" || outbound.Tag != "upstream" {
		t.Fatalf("known fields = %d/%q/%q, want 7/shadowsocks/upstream", outbound.Id, outbound.Type, outbound.Tag)
	}

	var options map[string]interface{}
	if err := json.Unmarshal(outbound.Options.Raw(), &options); err != nil {
		t.Fatalf("Options is not an object: %v", err)
	}
	// The whole point of the split: everything the panel does not model is kept
	// verbatim, so a new core release adds options without a migration.
	if options["method"] != "aes-256-gcm" || options["server"] != "203.0.113.10" {
		t.Errorf("Options = %v, want the unmodelled fields kept", options)
	}
	// ...and the modelled ones are not duplicated into it.
	for _, key := range []string{"id", "type", "tag"} {
		if _, present := options[key]; present {
			t.Errorf("Options still carries %q, which has a column of its own", key)
		}
	}
}

func TestOutboundRoundTripsToCoreShape(t *testing.T) {
	const incoming = `{"id": 3, "type": "direct", "tag": "direct", "bind_interface": "eth0"}`

	var outbound Outbound
	if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	encoded, err := json.Marshal(outbound)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var core map[string]interface{}
	if err := json.Unmarshal(encoded, &core); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}

	if core["type"] != "direct" || core["tag"] != "direct" {
		t.Errorf("core shape = %v, want type and tag", core)
	}
	if core["bind_interface"] != "eth0" {
		t.Errorf("core shape = %v, want the stored options flattened back out", core)
	}
	// The core has no use for the panel's id, and sing-box refuses unknown keys.
	if _, present := core["id"]; present {
		t.Error("core shape carries the panel's id")
	}
}

func TestOutboundDropsDisabledTls(t *testing.T) {
	cases := map[string]struct {
		tls  string
		want bool
	}{
		"enabled is kept":    {tls: `{"enabled": true, "server_name": "example.com"}`, want: true},
		"disabled is cut":    {tls: `{"enabled": false, "server_name": "example.com"}`, want: false},
		"absent flag is cut": {tls: `{"server_name": "example.com"}`, want: false},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var outbound Outbound
			incoming := `{"type": "trojan", "tag": "t", "tls": ` + tc.tls + `}`
			if err := json.Unmarshal([]byte(incoming), &outbound); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}

			encoded, err := json.Marshal(outbound)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			var core map[string]interface{}
			if err := json.Unmarshal(encoded, &core); err != nil {
				t.Fatalf("Marshal produced invalid JSON: %v", err)
			}

			_, present := core["tls"]
			if present != tc.want {
				t.Errorf("tls present = %v, want %v", present, tc.want)
			}

			// Whatever the generated config says, the stored options keep the
			// block, so toggling TLS off and on does not lose the settings.
			var options map[string]interface{}
			if err := json.Unmarshal(outbound.Options.Raw(), &options); err != nil {
				t.Fatalf("Options is not an object: %v", err)
			}
			if _, stored := options["tls"]; !stored {
				t.Error("the stored options lost the tls block")
			}
		})
	}
}

func TestOutboundMarshalFullKeepsTheId(t *testing.T) {
	var outbound Outbound
	if err := json.Unmarshal([]byte(`{"id": 4, "type": "direct", "tag": "out", "domain_strategy": "prefer_ipv4"}`), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	full, err := outbound.MarshalFull()
	if err != nil {
		t.Fatalf("MarshalFull: %v", err)
	}
	// The panel addresses an outbound by id; only the core shape omits it.
	if full["id"] != uint(4) {
		t.Errorf("full shape id = %v, want 4", full["id"])
	}
	if full["domain_strategy"] != "prefer_ipv4" {
		t.Errorf("full shape = %v, want the options flattened out", full)
	}
}

func TestBlockOutboundIsOnlyItsTypeAndTag(t *testing.T) {
	var sent Outbound
	if err := json.Unmarshal([]byte(`{"type": "block", "tag": "block"}`), &sent); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	// One read back from a row whose options were never written holds none at
	// all rather than an empty object, and has to render the same.
	stored := Outbound{Id: 2, Type: "block", Tag: "block"}

	for name, outbound := range map[string]Outbound{"as sent": sent, "as stored": stored} {
		t.Run(name, func(t *testing.T) {
			encoded, err := json.Marshal(outbound)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			// The core reads nothing for a block route beyond these two, and
			// refuses the configuration over anything else.
			if string(encoded) != `{"tag":"block","type":"block"}` {
				t.Errorf("core shape = %s, want only the type and the tag", encoded)
			}

			stray, err := outbound.StrayOptions()
			if err != nil {
				t.Fatalf("StrayOptions: %v", err)
			}
			if len(stray) != 0 {
				t.Errorf("stray options = %v, want none", stray)
			}
		})
	}
}

func TestStrayOptionsJudgeBlockAndWireGuardRoutes(t *testing.T) {
	cases := map[string]struct {
		incoming string
		want     []string
	}{
		"a block route left with options": {
			incoming: `{"type": "block", "tag": "b", "server_port": 1080, "server": "10.0.0.2"}`,
			want:     []string{"server", "server_port"},
		},
		// Written the way the core took WireGuard as an outbound, the keys the
		// endpoint it is written as does not read are named, and the ones it
		// does are not.
		"a wireguard route written as its old outbound": {
			incoming: `{"type": "wireguard", "tag": "wg", "server": "vpn.example.com", "server_port": 51820,
				"local_address": ["10.0.0.2/32"], "private_key": "k", "peer_public_key": "p", "mtu": 1420}`,
			want: []string{"local_address", "peer_public_key", "server", "server_port"},
		},
		"a wireguard route written as the endpoint it is": {
			incoming: `{"type": "wireguard", "tag": "wg", "address": ["10.0.0.2/32"], "private_key": "k",
				"peers": [{"address": "vpn.example.com", "port": 51820, "public_key": "p", "reserved": [1, 2, 3]}]}`,
			want: nil,
		},
		// A direct route's options are the core's to judge, and change with its
		// releases, so nothing on one is called stray.
		"any other type": {
			incoming: `{"type": "direct", "tag": "d", "bind_interface": "eth0"}`,
			want:     nil,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			var outbound Outbound
			if err := json.Unmarshal([]byte(tc.incoming), &outbound); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			stray, err := outbound.StrayOptions()
			if err != nil {
				t.Fatalf("StrayOptions: %v", err)
			}
			// Sorted, so the refusal that names them reads the same every time.
			if strings.Join(stray, ",") != strings.Join(tc.want, ",") {
				t.Errorf("stray options = %v, want %v", stray, tc.want)
			}
		})
	}
}

func TestOnlyAWireGuardRouteIsWrittenAsAnEndpoint(t *testing.T) {
	cases := map[string]bool{
		"wireguard": true,
		// Every other type is an outbound to the core, a block route included.
		"direct": false,
		"block":  false,
		"socks":  false,
	}

	for outboundType, want := range cases {
		if got := (Outbound{Type: outboundType, Tag: "t"}).IsEndpoint(); got != want {
			t.Errorf("IsEndpoint(%q) = %v, want %v", outboundType, got, want)
		}
	}
}

func TestOutboundToleratesWrongTypedFields(t *testing.T) {
	// A tag sent as a number used to panic on an unchecked type assertion,
	// which turns a malformed request into a 500 instead of a 400.
	var outbound Outbound
	if err := json.Unmarshal([]byte(`{"type": 12, "tag": null}`), &outbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if outbound.Type != "" || outbound.Tag != "" {
		t.Errorf("type/tag = %q/%q, want both empty so validation reports them", outbound.Type, outbound.Tag)
	}
}
