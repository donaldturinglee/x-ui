package service

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// certProbeTimeout bounds the whole probe. It is reachable from an operator
// form, so an unresponsive host must not hold a request open.
const certProbeTimeout = 10 * time.Second

// CertificateProbe is what a server presented.
type CertificateProbe struct {
	Domain string `json:"domain"`
	Port   int    `json:"port"`

	Subject   string   `json:"subject"`
	Issuer    string   `json:"issuer"`
	DNSNames  []string `json:"dnsNames"`
	NotBefore int64    `json:"notBefore"`
	NotAfter  int64    `json:"notAfter"`
	// DaysRemaining is negative once the certificate has expired.
	DaysRemaining int64 `json:"daysRemaining"`
	// SHA256 is the fingerprint a client would pin against.
	SHA256 string `json:"sha256"`
	// SelfSigned reports whether the leaf signed itself.
	SelfSigned bool `json:"selfSigned"`
	// Negotiated is what the handshake settled on.
	TLSVersion string `json:"tlsVersion"`
	ALPN       string `json:"alpn,omitempty"`
}

// ProbeCertificate dials a host and reports the certificate it presents.
//
// Verification is deliberately skipped: the point is to see what is there, and
// refusing to look at a certificate because it does not verify is exactly
// backwards for a diagnostic. Nothing here trusts the result — it is read and
// described, never used to authenticate anything.
func ProbeCertificate(ctx context.Context, domainName string, port string) (*CertificateProbe, error) {
	host := strings.TrimSpace(domainName)
	if host == "" {
		return nil, domain.Invalidf("a domain is required")
	}
	// A host with a scheme or a path is a URL someone pasted, and dialling it
	// fails with an error that does not say so.
	if strings.ContainsAny(host, "/\\ ") {
		return nil, domain.Invalidf("give a host name, not a URL")
	}

	portNumber := 443
	if trimmed := strings.TrimSpace(port); trimmed != "" {
		parsed, err := strconv.Atoi(trimmed)
		if err != nil || parsed < 1 || parsed > 65535 {
			return nil, domain.Invalidf("port %q is not a port number", port)
		}
		portNumber = parsed
	}

	ctx, cancel := context.WithTimeout(ctx, certProbeTimeout)
	defer cancel()

	dialer := &net.Dialer{Timeout: certProbeTimeout, Deadline: deadlineOf(ctx)}
	conn, err := tls.DialWithDialer(
		dialer,
		"tcp",
		net.JoinHostPort(host, strconv.Itoa(portNumber)),
		&tls.Config{
			ServerName:         host,
			InsecureSkipVerify: true,
			NextProtos:         []string{"h2", "http/1.1"},
			MinVersion:         tls.VersionTLS12,
		},
	)
	if err != nil {
		return nil, domain.Invalidf("could not complete a TLS handshake with %s: %v", host, err)
	}
	// Closed on every path: this is reachable from a form, so a host that
	// handshakes but serves nothing usable would otherwise leak a socket per
	// attempt.
	defer conn.Close()

	state := conn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return nil, domain.Invalidf("%s completed a handshake but presented no certificate", host)
	}
	leaf := state.PeerCertificates[0]
	sum := sha256.Sum256(leaf.Raw)

	return &CertificateProbe{
		Domain:        host,
		Port:          portNumber,
		Subject:       leaf.Subject.String(),
		Issuer:        leaf.Issuer.String(),
		DNSNames:      leaf.DNSNames,
		NotBefore:     leaf.NotBefore.Unix(),
		NotAfter:      leaf.NotAfter.Unix(),
		DaysRemaining: int64(time.Until(leaf.NotAfter).Hours() / 24),
		SHA256:        hex.EncodeToString(sum[:]),
		SelfSigned:    isSelfSigned(leaf),
		TLSVersion:    tlsVersionName(state.Version),
		ALPN:          state.NegotiatedProtocol,
	}, nil
}

func deadlineOf(ctx context.Context) time.Time {
	deadline, ok := ctx.Deadline()
	if !ok {
		return time.Now().Add(certProbeTimeout)
	}
	return deadline
}

// isSelfSigned reports whether the leaf signed itself, which is the difference
// between "this needs skip-verify" and "something is wrong with the chain".
func isSelfSigned(certificate *x509.Certificate) bool {
	if certificate.Subject.String() != certificate.Issuer.String() {
		return false
	}
	return certificate.CheckSignatureFrom(certificate) == nil
}

func tlsVersionName(version uint16) string {
	switch version {
	case tls.VersionTLS10:
		return "TLS 1.0"
	case tls.VersionTLS11:
		return "TLS 1.1"
	case tls.VersionTLS12:
		return "TLS 1.2"
	case tls.VersionTLS13:
		return "TLS 1.3"
	}
	return "unknown"
}
