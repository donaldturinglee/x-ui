package service

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// buildInbound assembles an inbound the way the database hands one back: the
// modelled fields in columns, everything else in Options.
func buildInbound(t *testing.T, inboundType string, tag string, options string) *domain.Inbound {
	t.Helper()
	return &domain.Inbound{
		Id:      1,
		Type:    inboundType,
		Tag:     tag,
		Options: domain.JSON(options),
	}
}

// withTLS gives a listener its TLS as it is stored: the server half among its
// options, and the client half, where there is one, in its out_json.
func withTLS(t *testing.T, inbound *domain.Inbound, server string, client string) *domain.Inbound {
	t.Helper()
	options := map[string]json.RawMessage{}
	if len(inbound.Options) > 0 {
		if err := json.Unmarshal(inbound.Options.Raw(), &options); err != nil {
			t.Fatalf("options: %v", err)
		}
	}
	options["tls"] = json.RawMessage(server)
	encoded, err := json.Marshal(options)
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	inbound.Options = domain.JSON(encoded)
	if client != "" {
		inbound.OutJson = domain.JSON(`{"tls": ` + client + `}`)
	}
	return inbound
}

func buildClient(t *testing.T, name string, remark string, config string) *domain.Client {
	t.Helper()
	return &domain.Client{
		Id:     1,
		Name:   name,
		Remark: remark,
		Config: domain.JSON(config),
	}
}

// parseLink fails the test rather than returning an error: a generated link
// that does not parse is the defect these tests exist to catch.
func parseLink(t *testing.T, link string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(link)
	if err != nil {
		t.Fatalf("generated link does not parse: %q: %v", link, err)
	}
	return parsed
}

func generate(t *testing.T, client *domain.Client, inbound *domain.Inbound, hostname string) []string {
	t.Helper()
	links, err := GenerateLinks(client, inbound, hostname)
	if err != nil {
		t.Fatalf("GenerateLinks: %v", err)
	}
	return links
}

func TestHasLink(t *testing.T) {
	for _, withLink := range []string{"vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "anytls", "naive", "socks", "http", "mixed", "hysteria"} {
		if !HasLink(withLink) {
			t.Errorf("HasLink(%q) = false, want true", withLink)
		}
	}
	// A listener nobody dials from a client application: offering a link for it
	// would hand the subscriber something that cannot work.
	for _, withoutLink := range []string{"tun", "redirect", "tproxy", "direct", ""} {
		if HasLink(withoutLink) {
			t.Errorf("HasLink(%q) = true, want false", withoutLink)
		}
	}
}

func TestVlessLinkCarriesTransportAndTls(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "vless", "edge", `{
		"listen_port": 443,
		"transport": {"type": "ws", "path": "/ray", "headers": {"Host": "cdn.example.com"}}
	}`),
		`{"enabled": true, "server_name": "cdn.example.com", "alpn": ["h2", "http/1.1"]}`,
		`{"utls": {"fingerprint": "chrome"}}`,
	)
	client := buildClient(t, "alice", "AL", `{"vless": {"uuid": "11111111-2222-3333-4444-555555555555"}}`)

	links := generate(t, client, inbound, "panel.example.com")
	if len(links) != 1 {
		t.Fatalf("got %d links, want 1: %v", len(links), links)
	}

	u := parseLink(t, links[0])
	if u.Scheme != "vless" {
		t.Errorf("scheme = %q, want vless", u.Scheme)
	}
	if u.User.Username() != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("userinfo = %q, want the uuid", u.User.Username())
	}
	if u.Host != "panel.example.com:443" {
		t.Errorf("host = %q, want the request host and the listening port", u.Host)
	}
	// The remark is what the subscriber sees in their client's node list.
	if u.Fragment != "AL-edge" {
		t.Errorf("fragment = %q, want %q", u.Fragment, "AL-edge")
	}

	q := u.Query()
	for key, want := range map[string]string{
		"type":     "ws",
		"path":     "/ray",
		"host":     "cdn.example.com",
		"security": "tls",
		"sni":      "cdn.example.com",
		"fp":       "chrome",
		"alpn":     "h2,http/1.1",
	} {
		if got := q.Get(key); got != want {
			t.Errorf("param %q = %q, want %q", key, got, want)
		}
	}
}

