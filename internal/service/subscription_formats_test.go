package service

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"

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

func TestClashHTTPUpgradePreservesPathHostAndHeaders(t *testing.T) {
	node := vlessNode()
	headers := map[string]interface{}{"Host": "old.example", "X-Test": "value"}
	node.Transport = map[string]interface{}{"type": "httpupgrade", "host": "upgrade.example", "path": "/upgrade", "headers": headers}
	proxy := clashProxy(node)
	opts, ok := proxy["ws-opts"].(map[string]interface{})
	if !ok || proxy["network"] != "ws" || opts["v2ray-http-upgrade"] != true || opts["path"] != "/upgrade" {
		t.Fatalf("HTTPUpgrade = %v, want WebSocket options with upgrade enabled", proxy)
	}
	got := opts["headers"].(map[string]interface{})
	if got["Host"] != "upgrade.example" || got["X-Test"] != "value" || headers["Host"] != "old.example" {
		t.Fatalf("headers = %v, source = %v", got, headers)
	}
}

func TestClashHTTPTransportUsesTheListenerTLSAndRequestOptions(t *testing.T) {
	node := vlessNode()
	node.Transport = map[string]interface{}{
		"type": "http", "host": "http.example", "path": "/http", "method": "GET",
		"headers": map[string]interface{}{"X-Test": "value"},
	}
	node.TLS = nil
	proxy := clashProxy(node)
	opts := proxy["http-opts"].(map[string]interface{})
	if proxy["network"] != "http" || opts["method"] != "GET" || !reflect.DeepEqual(opts["path"], []string{"/http"}) {
		t.Fatalf("plain HTTP = %v", proxy)
	}
	headers := opts["headers"].(map[string]interface{})
	if !reflect.DeepEqual(headers["Host"], []string{"http.example"}) || !reflect.DeepEqual(headers["X-Test"], []string{"value"}) {
		t.Fatalf("HTTP headers = %v", headers)
	}
	node.TLS = map[string]interface{}{"enabled": true}
	proxy = clashProxy(node)
	opts = proxy["h2-opts"].(map[string]interface{})
	if proxy["network"] != "h2" || opts["path"] != "/http" || !reflect.DeepEqual(opts["host"], []string{"http.example"}) {
		t.Fatalf("HTTP over TLS = %v", proxy)
	}
}

func TestClashSkipsUnrepresentableTransportsAndRefusesEmptyConfigurations(t *testing.T) {
	node := vlessNode()
	node.Transport = map[string]interface{}{"type": "quic"}
	if proxy := clashProxy(node); proxy != nil {
		t.Fatalf("unsupported transport = %v", proxy)
	}
	for _, nodes := range [][]clientNode{nil, {*node}, {{Type: "naive"}, {Type: "snell"}, {Type: "hysteria"}}} {
		body, err := renderClashNodes(nodes)
		if body != "" || !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("empty subscription = %q, %v", body, err)
		}
	}
}

