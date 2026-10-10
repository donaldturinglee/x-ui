package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"

	"github.com/gin-gonic/gin"
)

// mountAPI registers every handler the way the API server does.
//
// No database is touched: registration only builds the routing tree, so the
// repositories are handed a nil handle and never asked anything.
func mountAPI() *gin.Engine {
	gin.SetMode(gin.TestMode)

	store := repository.NewStore(nil)
	users := service.NewUserService(store)

	settings := service.NewSettingService(store)
	telegram := service.NewTelegramService(settings)
	clients := service.NewClientService(store)
	inbounds := service.NewInboundService(store)
	outbounds := service.NewOutboundService(store)
	configs := service.NewConfigService(store, settings, inbounds, outbounds)
	stats := service.NewStatsService(store, 0, 0)

	userHandler := NewUserHandler(users, middleware.NewTokenAuthenticator(users), telegram, 0)
	links := service.NewLinkService(store)
	clientHandler := NewClientHandler(clients, links, config.SubscriptionConfig{}, service.NewSubscriptionService(store, settings, links))
	inboundHandler := NewInboundHandler(inbounds)
	outboundHandler := NewOutboundHandler(outbounds)
	configHandler := NewConfigHandler(configs)
	panelHandler := NewPanelHandler(service.NewPanelService(store, clients, inbounds, outbounds, settings, configs, stats))
	settingHandler := NewSettingHandler(settings, telegram, config.Default())
	systemHandler := NewSystemHandler(service.NewSystemService(store, settings))
	statsHandler := NewStatsHandler(stats, settings, nil)
	upgradeHandler := NewUpgradeHandler(service.NewUpgradeService(config.Default()))
	coreVersionHandler := NewCoreVersionHandler(service.NewCoreVersionService(settings))

	engine := gin.New()
	statsHandler.RegisterHealth(engine)

	public := engine.Group("/api")
	userHandler.RegisterPublic(public)

	// Both prefixes carry the same endpoints, which is also what checks that
	// registering them twice on one engine is possible at all.
	for _, prefix := range []string{"/api", "/apiv2"} {
		group := engine.Group(prefix)
		userHandler.Register(group)
		clientHandler.Register(group)
		inboundHandler.Register(group)
		outboundHandler.Register(group)
		configHandler.Register(group)
		panelHandler.Register(group)
		settingHandler.Register(group)
		systemHandler.Register(group)
		statsHandler.Register(group)
		upgradeHandler.Register(group)
		coreVersionHandler.Register(group)
	}

	return engine
}

