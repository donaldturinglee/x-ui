package service

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"

	"gopkg.in/yaml.v3"
)

// clientNode is one dialable node, held in a shape neutral enough to render
// into either client format.
//
// Both formats describe the same thing in different vocabularies, so they are
// built from one enumeration rather than two: otherwise a node that appears in
// the sing-box subscription can quietly go missing from the Clash one.
type clientNode struct {
	Tag        string
	Type       string
	Server     string
	ServerPort int
	// Identity is the subscriber's credentials for this protocol.
	Identity map[string]interface{}
	// Transport, TLS and Options are the inbound's, as the client needs to see
	// them.
	Transport map[string]interface{}
	TLS       map[string]interface{}
	Options   map[string]interface{}
}

// singBoxTemplate is the client-side configuration a subscriber's nodes are
// dropped into: a tun device for the system, a local mixed proxy for
// applications that want one, and a selector over the nodes.
const singBoxTemplate = `{
  "log": {"level": "warn"},
  "dns": {
    "servers": [{"type": "local", "tag": "local"}],
    "rules": []
  },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      "mtu": 9000,
      "auto_route": true,
      "strict_route": false,
      "stack": "system"
    },
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 2080
    }
  ],
  "outbounds": [],
  "route": {
    "rules": [
      {"action": "sniff"},
      {"protocol": ["dns"], "action": "hijack-dns"}
    ],
    "auto_detect_interface": true
  }
}`

// clashTemplate is the equivalent for Clash and Mihomo.
const clashTemplate = `mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
external-controller: 127.0.0.1:9090
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://1.1.1.1/dns-query
    - https://dns.google/dns-query
  fake-ip-filter:
    - "*.lan"
    - "*.local"
    - localhost
rules:
  - GEOIP,private,DIRECT,no-resolve
  - MATCH,Proxy
`

// Group names the selectors added over a subscriber's nodes.
const (
	groupProxy = "Proxy"
	groupAuto  = "Auto"
)

func (s *SubscriptionService) renderSingBox(ctx context.Context, client *domain.Client, host string) (string, error) {
	nodes, err := s.nodes(ctx, client, host)
	if err != nil {
		return "", err
	}

	var config map[string]interface{}
	if err := json.Unmarshal([]byte(singBoxTemplate), &config); err != nil {
		return "", err
	}

	outbounds := make([]interface{}, 0, len(nodes)+4)
	tags := make([]string, 0, len(nodes))
	for i := range nodes {
		outbound := singBoxOutbound(&nodes[i])
		if outbound == nil {
			// A protocol this format cannot express is left out rather than
			// emitted half-formed, which the client would refuse to load.
			continue
		}
		outbounds = append(outbounds, outbound)
		tags = append(tags, nodes[i].Tag)
	}

	// The selectors go last so they can name every node above them. Even with
	// no nodes they are emitted: a configuration whose route rules detour to a
	// tag that does not exist will not load at all.
	outbounds = append(outbounds,
		map[string]interface{}{
			"type": "selector", "tag": groupProxy,
			"outbounds": append(append([]string{}, tags...), groupAuto),
			"default":   groupAuto,
		},
		map[string]interface{}{
			"type": "urltest", "tag": groupAuto,
			"outbounds": orEmptyStrings(tags),
			"url":       "http://www.gstatic.com/generate_204",
			"interval":  "5m",
		},
		map[string]interface{}{"type": "direct", "tag": "direct"},
	)
	config["outbounds"] = outbounds

	if route, ok := config["route"].(map[string]interface{}); ok {
		route["final"] = groupProxy
	}

	rendered, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}
	return string(rendered), nil
}

