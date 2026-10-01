package domain

// CoreConfig is the document a node is configured from.
//
// It is assembled at request time from two sources: the base document an
// operator edits, which holds everything that is not an object the panel
// models, and the objects themselves -- inbounds and outbounds -- which come
// from their own tables.
//
// Every top-level key the core accepts has to be listed here, including the
// ones the panel does not model yet. A key that is missing from this struct is
// silently dropped on the way through, taking with it whatever the operator
// wrote by hand.
type CoreConfig struct {
	Schema string `json:"$schema,omitempty"`

	Log JSON `json:"log,omitempty"`
	DNS JSON `json:"dns,omitempty"`
	NTP JSON `json:"ntp,omitempty"`

	// Certificate is the core's global certificate store.
	Certificate JSON `json:"certificate,omitempty"`

	// HTTPClients are named clients that remote rule-sets download over.
	HTTPClients       []JSON `json:"http_clients,omitempty"`
	NetworkNamespaces []JSON `json:"network_namespaces,omitempty"`

	// Inbounds and Outbounds are replaced from the database on every
	// generation. They carry no omitempty: a core reads a missing key and an
	// empty list differently, and "this node serves nothing" has to be sayable.
	Inbounds  []JSON `json:"inbounds"`
	Outbounds []JSON `json:"outbounds"`

	// Endpoints are replaced the same way: they are the WireGuard routes out,
	// which the core runs as endpoints rather than as outbounds. They do carry
	// omitempty: unlike the two above, a node with none is the ordinary case,
	// and an empty list would have the core parse a key that says nothing.
	Endpoints []JSON `json:"endpoints,omitempty"`
	// Services are not modelled by the panel. Whatever an operator writes into
	// the base document is passed through as it is.
	Services []JSON `json:"services,omitempty"`

	Route        JSON `json:"route,omitempty"`
	Experimental JSON `json:"experimental,omitempty"`
}

// ManagedConfigKeys are the parts of the document the panel owns. They are
// refused in a base config rather than overwritten, so an operator who puts one
// there is told, instead of watching it disappear on the next generation.
var ManagedConfigKeys = []string{"inbounds", "outbounds", "endpoints"}

// DefaultCoreConfig is the base document a fresh install starts from: enough
// route rules to resolve names and sniff protocols, and nothing opinionated
// beyond that.
const DefaultCoreConfig = `{
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [],
    "rules": []
  },
  "route": {
    "rules": [
      {
        "action": "sniff"
      },
      {
        "protocol": [
          "dns"
        ],
        "action": "hijack-dns"
      }
    ]
  },
  "experimental": {}
}`
