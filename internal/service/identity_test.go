package service

import (
	"encoding/json"
	"regexp"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// uuidV4 is the canonical form, with the version and variant bits several cores
// validate before accepting a uuid at all.
var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func identitiesOf(t *testing.T, client *domain.Client) map[string]map[string]interface{} {
	t.Helper()
	var identities map[string]map[string]interface{}
	if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
		t.Fatalf("config is not an identity map: %v", err)
	}
	return identities
}

func TestNewUUIDIsVersionFour(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		id, err := newUUID()
		if err != nil {
			t.Fatalf("newUUID: %v", err)
		}
		if !uuidV4.MatchString(id) {
			t.Fatalf("newUUID = %q, want a canonical v4 uuid", id)
		}
		if seen[id] {
			t.Fatalf("newUUID returned %q twice", id)
		}
		seen[id] = true
	}
}

func TestEnsureIdentitiesMintsWhatEachProtocolNeeds(t *testing.T) {
	client := &domain.Client{Name: "alice"}

	if err := ensureIdentities(client, []string{"vless", "trojan", "tuic", "socks"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	identities := identitiesOf(t, client)

	if !uuidV4.MatchString(identities["vless"]["uuid"].(string)) {
		t.Errorf("vless uuid = %v, want a v4 uuid", identities["vless"]["uuid"])
	}
	if password, _ := identities["trojan"]["password"].(string); password == "" {
		t.Error("trojan identity has no password")
	}
	// tuic needs both.
	if !uuidV4.MatchString(identities["tuic"]["uuid"].(string)) {
		t.Errorf("tuic uuid = %v, want a v4 uuid", identities["tuic"]["uuid"])
	}
	if password, _ := identities["tuic"]["password"].(string); password == "" {
		t.Error("tuic identity has no password")
	}
	// socks names its display field differently, and putting a "name" key in a
	// socks user is something the core refuses.
	if identities["socks"]["username"] != "alice" {
		t.Errorf("socks username = %v, want the client name", identities["socks"]["username"])
	}
	if _, present := identities["socks"]["name"]; present {
		t.Error("socks identity carries a name field, which the core does not accept")
	}
	if identities["vless"]["name"] != "alice" {
		t.Errorf("vless name = %v, want the client name", identities["vless"]["name"])
	}
}

func TestEnsureIdentitiesNeverRegenerates(t *testing.T) {
	client := &domain.Client{
		Name:   "alice",
		Config: domain.JSON(`{"vless": {"name": "alice", "uuid": "keep-this-uuid"}}`),
	}

	// A second inbound is added, so a new identity is minted for it. The
	// existing one must survive untouched: a subscriber's uuid is in every
	// client application they have installed, and rewriting it on an unrelated
	// edit cuts them off with no indication why.
	if err := ensureIdentities(client, []string{"vless", "trojan"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	identities := identitiesOf(t, client)

	if identities["vless"]["uuid"] != "keep-this-uuid" {
		t.Errorf("vless uuid = %v, want the stored one kept", identities["vless"]["uuid"])
	}
	if password, _ := identities["trojan"]["password"].(string); password == "" {
		t.Error("the newly assigned protocol got no password")
	}
}

func TestEnsureIdentitiesReplacesAnEmptyCredential(t *testing.T) {
	client := &domain.Client{
		Name:   "alice",
		Config: domain.JSON(`{"trojan": {"name": "alice", "password": ""}}`),
	}

	if err := ensureIdentities(client, []string{"trojan"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	// An empty password is not a credential; leaving it would let anyone
	// connect as this subscriber.
	if password, _ := identitiesOf(t, client)["trojan"]["password"].(string); password == "" {
		t.Error("an empty password was left in place")
	}
}

func TestRenameFollowsThroughToEveryIdentity(t *testing.T) {
	client := &domain.Client{
		Name: "bob",
		Config: domain.JSON(`{
			"vless": {"name": "alice", "uuid": "u"},
			"socks": {"username": "alice", "password": "p"},
			"trojan": {"password": "p"}
		}`),
	}

	if err := SyncIdentityNames(client); err != nil {
		t.Fatalf("SyncIdentityNames: %v", err)
	}
	identities := identitiesOf(t, client)

	if identities["vless"]["name"] != "bob" || identities["socks"]["username"] != "bob" {
		t.Errorf("identities = %v, want the display names following the rename", identities)
	}
	// trojan carried no name field, so none is added: a key the core does not
	// expect in a user entry is a key it refuses.
	if _, present := identities["trojan"]["name"]; present {
		t.Error("a name field was added to an identity that had none")
	}
	// Credentials are untouched by a rename.
	if identities["vless"]["uuid"] != "u" || identities["trojan"]["password"] != "p" {
		t.Errorf("identities = %v, want the credentials untouched", identities)
	}
}

func TestIdentitiesForProtocolsNoLongerUsedAreKept(t *testing.T) {
	client := &domain.Client{
		Name:   "alice",
		Config: domain.JSON(`{"vmess": {"name": "alice", "uuid": "old-uuid"}}`),
	}

	// The subscriber is moved off vmess and onto vless.
	if err := ensureIdentities(client, []string{"vless"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	identities := identitiesOf(t, client)

	// Dropping the old identity and later re-adding the inbound would mint new
	// credentials and break every client application that still had the old
	// ones. Keeping it costs a few bytes.
	if identities["vmess"]["uuid"] != "old-uuid" {
		t.Errorf("identities = %v, want the unused identity kept", identities)
	}
	if _, present := identities["vless"]; !present {
		t.Error("the newly assigned protocol got no identity")
	}
}

func TestIdentityKeysFor(t *testing.T) {
	cases := map[string]struct {
		inboundType string
		options     map[string]interface{}
		want        []string
	}{
		"vless":                 {inboundType: "vless", want: []string{"vless"}},
		"mixed needs both":      {inboundType: "mixed", want: []string{"socks", "http"}},
		"shadowsocks legacy":    {inboundType: "shadowsocks", options: map[string]interface{}{"method": "aes-256-gcm"}, want: []string{"shadowsocks"}},
		"shadowsocks 2022":      {inboundType: "shadowsocks", options: map[string]interface{}{"method": "2022-blake3-aes-128-gcm"}, want: []string{"shadowsocks16"}},
		"snell":                 {inboundType: "snell", want: []string{"snell"}},
		"shadowtls 3":           {inboundType: "shadowtls", options: map[string]interface{}{"version": float64(3)}, want: []string{"shadowtls"}},
		"shadowtls before 3":    {inboundType: "shadowtls", options: map[string]interface{}{"version": float64(2)}, want: nil},
		"no identity for a tun": {inboundType: "tun", want: nil},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := identityKeysFor(tc.inboundType, tc.options)
			if len(got) != len(tc.want) {
				t.Fatalf("identityKeysFor = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("identityKeysFor = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestShadowsocksKeysFitTheirMethods(t *testing.T) {
	client := &domain.Client{Name: "alice"}

	if err := ensureIdentities(client, []string{"shadowsocks", "shadowsocks16"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	identities := identitiesOf(t, client)

	// A 2022 method reads the password as a base64 key of a fixed length, and a
	// core handed any other refuses its whole configuration.
	cases := map[string]string{
		"shadowsocks":   "2022-blake3-aes-256-gcm",
		"shadowsocks16": "2022-blake3-aes-128-gcm",
	}
	for key, method := range cases {
		password, _ := identities[key]["password"].(string)
		if !validShadowsocksKey(method, password) {
			t.Errorf("%s password %q is not a key %s can use", key, password, method)
		}
	}
	// The 256-bit one is also what a method from before 2022 takes.
	if !validShadowsocksKey("aes-256-gcm", identities["shadowsocks"]["password"].(string)) {
		t.Error("the shadowsocks key is refused by a legacy method")
	}
}

func TestSnellIdentityCarriesAUserKey(t *testing.T) {
	client := &domain.Client{Name: "alice"}

	if err := ensureIdentities(client, []string{"snell"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	snell := identitiesOf(t, client)["snell"]

	if snell["name"] != "alice" {
		t.Errorf("snell name = %v, want the client name", snell["name"])
	}
	if userkey, _ := snell["userkey"].(string); len(userkey) < 32 {
		t.Errorf("snell userkey = %q, want a key beyond guessing", userkey)
	}
}

func TestLacksIdentities(t *testing.T) {
	client := &domain.Client{
		Name:   "alice",
		Config: domain.JSON(`{"vless": {"name": "alice", "uuid": "u"}, "trojan": {"name": "alice", "password": ""}}`),
	}

	cases := map[string]struct {
		keys []string
		want bool
	}{
		"all there":             {keys: []string{"vless"}, want: false},
		"an identity missing":   {keys: []string{"vless", "snell"}, want: true},
		"a credential left out": {keys: []string{"trojan"}, want: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := lacksIdentities(client, tc.keys)
			if err != nil {
				t.Fatalf("lacksIdentities: %v", err)
			}
			if got != tc.want {
				t.Errorf("lacksIdentities(%v) = %v, want %v", tc.keys, got, tc.want)
			}
		})
	}

	unreadable := &domain.Client{Name: "bob", Config: domain.JSON(`["not", "a", "map"]`)}
	if _, err := lacksIdentities(unreadable, []string{"vless"}); err == nil {
		t.Error("lacksIdentities accepted a config that is not an identity map")
	}
}

func TestEnsureIdentitiesRejectsAnUnreadableConfig(t *testing.T) {
	client := &domain.Client{Name: "alice", Config: domain.JSON(`["not", "an", "object"]`)}

	// Overwriting it would destroy credentials that may still be recoverable;
	// reporting it lets an operator look.
	if err := ensureIdentities(client, []string{"vless"}); err == nil {
		t.Fatal("ensureIdentities accepted a config that is not an identity map")
	}
}

func TestGeneratedCredentialsAreDistinctPerClient(t *testing.T) {
	first := &domain.Client{Name: "alice"}
	second := &domain.Client{Name: "bob"}

	if err := ensureIdentities(first, []string{"trojan"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}
	if err := ensureIdentities(second, []string{"trojan"}); err != nil {
		t.Fatalf("ensureIdentities: %v", err)
	}

	a := identitiesOf(t, first)["trojan"]["password"]
	b := identitiesOf(t, second)["trojan"]["password"]
	// Two subscribers sharing a password is two subscribers who can use each
	// other's quota.
	if a == b {
		t.Errorf("two clients were given the same password: %v", a)
	}
}