func (s *SubscriptionService) renderClash(ctx context.Context, client *domain.Client, host string) (string, error) {
	nodes, err := s.nodes(ctx, client, host)
	if err != nil {
		return "", err
	}

	var config map[string]interface{}
	if err := yaml.Unmarshal([]byte(clashTemplate), &config); err != nil {
		return "", err
	}

	proxies := make([]interface{}, 0, len(nodes))
	names := make([]string, 0, len(nodes))
	for i := range nodes {
		proxy := clashProxy(&nodes[i])
		if proxy == nil {
			continue
		}
		proxies = append(proxies, proxy)
		names = append(names, nodes[i].Tag)
	}

	config["proxies"] = proxies
	config["proxy-groups"] = []interface{}{
		map[string]interface{}{
			"name": groupProxy, "type": "select",
			"proxies": append([]string{groupAuto, "DIRECT"}, names...),
		},
		map[string]interface{}{
			"name": groupAuto, "type": "url-test",
			"proxies":  orEmptyStrings(names),
			"url":      "http://www.gstatic.com/generate_204",
			"interval": 300,
		},
	}

	rendered, err := yaml.Marshal(config)
	if err != nil {
		return "", err
	}
	return string(rendered), nil
}

// singBoxOutbound renders one node as a sing-box outbound, or nil when the
// format cannot express it.
func singBoxOutbound(node *clientNode) map[string]interface{} {
	out := map[string]interface{}{
		"tag":         node.Tag,
		"server":      node.Server,
		"server_port": node.ServerPort,
	}

	switch node.Type {
	case "vless":
		out["type"] = "vless"
		out["uuid"] = stringOr(node.Identity["uuid"], "")
		if flow := stringOr(node.Identity["flow"], ""); flow != "" && transportType(node.Transport) == "tcp" {
			out["flow"] = flow
		}
	case "vmess":
		out["type"] = "vmess"
		out["uuid"] = stringOr(node.Identity["uuid"], "")
		out["security"] = "auto"
	case "trojan":
		out["type"] = "trojan"
		out["password"] = stringOr(node.Identity["password"], "")
	case "shadowsocks":
		out["type"] = "shadowsocks"
		out["method"] = stringOr(node.Options["method"], "")
		out["password"] = shadowsocksPassword(node)
	case "hysteria2":
		out["type"] = "hysteria2"
		out["password"] = stringOr(node.Identity["password"], "")
		if obfs, ok := node.Options["obfs"].(map[string]interface{}); ok {
			out["obfs"] = map[string]interface{}{
				"type":     stringOr(obfs["type"], ""),
				"password": stringOr(obfs["password"], ""),
			}
		}
	case "tuic":
		out["type"] = "tuic"
		out["uuid"] = stringOr(node.Identity["uuid"], "")
		out["password"] = stringOr(node.Identity["password"], "")
		if cc := stringOr(node.Options["congestion_control"], ""); cc != "" {
			out["congestion_control"] = cc
		}
	case "anytls":
		out["type"] = "anytls"
		out["password"] = stringOr(node.Identity["password"], "")
	case "naive":
		out["type"] = "naive"
		addUserPassword(out, node.Identity)
		// A listener that speaks QUIC as well is dialled over it, with its
		// congestion control. Only what the listener asks for now goes out, so
		// clearing it there clears it here rather than leaving QUIC switched on.
		if cc := stringOr(node.Options["quic_congestion_control"], ""); cc != "" {
			out["quic"] = true
			out["quic_congestion_control"] = naiveCongestionControl(cc)
		}
	case "snell":
		out["type"] = "snell"
		// Version 6 is dialled as itself, in its mode; the listeners before it
		// answer version 4, with their obfuscation.
		if version, _ := node.Options["version"].(float64); int(version) == 6 {
			out["version"] = 6
			if mode := stringOr(node.Options["mode"], ""); mode != "" {
				out["mode"] = mode
			}
		} else {
			out["version"] = 4
			if obfsMode := stringOr(node.Options["obfs_mode"], ""); obfsMode != "" {
				out["obfs_mode"] = obfsMode
			}
		}
		if psk, ok := node.Options["psk"].(string); ok {
			out["psk"] = psk
		}
		// The subscriber's own key, which a listener with users asks of each.
		if userkey := stringOr(node.Identity["userkey"], ""); userkey != "" {
			out["userkey"] = userkey
		}
	case "socks", "mixed":
		out["type"] = "socks"
		out["version"] = "5"
		addUserPassword(out, node.Identity)
	case "http":
		out["type"] = "http"
		addUserPassword(out, node.Identity)
	default:
		return nil
	}

	if transport := singBoxTransport(node.Transport); transport != nil {
		out["transport"] = transport
	}
	if tls := singBoxTLS(node.TLS); tls != nil {
		out["tls"] = tls
	}
	return out
}

