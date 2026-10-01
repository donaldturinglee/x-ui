package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAListenerKeepsItsTLSAmongItsOptions(t *testing.T) {
	var inbound Inbound
	if err := json.Unmarshal([]byte(`{
		"type": "vless",
		"tag": "edge",
		"listen_port": 443,
		"tls": {"enabled": true, "reality": {"enabled": true, "short_id": ["ab"]}},
		"tls_id": 3,
		"out_json": {"tls": {"reality": {"public_key": "PUBKEY"}}}
	}`), &inbound); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	// Written into the node's configuration as the core reads it...
	core, err := json.Marshal(inbound)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(core, &document); err != nil {
		t.Fatalf("the core's shape is not an object: %v", err)
	}
	if !strings.Contains(string(document["tls"]), `"reality"`) {
		t.Errorf("core tls = %s, want the block the listener terminates with", document["tls"])
	}
	// ...with nothing a client is handed, and nothing naming the configuration
	// a listener pointed at before it carried its own: the core refuses both.
	for _, key := range []string{"out_json", "tls_id"} {
		if _, present := document[key]; present {
			t.Errorf("core shape carries %q: %s", key, core)
		}
	}

	full, err := inbound.MarshalFull()
	if err != nil {
		t.Fatalf("MarshalFull: %v", err)
	}
	if _, present := full["tls_id"]; present {
		t.Errorf("the panel's shape still answers with a tls_id: %v", full)
	}
	if full["tls"] == nil {
		t.Errorf("the panel's shape = %v, want the tls block among the options", full)
	}

	server, client, err := inbound.TLS()
	if err != nil {
		t.Fatalf("TLS: %v", err)
	}
	if !strings.Contains(string(server), `"short_id"`) || !strings.Contains(string(client), "PUBKEY") {
		t.Errorf("tls = %s / %s, want the server half and the client half", server, client)
	}
}

func TestTLSIsWhatTheServerHalfSays(t *testing.T) {
	cases := map[string]Inbound{
		"no tls":      {Options: JSON(`{"listen_port": 443}`)},
		"tls as null": {Options: JSON(`{"tls": null}`)},
		// What a client is told means nothing with no TLS on the listener to meet.
		"a client half alone": {
			Options: JSON(`{}`),
			OutJson: JSON(`{"tls": {"insecure": true}}`),
		},
		"no options at all": {},
	}
	for name, inbound := range cases {
		t.Run(name, func(t *testing.T) {
			server, client, err := inbound.TLS()
			if err != nil {
				t.Fatalf("TLS: %v", err)
			}
			if server != nil || client != nil {
				t.Errorf("tls = %s / %s, want none", server, client)
			}
		})
	}
}

func TestTLSWithoutAClientHalf(t *testing.T) {
	// Plain TLS a client meets with nothing but what the server half says.
	inbound := Inbound{Options: JSON(`{"tls": {"enabled": true}}`)}

	server, client, err := inbound.TLS()
	if err != nil {
		t.Fatalf("TLS: %v", err)
	}
	if string(server) != `{"enabled": true}` || client != nil {
		t.Errorf("tls = %s / %s, want the server half alone", server, client)
	}
}

func TestAnUnreadableOutJsonIsSaidOfATLSListener(t *testing.T) {
	inbound := Inbound{
		Options: JSON(`{"tls": {"enabled": true}}`),
		OutJson: JSON(`["not", "an", "object"]`),
	}

	if _, _, err := inbound.TLS(); err == nil || !strings.Contains(err.Error(), "out_json") {
		t.Errorf("err = %v, want the out_json named", err)
	}
}
