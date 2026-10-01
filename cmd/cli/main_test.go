package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/middleware"

	"github.com/gin-gonic/gin"
)

func TestRootCredentialsPrefersTheFlags(t *testing.T) {
	t.Setenv(config.RootUsernameEnv, "from-env")
	t.Setenv(config.RootPasswordEnv, "env-password")

	username, password := rootCredentials("from-flag", "flag-password")

	if username != "from-flag" || password != "flag-password" {
		t.Errorf("got %q/%q, want what the flags said", username, password)
	}
}

func TestRootCredentialsFallsBackToTheEnvironment(t *testing.T) {
	t.Setenv(config.RootUsernameEnv, "from-env")
	t.Setenv(config.RootPasswordEnv, "env-password")

	// The same pair the API reads when it bootstraps at startup, so a
	// deployment that already sets them needs no flags here.
	username, password := rootCredentials("", "")

	if username != "from-env" || password != "env-password" {
		t.Errorf("got %q/%q, want what the environment said", username, password)
	}
}

func TestRootCredentialsFillsEachHalfOnItsOwn(t *testing.T) {
	t.Setenv(config.RootUsernameEnv, "from-env")
	t.Setenv(config.RootPasswordEnv, "env-password")

	// A username on the command line and the password out of the environment
	// is the shape a deploy script wants: the half that is a secret never
	// reaches the process table, where every other user on the host can read
	// it.
	username, password := rootCredentials("from-flag", "")

	if username != "from-flag" || password != "env-password" {
		t.Errorf("got %q/%q, want the flag's username and the environment's password", username, password)
	}
}

func TestProbeTakesWhateverCertificateTheListenerServes(t *testing.T) {
	// Signed by nothing this process trusts -- which is what a certificate
	// issued for the panel's name amounts to at the address the probe dials.
	server := httptest.NewTLSServer(healthz(""))
	defer server.Close()

	if err := probe(context.Background(), listenerOf(t, server, true, "")); err != nil {
		t.Fatalf("probe: %v", err)
	}
}

func TestProbeAsksAsThePanelsDomain(t *testing.T) {
	server := httptest.NewServer(healthz("panel.example.com"))
	defer server.Close()

	if err := probe(context.Background(), listenerOf(t, server, false, "panel.example.com")); err != nil {
		t.Fatalf("probe: %v", err)
	}

	// The panel's own check, so without the name the probe is turned away like
	// anyone else who found the address by scanning.
	if err := probe(context.Background(), listenerOf(t, server, false, "")); err == nil {
		t.Error("probe without the domain was answered; want the domain check to refuse it")
	}
}

// healthz is a panel's /healthz, behind the panel's domain check when it has a
// domain.
func healthz(domain string) http.Handler {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	if domain != "" {
		engine.Use(middleware.DomainValidator(domain))
	}
	engine.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusOK) })
	return engine
}

// listenerOf is the configuration of a panel listening where server does. The
// probe only looks at whether a certificate is set, to choose the scheme, so
// the files named need not exist.
func listenerOf(t *testing.T, server *httptest.Server, https bool, domain string) config.ServerConfig {
	t.Helper()
	host, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	number, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	listener := config.ServerConfig{Listen: host, Port: number, Domain: domain}
	if https {
		listener.CertFile, listener.KeyFile = "fullchain.pem", "privkey.pem"
	}
	return listener
}
