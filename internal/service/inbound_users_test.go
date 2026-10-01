package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func usersFor(t *testing.T, inbound *domain.Inbound, clients ...domain.Client) ([]map[string]interface{}, []string) {
	t.Helper()
	options, err := decodeObject(inbound.Options, "inbound options")
	if err != nil {
		t.Fatalf("decodeObject: %v", err)
	}
	return inboundUsers(inbound, options, clients)
}

func subscriber(name string, config string) domain.Client {
	return domain.Client{Name: name, Enable: true, Config: domain.JSON(config)}
}

func TestInboundUsersAreTheSubscribersIdentities(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "vless", "edge", `{"listen_port": 443}`), `{"enabled": true}`, "")

	users, problems := usersFor(t, inbound,
		subscriber("alice", `{"vless": {"name": "alice", "uuid": "a-uuid", "flow": "xtls-rprx-vision", "note": "kept out"}}`),
		subscriber("bob", `{"vless": {"name": "bob", "uuid": "b-uuid"}, "trojan": {"name": "bob", "password": "p"}}`),
	)

	if len(problems) != 0 {
		t.Fatalf("problems = %v, want none", problems)
	}
	want := []map[string]interface{}{
		{"name": "alice", "uuid": "a-uuid", "flow": "xtls-rprx-vision"},
		{"name": "bob", "uuid": "b-uuid"},
	}
	// In the order the subscribers came, and with nothing a vless user does not
	// take: a key the core does not expect in a user is one it refuses.
	if got, _ := json.Marshal(users); string(got) != mustJSON(t, want) {
		t.Errorf("users = %s, want %s", got, mustJSON(t, want))
	}
}

func TestVisionOnlyOverRawTLS(t *testing.T) {
	identity := `{"vless": {"name": "alice", "uuid": "a-uuid", "flow": "xtls-rprx-vision"}}`

	on := `{"enabled": true}`
	cases := map[string]struct {
		inbound  *domain.Inbound
		withFlow bool
	}{
		"raw TLS":          {inbound: withTLS(t, buildInbound(t, "vless", "edge", `{}`), on, ""), withFlow: true},
		"Reality":          {inbound: withTLS(t, buildInbound(t, "vless", "edge", `{}`), `{"enabled": true, "reality": {"enabled": true}}`, ""), withFlow: true},
		"no TLS":           {inbound: buildInbound(t, "vless", "edge", `{}`), withFlow: false},
		"TLS switched off": {inbound: withTLS(t, buildInbound(t, "vless", "edge", `{}`), `{"enabled": false}`, ""), withFlow: false},
		"TLS over a route": {inbound: withTLS(t, buildInbound(t, "vless", "edge", `{"transport": {"type": "ws"}}`), on, ""), withFlow: false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			users, _ := usersFor(t, tc.inbound, subscriber("alice", identity))
			if len(users) != 1 {
				t.Fatalf("users = %v, want one", users)
			}
			// Vision is a flow over raw TLS: asked for anywhere else, the core
			// refuses the user.
			if _, present := users[0]["flow"]; present != tc.withFlow {
				t.Errorf("flow present = %v, want %v", present, tc.withFlow)
			}
		})
	}
}

func TestMixedInboundTakesBothIdentities(t *testing.T) {
	inbound := buildInbound(t, "mixed", "local", `{}`)

	users, _ := usersFor(t, inbound, subscriber("alice", `{
		"socks": {"username": "alice", "password": "socks-pw"},
		"http": {"username": "alice", "password": "http-pw"}
	}`))
	// One listener speaking both, so each link a subscriber holds for it works.
	if len(users) != 2 || users[0]["password"] != "socks-pw" || users[1]["password"] != "http-pw" {
		t.Errorf("users = %v, want the socks and the http identity", users)
	}

	users, _ = usersFor(t, inbound, subscriber("bob", `{
		"socks": {"username": "bob", "password": "same"},
		"http": {"username": "bob", "password": "same"}
	}`))
	if len(users) != 1 {
		t.Errorf("users = %v, want one user for two identical identities", users)
	}
}