func TestVlessFlowOnlyOverRawTcp(t *testing.T) {
	tls := `{"enabled": true, "server_name": "a.example.com"}`
	client := buildClient(t, "alice", "", `{"vless": {"uuid": "u", "flow": "xtls-rprx-vision"}}`)

	t.Run("tcp advertises flow", func(t *testing.T) {
		inbound := withTLS(t, buildInbound(t, "vless", "direct", `{"listen_port": 443, "transport": {"type": "tcp"}}`), tls, "")

		links := generate(t, client, inbound, "h")
		if got := parseLink(t, links[0]).Query().Get("flow"); got != "xtls-rprx-vision" {
			t.Errorf("flow = %q, want it advertised over raw tcp", got)
		}
	})

	t.Run("websocket does not", func(t *testing.T) {
		inbound := withTLS(t, buildInbound(t, "vless", "ws", `{"listen_port": 443, "transport": {"type": "ws", "path": "/"}}`), tls, "")

		links := generate(t, client, inbound, "h")
		// A client that sees flow on a non-TCP transport refuses the link
		// outright, so this is the difference between working and not.
		if got := parseLink(t, links[0]).Query().Get("flow"); got != "" {
			t.Errorf("flow = %q, want it omitted on a websocket transport", got)
		}
	})
}

func TestRealityReplacesTls(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "vless", "reality", `{"listen_port": 443, "transport": {"type": "tcp"}}`),
		`{"enabled": true, "server_name": "www.example.com", "reality": {"enabled": true, "short_id": ["abcd"]}}`,
		`{"reality": {"public_key": "PUBKEY"}}`,
	)
	client := buildClient(t, "alice", "", `{"vless": {"uuid": "u"}}`)

	q := parseLink(t, generate(t, client, inbound, "h")[0]).Query()
	if q.Get("security") != "reality" {
		t.Errorf("security = %q, want reality", q.Get("security"))
	}
	if q.Get("pbk") != "PUBKEY" {
		t.Errorf("pbk = %q, want the client-side public key", q.Get("pbk"))
	}
	if q.Get("sid") != "abcd" {
		t.Errorf("sid = %q, want one of the server's short ids", q.Get("sid"))
	}
}

func TestAClientHalfAloneIsNoTLS(t *testing.T) {
	// What a client is told to meet the listener's TLS means nothing without
	// the listener terminating any: the server half is what says there is some.
	inbound := buildInbound(t, "trojan", "plain", `{"listen_port": 443}`)
	inbound.OutJson = domain.JSON(`{"tls": {"utls": {"enabled": true, "fingerprint": "chrome"}}}`)
	client := buildClient(t, "alice", "", `{"trojan": {"password": "pw"}}`)

	q := parseLink(t, generate(t, client, inbound, "h")[0]).Query()
	if q.Get("security") != "" || q.Get("fp") != "" {
		t.Errorf("query = %v, want no TLS from a listener that terminates none", q)
	}
}

func TestPrivateKeysNeverReachALink(t *testing.T) {
	// The server half holds the material that must not leave the panel.
	inbound := withTLS(t, buildInbound(t, "vless", "secure", `{"listen_port": 443, "transport": {"type": "tcp"}}`), `{
			"enabled": true,
			"server_name": "a.example.com",
			"key_path": "/etc/ssl/private/a.key",
			"key": "-----BEGIN PRIVATE KEY-----SECRET-----END PRIVATE KEY-----",
			"reality": {"enabled": true, "private_key": "SERVER-PRIVATE", "short_id": ["ab"]}
		}`,
		`{"reality": {"public_key": "PUBKEY"}}`,
	)
	client := buildClient(t, "alice", "", `{"vless": {"uuid": "u"}}`)

	link := generate(t, client, inbound, "h")[0]
	// Only the fields that describe the handshake cross from the server half to
	// the client half. Everything else -- keys, paths -- stays behind.
	for _, secret := range []string{"SECRET", "SERVER-PRIVATE", "/etc/ssl/private/a.key", "PRIVATE KEY"} {
		if strings.Contains(link, secret) {
			t.Errorf("generated link leaks %q: %s", secret, link)
		}
	}
}

