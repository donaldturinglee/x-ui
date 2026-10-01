package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// LinkService turns what is stored about a subscriber into the connection URIs
// a client application understands.
//
// Generation is pure: it reads a client and an inbound and returns strings. It
// needs no proxy core and touches nothing outside its arguments, which is what
// lets the whole of it be tested without a database or a running node.
type LinkService struct {
	store *repository.Store
}

func NewLinkService(store *repository.Store) *LinkService {
	return &LinkService{store: store}
}

// inboundTypesWithLink are the inbound types a subscriber can be handed a link
// for. Anything else is a listener the panel manages but no client app dials
// directly -- a tun device, a redirect, a DNS listener.
var inboundTypesWithLink = map[string]bool{
	"socks": true, "http": true, "mixed": true,
	"shadowsocks": true, "naive": true,
	"hysteria": true, "hysteria2": true, "anytls": true, "tuic": true,
	"vless": true, "trojan": true, "vmess": true,
}

// HasLink reports whether an inbound type produces subscriber links.
func HasLink(inboundType string) bool {
	return inboundTypesWithLink[inboundType]
}

// inboundAddress is one address an inbound is reachable at.
//
// An inbound listens once but can be published many times -- a domain and a
// bare address, a CDN edge and the origin -- and each publication can carry its
// own TLS overrides. When the operator has configured none, the request's own
// hostname and the listening port are used.
type inboundAddress struct {
	Server     string                 `json:"server"`
	ServerPort int                    `json:"server_port"`
	Remark     string                 `json:"remark"`
	TLS        map[string]interface{} `json:"tls"`
}

// LinksForClient returns every link a subscriber can connect with, across all
// the inbounds they are assigned to.
//
// An inbound that cannot be rendered is logged and skipped rather than failing
// the request. A subscription that comes back one node short is recoverable; a
// subscription that comes back as an error leaves the subscriber with nothing.
func (s *LinkService) LinksForClient(ctx context.Context, clientId uint, hostname string) ([]string, error) {
	client, err := s.store.Clients.FindById(ctx, clientId)
	if err != nil {
		return nil, err
	}
	return s.linksFor(ctx, client, hostname)
}

// LinksForClientName is the same, addressed the way a subscription is.
func (s *LinkService) LinksForClientName(ctx context.Context, name string, hostname string) ([]string, error) {
	client, err := s.store.Clients.FindByName(ctx, name)
	if err != nil {
		return nil, err
	}
	return s.linksFor(ctx, client, hostname)
}

func (s *LinkService) linksFor(ctx context.Context, client *domain.Client, hostname string) ([]string, error) {
	ids, err := clientInboundIds(client)
	if err != nil {
		return nil, err
	}
	inbounds, err := s.store.Inbounds.ListByIds(ctx, ids)
	if err != nil {
		return nil, err
	}

	links := make([]string, 0, len(inbounds))
	for i := range inbounds {
		inbound := &inbounds[i]
		if !HasLink(inbound.Type) {
			continue
		}
		generated, err := GenerateLinks(client, inbound, hostname)
		if err != nil {
			logger.Warning("unable to build links for inbound ", inbound.Tag,
				" and client ", client.Name, ": ", err)
			continue
		}
		links = append(links, generated...)
	}
	return links, nil
}

func clientInboundIds(client *domain.Client) ([]uint, error) {
	if len(client.Inbounds) == 0 {
		return nil, nil
	}
	var ids []uint
	if err := json.Unmarshal(client.Inbounds.Raw(), &ids); err != nil {
		return nil, domain.Invalidf("client %q has an unreadable inbound list", client.Name)
	}
	return ids, nil
}

