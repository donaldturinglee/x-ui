package service

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"strings"
)

// linkParam is one query parameter of a generated link. A slice rather than a
// map: the order is what a subscriber sees, and several client applications
// still parse these positionally.
type linkParam struct {
	Key   string
	Value string
}

func socksLinks(identity map[string]interface{}, addrs []inboundAddress) []string {
	user := stringOr(identity["username"], "")
	pass := stringOr(identity["password"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		links = append(links, linkURL("socks5", url.UserPassword(user, pass), addr, nil))
	}
	return links
}

func httpLinks(identity map[string]interface{}, addrs []inboundAddress) []string {
	user := stringOr(identity["username"], "")
	pass := stringOr(identity["password"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		// Decided per address rather than once: an inbound published on both a
		// TLS edge and a plain origin needs a different scheme for each.
		scheme := "http"
		if addr.TLS != nil {
			scheme = "https"
		}
		links = append(links, linkURL(scheme, url.UserPassword(user, pass), addr, nil))
	}
	return links
}

func shadowsocksLinks(
	identities map[string]map[string]interface{},
	options map[string]interface{},
	outJSON map[string]interface{},
	addrs []inboundAddress) []string {

	method := stringOr(options["method"], "")

	// A 2022 method derives the session key from the server password and the
	// user password together, so both go into the userinfo, in that order.
	var passwords []string
	if strings.HasPrefix(method, "2022") {
		passwords = append(passwords, stringOr(options["password"], ""))
	}
	passwords = append(passwords, stringOr(identities[shadowsocksIdentityKey(method)]["password"], ""))

	// SIP002 specifies base64url without padding. Standard base64 emits + / and
	// =, which several clients reject outright.
	userInfo := base64.RawURLEncoding.EncodeToString([]byte(method + ":" + strings.Join(passwords, ":")))

	plugin := stringOr(outJSON["plugin"], "")
	pluginOpts := stringOr(outJSON["plugin_opts"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var params []linkParam
		if plugin != "" {
			value := plugin
			if pluginOpts != "" {
				value += ";" + pluginOpts
			}
			params = append(params, linkParam{"plugin", value})
		}
		// Built through url.URL so a remark containing a space or a # is
		// escaped rather than concatenated into the fragment.
		u := url.URL{
			Scheme:   "ss",
			Host:     authority(addr),
			Fragment: addr.Remark,
			RawQuery: encodeParams(params),
		}
		// url.URL would re-escape an already-encoded userinfo, so the SIP002
		// blob is spliced in after the scheme instead.
		links = append(links, strings.Replace(u.String(), "ss://", "ss://"+userInfo+"@", 1))
	}
	return links
}

// shadowsocksIdentityKey names the stored identity for a method. The 2022
// variants use a different key length, so a client carries one of each.
func shadowsocksIdentityKey(method string) string {
	if method == "2022-blake3-aes-128-gcm" {
		return "shadowsocks16"
	}
	return "shadowsocks"
}

func naiveLinks(identity map[string]interface{}, options map[string]interface{}, addrs []inboundAddress) []string {
	username := stringOr(identity["username"], "")
	password := stringOr(identity["password"], "")

	var links []string
	for _, addr := range addrs {
		params := []linkParam{{"padding", "1"}}
		if addr.TLS != nil {
			if sni := stringOr(addr.TLS["server_name"], ""); sni != "" {
				params = append(params, linkParam{"peer", sni})
			}
			if alpn := alpnList(addr.TLS["alpn"]); alpn != "" {
				params = append(params, linkParam{"alpn", alpn})
			}
			if boolOr(addr.TLS["insecure"]) {
				params = append(params, linkParam{"insecure", "1"})
			}
		}
		params = append(params, linkParam{"tfo", boolParam(options["tcp_fast_open"])})

		// Two shapes, because the clients disagree: naive's own base64 form,
		// and the scheme form other applications import.
		credentials := fmt.Sprintf("%s:%s@%s", username, password, authority(addr))
		links = append(links, addParams("http2://"+toBase64([]byte(credentials)), params, addr.Remark))

		for _, scheme := range naiveSchemes(stringOr(options["network"], "")) {
			links = append(links, linkURL(scheme, url.UserPassword(username, password), addr, params))
		}
	}
	return links
}

// naiveSchemes are the transports a naive inbound can be dialled over. An
// inbound bound to one network only advertises that one.
func naiveSchemes(network string) []string {
	switch network {
	case "tcp":
		return []string{"naive+https"}
	case "udp":
		return []string{"naive+quic"}
	default:
		return []string{"naive+https", "naive+quic"}
	}
}

func hysteriaLinks(
	identity map[string]interface{},
	options map[string]interface{},
	outJSON map[string]interface{},
	addrs []inboundAddress) []string {

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var params []linkParam
		// Reversed on purpose: the server's upload limit is the client's
		// download limit.
		if up, ok := options["up_mbps"].(float64); ok {
			params = append(params, linkParam{"downmbps", fmt.Sprintf("%.0f", up)})
		}
		if down, ok := options["down_mbps"].(float64); ok {
			params = append(params, linkParam{"upmbps", fmt.Sprintf("%.0f", down)})
		}
		if auth := stringOr(identity["auth_str"], ""); auth != "" {
			params = append(params, linkParam{"auth", auth})
		}
		if addr.TLS != nil {
			appendTLSParams(&params, addr.TLS, "hysteria")
		}
		if obfs := stringOr(options["obfs"], ""); obfs != "" {
			params = append(params, linkParam{"obfs", obfs})
		}
		params = append(params, linkParam{"fastopen", boolParam(options["tcp_fast_open"])})
		if ports := portHopping(outJSON); ports != "" {
			params = append(params, linkParam{"mport", ports})
		}

		links = append(links, linkURL("hysteria", nil, addr, params))
	}
	return links
}

func hysteria2Links(
	identity map[string]interface{},
	options map[string]interface{},
	outJSON map[string]interface{},
	addrs []inboundAddress) []string {

	password := stringOr(identity["password"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var params []linkParam
		if up, ok := options["up_mbps"].(float64); ok {
			params = append(params, linkParam{"downmbps", fmt.Sprintf("%.0f", up)})
		}
		if down, ok := options["down_mbps"].(float64); ok {
			params = append(params, linkParam{"upmbps", fmt.Sprintf("%.0f", down)})
		}
		if addr.TLS != nil {
			appendTLSParams(&params, addr.TLS, "hysteria2")
		}
		if obfs, ok := options["obfs"].(map[string]interface{}); ok {
			if obfsType := stringOr(obfs["type"], ""); obfsType != "" {
				params = append(params, linkParam{"obfs", obfsType})
			}
			if obfsPassword := stringOr(obfs["password"], ""); obfsPassword != "" {
				params = append(params, linkParam{"obfs-password", obfsPassword})
			}
		}
		params = append(params, linkParam{"fastopen", boolParam(options["tcp_fast_open"])})
		if ports := portHopping(outJSON); ports != "" {
			params = append(params, linkParam{"mport", ports})
		}

		links = append(links, linkURL("hysteria2", url.User(password), addr, params))
	}
	return links
}

func anytlsLinks(identity map[string]interface{}, addrs []inboundAddress) []string {
	password := stringOr(identity["password"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var params []linkParam
		if addr.TLS != nil {
			appendTLSParams(&params, addr.TLS, "anytls")
		}
		links = append(links, linkURL("anytls", url.User(password), addr, params))
	}
	return links
}

func tuicLinks(
	identity map[string]interface{},
	options map[string]interface{},
	outJSON map[string]interface{},
	addrs []inboundAddress) []string {

	uuid := stringOr(identity["uuid"], "")
	password := stringOr(identity["password"], "")

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var params []linkParam
		if addr.TLS != nil {
			appendTLSParams(&params, addr.TLS, "tuic")
		}
		if cc := stringOr(options["congestion_control"], ""); cc != "" {
			params = append(params, linkParam{"congestion_control", cc})
		}
		// A client-side choice, so it lives in out_json rather than in the
		// listener's own options.
		if mode := stringOr(outJSON["udp_relay_mode"], ""); mode != "" {
			params = append(params, linkParam{"udp_relay_mode", mode})
		}

		links = append(links, linkURL("tuic", url.UserPassword(uuid, password), addr, params))
	}
	return links
}

func vlessLinks(identity map[string]interface{}, options map[string]interface{}, addrs []inboundAddress) []string {
	uuid := stringOr(identity["uuid"], "")
	base := transportParams(options["transport"])
	// flow is only meaningful over raw TCP; advertising it on a websocket or
	// grpc transport makes clients refuse the link.
	overTCP := len(base) == 1 && base[0].Value == "tcp"

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		params := append([]linkParam(nil), base...)
		if addr.TLS != nil && boolOr(addr.TLS["enabled"]) {
			appendTLSParams(&params, addr.TLS, "vless")
			if flow := stringOr(identity["flow"], ""); flow != "" && overTCP {
				params = append(params, linkParam{"flow", flow})
			}
		}
		links = append(links, linkURL("vless", url.User(uuid), addr, params))
	}
	return links
}

func trojanLinks(identity map[string]interface{}, options map[string]interface{}, addrs []inboundAddress) []string {
	password := stringOr(identity["password"], "")
	base := transportParams(options["transport"])

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		params := append([]linkParam(nil), base...)
		if addr.TLS != nil && boolOr(addr.TLS["enabled"]) {
			appendTLSParams(&params, addr.TLS, "trojan")
		}
		links = append(links, linkURL("trojan", url.User(password), addr, params))
	}
	return links
}

// vmessLinks builds the one protocol that is not a URI with a query string:
// vmess carries a base64-encoded JSON object instead, with its own field names.
func vmessLinks(identity map[string]interface{}, options map[string]interface{}, addrs []inboundAddress) []string {
	uuid := stringOr(identity["uuid"], "")

	var network, headerType, host, path string
	for _, p := range transportParams(options["transport"]) {
		switch p.Key {
		case "type":
			network = p.Value
		case "host":
			host = p.Value
		case "path":
			path = p.Value
		case "serviceName":
			// The vmess object has no serviceName field: grpc carries the
			// service name in "path". Dropping it points every grpc link at the
			// default service, where it simply does not connect.
			if path == "" {
				path = p.Value
			}
		}
	}

	links := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		obj := map[string]interface{}{
			"v":    "2",
			"id":   uuid,
			"aid":  0,
			"add":  addr.Server,
			"port": fmt.Sprintf("%d", addr.ServerPort),
			"ps":   addr.Remark,
		}
		// vmess knows no "http" network: it is tcp carrying an http header.
		if network == "http" || network == "tcp" {
			obj["net"] = "tcp"
			if network == "http" {
				headerType = "http"
			}
		} else {
			obj["net"] = network
		}
		if headerType != "" {
			obj["type"] = headerType
		}
		if host != "" {
			obj["host"] = host
		}
		if path != "" {
			obj["path"] = path
		}
		appendVmessTLS(obj, addr.TLS)

		encoded, err := json.Marshal(obj)
		if err != nil {
			continue
		}
		links = append(links, "vmess://"+toBase64(encoded))
	}
	return links
}