func TestOutboundTlsCarriesTheHandshakesTerms(t *testing.T) {
	tls := outboundTLS(
		domain.JSON(`{
			"enabled": true,
			"server_name": "a.example.com",
			"alpn": ["h2"],
			"min_version": "1.2",
			"max_version": "1.3",
			"cipher_suites": ["TLS_AES_128_GCM_SHA256"],
			"handshake_timeout": "5s",
			"certificate": ["-----BEGIN CERTIFICATE-----PUBLIC-----END CERTIFICATE-----"],
			"key": ["-----BEGIN PRIVATE KEY-----SECRET-----END PRIVATE KEY-----"],
			"key_path": "/etc/ssl/private/a.key"
		}`),
		domain.JSON(`{"utls": {"enabled": true, "fingerprint": "chrome"}}`),
	)

	// Both ends agree on the handshake's terms, a spoofed one included, and the
	// client can trust a certificate nobody signed.
	for _, key := range []string{"enabled", "server_name", "alpn", "min_version", "max_version", "cipher_suites", "handshake_timeout", "certificate", "utls"} {
		if _, present := tls[key]; !present {
			t.Errorf("outbound tls = %v, want %q carried", tls, key)
		}
	}
	for _, key := range []string{"key", "key_path"} {
		if _, present := tls[key]; present {
			t.Errorf("outbound tls carries the server's %q", key)
		}
	}
	if encoded := mustJSON(t, tls); strings.Contains(encoded, "SECRET") {
		t.Errorf("outbound tls leaks the private key: %s", encoded)
	}
}

func TestOutboundTlsLeavesTheCertificateToAPin(t *testing.T) {
	tls := outboundTLS(
		domain.JSON(`{"enabled": true, "certificate": ["-----BEGIN CERTIFICATE-----PUBLIC-----END CERTIFICATE-----"]}`),
		domain.JSON(`{"certificate_public_key_sha256": ["pinned"]}`),
	)

	// A client that pins the key has nothing to gain from the certificate.
	if _, present := tls["certificate"]; present {
		t.Error("the certificate was carried beside a pin")
	}
}

func TestOutboundTlsSwitchesRealityAndEchOn(t *testing.T) {
	tls := outboundTLS(
		domain.JSON(`{
			"enabled": true,
			"reality": {"enabled": true, "private_key": "SERVER-PRIVATE", "short_id": ["ab", "cd"]},
			"ech": {"enabled": true, "key": ["ECH-KEY"], "pq_signature_schemes_enabled": true}
		}`),
		domain.JSON(`{"reality": {"public_key": "PUBKEY"}, "ech": {"config": ["ECH-CONFIG"]}}`),
	)

	reality, _ := tls["reality"].(map[string]interface{})
	if reality["enabled"] != true || reality["public_key"] != "PUBKEY" {
		t.Errorf("reality = %v, want it on with the public key", reality)
	}
	// One of the server's short ids, not the list.
	if id := reality["short_id"]; id != "ab" && id != "cd" {
		t.Errorf("short_id = %v, want one of the server's", id)
	}
	ech, _ := tls["ech"].(map[string]interface{})
	if ech["enabled"] != true || ech["pq_signature_schemes_enabled"] != true {
		t.Errorf("ech = %v, want it on with the server's signature schemes", ech)
	}
	if _, present := ech["key"]; present {
		t.Error("the server's ECH key crossed over")
	}
	if encoded := mustJSON(t, tls); strings.Contains(encoded, "SERVER-PRIVATE") {
		t.Errorf("outbound tls leaks the Reality private key: %s", encoded)
	}
}

func TestPublishedAddressesEachProduceALink(t *testing.T) {
	inbound := buildInbound(t, "trojan", "multi", `{"listen_port": 443, "transport": {"type": "tcp"}}`)
	inbound.Addrs = domain.JSON(`[
		{"server": "a.example.com", "server_port": 443, "remark": "-eu"},
		{"server": "b.example.com", "server_port": 8443, "remark": "-us"}
	]`)
	client := buildClient(t, "alice", "AL", `{"trojan": {"password": "pw"}}`)

	links := generate(t, client, inbound, "ignored.example.com")
	if len(links) != 2 {
		t.Fatalf("got %d links, want one per published address: %v", len(links), links)
	}

	first := parseLink(t, links[0])
	second := parseLink(t, links[1])
	if first.Host != "a.example.com:443" || second.Host != "b.example.com:8443" {
		t.Errorf("hosts = %q, %q; want the published addresses, not the request host", first.Host, second.Host)
	}
	if first.Fragment != "AL-multi-eu" || second.Fragment != "AL-multi-us" {
		t.Errorf("fragments = %q, %q; want client, inbound and address names joined", first.Fragment, second.Fragment)
	}
}

