package service

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestSharedAddressAcrossLinkProtocols(t *testing.T) {
	client := buildClient(t, "alice", `{
		"socks": {"username": "alice", "password": "password"},
		"http": {"username": "alice", "password": "password"},
		"shadowsocks": {"password": "password"},
		"naive": {"username": "alice", "password": "password"},
		"hysteria": {"auth_str": "password"},
		"hysteria2": {"password": "password"},
		"anytls": {"password": "password"},
		"tuic": {"uuid": "uuid", "password": "password"},
		"vless": {"uuid": "uuid"},
		"trojan": {"password": "password"},
		"vmess": {"uuid": "uuid"}
	}`)

	for _, protocol := range []string{
		"socks", "http", "mixed", "shadowsocks", "naive", "hysteria",
		"hysteria2", "anytls", "tuic", "vless", "trojan", "vmess",
	} {
		t.Run(protocol, func(t *testing.T) {
			inbound := buildInbound(t, protocol, "edge", `{"listen_port":56123,"method":"aes-128-gcm"}`)
			inbound.Addrs = domain.JSON(`[{"server":"node.example.com","server_port":56123}]`)
			links := generate(t, client, inbound, "panel.example.com")
			if len(links) == 0 {
				t.Fatal("no client links generated")
			}
			// URI subscriptions call the same generator with their request host.
			// An explicitly published address must be independent of both hosts.
			if subscribed := generate(t, client, inbound, "subscription.example.com"); !reflect.DeepEqual(links, subscribed) {
				t.Errorf("client links = %v, subscription links = %v", links, subscribed)
			}

			for _, link := range links {
				u := parseLink(t, link)
				switch u.Scheme {
				case "vmess":
					decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(link, "vmess://"))
					if err != nil {
						t.Fatal(err)
					}
					var payload map[string]interface{}
					if err := json.Unmarshal(decoded, &payload); err != nil {
						t.Fatal(err)
					}
					if payload["add"] != "node.example.com" || payload["port"] != "56123" {
						t.Errorf("VMess payload = %v; want the shared domain and entered port", payload)
					}
				case "http2":
					decoded, err := base64.StdEncoding.DecodeString(u.Host)
					if err != nil {
						t.Fatal(err)
					}
					endpoint, err := url.Parse("https://" + string(decoded))
					if err != nil {
						t.Fatal(err)
					}
					if endpoint.Host != "node.example.com:56123" {
						t.Errorf("Naive endpoint = %q", endpoint.Host)
					}
				default:
					if u.Host != "node.example.com:56123" {
						t.Errorf("link host = %q; want node.example.com:56123", u.Host)
					}
				}
			}
		})
	}
}

func TestSharedAddressAcrossSubscriptionFormats(t *testing.T) {
	for _, protocol := range []string{
		"socks", "http", "mixed", "shadowsocks", "naive", "hysteria",
		"hysteria2", "anytls", "tuic", "vless", "trojan", "vmess", "snell",
	} {
		t.Run(protocol, func(t *testing.T) {
			inbound := buildInbound(t, protocol, "edge", `{"listen_port":56123,"method":"aes-128-gcm"}`)
			inbound.Addrs = domain.JSON(`[{"server":"node.example.com","server_port":56123}]`)
			options, err := decodeObject(inbound.Options, "options")
			if err != nil {
				t.Fatal(err)
			}
			addrs, err := inboundAddresses(inbound, "subscription.example.com", "alice", options, outboundTLS)
			if err != nil || len(addrs) != 1 {
				t.Fatalf("addresses = %v, error = %v", addrs, err)
			}
			node := &clientNode{
				Tag: "alice", Type: protocol,
				Server: addrs[0].Server, ServerPort: addrs[0].ServerPort,
				Options: options,
			}
			out := singBoxOutbound(node)
			if out == nil && protocol != "hysteria" {
				t.Fatal("missing sing-box outbound")
			}
			if out != nil {
				if out["server"] != "node.example.com" || out["server_port"] != 56123 {
					t.Errorf("sing-box outbound = %v; want the shared domain and entered port", out)
				}
			}
			proxy := clashProxy(node)
			if proxy == nil && protocol != "hysteria" && protocol != "naive" && protocol != "snell" {
				t.Fatal("missing Clash proxy")
			}
			if proxy != nil {
				if proxy["server"] != "node.example.com" || proxy["port"] != 56123 {
					t.Errorf("Clash proxy = %v; want the shared domain and entered port", proxy)
				}
			}
		})
	}
}

func TestEmptySharedAddressUsesRequestHostAndEnteredPort(t *testing.T) {
	inbound := buildInbound(t, "vless", "edge", `{"listen_port":56123}`)
	inbound.Addrs = domain.JSON(`[]`)
	client := buildClient(t, "alice", `{"vless":{"uuid":"uuid"}}`)

	for _, host := range []string{"panel.example.com", "45.32.93.251"} {
		links := generate(t, client, inbound, host)
		if len(links) != 1 {
			t.Fatalf("links = %v; want one automatic address", links)
		}
		if u := parseLink(t, links[0]); u.Host != host+":56123" {
			t.Errorf("automatic address = %q; want %s:56123", u.Host, host)
		}
	}
}