// GenerateLinks builds every connection URI for one client on one inbound.
//
// hostname is what the subscriber reached the panel on, and is the fallback
// address when the inbound publishes none of its own -- a panel and its nodes
// are often the same host, and this saves configuring the obvious.
func GenerateLinks(client *domain.Client, inbound *domain.Inbound, hostname string) ([]string, error) {
	if !HasLink(inbound.Type) {
		return nil, nil
	}

	options, err := decodeObject(inbound.Options, "inbound options")
	if err != nil {
		return nil, err
	}
	outJSON, err := decodeObject(inbound.OutJson, "inbound out_json")
	if err != nil {
		return nil, err
	}

	// The per-protocol identities the subscriber authenticates with, keyed by
	// protocol: {"vless": {"uuid": "..."}, "trojan": {"password": "..."}}.
	var identities map[string]map[string]interface{}
	if len(client.Config) > 0 {
		if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
			return nil, fmt.Errorf("client %q has an unreadable config: %w", client.Name, err)
		}
	}

	addrs, err := inboundAddresses(inbound, hostname, client.Remark, options, prepareTLS)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, nil
	}

	switch inbound.Type {
	case "socks":
		return socksLinks(identities["socks"], addrs), nil
	case "http":
		return httpLinks(identities["http"], addrs), nil
	case "mixed":
		// One listener, two protocols: a mixed inbound speaks both, so the
		// subscriber gets a link for each rather than being made to guess.
		return append(
			socksLinks(identities["socks"], addrs),
			httpLinks(identities["http"], addrs)...,
		), nil
	case "shadowsocks":
		return shadowsocksLinks(identities, options, outJSON, addrs), nil
	case "naive":
		return naiveLinks(identities["naive"], options, addrs), nil
	case "hysteria":
		return hysteriaLinks(identities["hysteria"], options, outJSON, addrs), nil
	case "hysteria2":
		return hysteria2Links(identities["hysteria2"], options, outJSON, addrs), nil
	case "anytls":
		return anytlsLinks(identities["anytls"], addrs), nil
	case "tuic":
		return tuicLinks(identities["tuic"], options, outJSON, addrs), nil
	case "vless":
		return vlessLinks(identities["vless"], options, addrs), nil
	case "trojan":
		return trojanLinks(identities["trojan"], options, addrs), nil
	case "vmess":
		return vmessLinks(identities["vmess"], options, addrs), nil
	}
	return nil, nil
}

// inboundAddresses resolves where this inbound is published, and attaches the
// TLS each address should advertise, as prepare renders it for the caller: a
// link says less about the handshake than an outbound does.
func inboundAddresses(
	inbound *domain.Inbound,
	hostname string,
	clientRemark string,
	options map[string]interface{},
	prepare func(server, client domain.JSON) map[string]interface{},
) ([]inboundAddress, error) {
	server, client, err := inbound.TLS()
	if err != nil {
		return nil, fmt.Errorf("inbound %q has an unreadable tls: %w", inbound.Tag, err)
	}
	var tls map[string]interface{}
	if server != nil {
		tls = prepare(server, client)
	}

	var addrs []inboundAddress
	if len(inbound.Addrs) > 0 {
		if err := json.Unmarshal(inbound.Addrs.Raw(), &addrs); err != nil {
			return nil, fmt.Errorf("inbound %q has unreadable addresses: %w", inbound.Tag, err)
		}
	}

	if len(addrs) == 0 {
		// Nothing published: fall back to the host the subscriber asked on and
		// the port the inbound listens on.
		port, _ := options["listen_port"].(float64)
		addr := inboundAddress{
			Server:     hostname,
			ServerPort: int(port),
			Remark:     joinRemark(clientRemark, inbound.Tag),
			TLS:        tls,
		}
		addrs = []inboundAddress{addr}
	} else {
		for i := range addrs {
			addrs[i].Remark = joinRemark(clientRemark, inbound.Tag+addrs[i].Remark)
			if tls == nil {
				continue
			}
			// Copied per address before the overrides are applied: sharing the
			// map would let one address's server_name become every address's.
			merged := make(map[string]interface{}, len(tls)+len(addrs[i].TLS))
			for k, v := range tls {
				merged[k] = v
			}
			for k, v := range addrs[i].TLS {
				merged[k] = v
			}
			addrs[i].TLS = merged
		}
	}

	for i := range addrs {
		addrs[i].Server = normalizeHost(addrs[i].Server)
	}
	return addrs, nil
}

// joinRemark prefixes a node's name with the subscriber's own alias, so
// everyone sees their nodes named for them rather than for the server.
func joinRemark(clientRemark string, inboundRemark string) string {
	if clientRemark != "" {
		return clientRemark + "-" + inboundRemark
	}
	return inboundRemark
}