// TestRegisterMountsEveryRouteWithoutConflict checks the tree the API server
// builds at startup.
//
// Route registration panics on an ambiguous tree -- a static segment beside a
// parameter at the same position -- and that panic happens at startup, on a
// path no test exercising one endpoint at a time would reach. The cheapest
// place to find out is here.
func TestRegisterMountsEveryRouteWithoutConflict(t *testing.T) {
	registered := map[string]bool{}
	for _, route := range mountAPI().Routes() {
		registered[route.Method+" "+route.Path] = true
	}

	want := []string{
		"GET /healthz",
		"GET /api/signin/config",
		"POST /api/signin",
		"POST /api/signout",
		"GET /api/me",
		"POST /api/me/credentials",
		"POST /api/me/two-factor/setup",
		"POST /api/me/two-factor/enable",
		"POST /api/me/two-factor/disable",
		"GET /api/users",
		"GET /api/tokens",
		"POST /api/tokens",
		"DELETE /api/tokens/:id",
		"GET /api/clients",
		"POST /api/clients",
		"GET /api/clients/:id",
		"POST /api/clients/:id",
		"DELETE /api/clients/:id",
		"GET /api/clients/:id/links",
		"GET /api/clients/:id/subscription-info",
		"POST /api/clients/:id/reset-traffic",
		"GET /api/client-groups",
		"POST /api/traffic",
		"POST /api/traffic/reset",
		"GET /api/inbounds",
		"POST /api/inbounds",
		"GET /api/inbounds/:id",
		"POST /api/inbounds/:id",
		"DELETE /api/inbounds/:id",
		"GET /api/outbounds",
		"POST /api/outbounds",
		"GET /api/outbounds/:id",
		"POST /api/outbounds/:id",
		"DELETE /api/outbounds/:id",
		"POST /api/outbounds/:id/check",
		"GET /api/config",
		"GET /api/config/download",
		"GET /api/config/base",
		"POST /api/config/base",
		"POST /api/config/base/reset",
		"GET /api/load",
		"GET /api/settings",
		"POST /api/settings",
		"POST /api/settings/reset",
		"GET /api/settings/startup",
		"GET /api/settings/panel",
		"POST /api/settings/panel",
		"POST /api/settings/panel/restart",
		"GET /api/settings/panel/restart/:id",
		"GET /api/settings/subscription",
		"POST /api/settings/subscription",
		"POST /api/settings/apply",
		"GET /api/settings/apply/:id",
		"POST /api/telegram/test",
		"GET /api/maintenance",
		"POST /api/maintenance",
		"GET /api/system",
		"GET /api/upgrade",
		"POST /api/upgrade/check",
		"POST /api/upgrade",
		"GET /api/upgrade/jobs/:id",
		"GET /api/core",
		"POST /api/core/restart",
		"GET /api/core/restart/:id",
		"GET /api/core/logs",
		"GET /api/core/versions",
		"POST /api/core/version/check",
		"POST /api/core/version",
		"GET /api/core/version/jobs/:id",
		"GET /api/keypairs",
		"POST /api/cert-probe",
		"GET /api/backup",
		"POST /api/backup/restore",
		"GET /api/stats",
		"GET /api/onlines",
		"GET /api/changes",
		"GET /api/logs",
		"GET /api/status",
		// The token prefix carries everything except the session endpoints.
		"GET /apiv2/clients",
		"POST /apiv2/traffic",
	}

	for _, route := range want {
		if !registered[route] {
			t.Errorf("route %q is not registered", route)
		}
	}
}

// TestRemovedObjectsAreNotMounted keeps the endpoints, services, separate TLS
// configurations and certificate providers gone. A WireGuard tunnel is an
// outbound now, services pass through from the base document, and a listener
// carries its own TLS; a path still answering for any of them would be writing
// somewhere nothing reads.
func TestRemovedObjectsAreNotMounted(t *testing.T) {
	for _, route := range mountAPI().Routes() {
		for _, removed := range []string{"endpoints", "services", "tls", "certificate-providers"} {
			if strings.HasSuffix(route.Path, "/"+removed) || strings.Contains(route.Path, "/"+removed+"/") {
				t.Errorf("%s %s is still mounted", route.Method, route.Path)
			}
		}
	}
}

// TestOnlyGetPostAndDeleteAreMounted holds the API to three methods.
//
// An update is a POST to the record's own path rather than a PUT. A panel is
// reached through whatever sits in front of it -- a corporate proxy, an
// embedded webview, a captive network's filter -- and the three are the ones
// those are relied on to forward. Keeping to them is cheaper than finding out
// per deployment which of the rest survive the trip.
func TestOnlyGetPostAndDeleteAreMounted(t *testing.T) {
	allowed := map[string]bool{
		http.MethodGet:    true,
		http.MethodPost:   true,
		http.MethodDelete: true,
	}

	for _, route := range mountAPI().Routes() {
		if !allowed[route.Method] {
			t.Errorf("%s %s is outside GET, POST and DELETE", route.Method, route.Path)
		}
	}
}

// TestSignInIsNotMountedBehindTheTokenPrefix keeps the two schemes from
// overlapping. A password sign-in reachable with a token would let a token
// escalate into a session, and a session is what the same-origin check
// protects.
func TestSignInIsNotMountedBehindTheTokenPrefix(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store := repository.NewStore(nil)
	users := service.NewUserService(store)
	userHandler := NewUserHandler(users, middleware.NewTokenAuthenticator(users), nil, 0)

	engine := gin.New()
	userHandler.RegisterPublic(engine.Group("/api"))
	userHandler.Register(engine.Group("/apiv2"))

	for _, route := range engine.Routes() {
		if strings.HasPrefix(route.Path, "/apiv2/signin") || route.Path == "/apiv2/signout" {
			t.Errorf("%s is mounted behind the token prefix", route.Path)
		}
	}
}