func appendVmessTLS(obj map[string]interface{}, tls map[string]interface{}) {
	if tls == nil || !boolOr(tls["enabled"]) {
		obj["tls"] = "none"
		return
	}

	obj["tls"] = "tls"
	var params []linkParam
	appendTLSParams(&params, tls, "vmess")
	for _, p := range params {
		switch p.Key {
		case "security":
			// Already said by the "tls" field above.
		case "allowInsecure":
			obj["allowInsecure"] = 1
		case "sni", "fp", "alpn":
			obj[p.Key] = p.Value
		}
	}
}

// transportParams renders the transport half of a link's query.
func transportParams(raw interface{}) []linkParam {
	transport, _ := raw.(map[string]interface{})
	transportType := stringOr(transport["type"], "tcp")

	params := []linkParam{{"type", transportType}}
	if transportType == "tcp" {
		return params
	}

	switch transportType {
	case "http":
		if hosts := stringList(transport["host"]); len(hosts) > 0 {
			params = append(params, linkParam{"host", strings.Join(hosts, ",")})
		}
		if path := stringOr(transport["path"], ""); path != "" {
			params = append(params, linkParam{"path", path})
		}
	case "ws":
		if path := stringOr(transport["path"], ""); path != "" {
			params = append(params, linkParam{"path", websocketPath(transport, path)})
		}
		if headers, ok := transport["headers"].(map[string]interface{}); ok {
			if host := stringOr(headers["Host"], ""); host != "" {
				params = append(params, linkParam{"host", host})
			}
		}
	case "grpc":
		if name := stringOr(transport["service_name"], ""); name != "" {
			params = append(params, linkParam{"serviceName", name})
		}
	case "httpupgrade":
		if host := stringOr(transport["host"], ""); host != "" {
			params = append(params, linkParam{"host", host})
		}
		if path := stringOr(transport["path"], ""); path != "" {
			params = append(params, linkParam{"path", path})
		}
	}
	return params
}