func TestPerAddressTlsOverridesDoNotLeakBetweenAddresses(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "trojan", "multi", `{"listen_port": 443, "transport": {"type": "tcp"}}`),
		`{"enabled": true, "server_name": "shared.example.com"}`, "")
	inbound.Addrs = domain.JSON(`[
		{"server": "a.example.com", "server_port": 443, "tls": {"server_name": "a-override.example.com"}},
		{"server": "b.example.com", "server_port": 443}
	]`)
	client := buildClient(t, "alice", "", `{"trojan": {"password": "pw"}}`)

	links := generate(t, client, inbound, "h")
	if len(links) != 2 {
		t.Fatalf("got %d links, want 2", len(links))
	}

	if sni := parseLink(t, links[0]).Query().Get("sni"); sni != "a-override.example.com" {
		t.Errorf("first sni = %q, want the address override", sni)
	}
	// Sharing one map between addresses would have made this the override too.
	if sni := parseLink(t, links[1]).Query().Get("sni"); sni != "shared.example.com" {
		t.Errorf("second sni = %q, want the inbound's own name", sni)
	}
}

func TestAwkwardCredentialsSurvive(t *testing.T) {
	// A password with a space, a #, a % and a non-ASCII character. Formatting a
	// string and parsing it back loses every one of these; building through
	// url.URL escapes them.
	const password = "p ss#w%rd/ü"

	inbound := buildInbound(t, "trojan", "edge", `{"listen_port": 443, "transport": {"type": "tcp"}}`)
	client := buildClient(t, "alice", "", `{"trojan": {"password": "`+password+`"}}`)

	links := generate(t, client, inbound, "h.example.com")
	if len(links) != 1 {
		t.Fatalf("got %d links, want 1", len(links))
	}

	u := parseLink(t, links[0])
	if got := u.User.Username(); got != password {
		t.Errorf("password round-tripped as %q, want %q", got, password)
	}
	if u.Host != "h.example.com:443" {
		t.Errorf("host = %q, want the credential escaping not to disturb it", u.Host)
	}
}

func TestIpv6AddressesAreBracketedInTheAuthority(t *testing.T) {
	inbound := buildInbound(t, "trojan", "v6", `{"listen_port": 443, "transport": {"type": "tcp"}}`)
	inbound.Addrs = domain.JSON(`[{"server": "[2001:db8::1]", "server_port": 443}]`)
	client := buildClient(t, "alice", "", `{"trojan": {"password": "pw"}}`)

	u := parseLink(t, generate(t, client, inbound, "h")[0])
	// Without the brackets the port is unparseable and the link is useless.
	if u.Host != "[2001:db8::1]:443" {
		t.Errorf("host = %q, want a bracketed IPv6 literal", u.Host)
	}
	if u.Hostname() != "2001:db8::1" {
		t.Errorf("hostname = %q, want the bare address", u.Hostname())
	}
}

func TestShadowsocksUsesSip002Userinfo(t *testing.T) {
	inbound := buildInbound(t, "shadowsocks", "ss", `{"listen_port": 8388, "method": "aes-256-gcm"}`)
	client := buildClient(t, "alice", "", `{"shadowsocks": {"password": "userpass"}}`)

	link := generate(t, client, inbound, "h.example.com")[0]
	if !strings.HasPrefix(link, "ss://") {
		t.Fatalf("link = %q, want an ss:// scheme", link)
	}

	encoded := strings.TrimPrefix(link, "ss://")
	encoded = encoded[:strings.Index(encoded, "@")]
	// base64url without padding: standard base64 emits + / and =, which several
	// clients reject outright.
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("userinfo is not base64url without padding: %v", err)
	}
	if string(decoded) != "aes-256-gcm:userpass" {
		t.Errorf("userinfo = %q, want %q", decoded, "aes-256-gcm:userpass")
	}
}

