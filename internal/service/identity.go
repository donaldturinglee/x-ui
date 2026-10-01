package service

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// identityPasswordBytes is the size of a generated protocol password before
// encoding. It is the subscriber's only credential, so it is sized to be beyond
// guessing rather than to be typed.
const identityPasswordBytes = 24

// credential is one field of a protocol identity, and how to fill it.
type credentialKind int

const (
	credentialUUID credentialKind = iota
	credentialPassword
	// credentialName tracks the client's own name rather than being generated.
	// It is what a subscriber sees the account called, and several cores use it
	// as the user tag traffic is reported against.
	credentialName
	// credentialKey128 and credentialKey256 are a shadowsocks 2022 user key: the
	// method reads the password as the base64 of exactly that many bits, and a
	// core handed any other length refuses the whole configuration.
	credentialKey128
	credentialKey256
)

type credential struct {
	Field string
	Kind  credentialKind
}

// identitySpecs says what each protocol needs a subscriber to hold.
//
// Keyed by the identity key rather than by inbound type, because shadowsocks
// uses two of them: a 2022 method needs a different key length, so a subscriber
// carries a separate identity for it. The 256-bit one is also what a method
// from before 2022 takes, which accepts any password.
//
// Snell has taken a user per subscriber since sing-box 1.14, as the reference
// gives it one, and a shadowtls listener has always authenticated its own from
// version 3 on.
var identitySpecs = map[string][]credential{
	"vless":         {{"name", credentialName}, {"uuid", credentialUUID}},
	"vmess":         {{"name", credentialName}, {"uuid", credentialUUID}},
	"trojan":        {{"name", credentialName}, {"password", credentialPassword}},
	"shadowsocks":   {{"name", credentialName}, {"password", credentialKey256}},
	"shadowsocks16": {{"name", credentialName}, {"password", credentialKey128}},
	"shadowtls":     {{"name", credentialName}, {"password", credentialPassword}},
	"snell":         {{"name", credentialName}, {"userkey", credentialPassword}},
	"hysteria":      {{"name", credentialName}, {"auth_str", credentialPassword}},
	"hysteria2":     {{"name", credentialName}, {"password", credentialPassword}},
	"anytls":        {{"name", credentialName}, {"password", credentialPassword}},
	"tuic":          {{"name", credentialName}, {"uuid", credentialUUID}, {"password", credentialPassword}},
	"naive":         {{"username", credentialName}, {"password", credentialPassword}},
	"socks":         {{"username", credentialName}, {"password", credentialPassword}},
	"http":          {{"username", credentialName}, {"password", credentialPassword}},
}

// identityKeysFor names the identities an inbound type needs. Its options are
// consulted because shadowsocks picks its key from the method in use, and a
// shadowtls listener only authenticates users from version 3.
func identityKeysFor(inboundType string, options map[string]interface{}) []string {
	switch inboundType {
	case "mixed":
		// One listener speaking both, so the subscriber needs both.
		return []string{"socks", "http"}
	case "shadowsocks":
		return []string{shadowsocksIdentityKey(stringOr(options["method"], ""))}
	case "shadowtls":
		if version, _ := options["version"].(float64); int(version) < 3 {
			return nil
		}
	}
	if _, known := identitySpecs[inboundType]; known {
		return []string{inboundType}
	}
	return nil
}

// ensureIdentities fills in whatever the subscriber is missing for the given
// protocols, and keeps the name fields in step with the client's own name.
//
// Existing credentials are never regenerated. A subscriber's uuid is in every
// client application they have installed; rewriting it on an unrelated edit
// would cut them off with no indication why.
func ensureIdentities(client *domain.Client, keys []string) error {
	identities := map[string]map[string]interface{}{}
	if len(client.Config) > 0 {
		if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
			return domain.Invalidf("client %q has an unreadable config", client.Name)
		}
	}

	for _, key := range keys {
		spec, known := identitySpecs[key]
		if !known {
			continue
		}
		identity := identities[key]
		if identity == nil {
			identity = map[string]interface{}{}
		}
		for _, field := range spec {
			value, err := fillCredential(identity[field.Field], field.Kind, client.Name)
			if err != nil {
				return err
			}
			identity[field.Field] = value
		}
		identities[key] = identity
	}

	// Identities for protocols the subscriber no longer uses are left alone.
	// Removing one and later re-adding the inbound would mint new credentials
	// and break every client application that already had the old ones.
	syncIdentityNames(identities, client.Name)

	encoded, err := json.Marshal(identities)
	if err != nil {
		return err
	}
	client.Config = domain.JSON(encoded)
	return nil
}

// syncIdentityNames rewrites the display-name field of every identity to match
// the client's own name.
//
// Only a field that is already present is rewritten: its absence means this
// protocol does not carry one, and adding it would put a key in the generated
// configuration that the core does not accept.
func syncIdentityNames(identities map[string]map[string]interface{}, name string) {
	for _, identity := range identities {
		for _, field := range []string{"name", "username"} {
			if _, present := identity[field]; present {
				identity[field] = name
			}
		}
	}
}

// SyncIdentityNames keeps a stored config's name fields in step with a rename.
func SyncIdentityNames(client *domain.Client) error {
	if len(client.Config) == 0 {
		return nil
	}
	var identities map[string]map[string]interface{}
	if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
		return domain.Invalidf("client %q has an unreadable config", client.Name)
	}

	syncIdentityNames(identities, client.Name)

	encoded, err := json.Marshal(identities)
	if err != nil {
		return err
	}
	client.Config = domain.JSON(encoded)
	return nil
}

func fillCredential(existing interface{}, kind credentialKind, name string) (interface{}, error) {
	if kind == credentialName {
		return name, nil
	}
	// Already set, and set to something. A credential is only generated once.
	if current, ok := existing.(string); ok && current != "" {
		return current, nil
	}

	switch kind {
	case credentialUUID:
		return newUUID()
	case credentialKey128:
		return newKey(16)
	case credentialKey256:
		return newKey(32)
	default:
		return RandomSecret(identityPasswordBytes)
	}
}

// newKey returns n random bytes in standard base64, which is the form a
// shadowsocks 2022 method reads its keys in.
func newKey(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf), nil
}

// lacksIdentities reports whether a client is missing any credential the given
// identities need, which is what saving it again would mint.
func lacksIdentities(client *domain.Client, keys []string) (bool, error) {
	identities := map[string]map[string]interface{}{}
	if len(client.Config) > 0 {
		if err := json.Unmarshal(client.Config.Raw(), &identities); err != nil {
			return false, domain.Invalidf("client %q has an unreadable config", client.Name)
		}
	}
	for _, key := range keys {
		for _, field := range identitySpecs[key] {
			if field.Kind == credentialName {
				continue
			}
			if value, _ := identities[key][field.Field].(string); value == "" {
				return true, nil
			}
		}
	}
	return false, nil
}

// newUUID returns a random version 4 UUID in its canonical text form.
//
// Written out rather than pulled in as a dependency: it is twenty lines, and
// the only property that matters here is that the bytes come from crypto/rand.
func newUUID() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	// Version 4, variant RFC 4122. Several cores validate these bits and
	// refuse a uuid that does not carry them.
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80

	encoded := hex.EncodeToString(buf[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		encoded[0:8], encoded[8:12], encoded[12:16], encoded[16:20], encoded[20:32]), nil
}