// websocketPath appends the early-data marker clients expect in the path, but
// only for the header name that carries it -- any other header name means the
// server is not reading early data from the path at all.
func websocketPath(transport map[string]interface{}, path string) string {
	maxEarlyData, ok := transport["max_early_data"].(float64)
	if !ok || maxEarlyData <= 0 {
		return path
	}
	if stringOr(transport["early_data_header_name"], "") != "Sec-WebSocket-Protocol" {
		return path
	}
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return fmt.Sprintf("%s%sed=%d", path, separator, int(maxEarlyData))
}

// appendTLSParams renders the TLS half of a link's query. protocol selects the
// parameter names, which differ between client families for the same idea.
func appendTLSParams(params *[]linkParam, tls map[string]interface{}, protocol string) {
	if reality, ok := tls["reality"].(map[string]interface{}); ok && boolOr(reality["enabled"]) {
		*params = append(*params, linkParam{"security", "reality"})
		if pbk := stringOr(reality["public_key"], ""); pbk != "" {
			*params = append(*params, linkParam{"pbk", pbk})
		}
		if sid := stringOr(reality["short_id"], ""); sid != "" {
			*params = append(*params, linkParam{"sid", sid})
		}
	} else {
		*params = append(*params, linkParam{"security", "tls"})
		if boolOr(tls["insecure"]) {
			*params = append(*params, linkParam{insecureKeyFor(protocol), "1"})
		}
		if pin := stringOr(tls["pinSHA256"], ""); pin != "" {
			*params = append(*params, linkParam{pinKeyFor(protocol), pin})
		}
		if boolOr(tls["disable_sni"]) {
			*params = append(*params, linkParam{"disable_sni", "1"})
		}
	}
	if utls, ok := tls["utls"].(map[string]interface{}); ok {
		if fingerprint := stringOr(utls["fingerprint"], ""); fingerprint != "" {
			*params = append(*params, linkParam{"fp", fingerprint})
		}
	}
	if sni := stringOr(tls["server_name"], ""); sni != "" {
		*params = append(*params, linkParam{"sni", sni})
	}
	if alpn := alpnList(tls["alpn"]); alpn != "" {
		*params = append(*params, linkParam{"alpn", alpn})
	}
}