func TestShadowsocks2022CombinesServerAndUserPassword(t *testing.T) {
	inbound := buildInbound(t, "shadowsocks", "ss", `{
		"listen_port": 8388,
		"method": "2022-blake3-aes-128-gcm",
		"password": "serverpass"
	}`)
	// A 2022 method stores its identity under its own key, because the key
	// length differs from the older methods.
	client := buildClient(t, "alice", "", `{"shadowsocks16": {"password": "userpass"}}`)

	link := generate(t, client, inbound, "h")[0]
	encoded := strings.TrimPrefix(link, "ss://")
	encoded = encoded[:strings.Index(encoded, "@")]
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("userinfo is not base64url: %v", err)
	}
	// The session key derives from both, in this order.
	if string(decoded) != "2022-blake3-aes-128-gcm:serverpass:userpass" {
		t.Errorf("userinfo = %q, want the server and user passwords joined", decoded)
	}
}

func TestVmessIsABase64Object(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "vmess", "vm", `{
		"listen_port": 443,
		"transport": {"type": "grpc", "service_name": "GunService"}
	}`), `{"enabled": true, "server_name": "vm.example.com"}`, "")
	client := buildClient(t, "alice", "AL", `{"vmess": {"uuid": "vmess-uuid"}}`)

	link := generate(t, client, inbound, "h.example.com")[0]
	if !strings.HasPrefix(link, "vmess://") {
		t.Fatalf("link = %q, want a vmess:// scheme", link)
	}

	decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(link, "vmess://"))
	if err != nil {
		t.Fatalf("vmess payload is not standard base64: %v", err)
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(decoded, &obj); err != nil {
		t.Fatalf("vmess payload is not JSON: %v", err)
	}

	if obj["id"] != "vmess-uuid" || obj["add"] != "h.example.com" || obj["port"] != "443" {
		t.Errorf("payload = %v, want the uuid, address and port", obj)
	}
	if obj["ps"] != "AL-vm" {
		t.Errorf("ps = %v, want the joined remark", obj["ps"])
	}
	if obj["tls"] != "tls" || obj["sni"] != "vm.example.com" {
		t.Errorf("payload = %v, want TLS reported", obj)
	}
	// vmess has no serviceName field: grpc carries the service name in "path",
	// and a link without it points at the default service and cannot connect.
	if obj["path"] != "GunService" {
		t.Errorf("path = %v, want the grpc service name", obj["path"])
	}
}

func TestMixedInboundOffersBothProtocols(t *testing.T) {
	inbound := buildInbound(t, "mixed", "mix", `{"listen_port": 1080}`)
	client := buildClient(t, "alice", "", `{
		"socks": {"username": "u", "password": "p"},
		"http": {"username": "u", "password": "p"}
	}`)

	links := generate(t, client, inbound, "h.example.com")
	if len(links) != 2 {
		t.Fatalf("got %d links, want one per protocol: %v", len(links), links)
	}
	// One listener speaks both, so the subscriber is handed both rather than
	// being left to guess which one works.
	schemes := map[string]bool{
		parseLink(t, links[0]).Scheme: true,
		parseLink(t, links[1]).Scheme: true,
	}
	if !schemes["socks5"] || !schemes["http"] {
		t.Errorf("schemes = %v, want socks5 and http", schemes)
	}
}

func TestHttpLinkSchemeFollowsEachAddress(t *testing.T) {
	inbound := withTLS(t, buildInbound(t, "http", "h", `{"listen_port": 8080}`), `{"enabled": true}`, "")
	inbound.Addrs = domain.JSON(`[
		{"server": "secure.example.com", "server_port": 443},
		{"server": "plain.example.com", "server_port": 8080}
	]`)
	client := buildClient(t, "alice", "", `{"http": {"username": "u", "password": "p"}}`)

	links := generate(t, client, inbound, "h")
	// Both addresses inherit the inbound's TLS here, so both are https. The
	// point is that the scheme is decided per address rather than latched by
	// the first one that had TLS.
	for _, link := range links {
		if scheme := parseLink(t, link).Scheme; scheme != "https" {
			t.Errorf("scheme = %q, want https for a TLS-terminating address", scheme)
		}
	}
}

