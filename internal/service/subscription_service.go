package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// Subscription formats. A client application supports one or two of these and
// not the others, which is why one is not enough.
const (
	FormatLinks   = "links"
	FormatSingBox = "json"
	FormatClash   = "clash"
)

// Subscription is a rendered subscription and the metadata that travels with
// it in response headers.
type Subscription struct {
	// Body is the document itself, already encoded.
	Body string
	// ContentType is what the body is.
	ContentType string
	// UserInfo is the Subscription-Userinfo header: how much of the quota is
	// spent and when it runs out. Client applications show this without having
	// to ask the panel anything.
	UserInfo string
	// UpdateInterval is how many hours a client should wait before refetching.
	UpdateInterval int
	// Title is what the subscription is called in a client's profile list.
	Title string
}

// SubscriptionService renders a subscriber's nodes in the formats client
// applications import.
type SubscriptionService struct {
	store    *repository.Store
	settings *SettingService
	links    *LinkService
}

func NewSubscriptionService(store *repository.Store, settings *SettingService, links *LinkService) *SubscriptionService {
	return &SubscriptionService{store: store, settings: settings, links: links}
}

// Render builds a subscription in the requested format.
func (s *SubscriptionService) Render(ctx context.Context, name string, format string, host string) (*Subscription, error) {
	client, err := s.subscriber(ctx, name)
	if err != nil {
		return nil, err
	}

	meta, err := s.metaFor(ctx, client)
	if err != nil {
		return nil, err
	}

	switch format {
	case FormatSingBox:
		body, err := s.renderSingBox(ctx, client, host)
		if err != nil {
			return nil, err
		}
		meta.Body, meta.ContentType = body, "application/json; charset=utf-8"
	case FormatClash:
		body, err := s.renderClash(ctx, client, host)
		if err != nil {
			return nil, err
		}
		meta.Body, meta.ContentType = body, "text/yaml; charset=utf-8"
	default:
		body, err := s.renderLinks(ctx, client, host)
		if err != nil {
			return nil, err
		}
		meta.Body, meta.ContentType = body, "text/plain; charset=utf-8"
	}
	return meta, nil
}

// Meta returns only the headers, for a HEAD request. A client polls this to
// refresh the quota it displays without downloading the whole subscription.
func (s *SubscriptionService) Meta(ctx context.Context, name string) (*Subscription, error) {
	client, err := s.subscriber(ctx, name)
	if err != nil {
		return nil, err
	}
	return s.metaFor(ctx, client)
}

// subscriber resolves a subscription id to an enabled client.
//
// A disabled subscriber is reported as not found, not as forbidden: the id is
// the only secret protecting a subscription, and distinguishing "no such
// subscription" from "that one is switched off" tells an unauthenticated
// caller which ids exist.
func (s *SubscriptionService) subscriber(ctx context.Context, name string) (*domain.Client, error) {
	client, err := s.store.Clients.FindByName(ctx, name)
	if err != nil {
		return nil, err
	}
	if !client.Enable {
		return nil, domain.NotFoundf("subscription")
	}
	return client, nil
}

func (s *SubscriptionService) metaFor(ctx context.Context, client *domain.Client) (*Subscription, error) {
	updateInterval, err := s.settings.GetInt(ctx, domain.SettingSubUpdates)
	if err != nil {
		return nil, err
	}

	return &Subscription{
		// The header reports the current period, which is what the subscriber
		// is being held to. Lifetime totals would show a figure that never
		// goes down after a reset.
		UserInfo: fmt.Sprintf("upload=%d; download=%d; total=%d; expire=%d",
			client.Up, client.Down, client.Volume, client.Expiry),
		UpdateInterval: updateInterval,
		Title:          client.Name,
	}, nil
}

// renderLinks is the oldest and most widely understood format: one URI per
// line, optionally base64-encoded because several clients expect that.
func (s *SubscriptionService) renderLinks(ctx context.Context, client *domain.Client, host string) (string, error) {
	links, err := s.links.LinksForClient(ctx, client.Id, host)
	if err != nil {
		return "", err
	}
	if len(links) == 0 {
		return "", domain.Invalidf("no nodes are available in the links subscription")
	}

	showInfo, err := s.settings.GetBool(ctx, domain.SettingSubShowInfo)
	if err != nil {
		return "", err
	}
	if showInfo {
		// A pseudo-entry carrying the remaining quota. It is not a working
		// node; clients display its name in the node list, which is the only
		// place many of them will show this information at all.
		if summary := quotaSummary(client); summary != "" {
			links = append(links, summary)
		}
	}

	body := strings.Join(links, "\n")

	encode, err := s.settings.GetBool(ctx, domain.SettingSubEncode)
	if err != nil {
		return "", err
	}
	if encode {
		body = base64.StdEncoding.EncodeToString([]byte(body))
	}
	return body, nil
}