// singBoxTransport passes the transport through with the server-only fields
// removed. Early-data settings in particular are the listener's business and
// mean nothing to a client.
func singBoxTransport(transport map[string]interface{}) map[string]interface{} {
	if transport == nil {
		return nil
	}
	transportType := transportType(transport)
	if transportType == "" || transportType == "tcp" {
		return nil
	}

	out := map[string]interface{}{"type": transportType}
	for _, key := range []string{"path", "host", "headers", "service_name"} {
		if value, ok := transport[key]; ok {
			out[key] = value
		}
	}
	return out
}

// singBoxTLS renders the client half of a listener's TLS, dropping the panel's
// own bookkeeping field.
func singBoxTLS(tls map[string]interface{}) map[string]interface{} {
	if tls == nil || !boolOr(tls["enabled"]) {
		return nil
	}
	out := map[string]interface{}{"enabled": true}
	for key, value := range tls {
		switch key {
		case "enabled", "pinSHA256", "certificate_public_key_sha256":
			// pinSHA256 is computed for the link formats; sing-box expects the
			// certificate itself, not a fingerprint in this field.
		default:
			out[key] = value
		}
	}
	return out
}

// clashProxy renders one node as a Clash proxy, or nil when Clash has no
// equivalent.
func clashProxy(node *clientNode) map[string]interface{} {
	proxy := map[string]interface{}{
		"name":   node.Tag,
		"server": node.Server,
		"port":   node.ServerPort,
		// Clash disables UDP unless a proxy opts in, so without this every node
		// reaches the subscriber with UDP off and nothing says why.
		"udp": true,
	}

	switch node.Type {
	case "vless":
		proxy["type"] = "vless"
		proxy["uuid"] = stringOr(node.Identity["uuid"], "")
		if flow := stringOr(node.Identity["flow"], ""); flow != "" && transportType(node.Transport) == "tcp" {
			proxy["flow"] = flow
		}
	case "vmess":
		proxy["type"] = "vmess"
		proxy["uuid"] = stringOr(node.Identity["uuid"], "")
		proxy["alterId"] = 0
		proxy["cipher"] = "auto"
	case "trojan":
		proxy["type"] = "trojan"
		proxy["password"] = stringOr(node.Identity["password"], "")
	case "shadowsocks":
		proxy["type"] = "ss"
		proxy["cipher"] = stringOr(node.Options["method"], "")
		proxy["password"] = shadowsocksPassword(node)
	case "hysteria2":
		proxy["type"] = "hysteria2"
		proxy["password"] = stringOr(node.Identity["password"], "")
		if obfs, ok := node.Options["obfs"].(map[string]interface{}); ok {
			proxy["obfs"] = stringOr(obfs["type"], "")
			proxy["obfs-password"] = stringOr(obfs["password"], "")
		}
	case "tuic":
		proxy["type"] = "tuic"
		proxy["uuid"] = stringOr(node.Identity["uuid"], "")
		proxy["password"] = stringOr(node.Identity["password"], "")
		if cc := stringOr(node.Options["congestion_control"], ""); cc != "" {
			proxy["congestion-controller"] = cc
		}
	case "anytls":
		proxy["type"] = "anytls"
		proxy["password"] = stringOr(node.Identity["password"], "")
	case "socks", "mixed":
		proxy["type"] = "socks5"
		addClashUserPassword(proxy, node.Identity)
	case "http":
		proxy["type"] = "http"
		addClashUserPassword(proxy, node.Identity)
	default:
		// naive, snell and hysteria v1 have no Clash equivalent worth emitting.
		return nil
	}

	addClashTransport(proxy, node)
	addClashTLS(proxy, node)
	return proxy
}

