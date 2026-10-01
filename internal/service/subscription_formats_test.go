package service

import (
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func vlessNode() *clientNode {
	return &clientNode{
		Tag:        "edge",
		Type:       "vless",
		Server:     "edge.example.com",
		ServerPort: 443,
		Identity:   map[string]interface{}{"uuid": "the-uuid", "flow": "xtls-rprx-vision"},
		Transport:  map[string]interface{}{"type": "ws", "path": "/ray", "headers": map[string]interface{}{"Host": "edge.example.com"}},
		TLS:        map[string]interface{}{"enabled": true, "server_name": "edge.example.com", "alpn": []interface{}{"h2"}},
		Options:    map[string]interface{}{},
	}
}

func TestSingBoxOutboundRendersTheProtocol(t *testing.T) {
	out := singBoxOutbound(vlessNode())
	if out == nil {
		t.Fatal("singBoxOutbound returned nil for vless")
	}

	if out["type"] != "vless" || out["uuid"] != "the-uuid" {
		t.Errorf("outbound = %v, want a vless outbound with the uuid", out)
	}
	if out["server"] != "edge.example.com" || out["server_port"] != 443 {
		t.Errorf("outbound = %v, want the address and port", out)
	}
	// flow is only valid over raw TCP; on a websocket transport the client
	// refuses the outbound outright.
	if _, present := out["flow"]; present {
		t.Error("flow was advertised on a websocket transport")
	}

	transport, ok := out["transport"].(map[string]interface{})
	if !ok {
		t.Fatalf("transport = %v, want an object", out["transport"])
	}
	if transport["type"] != "ws" || transport["path"] != "/ray" {
		t.Errorf("transport = %v, want the websocket settings", transport)
	}
}

func TestSingBoxTlsDropsThePanelsOwnFields(t *testing.T) {
	node := vlessNode()
	node.TLS["pinSHA256"] = "deadbeef"
	node.TLS["certificate_public_key_sha256"] = true

	out := singBoxOutbound(node)
	tls, ok := out["tls"].(map[string]interface{})
	if !ok {
		t.Fatalf("tls = %v, want an object", out["tls"])
	}

	if tls["server_name"] != "edge.example.com" {
		t.Errorf("tls = %v, want the server name carried through", tls)
	}
	// Both are the panel's bookkeeping for the link formats. sing-box expects
	// a certificate in this field, not a fingerprint, and would refuse it.
	for _, key := range []string{"pinSHA256", "certificate_public_key_sha256"} {
		if _, present := tls[key]; present {
			t.Errorf("tls carries %q, which sing-box does not understand", key)
		}
	}
}

func TestSingBoxTransportOmittedForRawTcp(t *testing.T) {
	node := vlessNode()
	node.Transport = map[string]interface{}{"type": "tcp"}

	out := singBoxOutbound(node)
	// A "tcp" transport object is not a thing sing-box accepts: raw TCP is the
	// absence of a transport.
	if _, present := out["transport"]; present {
		t.Errorf("outbound = %v, want no transport for raw tcp", out)
	}
}

func TestSingBoxSkipsProtocolsItCannotExpress(t *testing.T) {
	node := vlessNode()
	node.Type = "tun"

	if out := singBoxOutbound(node); out != nil {
		t.Errorf("singBoxOutbound(tun) = %v, want nil so it is left out rather than emitted half-formed", out)
	}
}

func TestSingBoxNaiveOutbound(t *testing.T) {
	node := vlessNode()
	node.Type = "naive"
	node.Transport = nil
	node.Identity = map[string]interface{}{"username": "alice", "password": "pw"}
	node.Options = map[string]interface{}{"quic_congestion_control": "bbr_standard"}

	out := singBoxOutbound(node)
	if out["type"] != "naive" || out["username"] != "alice" || out["password"] != "pw" {
		t.Fatalf("outbound = %v, want a naive outbound with the credentials", out)
	}
	// A listener speaking QUIC is dialled over it, with the congestion control
	// under the name the client knows it by.
	if out["quic"] != true || out["quic_congestion_control"] != "bbr" {
		t.Errorf("outbound = %v, want quic on with bbr", out)
	}
	if _, ok := out["tls"].(map[string]interface{}); !ok {
		t.Errorf("tls = %v, want the listener's TLS", out["tls"])
	}

	// Cleared on the listener, it goes from the outbound too, rather than
	// leaving QUIC switched on with nothing to say how.
	node.Options = map[string]interface{}{"quic_congestion_control": ""}
	out = singBoxOutbound(node)
	for _, key := range []string{"quic", "quic_congestion_control"} {
		if _, present := out[key]; present {
			t.Errorf("outbound carries %q with QUIC cleared on the listener", key)
		}
	}
}

func TestSingBoxSnellOutbound(t *testing.T) {
	node := &clientNode{
		Tag: "snell", Type: "snell", Server: "edge.example.com", ServerPort: 8443,
		Identity: map[string]interface{}{"name": "alice", "userkey": "alice-key"},
		Options:  map[string]interface{}{"version": float64(6), "mode": "quic", "psk": "the-psk"},
	}

	out := singBoxOutbound(node)
	if out["type"] != "snell" || out["version"] != 6 || out["mode"] != "quic" {
		t.Fatalf("outbound = %v, want a version 6 snell outbound in its mode", out)
	}
	// The listener's key, and the subscriber's own, which a listener with users
	// asks of each.
	if out["psk"] != "the-psk" || out["userkey"] != "alice-key" {
		t.Errorf("outbound = %v, want the psk and the subscriber's key", out)
	}

	// The listeners before version 6 are dialled as version 4, with their
	// obfuscation rather than a mode.
	node.Options = map[string]interface{}{"version": float64(5), "obfs_mode": "tls", "mode": "quic", "psk": "the-psk"}
	out = singBoxOutbound(node)
	if out["version"] != 4 || out["obfs_mode"] != "tls" {
		t.Errorf("outbound = %v, want version 4 with the obfuscation", out)
	}
	if _, present := out["mode"]; present {
		t.Error("a version 4 outbound was given a version 6 mode")
	}
	// Clash has no equivalent worth emitting.
	if proxy := clashProxy(node); proxy != nil {
		t.Errorf("clashProxy(snell) = %v, want nil", proxy)
	}
}

func TestInSubscription(t *testing.T) {
	// snell has no link, but is an outbound like the rest.
	for _, inType := range []string{"vless", "naive", "snell"} {
		if !inSubscription(inType) {
			t.Errorf("inSubscription(%q) = false, want true", inType)
		}
	}
	for _, outType := range []string{"tun", "shadowtls", "direct"} {
		if inSubscription(outType) {
			t.Errorf("inSubscription(%q) = true, want false", outType)
		}
	}
}

func TestClashProxyRendersTheProtocol(t *testing.T) {
	proxy := clashProxy(vlessNode())
	if proxy == nil {
		t.Fatal("clashProxy returned nil for vless")
	}

	if proxy["type"] != "vless" || proxy["uuid"] != "the-uuid" {
		t.Errorf("proxy = %v, want a vless proxy with the uuid", proxy)
	}
	if proxy["name"] != "edge" || proxy["port"] != 443 {
		t.Errorf("proxy = %v, want the name and port", proxy)
	}
	// Clash disables UDP unless a proxy opts in, so without this every node
	// reaches the subscriber with UDP off and nothing says why.
	if proxy["udp"] != true {
		t.Errorf("proxy = %v, want udp enabled", proxy)
	}
	if proxy["network"] != "ws" {
		t.Errorf("network = %v, want ws", proxy["network"])
	}
	if proxy["servername"] != "edge.example.com" {
		t.Errorf("servername = %v, want the TLS server name", proxy["servername"])
	}
}

func TestClashTlsFieldsDependOnTheProtocol(t *testing.T) {
	t.Run("tls-by-definition protocols do not repeat it", func(t *testing.T) {
		node := vlessNode()
		node.Type = "hysteria2"
		node.Identity = map[string]interface{}{"password": "pw"}

		proxy := clashProxy(node)
		// hysteria2 is TLS by definition, and saying so again is what makes
		// some Clash builds reject the proxy.
		if _, present := proxy["tls"]; present {
			t.Errorf("proxy = %v, want no explicit tls flag", proxy)
		}
		if proxy["sni"] != "edge.example.com" {
			t.Errorf("sni = %v, want the server name under sni", proxy["sni"])
		}
		if _, present := proxy["servername"]; present {
			t.Errorf("proxy = %v, want servername not used for hysteria2", proxy)
		}
	})

	t.Run("others say tls explicitly", func(t *testing.T) {
		proxy := clashProxy(vlessNode())
		if proxy["tls"] != true {
			t.Errorf("proxy = %v, want tls: true for vless", proxy)
		}
	})
}

func TestClashRealityOptions(t *testing.T) {
	node := vlessNode()
	node.TLS["reality"] = map[string]interface{}{
		"enabled": true, "public_key": "PUBKEY", "short_id": "abcd",
	}

	proxy := clashProxy(node)
	opts, ok := proxy["reality-opts"].(map[string]interface{})
	if !ok {
		t.Fatalf("reality-opts = %v, want an object", proxy["reality-opts"])
	}
	// Clash spells these with dashes, not underscores.
	if opts["public-key"] != "PUBKEY" || opts["short-id"] != "abcd" {
		t.Errorf("reality-opts = %v, want the public key and short id", opts)
	}
}

func TestShadowsocksPasswordCombinesForTwentyTwentyTwo(t *testing.T) {
	node := &clientNode{
		Type:     "shadowsocks",
		Identity: map[string]interface{}{"password": "userpass"},
		Options:  map[string]interface{}{"method": "2022-blake3-aes-128-gcm", "password": "serverpass"},
	}
	if got := shadowsocksPassword(node); got != "serverpass:userpass" {
		t.Errorf("password = %q, want the server and user passwords joined", got)
	}

	node.Options["method"] = "aes-256-gcm"
	if got := shadowsocksPassword(node); got != "userpass" {
		t.Errorf("password = %q, want only the user password for a non-2022 method", got)
	}
}

func TestSingBoxTemplateIsValid(t *testing.T) {
	var config map[string]interface{}
	if err := json.Unmarshal([]byte(singBoxTemplate), &config); err != nil {
		t.Fatalf("singBoxTemplate is not valid JSON: %v", err)
	}
	for _, key := range []string{"inbounds", "outbounds", "route", "dns"} {
		if _, present := config[key]; !present {
			t.Errorf("singBoxTemplate is missing %q", key)
		}
	}
}

func TestClashTemplateIsValid(t *testing.T) {
	var config map[string]interface{}
	if err := yaml.Unmarshal([]byte(clashTemplate), &config); err != nil {
		t.Fatalf("clashTemplate is not valid YAML: %v", err)
	}
	// The rule set detours to the Proxy group, so that group has to exist in
	// the rendered output or the configuration will not load.
	rules, ok := config["rules"].([]interface{})
	if !ok || len(rules) == 0 {
		t.Fatalf("rules = %v, want a non-empty list", config["rules"])
	}
	last, _ := rules[len(rules)-1].(string)
	if !strings.HasSuffix(last, groupProxy) {
		t.Errorf("final rule = %q, want it to detour to %q", last, groupProxy)
	}
}

func TestUniqueTag(t *testing.T) {
	taken := map[string]bool{}

	first := uniqueTag("edge", taken)
	taken[first] = true
	second := uniqueTag("edge", taken)
	taken[second] = true
	third := uniqueTag("edge", taken)

	// Both formats reject duplicate names, and an inbound published at two
	// addresses would otherwise produce two nodes called the same thing.
	if first != "edge" || second != "edge-2" || third != "edge-3" {
		t.Errorf("tags = %q, %q, %q; want edge, edge-2, edge-3", first, second, third)
	}

	if got := uniqueTag("", map[string]bool{}); got != "node" {
		t.Errorf("uniqueTag(\"\") = %q, want a fallback name", got)
	}
}

func TestIdentityKeyFor(t *testing.T) {
	cases := map[string]struct {
		inboundType string
		options     map[string]interface{}
		want        string
	}{
		"vless":              {inboundType: "vless", want: "vless"},
		"mixed uses socks":   {inboundType: "mixed", want: "socks"},
		"shadowsocks legacy": {inboundType: "shadowsocks", options: map[string]interface{}{"method": "aes-256-gcm"}, want: "shadowsocks"},
		"shadowsocks 2022": {
			// A 2022 method needs a different key length, so the subscriber
			// carries a separate identity for it.
			inboundType: "shadowsocks",
			options:     map[string]interface{}{"method": "2022-blake3-aes-128-gcm"},
			want:        "shadowsocks16",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := identityKeyFor(tc.inboundType, tc.options); got != tc.want {
				t.Errorf("identityKeyFor = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFormatBytes(t *testing.T) {
	cases := map[int64]string{
		512:                    "512B",
		2048:                   "2.00KB",
		5 * 1024 * 1024:        "5.00MB",
		3 * 1024 * 1024 * 1024: "3.00GB",
	}
	for bytes, want := range cases {
		if got := formatBytes(bytes); got != want {
			t.Errorf("formatBytes(%d) = %q, want %q", bytes, got, want)
		}
	}
}
