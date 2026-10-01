package agent

import (
	"context"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPanelClientConnectsLocallyWithPanelsTLSName(t *testing.T) {
	name := ""
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != name {
			t.Errorf("Host = %q, want %q", r.Host, name)
		}
		if r.Header.Get("Token") != "node-token" {
			t.Errorf("Token header = %q", r.Header.Get("Token"))
		}
		if r.URL.Path != "/apiv2/config/download" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"inbounds":[],"outbounds":[]}`))
	}))
	defer server.Close()

	// Trust this test listener, but require its DNS name while dialling the IP
	// in server.URL. This is the same shape as a combined panel/node host.
	certificate := server.Certificate()
	if len(certificate.DNSNames) == 0 {
		t.Fatal("test certificate has no DNS name")
	}
	name = certificate.DNSNames[0]
	client := NewPanelClient(PanelConfig{
		URL:     server.URL + "/apiv2",
		Host:    name,
		Token:   "node-token",
		Timeout: Duration(5 * time.Second),
	})
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	client.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool

	result, err := client.FetchConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Document) != `{"inbounds":[],"outbounds":[]}` {
		t.Errorf("document = %s", result.Document)
	}
}
