package domain

import (
	"encoding/json"
	"sort"
)

// OutboundTypeBlock is the route out that refuses every connection sent to it.
//
// The core also refuses a connection from a rule, with the reject action, and
// needs no route out to do it. A block route is for what can only name one --
// the default outbound above all, named as a block route to have a node refuse
// whatever no rule let through -- which is why a panel starts with one. It is
// also the one type whose options the panel knows in full, because it has none.
const OutboundTypeBlock = "block"

// OutboundTypeWireGuard is the route out through a WireGuard tunnel.
//
// The core has run WireGuard as an endpoint rather than an outbound since 1.11,
// and since 1.13 it refuses one among its outbounds -- the whole configuration,
// not the one route. The panel keeps it among the outbounds all the same, where
// an operator looks for a route out, with the options the endpoint takes, and
// writes it into the endpoints of the generated configuration instead. A rule
// and a detour name an endpoint by its tag as they name an outbound, so nothing
// that names one has to know the difference.
const OutboundTypeWireGuard = "wireguard"

// wireGuardOutboundOptions are the options the WireGuard outbound took before
// the core moved WireGuard to its endpoints, which the endpoint a WireGuard
// route is written as does not read: the far end is its peer's address and port
// now, the local addresses are its own address, and the peer's key, the key the
// two share and the reserved bytes are the peer's.
var wireGuardOutboundOptions = map[string]bool{
	"server":           true,
	"server_port":      true,
	"system_interface": true,
	"gso":              true,
	"interface_name":   true,
	"local_address":    true,
	"peer_public_key":  true,
	"pre_shared_key":   true,
	"reserved":         true,
	"network":          true,
}

// Outbound is a route out of the node: where traffic goes after an inbound has
// accepted it.
//
// It is stored the same way an inbound is -- the two fields the panel reasons
// about in columns, every other option the core accepts kept verbatim in
// Options -- so a new core release adds outbound types without a migration.
//
// A configuration with inbounds and no outbounds routes nothing, which is why
// a `direct` outbound is seeded when the table is created. A `block` one is
// seeded after it, never before: the first route out is where the core sends
// whatever no rule matched. A WireGuard route is never that first one, as it
// is written among the endpoints rather than the outbounds.
type Outbound struct {
	Id   uint   `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Type string `json:"type" form:"type"`
	Tag  string `json:"tag" form:"tag" gorm:"uniqueIndex"`
	// Options is every remaining core option for this outbound type.
	Options JSON `json:"-" form:"-" gorm:"type:jsonb"`
}

func (Outbound) TableName() string {
	return "outbounds"
}

func (o *Outbound) UnmarshalJSON(data []byte) error {
	id, objectType, tag, options, err := splitCoreObject(data)
	if err != nil {
		return err
	}
	o.Id, o.Type, o.Tag, o.Options = id, objectType, tag, options
	return nil
}

// MarshalJSON renders the outbound the way the proxy core expects it.
func (o Outbound) MarshalJSON() ([]byte, error) {
	combined, err := coreShape(o.Type, o.Tag, o.Options)
	if err != nil {
		return nil, err
	}
	return json.Marshal(combined)
}

// MarshalFull renders the outbound the way the panel's own API returns it.
func (o Outbound) MarshalFull() (map[string]interface{}, error) {
	return panelShape(o.Id, o.Type, o.Tag, o.Options)
}

// IsEndpoint reports whether the core takes this route out as an endpoint
// rather than as an outbound, which is where a generated configuration puts it.
func (o Outbound) IsEndpoint() bool {
	return o.Type == OutboundTypeWireGuard
}

// StrayOptions lists the options stored on an outbound that the core does not
// read for its type, sorted so that saying which reads the same every time.
//
// Two types are judged. The core reads nothing for a block route beyond its type
// and its tag, and nothing for a WireGuard route that only its old outbound took,
// as it is written as an endpoint. The core refuses a configuration over a key it
// does not read -- the whole configuration, not the one route -- so an option
// like that stops a node rather than being ignored. Every other type's options
// are the core's to judge, and differ from one release of it to the next.
func (o Outbound) StrayOptions() ([]string, error) {
	if (o.Type != OutboundTypeBlock && o.Type != OutboundTypeWireGuard) || len(o.Options) == 0 {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(o.Options.Raw(), &fields); err != nil {
		return nil, err
	}
	stray := make([]string, 0, len(fields))
	for key := range fields {
		if o.Type == OutboundTypeBlock || wireGuardOutboundOptions[key] {
			stray = append(stray, key)
		}
	}
	sort.Strings(stray)
	return stray, nil
}
