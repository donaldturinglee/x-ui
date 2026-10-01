package service

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"net"
	"strings"
	"testing"

	"golang.org/x/crypto/curve25519"
)

func TestRealityKeypairIsAValidX25519Pair(t *testing.T) {
	keypair, err := GenerateKeypair(KeypairReality, "")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}

	// Reality spells these without padding; a padded key is rejected by the
	// clients that parse the link rather than the config.
	private, err := base64.RawURLEncoding.DecodeString(keypair.PrivateKey)
	if err != nil {
		t.Fatalf("private key is not unpadded base64url: %v", err)
	}
	public, err := base64.RawURLEncoding.DecodeString(keypair.PublicKey)
	if err != nil {
		t.Fatalf("public key is not unpadded base64url: %v", err)
	}
	if len(private) != 32 || len(public) != 32 {
		t.Fatalf("key sizes = %d/%d, want 32/32", len(private), len(public))
	}

	// The pair has to actually be a pair.
	derived, err := curve25519.X25519(private, curve25519.Basepoint)
	if err != nil {
		t.Fatalf("X25519: %v", err)
	}
	if base64.RawURLEncoding.EncodeToString(derived) != keypair.PublicKey {
		t.Error("the public key is not derived from the private key")
	}

	// Clamping: the low three bits cleared, the high bit cleared, the
	// second-highest set. An unclamped scalar is a key some implementations
	// quietly accept and others reject.
	if private[0]&7 != 0 {
		t.Errorf("private[0] = %08b, want the low three bits clear", private[0])
	}
	if private[31]&128 != 0 || private[31]&64 == 0 {
		t.Errorf("private[31] = %08b, want the high bit clear and the next set", private[31])
	}
}

func TestKeypairsAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		keypair, err := GenerateKeypair(KeypairReality, "")
		if err != nil {
			t.Fatalf("GenerateKeypair: %v", err)
		}
		if seen[keypair.PrivateKey] {
			t.Fatal("the same private key was generated twice")
		}
		seen[keypair.PrivateKey] = true
	}
}

func TestWireguardKeypairUsesStandardBase64(t *testing.T) {
	keypair, err := GenerateKeypair(KeypairWireGuard, "")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	// WireGuard's own tooling writes padded standard base64, and its config
	// parser expects the same.
	if _, err := base64.StdEncoding.DecodeString(keypair.PrivateKey); err != nil {
		t.Errorf("private key is not standard base64: %v", err)
	}
	if !strings.HasSuffix(keypair.PrivateKey, "=") {
		t.Errorf("private key = %q, want the standard padded form", keypair.PrivateKey)
	}
}

func TestWireguardDerivesFromAGivenPrivateKey(t *testing.T) {
	generated, err := GenerateKeypair(KeypairWireGuard, "")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}

	derived, err := GenerateKeypair(KeypairWireGuard, generated.PrivateKey)
	if err != nil {
		t.Fatalf("GenerateKeypair with a private key: %v", err)
	}
	if derived.PublicKey != generated.PublicKey {
		t.Errorf("derived public key = %q, want %q", derived.PublicKey, generated.PublicKey)
	}
	// The private key was supplied, not minted, so it is not echoed back.
	if derived.PrivateKey != "" {
		t.Error("the supplied private key was returned in the response")
	}
}

func TestWireguardRejectsSomethingThatIsNotAKey(t *testing.T) {
	for _, notAKey := range []string{"hello", "aGVsbG8=", "!!!!"} {
		if _, err := GenerateKeypair(KeypairWireGuard, notAKey); err == nil {
			t.Errorf("GenerateKeypair accepted %q as a private key", notAKey)
		}
	}
}

func TestSelfSignedCertificate(t *testing.T) {
	keypair, err := GenerateKeypair(KeypairTLS, "node.example.com")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}

	block, _ := pem.Decode([]byte(keypair.Certificate))
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatalf("certificate is not a PEM CERTIFICATE block")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("certificate does not parse: %v", err)
	}
	if certificate.Subject.CommonName != "node.example.com" {
		t.Errorf("common name = %q, want the requested name", certificate.Subject.CommonName)
	}
	if len(certificate.DNSNames) != 1 || certificate.DNSNames[0] != "node.example.com" {
		t.Errorf("DNS names = %v, want the requested name", certificate.DNSNames)
	}
	// A certificate with only a common name matches nothing in a modern client:
	// the SAN is what is checked.
	if certificate.NotAfter.Before(certificate.NotBefore) {
		t.Error("the certificate expires before it starts")
	}

	keyBlock, _ := pem.Decode([]byte(keypair.PrivateKey))
	if keyBlock == nil {
		t.Fatal("private key is not a PEM block")
	}
	if _, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes); err != nil {
		t.Errorf("private key does not parse: %v", err)
	}
}

func TestSelfSignedCertificateForAnAddress(t *testing.T) {
	keypair, err := GenerateKeypair(KeypairTLS, "203.0.113.10")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}
	block, _ := pem.Decode([]byte(keypair.Certificate))
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("certificate does not parse: %v", err)
	}

	// An address in DNSNames matches nothing, and the handshake fails for a
	// reason nobody can see.
	if len(certificate.IPAddresses) != 1 || !certificate.IPAddresses[0].Equal(net.ParseIP("203.0.113.10")) {
		t.Errorf("IP addresses = %v, want the requested address", certificate.IPAddresses)
	}
	if len(certificate.DNSNames) != 0 {
		t.Errorf("DNS names = %v, want none for an address", certificate.DNSNames)
	}
}

func TestOpenVPNStaticKeyShape(t *testing.T) {
	keypair, err := GenerateKeypair(KeypairOpenVPN, "")
	if err != nil {
		t.Fatalf("GenerateKeypair: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(keypair.Secret), "\n")
	if lines[3] != "-----BEGIN OpenVPN Static key V1-----" {
		t.Errorf("first marker = %q, want OpenVPN's own", lines[3])
	}
	if lines[len(lines)-1] != "-----END OpenVPN Static key V1-----" {
		t.Errorf("last marker = %q, want OpenVPN's own", lines[len(lines)-1])
	}
	// 256 bytes as hex is 512 characters, in 32-character lines.
	body := lines[4 : len(lines)-1]
	if len(body) != 16 {
		t.Errorf("got %d key lines, want 16", len(body))
	}
	for _, line := range body {
		if len(line) != 32 {
			t.Errorf("key line %q is %d characters, want 32", line, len(line))
		}
	}
}

func TestUnknownKeypairKindIsRefused(t *testing.T) {
	for _, kind := range []string{"", "ech", "rsa"} {
		if _, err := GenerateKeypair(kind, ""); err == nil {
			t.Errorf("GenerateKeypair(%q) was accepted", kind)
		}
	}
}
