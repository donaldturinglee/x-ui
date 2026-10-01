package domain

import (
	"encoding/json"
	"fmt"
)

// Inbound is a listener clients connect to.
//
// Only the fields the panel itself reasons about have columns; everything else
// the proxy core accepts for that inbound type is kept verbatim in Options.
// That is what lets the panel carry a new core release's options without a
// migration, at the cost of the marshalling below.
//
// Its TLS is one of those options: the `tls` block the core terminates with,
// Reality included. What a client is handed to meet it -- the uTLS fingerprint,
// the Reality public key, whether to verify the certificate at all -- is no
// option the core takes on a listener, so it is kept in OutJson under the same
// key, beside the rest of what a client is told.
type Inbound struct {
	Id   uint   `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Type string `json:"type" form:"type"`
	Tag  string `json:"tag" form:"tag" gorm:"uniqueIndex"`

	// Addrs are the addresses this inbound is reachable at, used to build the
	// subscription links handed to clients.
	Addrs JSON `json:"addrs" form:"addrs" gorm:"type:jsonb"`
	// OutJson overrides what a generated client-side link says about this
	// inbound, for the cases where the address clients dial is not the address
	// the server listens on.
	OutJson JSON `json:"out_json" form:"out_json" gorm:"type:jsonb"`
	// Options is every remaining core option for this inbound type.
	Options JSON `json:"-" form:"-" gorm:"type:jsonb"`
}

func (Inbound) TableName() string {
	return "inbounds"
}

// UnmarshalJSON splits an incoming inbound into the columns the panel knows and
// the Options blob that holds the rest.
func (i *Inbound) UnmarshalJSON(data []byte) error {
	var err error
	var raw map[string]interface{}
	if err = json.Unmarshal(data, &raw); err != nil {
		return err
	}

	// Extract fixed fields and store the rest in Options
	if val, exists := raw["id"].(float64); exists {
		i.Id = uint(val)
	}
	delete(raw, "id")
	i.Type, _ = raw["type"].(string)
	delete(raw, "type")
	i.Tag, _ = raw["tag"].(string)
	delete(raw, "tag")

	// tls_id named a TLS configuration kept apart from the listener, which is
	// where its TLS used to be. Left among the options, it would reach the core
	// as one it refuses.
	delete(raw, "tls_id")
	// The client list is rendered on the way out but never accepted on the way
	// in: it belongs to another table.
	delete(raw, "users")

	if i.Addrs, err = marshalField(raw, "addrs"); err != nil {
		return err
	}
	if i.OutJson, err = marshalField(raw, "out_json"); err != nil {
		return err
	}

	// Remaining fields
	options, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	i.Options = JSON(options)
	return nil
}

// marshalField renders one named field back to JSON and removes it from raw. An
// absent field yields no document rather than the literal "null", so the column
// stays NULL instead of holding four bytes that read as a value.
func marshalField(raw map[string]interface{}, name string) (JSON, error) {
	value, ok := raw[name]
	delete(raw, name)
	if !ok || value == nil {
		return nil, nil
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return JSON(encoded), nil
}

// MarshalJSON renders the inbound the way the proxy core expects it: the known
// fields, and Options -- its TLS among them -- flattened back out.
func (i Inbound) MarshalJSON() ([]byte, error) {
	combined := make(map[string]interface{})
	combined["type"] = i.Type
	combined["tag"] = i.Tag

	if len(i.Options) > 0 {
		var restFields map[string]json.RawMessage
		if err := json.Unmarshal(i.Options.Raw(), &restFields); err != nil {
			return nil, err
		}
		for k, v := range restFields {
			combined[k] = v
		}
	}

	return json.Marshal(combined)
}

// MarshalFull renders the inbound the way the panel's own API returns it: the
// same flattening, plus the identifiers the core config has no use for.
func (i Inbound) MarshalFull() (map[string]interface{}, error) {
	combined := make(map[string]interface{})
	combined["id"] = i.Id
	combined["type"] = i.Type
	combined["tag"] = i.Tag
	combined["addrs"] = i.Addrs
	combined["out_json"] = i.OutJson

	if len(i.Options) > 0 {
		var restFields map[string]interface{}
		if err := json.Unmarshal(i.Options.Raw(), &restFields); err != nil {
			return nil, err
		}
		for k, v := range restFields {
			combined[k] = v
		}
	}
	return combined, nil
}

// TLS reads the listener's TLS as the two halves the panel keeps apart: the
// block the core terminates with, among the options, and what a client is
// handed to meet it, in out_json. Server is nil for a listener that terminates
// none, and client for one that hands a client nothing beyond what the server
// half says.
func (i Inbound) TLS() (server JSON, client JSON, err error) {
	if server, err = documentKey(i.Options, "tls"); err != nil {
		return nil, nil, fmt.Errorf("options: %w", err)
	}
	if server == nil {
		return nil, nil, nil
	}
	if client, err = documentKey(i.OutJson, "tls"); err != nil {
		return nil, nil, fmt.Errorf("out_json: %w", err)
	}
	return server, client, nil
}

// documentKey reads one key of a stored document, or nothing where the document
// or the key is absent. A key written as null is as good as absent: the core
// reads it that way too.
func documentKey(document JSON, key string) (JSON, error) {
	if len(document) == 0 {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(document.Raw(), &fields); err != nil {
		return nil, err
	}
	value, present := fields[key]
	if !present || string(value) == "null" {
		return nil, nil
	}
	return JSON(value), nil
}