func TestClashRenderedConfiguration(t *testing.T) {
	var nodes []clientNode
	for _, transport := range []string{"tcp", "ws", "grpc", "httpupgrade", "http"} {
		node := vlessNode()
		node.Tag = transport
		node.Transport = map[string]interface{}{"type": transport, "path": "/proxy", "host": "edge.example.com", "service_name": "service"}
		node.Identity = map[string]interface{}{"uuid": "11111111-2222-3333-4444-555555555555"}
		nodes = append(nodes, *node)
	}
	body, err := renderClashNodes(nodes)
	if err != nil {
		t.Fatal(err)
	}
	var rendered struct {
		DNS struct {
			DefaultNameserver            []string `yaml:"default-nameserver"`
			ProxyServerNameserver        []string `yaml:"proxy-server-nameserver"`
			Nameserver                   []string
			Fallback                     []string
			DirectNameserver             []string            `yaml:"direct-nameserver"`
			DirectNameserverFollowPolicy bool                `yaml:"direct-nameserver-follow-policy"`
			NameserverPolicy             map[string][]string `yaml:"nameserver-policy"`
			FakeIPFilterMode             string              `yaml:"fake-ip-filter-mode"`
			FakeIPFilter                 []string            `yaml:"fake-ip-filter"`
		}
		Proxies []struct{ Name string }
		Groups  []struct {
			Name     string
			Type     string
			Proxies  []string
			URL      *string `yaml:"url"`
			Interval *int    `yaml:"interval"`
		} `yaml:"proxy-groups"`
		RuleProviders map[string]struct {
			Type, Behavior, Format, URL, Path string
			Interval                          int
		} `yaml:"rule-providers"`
		Rules []string
	}
	if err := yaml.Unmarshal([]byte(body), &rendered); err != nil {
		t.Fatal(err)
	}
	if len(rendered.Proxies) != len(nodes) || len(rendered.Groups) != 1 {
		t.Fatalf("invalid rendered configuration: %+v", rendered)
	}
	group := rendered.Groups[0]
	if group.Name != "PROXY" || group.Type != "select" {
		t.Errorf("proxy group = %+v, want the PROXY select group", group)
	}
	wantProxies := []string{"tcp", "ws", "grpc", "httpupgrade", "http", "DIRECT"}
	if !reflect.DeepEqual(group.Proxies, wantProxies) {
		t.Errorf("group proxies = %v, want nodes in order followed by DIRECT: %v", group.Proxies, wantProxies)
	}
	if group.URL != nil || group.Interval != nil {
		t.Errorf("proxy group contains health check settings: %+v", group)
	}
	if len(rendered.DNS.Nameserver) == 0 {
		t.Error("nameserver is missing the remote DNS resolvers")
	}
	for _, resolver := range rendered.DNS.Nameserver {
		if !strings.HasSuffix(resolver, "#"+group.Name) {
			t.Errorf("nameserver resolver %q does not use the rendered proxy group %q", resolver, group.Name)
		}
	}
	if rendered.DNS.Fallback == nil || len(rendered.DNS.Fallback) != 0 {
		t.Errorf("fallback = %v, want an explicit empty list", rendered.DNS.Fallback)
	}
	if !reflect.DeepEqual(rendered.DNS.DefaultNameserver, []string{"system"}) {
		t.Errorf("default DNS resolvers = %v, want only the system resolver", rendered.DNS.DefaultNameserver)
	}
	if !reflect.DeepEqual(rendered.DNS.ProxyServerNameserver, []string{"system"}) {
		t.Errorf("proxy server DNS resolvers = %v, want only the system resolver", rendered.DNS.ProxyServerNameserver)
	}
	if !rendered.DNS.DirectNameserverFollowPolicy {
		t.Error("direct DNS resolution does not follow the domain policies")
	}
	if !reflect.DeepEqual(rendered.DNS.DirectNameserver, []string{"system"}) {
		t.Errorf("direct DNS resolvers = %v, want local resolution by default", rendered.DNS.DirectNameserver)
	}
	wantPolicies := map[string][]string{
		"localhost":               {"system"},
		"+.lan":                   {"system"},
		"+.local":                 {"system"},
		"rule-set:reject":         {"rcode://success"},
		"rule-set:private,direct": {"system"},
	}
	if !reflect.DeepEqual(rendered.DNS.NameserverPolicy, wantPolicies) {
		t.Errorf("nameserver policies = %v, want local and direct domains resolved locally and rejected domains answered with an empty success response: %v", rendered.DNS.NameserverPolicy, wantPolicies)
	}
	if rendered.DNS.FakeIPFilterMode != "blacklist" {
		t.Errorf("fake IP filter mode = %q, want blacklist", rendered.DNS.FakeIPFilterMode)
	}
	for _, pattern := range []string{"rule-set:reject", "rule-set:private"} {
		if !slices.Contains(rendered.DNS.FakeIPFilter, pattern) {
			t.Errorf("fake IP filter is missing %q, which must use the real DNS policies", pattern)
		}
	}
	for _, resolver := range []string{"223.5.5.5", "119.29.29.29", "https://dns.alidns.com/dns-query", "https://doh.pub/dns-query"} {
		if strings.Contains(body, resolver) {
			t.Errorf("subscription still contains the removed DNS resolver %q", resolver)
		}
	}
	wantProviders := map[string]struct{ Behavior, File, Path string }{
		"reject":  {"domain", "geosite/category-ads-all.mrs", "./providers/reject.mrs"},
		"direct":  {"domain", "geosite/cn.mrs", "./providers/direct.mrs"},
		"private": {"domain", "geosite/private.mrs", "./providers/private.mrs"},
		"proxy":   {"domain", "geosite/geolocation-!cn.mrs", "./providers/proxy.mrs"},
		"lancidr": {"ipcidr", "geoip/private.mrs", "./providers/lancidr.mrs"},
	}
	if len(rendered.RuleProviders) != len(wantProviders) {
		t.Fatalf("rule providers = %v, want the five routing rule providers", rendered.RuleProviders)
	}
	for name, want := range wantProviders {
		provider, present := rendered.RuleProviders[name]
		if !present {
			t.Errorf("missing %s rule provider", name)
			continue
		}
		if provider.Type != "http" || provider.Behavior != want.Behavior || provider.Format != "mrs" {
			t.Errorf("%s provider = %+v, want an HTTP %s MRS rule provider", name, provider, want.Behavior)
		}
		wantURL := "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/" + want.File
		if provider.URL != wantURL || provider.Path != want.Path || provider.Interval != 86400 {
			t.Errorf("%s provider = %+v, want %s cached at %s and updated daily", name, provider, wantURL, want.Path)
		}
	}
	wantRules := []string{
		"DOMAIN,localhost,DIRECT",
		"DOMAIN-SUFFIX,lan,DIRECT",
		"DOMAIN-SUFFIX,local,DIRECT",
		"RULE-SET,reject,REJECT",
		"RULE-SET,private,DIRECT",
		"RULE-SET,lancidr,DIRECT",
		"RULE-SET,direct,DIRECT",
		"RULE-SET,proxy,PROXY",
		"GEOIP,CN,DIRECT",
		"MATCH,PROXY",
	}
	if !reflect.DeepEqual(rendered.Rules, wantRules) {
		t.Errorf("rules = %v, want local exceptions, reject, private, LAN, direct, proxy, China IPs and the final match in order: %v", rendered.Rules, wantRules)
	}
	// An installed Mihomo can validate the exact document, without starting a
	// listener or contacting any of the example proxy servers.
	if binary := os.Getenv("X_UI_TEST_MIHOMO"); binary != "" {
		directory := t.TempDir()
		if dataDir := os.Getenv("X_UI_TEST_MIHOMO_DATA_DIR"); dataDir != "" {
			dataFiles := []string{"geoip.metadb", "Country.mmdb", "geoip.dat", "geosite.dat"}
			for _, provider := range rendered.RuleProviders {
				dataFiles = append(dataFiles, provider.Path)
			}
			for _, name := range dataFiles {
				if data, err := os.ReadFile(filepath.Join(dataDir, name)); err == nil {
					path := filepath.Join(directory, name)
					if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, data, 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
		path := filepath.Join(directory, "subscription.yaml")
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if output, err := exec.Command(binary, "-t", "-d", directory, "-f", path).CombinedOutput(); err != nil {
			t.Fatalf("Mihomo rejected the subscription: %v\n%s", err, output)
		}
	}
}

func TestClashRenderedFormatting(t *testing.T) {
	node := vlessNode()
	node.Tag = "cus_UI2rxLzuMbqUTM_US_01"
	body, err := renderClashNodes([]clientNode{*node})
	if err != nil {
		t.Fatal(err)
	}
	wantGroup := `proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - cus_UI2rxLzuMbqUTM_US_01
      - DIRECT
`
	if !strings.Contains(body, wantGroup) {
		t.Fatalf("subscription does not contain the group in display order with two-space indentation:\n%s", body)
	}
	wantPolicies := `  nameserver-policy:
    "localhost":
      - system
    "+.lan":
      - system
    "+.local":
      - system
    "rule-set:reject":
      - rcode://success
    "rule-set:private,direct":
      - system
`
	if !strings.Contains(body, wantPolicies) {
		t.Errorf("subscription does not preserve local DNS exceptions before rejection and direct policies with two-space indentation:\n%s", body)
	}
	wantRules := `rules:
  - DOMAIN,localhost,DIRECT
  - DOMAIN-SUFFIX,lan,DIRECT
  - DOMAIN-SUFFIX,local,DIRECT
  - RULE-SET,reject,REJECT
  - RULE-SET,private,DIRECT
  - RULE-SET,lancidr,DIRECT
  - RULE-SET,direct,DIRECT
  - RULE-SET,proxy,PROXY
  - GEOIP,CN,DIRECT
  - MATCH,PROXY
`
	if !strings.Contains(body, wantRules) {
		t.Errorf("subscription does not contain the rules with two-space indentation:\n%s", body)
	}
	if !strings.Contains(body, "rule-providers:\n") || !strings.Contains(body, "\n    path: ./providers/lancidr.mrs\n") {
		t.Errorf("subscription does not contain the rule providers with two-space indentation:\n%s", body)
	}
	for _, name := range []string{"reject", "direct", "private", "proxy", "lancidr"} {
		if !strings.Contains(body, "\n  "+name+":\n") {
			t.Errorf("subscription does not contain the %s rule provider with two-space indentation:\n%s", name, body)
		}
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
	providers, ok := config["rule-providers"].(map[string]interface{})
	if !ok {
		t.Fatalf("rule-providers = %v, want an object", config["rule-providers"])
	}
	for _, name := range []string{"reject", "direct", "private", "proxy", "lancidr"} {
		if _, present := providers[name]; !present {
			t.Errorf("rule references a missing %s provider", name)
		}
	}
	// Local exceptions and rejection precede domain routing, China IPs and the final PROXY rule.
	rules, ok := config["rules"].([]interface{})
	wantRules := []string{
		"DOMAIN,localhost,DIRECT",
		"DOMAIN-SUFFIX,lan,DIRECT",
		"DOMAIN-SUFFIX,local,DIRECT",
		"RULE-SET,reject,REJECT",
		"RULE-SET,private,DIRECT",
		"RULE-SET,lancidr,DIRECT",
		"RULE-SET,direct,DIRECT",
		"RULE-SET,proxy,PROXY",
		"GEOIP,CN,DIRECT",
		"MATCH," + groupProxy,
	}
	if !ok || len(rules) != len(wantRules) {
		t.Fatalf("rules = %v, want the five routing rule sets between local exceptions and the China IP and match rules", config["rules"])
	}
	for i, want := range wantRules {
		if rule, _ := rules[i].(string); rule != want {
			t.Errorf("rule %d = %q, want %q", i, rule, want)
		}
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
	for _, test := range []struct {
		name string
		want string
	}{
		{"PROXY", "PROXY-2"},
		{"AUTO", "AUTO-2"},
		{"Proxy", "Proxy"},
		{"Auto", "Auto"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := uniqueTag(test.name, nodeNames()); got != test.want {
				t.Errorf("uniqueTag(%q) = %q, want %q", test.name, got, test.want)
			}
		})
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