// quotaSummary renders the remaining quota and time as a node name.
func quotaSummary(client *domain.Client) string {
	var parts []string
	if client.Volume > 0 {
		if remaining := client.Volume - client.Used(); remaining > 0 {
			parts = append(parts, formatBytes(remaining)+" left")
		} else {
			parts = append(parts, "quota spent")
		}
	}
	if client.Expiry > 0 {
		days := (client.Expiry - time.Now().Unix()) / 86400
		if days < 0 {
			days = 0
		}
		parts = append(parts, fmt.Sprintf("%d days", days))
	}
	if len(parts) == 0 {
		return ""
	}
	// Rendered as a link so a client that does not understand it skips the
	// entry rather than failing the whole subscription.
	return "trojan://unused@127.0.0.1:1#" + strings.Join(parts, " | ")
}

func formatBytes(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%dB", bytes)
	}
	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit && exp < 4; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f%cB", float64(bytes)/float64(div), "KMGTP"[exp])
}

// nodes enumerates the dialable nodes a subscriber has, flattened across every
// inbound they are assigned to and every address each inbound publishes.
func (s *SubscriptionService) nodes(ctx context.Context, client *domain.Client, host string) ([]clientNode, error) {
	ids, err := clientInboundIds(client)
	if err != nil {
		return nil, err
	}
	inbounds, err := s.store.Inbounds.ListByIds(ctx, ids)
	if err != nil {
		return nil, err
	}

	var identities map[string]map[string]interface{}
	if len(client.Config) > 0 {
		if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
			return nil, domain.Invalidf("client %q has an unreadable config", client.Name)
		}
	}

	// Tags must be unique within a client configuration: both sing-box and
	// Clash reject duplicates, and an inbound published at two addresses would
	// otherwise produce two nodes with the same name.
	taken := nodeNames()

	var nodes []clientNode
	for i := range inbounds {
		inbound := &inbounds[i]
		if !inSubscription(inbound.Type) {
			continue
		}

		options, err := decodeObject(inbound.Options, "inbound options")
		if err != nil {
			logger.Warning("subscription: skipping inbound ", inbound.Tag, ": ", err)
			continue
		}
		addrs, err := inboundAddresses(inbound, host, client.Name, options, outboundTLS)
		if err != nil {
			logger.Warning("subscription: skipping inbound ", inbound.Tag, ": ", err)
			continue
		}

		transport, _ := options["transport"].(map[string]interface{})
		for _, addr := range addrs {
			tag := uniqueTag(addr.Remark, taken)
			taken[tag] = true
			nodes = append(nodes, clientNode{
				Tag:        tag,
				Type:       inbound.Type,
				Server:     addr.Server,
				ServerPort: addr.ServerPort,
				Identity:   identities[identityKeyFor(inbound.Type, options)],
				Transport:  transport,
				TLS:        addr.TLS,
				Options:    options,
			})
		}
	}
	return nodes, nil
}

// inSubscription reports whether a subscription hands a subscriber an inbound
// of this type in some format: every type with a link, and snell, which has no
// link of its own but is an outbound like the rest.
func inSubscription(inboundType string) bool {
	return HasLink(inboundType) || inboundType == "snell"
}

// identityKeyFor names the stored identity an inbound type authenticates with.
// Shadowsocks is the exception: which key it uses depends on its method.
func identityKeyFor(inboundType string, options map[string]interface{}) string {
	if inboundType == "shadowsocks" {
		return shadowsocksIdentityKey(stringOr(options["method"], ""))
	}
	if inboundType == "mixed" {
		return "socks"
	}
	return inboundType
}

// nodeNames reserves the selectors and built-in destinations in the generated
// configurations. A subscriber may use any of these words as their own name.
func nodeNames() map[string]bool {
	return map[string]bool{
		groupProxy: true,
		groupAuto:  true,
		"direct":   true,
		"DIRECT":   true,
		"REJECT":   true,
	}
}

// uniqueTag keeps the subscriber's name, adding a numbered suffix when another
// node or a configuration destination already uses it.
func uniqueTag(tag string, taken map[string]bool) string {
	if tag == "" {
		tag = "node"
	}
	if !taken[tag] {
		return tag
	}
	for i := 2; ; i++ {
		candidate := fmt.Sprintf("%s-%d", tag, i)
		if !taken[candidate] {
			return candidate
		}
	}
}
