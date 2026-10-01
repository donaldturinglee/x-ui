package domain

import (
	"encoding/json"
	"testing"
)

func TestDefaultCoreConfigIsValid(t *testing.T) {
	if !json.Valid([]byte(DefaultCoreConfig)) {
		t.Fatal("DefaultCoreConfig is not valid JSON")
	}
	var config CoreConfig
	if err := json.Unmarshal([]byte(DefaultCoreConfig), &config); err != nil {
		t.Fatalf("DefaultCoreConfig does not fit CoreConfig: %v", err)
	}
	if len(config.Log) == 0 || len(config.Route) == 0 {
		t.Error("DefaultCoreConfig should ship with log and route rules")
	}
}

// TestCoreConfigCarriesEveryKeyThrough is the test that stops the quiet
// failure this struct exists to prevent: a top-level key the panel does not
// model is dropped on the way through, taking with it whatever the operator
// wrote by hand.
func TestCoreConfigCarriesEveryKeyThrough(t *testing.T) {
	const base = `{
		"$schema": "https://example.invalid/schema.json",
		"log": {"level": "debug"},
		"dns": {"servers": [{"tag": "local"}]},
		"ntp": {"enabled": true},
		"certificate": {"store": "system"},
		"http_clients": [{"tag": "default"}],
		"network_namespaces": [{"name": "ns0"}],
		"services": [{"type": "derp", "tag": "derp-in"}],
		"endpoints": [{"type": "wireguard", "tag": "wg0"}],
		"route": {"rules": [{"action": "sniff"}]},
		"experimental": {"cache_file": {"enabled": true}}
	}`

	var config CoreConfig
	if err := json.Unmarshal([]byte(base), &config); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}

	for _, key := range []string{
		"$schema", "log", "dns", "ntp", "certificate",
		"http_clients", "network_namespaces", "services", "endpoints",
		"route", "experimental",
	} {
		if _, present := out[key]; !present {
			t.Errorf("key %q was dropped on the way through", key)
		}
	}

}

func TestManagedObjectsAreAllDeclaredInTheStruct(t *testing.T) {
	// Every managed key needs a field to be written into. A key in
	// ManagedConfigKeys with no field would be refused on save and then never
	// appear in the generated document either -- unreachable from both ends.
	config := CoreConfig{
		Inbounds:  []JSON{JSON(`{"tag":"in"}`)},
		Outbounds: []JSON{JSON(`{"tag":"out"}`)},
		Endpoints: []JSON{JSON(`{"tag":"wg"}`)},
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}

	for _, key := range ManagedConfigKeys {
		if _, present := out[key]; !present {
			t.Errorf("managed key %q has no field in CoreConfig", key)
		}
	}
}

func TestCoreConfigAlwaysDeclaresTheManagedObjects(t *testing.T) {
	config := CoreConfig{
		Log:       JSON(`{"level":"info"}`),
		Inbounds:  []JSON{},
		Outbounds: []JSON{},
	}

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}

	// A core reads a missing key and an empty list differently, so "this node
	// serves nothing" has to be sayable rather than indistinguishable from
	// "this key was forgotten".
	for _, key := range []string{"inbounds", "outbounds"} {
		raw, present := out[key]
		if !present {
			t.Errorf("key %q is missing; it must always be declared", key)
			continue
		}
		if string(raw) != "[]" {
			t.Errorf("key %q = %s, want an empty list", key, raw)
		}
	}
}

func TestCoreConfigOmitsWhatWasNeverSet(t *testing.T) {
	config := CoreConfig{Inbounds: []JSON{}, Outbounds: []JSON{}}

	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("Marshal produced invalid JSON: %v", err)
	}

	// An empty optional key emitted as null is not the same as leaving it out:
	// a core that reads "dns": null and a core that reads no dns key at all
	// behave differently, and only the second is what "unset" means.
	for _, key := range []string{"log", "dns", "ntp", "route", "experimental", "services", "endpoints"} {
		if _, present := out[key]; present {
			t.Errorf("key %q was emitted despite never being set", key)
		}
	}
}

func TestManagedConfigKeysMatchTheManagedFields(t *testing.T) {
	// ManagedConfigKeys drives the rejection in SaveBase. If it drifts from the
	// fields Generate overwrites, an operator can store a key that silently
	// disappears at the next generation -- or, the other way, is refused one the
	// panel no longer writes, as services would be.
	want := map[string]bool{
		"inbounds": true, "outbounds": true, "endpoints": true,
	}
	if len(ManagedConfigKeys) != len(want) {
		t.Fatalf("ManagedConfigKeys = %v, want %v", ManagedConfigKeys, want)
	}
	for _, key := range ManagedConfigKeys {
		if !want[key] {
			t.Errorf("ManagedConfigKeys carries unexpected %q", key)
		}
	}
}