func insecureKeyFor(protocol string) string {
	switch protocol {
	case "vless", "trojan", "vmess":
		return "allowInsecure"
	}
	return "insecure"
}

func pinKeyFor(protocol string) string {
	switch protocol {
	case "hysteria", "hysteria2":
		return "pinSHA256"
	}
	return "pcs"
}

// portHopping renders the multi-port range a hysteria client rotates through.
//
// The ports arrive as numbers when they are single ports and as strings when
// they are ranges, so both are handled; an inbound with no out_json at all is
// the normal state and produces nothing rather than failing.
func portHopping(outJSON map[string]interface{}) string {
	ports, ok := outJSON["server_ports"].([]interface{})
	if !ok || len(ports) == 0 {
		return ""
	}
	list := make([]string, 0, len(ports))
	for _, value := range ports {
		switch port := value.(type) {
		case string:
			list = append(list, port)
		case float64:
			list = append(list, fmt.Sprintf("%.0f", port))
		}
	}
	return strings.Join(list, ",")
}

// linkURL assembles a link from its parts rather than formatting a string and
// parsing it back.
//
// Building through url.URL is what makes a password containing a space, a %, a
// # or a non-ASCII character safe: the type escapes the userinfo itself, so
// there is no string to get wrong and no parse that can fail.
func linkURL(scheme string, user *url.Userinfo, addr inboundAddress, params []linkParam) string {
	u := url.URL{
		Scheme:   scheme,
		User:     user,
		Host:     authority(addr),
		Fragment: addr.Remark,
		RawQuery: encodeParams(params),
	}
	return u.String()
}