// prepareTLS folds the server half of a listener's TLS into the client half.
//
// The two are stored separately because they are not the same document: the
// server holds certificates and private keys, the client holds what a
// subscriber needs to trust them. Only the fields that describe the handshake
// cross over -- a private key must never end up in a link.
func prepareTLS(serverHalf, clientHalf domain.JSON) map[string]interface{} {
	server, client, ok := tlsHalves(serverHalf, clientHalf)
	if !ok {
		return nil
	}

	if client["certificate_public_key_sha256"] != nil {
		client["pinSHA256"] = certSha256Hex(certPEMFromTLS(server))
	}

	for key, value := range server {
		switch key {
		case "enabled", "server_name", "alpn":
			client[key] = value
		case "reality":
			realityServer, okServer := value.(map[string]interface{})
			realityClient, okClient := client["reality"].(map[string]interface{})
			if !okServer || !okClient {
				continue
			}
			realityClient["enabled"] = realityServer["enabled"]
			// One short id per link, chosen at random. The server accepts any
			// of them; handing every subscriber the same one would make the
			// whole set identifiable from a single capture.
			if shortIDs, ok := realityServer["short_id"].([]interface{}); ok && len(shortIDs) > 0 {
				realityClient["short_id"] = shortIDs[randomIndex(len(shortIDs))]
			}
			client["reality"] = realityClient
		}
	}
	return client
}

// outboundTLS folds the server half into the client half as a subscription's
// outbounds carry it, the way the reference writes its client-side outbounds.
//
// More crosses over than into a link, because an outbound can say more: the
// handshake's own terms -- the versions, the cipher suites and how long it may
// take -- so the two ends agree on them, and the certificate, when the client
// pins nothing else to trust it by. Reality and ECH are switched on to match,
// with a Reality short id of its own per outbound. The key still never crosses.
func outboundTLS(serverHalf, clientHalf domain.JSON) map[string]interface{} {
	server, client, ok := tlsHalves(serverHalf, clientHalf)
	if !ok {
		return nil
	}

	for _, key := range []string{
		"enabled", "server_name", "alpn", "min_version", "max_version", "cipher_suites", "handshake_timeout",
	} {
		if value, ok := server[key]; ok {
			client[key] = value
		}
	}
	if _, pinned := client["certificate_public_key_sha256"]; !pinned {
		if certificate, ok := server["certificate"]; ok {
			client["certificate"] = certificate
		}
	}

	if reality, ok := server["reality"].(map[string]interface{}); ok && boolOr(reality["enabled"]) {
		realityClient, ok := client["reality"].(map[string]interface{})
		if !ok {
			realityClient = map[string]interface{}{}
		}
		realityClient["enabled"] = true
		if shortIDs, ok := reality["short_id"].([]interface{}); ok && len(shortIDs) > 0 {
			realityClient["short_id"] = shortIDs[randomIndex(len(shortIDs))]
		}
		client["reality"] = realityClient
	}
	if ech, ok := server["ech"].(map[string]interface{}); ok && boolOr(ech["enabled"]) {
		echClient, ok := client["ech"].(map[string]interface{})
		if !ok {
			echClient = map[string]interface{}{}
		}
		echClient["enabled"] = true
		for _, key := range []string{"pq_signature_schemes_enabled", "dynamic_record_sizing_disabled"} {
			if value, ok := ech[key]; ok {
				echClient[key] = value
			}
		}
		client["ech"] = echClient
	}
	return client
}

// tlsHalves reads both halves of a listener's TLS afresh, so what a caller folds
// into the client's is a copy of its own rather than the listener's. A listener
// that hands a client nothing beyond the server half has no client half at all,
// which reads as an empty one.
func tlsHalves(serverHalf, clientHalf domain.JSON) (server, client map[string]interface{}, ok bool) {
	if err := json.Unmarshal(serverHalf.Raw(), &server); err != nil {
		return nil, nil, false
	}
	if len(clientHalf) > 0 {
		if err := json.Unmarshal(clientHalf.Raw(), &client); err != nil {
			return nil, nil, false
		}
	}
	if client == nil {
		client = map[string]interface{}{}
	}
	return server, client, true
}

func decodeObject(raw domain.JSON, what string) (map[string]interface{}, error) {
	if len(raw) == 0 {
		return map[string]interface{}{}, nil
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw.Raw(), &decoded); err != nil {
		return nil, fmt.Errorf("unreadable %s: %w", what, err)
	}
	if decoded == nil {
		decoded = map[string]interface{}{}
	}
	return decoded, nil
}