func TestHysteriaBandwidthIsReversedForTheClient(t *testing.T) {
	inbound := buildInbound(t, "hysteria2", "hy", `{
		"listen_port": 443,
		"up_mbps": 100,
		"down_mbps": 20,
		"obfs": {"type": "salamander", "password": "obfspw"}
	}`)
	inbound.OutJson = domain.JSON(`{"server_ports": ["443:445", 8443]}`)
	client := buildClient(t, "alice", "", `{"hysteria2": {"password": "pw"}}`)

	q := parseLink(t, generate(t, client, inbound, "h")[0]).Query()
	// The server's upload limit is the client's download limit.
	if q.Get("downmbps") != "100" || q.Get("upmbps") != "20" {
		t.Errorf("bandwidth = up %q / down %q, want them swapped for the client's point of view", q.Get("upmbps"), q.Get("downmbps"))
	}
	if q.Get("obfs") != "salamander" || q.Get("obfs-password") != "obfspw" {
		t.Errorf("obfs = %q/%q, want the type and password", q.Get("obfs"), q.Get("obfs-password"))
	}
	// Port hopping ranges keep their commas: the client parsers expect them
	// unescaped.
	if q.Get("mport") != "443:445,8443" {
		t.Errorf("mport = %q, want the port list joined", q.Get("mport"))
	}
}

func TestMissingOutJsonIsNotAnError(t *testing.T) {
	// An inbound with no out_json is the normal state until an operator sets
	// one. Treating it as a failure produced a subscription that silently came
	// back short.
	inbound := buildInbound(t, "hysteria2", "hy", `{"listen_port": 443}`)
	client := buildClient(t, "alice", "", `{"hysteria2": {"password": "pw"}}`)

	links := generate(t, client, inbound, "h")
	if len(links) != 1 {
		t.Fatalf("got %d links, want 1 even with no out_json", len(links))
	}
	if q := parseLink(t, links[0]).Query(); q.Get("mport") != "" {
		t.Errorf("mport = %q, want it absent", q.Get("mport"))
	}
}

func TestUnreadableInboundIsReported(t *testing.T) {
	inbound := buildInbound(t, "vless", "broken", `{"listen_port": 443}`)
	inbound.Addrs = domain.JSON(`{"not": "a list"}`)
	client := buildClient(t, "alice", "", `{"vless": {"uuid": "u"}}`)

	// Reported rather than returned as an empty list: the caller decides
	// whether to skip this inbound or fail, and either way it is not silent.
	if _, err := GenerateLinks(client, inbound, "h"); err == nil {
		t.Fatal("GenerateLinks accepted an unreadable address list")
	}
}

func TestInboundWithoutLinksProducesNone(t *testing.T) {
	inbound := buildInbound(t, "tun", "tun0", `{"interface_name": "tun0"}`)
	client := buildClient(t, "alice", "", `{}`)

	links := generate(t, client, inbound, "h")
	if len(links) != 0 {
		t.Errorf("got %d links for a tun inbound, want none", len(links))
	}
}

func TestJoinRemark(t *testing.T) {
	if got := joinRemark("AL", "edge"); got != "AL-edge" {
		t.Errorf("joinRemark(AL, edge) = %q, want AL-edge", got)
	}
	// A subscriber with no alias gets the node's own name rather than a link
	// whose title starts with a dash.
	if got := joinRemark("", "edge"); got != "edge" {
		t.Errorf("joinRemark(\"\", edge) = %q, want edge", got)
	}
}

func TestEncodeParamsKeepsCommasWhereClientsExpectThem(t *testing.T) {
	got := encodeParams([]linkParam{
		{"alpn", "h2,http/1.1"},
		{"mport", "443:445,8443"},
		{"sni", "a b.example.com"},
	})
	if !strings.Contains(got, "alpn=h2,http/1.1") {
		t.Errorf("query = %q, want alpn's commas left unescaped", got)
	}
	if !strings.Contains(got, "mport=443:445,8443") {
		t.Errorf("query = %q, want mport's commas left unescaped", got)
	}
	// Everything else is escaped normally.
	if !strings.Contains(got, "sni=a+b.example.com") {
		t.Errorf("query = %q, want sni escaped", got)
	}
}