func TestShadowsocksUsersFollowTheMethod(t *testing.T) {
	key16 := "AAECAwQFBgcICQoLDA0ODw==" // 16 bytes
	inbound := buildInbound(t, "shadowsocks", "ss", `{"method": "2022-blake3-aes-128-gcm", "password": "server"}`)

	users, problems := usersFor(t, inbound,
		subscriber("alice", `{"shadowsocks16": {"name": "alice", "password": "`+key16+`"}, "shadowsocks": {"name": "alice", "password": "wrong-identity"}}`),
		subscriber("bob", `{"shadowsocks16": {"name": "bob", "password": "not-a-key"}}`),
	)

	// The method's own identity, and a password it cannot use is left out
	// rather than making the core refuse the whole configuration.
	if len(users) != 1 || users[0]["password"] != key16 {
		t.Errorf("users = %v, want alice's 128-bit key alone", users)
	}
	if len(problems) != 1 || !strings.Contains(problems[0], `"bob"`) {
		t.Errorf("problems = %v, want bob's password named", problems)
	}

	// A method from before 2022 takes any password.
	legacy := buildInbound(t, "shadowsocks", "ss", `{"method": "aes-256-gcm", "password": "server"}`)
	users, problems = usersFor(t, legacy, subscriber("carol", `{"shadowsocks": {"name": "carol", "password": "anything"}}`))
	if len(users) != 1 || len(problems) != 0 {
		t.Errorf("users = %v, problems = %v; want carol let in", users, problems)
	}
}

func TestShadowtlsUsersFromVersionThree(t *testing.T) {
	identity := `{"shadowtls": {"name": "alice", "password": "pw"}}`

	users, problems := usersFor(t, buildInbound(t, "shadowtls", "stls", `{"version": 2, "password": "one-for-all"}`), subscriber("alice", identity))
	// Before version 3 there is one password for everyone and no users.
	if users != nil || problems != nil {
		t.Errorf("users = %v, problems = %v; want none before version 3", users, problems)
	}

	users, _ = usersFor(t, buildInbound(t, "shadowtls", "stls", `{"version": 3}`), subscriber("alice", identity))
	if len(users) != 1 || users[0]["password"] != "pw" {
		t.Errorf("users = %v, want alice's identity", users)
	}
}

func TestSnellUsersCarryTheirKeys(t *testing.T) {
	inbound := buildInbound(t, "snell", "snell", `{"version": 6, "psk": "the-psk"}`)

	users, _ := usersFor(t, inbound, subscriber("alice", `{"snell": {"name": "alice", "userkey": "alice-key"}}`))
	if len(users) != 1 || users[0]["name"] != "alice" || users[0]["userkey"] != "alice-key" {
		t.Errorf("users = %v, want alice with her key", users)
	}
}

func TestSubscribersWithoutAnIdentityAreLeftOut(t *testing.T) {
	inbound := buildInbound(t, "trojan", "edge", `{}`)

	users, problems := usersFor(t, inbound,
		subscriber("alice", `{"trojan": {"name": "alice", "password": "pw"}}`),
		subscriber("bob", `{"vless": {"name": "bob", "uuid": "u"}}`),
		subscriber("carol", `["not", "a", "map"]`),
	)

	// One subscriber the node cannot let in must not keep out everyone else.
	if len(users) != 1 || users[0]["name"] != "alice" {
		t.Errorf("users = %v, want alice alone", users)
	}
	if len(problems) != 2 {
		t.Errorf("problems = %v, want bob's missing identity and carol's config named", problems)
	}
}

func TestInboundsThatAuthenticateNobody(t *testing.T) {
	users, problems := usersFor(t, buildInbound(t, "tun", "tun-in", `{}`), subscriber("alice", `{"vless": {"uuid": "u"}}`))
	if users != nil || problems != nil {
		t.Errorf("users = %v, problems = %v; want none for a tun", users, problems)
	}
}

func mustJSON(t *testing.T, value interface{}) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return string(encoded)
}
