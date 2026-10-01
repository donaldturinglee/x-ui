package service

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"

	"golang.org/x/crypto/curve25519"
)

// Keypair kinds an operator can ask for.
const (
	KeypairReality   = "reality"
	KeypairWireGuard = "wireguard"
	KeypairTLS       = "tls"
	KeypairOpenVPN   = "openvpn"
)

// Keypair is generated key material, ready to paste into a configuration.
//
// Everything is a string because that is how it goes into a config: a PEM
// block, a base64 key. The panel never stores any of this — it is generated,
// returned once, and forgotten.
type Keypair struct {
	Kind string `json:"kind"`
	// PrivateKey is the half that stays on the server.
	PrivateKey string `json:"privateKey,omitempty"`
	// PublicKey is the half that goes to subscribers.
	PublicKey string `json:"publicKey,omitempty"`
	// Certificate is set for the kinds that produce one.
	Certificate string `json:"certificate,omitempty"`
	// Secret is set for the kinds that are a single shared value.
	Secret string `json:"secret,omitempty"`
	// Note explains anything an operator has to know to use it.
	Note string `json:"note,omitempty"`
}

// GenerateKeypair mints key material of the requested kind.
//
// Configuring a Reality inbound without this means generating keys somewhere
// else and pasting them in, which in practice means a web page someone else
// runs — the one place a private key should never be generated.
func GenerateKeypair(kind string, options string) (*Keypair, error) {
	switch kind {
	case KeypairReality:
		return realityKeypair()
	case KeypairWireGuard:
		return wireguardKeypair(options)
	case KeypairTLS:
		return selfSignedCertificate(options)
	case KeypairOpenVPN:
		return openVPNStaticKey()
	case "":
		return nil, domain.Invalidf("a keypair kind is required")
	default:
		return nil, domain.Invalidf("unknown keypair kind %q", kind)
	}
}

// realityKeypair is an X25519 pair in the base64url form Reality expects.
func realityKeypair() (*Keypair, error) {
	private, public, err := x25519Keypair()
	if err != nil {
		return nil, err
	}
	return &Keypair{
		Kind: KeypairReality,
		// Reality spells these without padding, and a padded key is rejected
		// by the clients that parse the link rather than the config.
		PrivateKey: base64.RawURLEncoding.EncodeToString(private),
		PublicKey:  base64.RawURLEncoding.EncodeToString(public),
		Note:       "private_key goes in the inbound's reality block; public_key goes to subscribers.",
	}, nil
}

// wireguardKeypair is the same maths in WireGuard's own encoding. Given a
// private key it returns the matching public key instead, which is what an
// operator needs when the private half already exists on a peer.
func wireguardKeypair(existingPrivate string) (*Keypair, error) {
	if strings.TrimSpace(existingPrivate) != "" {
		private, err := base64.StdEncoding.DecodeString(strings.TrimSpace(existingPrivate))
		if err != nil || len(private) != curve25519.ScalarSize {
			return nil, domain.Invalidf("that is not a base64 WireGuard private key")
		}
		public, err := curve25519.X25519(private, curve25519.Basepoint)
		if err != nil {
			return nil, err
		}
		return &Keypair{
			Kind:      KeypairWireGuard,
			PublicKey: base64.StdEncoding.EncodeToString(public),
			Note:      "derived from the private key supplied; the private key was not stored.",
		}, nil
	}

	private, public, err := x25519Keypair()
	if err != nil {
		return nil, err
	}
	return &Keypair{
		Kind:       KeypairWireGuard,
		PrivateKey: base64.StdEncoding.EncodeToString(private),
		PublicKey:  base64.StdEncoding.EncodeToString(public),
	}, nil
}

func x25519Keypair() ([]byte, []byte, error) {
	private := make([]byte, curve25519.ScalarSize)
	if _, err := rand.Read(private); err != nil {
		return nil, nil, err
	}
	// Clamped as X25519 requires: the low three bits cleared, the high bit
	// cleared and the second-highest set. An unclamped scalar is a key some
	// implementations quietly accept and others reject.
	private[0] &= 248
	private[31] &= 127
	private[31] |= 64

	public, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		return nil, nil, err
	}
	return private, public, nil
}

// selfSignedCertificate mints a certificate for a server name.
//
// For getting an inbound working before a real certificate exists — subscribers
// have to be told to skip verification, which is why the note says so.
func selfSignedCertificate(serverName string) (*Keypair, error) {
	name := strings.TrimSpace(serverName)
	if name == "" {
		name = "localhost"
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}

	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(1, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	// A name that is an address goes in IPAddresses; a name in DNSNames that is
	// an address matches nothing, and the handshake fails for a reason nobody
	// can see.
	if ip := net.ParseIP(name); ip != nil {
		template.IPAddresses = []net.IP{ip}
	} else {
		template.DNSNames = []string{name}
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}

	return &Keypair{
		Kind:        KeypairTLS,
		Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		PrivateKey:  string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})),
		Note:        "self-signed and valid for one year: subscribers must be told to skip verification.",
	}, nil
}

// openVPNStaticKey produces what `openvpn --genkey secret` writes: 256 random
// bytes as hex between OpenVPN's own markers. tls-auth and tls-crypt take one
// of these rather than a PEM, and both ends of a tunnel carry the same one.
func openVPNStaticKey() (*Keypair, error) {
	material := make([]byte, 256)
	if _, err := rand.Read(material); err != nil {
		return nil, err
	}
	encoded := hex.EncodeToString(material)

	lines := []string{
		"#",
		"# 2048 bit OpenVPN static key",
		"#",
		"-----BEGIN OpenVPN Static key V1-----",
	}
	for offset := 0; offset < len(encoded); offset += 32 {
		lines = append(lines, encoded[offset:offset+32])
	}
	lines = append(lines, "-----END OpenVPN Static key V1-----")

	return &Keypair{
		Kind:   KeypairOpenVPN,
		Secret: strings.Join(lines, "\n"),
		Note:   "the same key goes on both ends of the tunnel.",
	}, nil
}
