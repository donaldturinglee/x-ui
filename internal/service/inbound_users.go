package service

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// userExtras are the fields a protocol's user carries beyond the credentials the
// panel mints: a vless flow and a vmess alterId are chosen rather than
// generated, and go with the user when a subscriber has one.
var userExtras = map[string][]string{
	"vless": {"flow"},
	"vmess": {"alterId"},
}

// inboundUsers is who a node lets in through an inbound: every subscriber given
// to it, as the identity they hold for its protocol, the way the reference fills
// an inbound's users when it assembles the core's configuration.
//
// clients are the enabled subscribers the inbound is assigned to. A disabled one
// is not among them, which is what takes a subscriber who has run out of quota
// or time off every node at its next sync.
//
// A subscriber whose user cannot be built is left out rather than failing the
// configuration, and said so in problems: one bad identity must not take every
// listener on every node down with it.
func inboundUsers(inbound *domain.Inbound, options map[string]interface{}, clients []domain.Client) (users []map[string]interface{}, problems []string) {
	keys := identityKeysFor(inbound.Type, options)
	if len(keys) == 0 {
		return nil, nil
	}

	method := stringOr(options["method"], "")
	// Vision is a flow over raw TLS, so a vless listener without TLS, or with a
	// transport between, has none to offer, and a user asking for it is refused.
	// Reality is TLS as far as the flow is concerned: it is switched on in the
	// same block.
	transportType := ""
	if transport, ok := options["transport"].(map[string]interface{}); ok {
		transportType = stringOr(transport["type"], "")
	}
	tls, _ := options["tls"].(map[string]interface{})
	withoutVision := !boolOr(tls["enabled"]) || transportType != ""

	for i := range clients {
		client := &clients[i]
		identities := map[string]map[string]interface{}{}
		if len(client.Config) > 0 {
			if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
				problems = append(problems, fmt.Sprintf("client %q has an unreadable config", client.Name))
				continue
			}
		}

		// A mixed listener takes both the socks and the http identity, which
		// are one user when they happen to be the same.
		seen := map[string]bool{}
		for _, key := range keys {
			identity := identities[key]
			if len(identity) == 0 {
				problems = append(problems, fmt.Sprintf("client %q has no %s identity", client.Name, key))
				continue
			}
			user := userEntry(key, identity)
			if inbound.Type == "vless" && withoutVision && user["flow"] == "xtls-rprx-vision" {
				delete(user, "flow")
			}
			if (key == "shadowsocks" || key == "shadowsocks16") && !validShadowsocksKey(method, stringOr(user["password"], "")) {
				problems = append(problems, fmt.Sprintf("client %q has a %s password the %s method cannot use", client.Name, key, method))
				continue
			}

			encoded, err := json.Marshal(user)
			if err != nil {
				problems = append(problems, fmt.Sprintf("client %q has an unwritable %s identity", client.Name, key))
				continue
			}
			if seen[string(encoded)] {
				continue
			}
			seen[string(encoded)] = true
			users = append(users, user)
		}
	}
	return users, problems
}

// userEntry is one identity as the core reads a user: its name and credentials,
// and whatever the subscriber chose for the protocol -- and no other key, since
// one the core does not expect in a user is one it refuses.
func userEntry(key string, identity map[string]interface{}) map[string]interface{} {
	user := map[string]interface{}{}
	for _, field := range identitySpecs[key] {
		if value, ok := identity[field.Field]; ok {
			user[field.Field] = value
		}
	}
	for _, field := range userExtras[key] {
		if value, ok := identity[field]; ok && value != "" {
			user[field] = value
		}
	}
	return user
}

// validShadowsocksKey reports whether a user password is one the method can
// take. A 2022 method reads it as a base64 key of a fixed length, and a core
// handed any other refuses its whole configuration; an older method takes any
// password at all.
func validShadowsocksKey(method string, password string) bool {
	if password == "" {
		return false
	}
	var size int
	switch method {
	case "2022-blake3-aes-128-gcm":
		size = 16
	case "2022-blake3-aes-256-gcm", "2022-blake3-chacha20-poly1305":
		size = 32
	default:
		return true
	}
	key, err := base64.StdEncoding.DecodeString(password)
	return err == nil && len(key) == size
}