func addClashTransport(proxy map[string]interface{}, node *clientNode) {
	switch transportType(node.Transport) {
	case "ws":
		proxy["network"] = "ws"
		opts := map[string]interface{}{}
		if path := stringOr(node.Transport["path"], ""); path != "" {
			opts["path"] = path
		}
		if headers, ok := node.Transport["headers"].(map[string]interface{}); ok && len(headers) > 0 {
			opts["headers"] = headers
		}
		if len(opts) > 0 {
			proxy["ws-opts"] = opts
		}
	case "grpc":
		proxy["network"] = "grpc"
		if name := stringOr(node.Transport["service_name"], ""); name != "" {
			proxy["grpc-opts"] = map[string]interface{}{"grpc-service-name": name}
		}
	case "http":
		proxy["network"] = "http"
	case "httpupgrade":
		proxy["network"] = "http"
	}
}

func addClashTLS(proxy map[string]interface{}, node *clientNode) {
	tls := node.TLS
	if tls == nil || !boolOr(tls["enabled"]) {
		return
	}

	// hysteria2, tuic and anytls are TLS by definition; saying so again is
	// what makes some Clash builds reject the proxy.
	switch node.Type {
	case "hysteria2", "tuic", "anytls":
	default:
		proxy["tls"] = true
	}

	if sni := stringOr(tls["server_name"], ""); sni != "" {
		proxy["servername"] = sni
		if node.Type == "hysteria2" || node.Type == "tuic" || node.Type == "anytls" {
			proxy["sni"] = sni
			delete(proxy, "servername")
		}
	}
	if boolOr(tls["insecure"]) {
		proxy["skip-cert-verify"] = true
	}
	if alpn := stringList(tls["alpn"]); len(alpn) > 0 {
		proxy["alpn"] = alpn
	}
	if utls, ok := tls["utls"].(map[string]interface{}); ok {
		if fingerprint := stringOr(utls["fingerprint"], ""); fingerprint != "" {
			proxy["client-fingerprint"] = fingerprint
		}
	}
	if reality, ok := tls["reality"].(map[string]interface{}); ok && boolOr(reality["enabled"]) {
		opts := map[string]interface{}{}
		if pbk := stringOr(reality["public_key"], ""); pbk != "" {
			opts["public-key"] = pbk
		}
		if sid := stringOr(reality["short_id"], ""); sid != "" {
			opts["short-id"] = sid
		}
		proxy["reality-opts"] = opts
	}
}

// naiveCongestionControl names a listener's QUIC congestion control as a naive
// client knows it: the listener's two BBR variants are the client's bbr and
// bbr2.
func naiveCongestionControl(name string) string {
	switch name {
	case "bbr_standard":
		return "bbr"
	case "bbr2_variant":
		return "bbr2"
	}
	return name
}

// shadowsocksPassword joins the server and user passwords for a 2022 method,
// which derives its session key from both.
func shadowsocksPassword(node *clientNode) string {
	userPassword := stringOr(node.Identity["password"], "")
	method := stringOr(node.Options["method"], "")
	if !strings.HasPrefix(method, "2022") {
		return userPassword
	}
	return stringOr(node.Options["password"], "") + ":" + userPassword
}

func addUserPassword(out map[string]interface{}, identity map[string]interface{}) {
	if username := stringOr(identity["username"], ""); username != "" {
		out["username"] = username
	}
	if password := stringOr(identity["password"], ""); password != "" {
		out["password"] = password
	}
}

func addClashUserPassword(proxy map[string]interface{}, identity map[string]interface{}) {
	if username := stringOr(identity["username"], ""); username != "" {
		proxy["username"] = username
	}
	if password := stringOr(identity["password"], ""); password != "" {
		proxy["password"] = password
	}
}

func transportType(transport map[string]interface{}) string {
	if transport == nil {
		return "tcp"
	}
	return stringOr(transport["type"], "tcp")
}

// orEmptyStrings keeps an empty list rendering as [] rather than null, which
// both formats read as a missing key.
func orEmptyStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