// addParams is the path for links whose authority is already encoded, such as
// the base64 payload of http2://.
func addParams(uri string, params []linkParam, remark string) string {
	parsed, err := url.Parse(uri)
	if err != nil || parsed == nil {
		// A backstop, not a path anything should reach: every caller that could
		// produce an unparseable string builds through linkURL instead.
		if query := encodeParams(params); query != "" {
			uri += "?" + query
		}
		if remark != "" {
			uri += "#" + url.PathEscape(remark)
		}
		return uri
	}
	parsed.RawQuery = encodeParams(params)
	parsed.Fragment = remark
	return parsed.String()
}

// encodeParams renders the query. mport and alpn keep their commas, which the
// client parsers expect unescaped.
func encodeParams(params []linkParam) string {
	if len(params) == 0 {
		return ""
	}
	pairs := make([]string, 0, len(params))
	for _, p := range params {
		switch p.Key {
		case "mport", "alpn":
			pairs = append(pairs, p.Key+"="+p.Value)
		default:
			pairs = append(pairs, p.Key+"="+url.QueryEscape(p.Value))
		}
	}
	return strings.Join(pairs, "&")
}

// authority renders host:port for a URI. An IPv6 literal is bracketed so the
// port stays parseable.
func authority(addr inboundAddress) string {
	host := normalizeHost(addr.Server)
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("%s:%d", host, addr.ServerPort)
}

// normalizeHost strips URI brackets from an IPv6 literal. Config formats want
// the bare form; only a URI authority wants the brackets back.
func normalizeHost(host string) string {
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		return host[1 : len(host)-1]
	}
	return host
}

func toBase64(data []byte) string {
	return base64.StdEncoding.EncodeToString(data)
}

// stringOr reads a map value the schema says is a string but which a
// hand-written or older config may leave absent or of another type.
func stringOr(value interface{}, fallback string) string {
	if s, ok := value.(string); ok {
		return s
	}
	return fallback
}

func boolOr(value interface{}) bool {
	b, _ := value.(bool)
	return b
}

// boolParam renders a flag the way these links spell booleans.
func boolParam(value interface{}) string {
	if boolOr(value) {
		return "1"
	}
	return "0"
}

func stringList(value interface{}) []string {
	items, ok := value.([]interface{})
	if !ok {
		return nil
	}
	list := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			list = append(list, s)
		}
	}
	return list
}

func alpnList(value interface{}) string {
	return strings.Join(stringList(value), ",")
}

// randomIndex picks an element position with crypto/rand, falling back to 0
// rather than to a predictable sequence -- the caller is choosing a Reality
// short id, and a guessable choice is worse than a fixed one.
func randomIndex(n int) int {
	if n <= 1 {
		return 0
	}
	value, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(value.Int64())
}

// certPEMFromTLS finds the server certificate, whether it was stored inline as
// a string, inline as a list of lines, or as a path on disk.
func certPEMFromTLS(server map[string]interface{}) string {
	if server == nil {
		return ""
	}
	switch certificate := server["certificate"].(type) {
	case string:
		if certificate != "" {
			return certificate
		}
	case []interface{}:
		if lines := stringList(certificate); len(lines) > 0 {
			return strings.Join(lines, "\n")
		}
	}
	if path := stringOr(server["certificate_path"], ""); path != "" {
		if data, err := os.ReadFile(path); err == nil {
			return string(data)
		}
	}
	return ""
}

// certSha256Hex is the fingerprint a client pins against.
func certSha256Hex(pemData string) string {
	rest := []byte(pemData)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return ""
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return ""
		}
		sum := sha256.Sum256(certificate.Raw)
		return hex.EncodeToString(sum[:])
	}
}
