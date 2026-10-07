// Command api serves the panel: the HTTP API, and the static assets the
// browser UI is loaded from.
//
// It migrates the database on startup, so a deploy that rolls the API forward
// does not need a separate migration step. The worker does the same, and both
// take an advisory lock first, so starting them together is safe.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/handler"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-contrib/gzip"
	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
)

// sessionSecretBytes is the size of a generated session secret.
const sessionSecretBytes = 32

func main() {
	if err := run(); err != nil {
		logger.Error(err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))
	logger.Info(config.Name, " ", config.Version, " starting")

	db, err := database.Open(cfg.Database, cfg.Log.Debug())
	if err != nil {
		return err
	}
	defer func() {
		if err := database.Close(db); err != nil {
			logger.Warning("unable to close the database: ", err)
		}
	}()

	startupCtx, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()

	if err := database.Ping(startupCtx, db); err != nil {
		return err
	}
	if err := database.Migrate(startupCtx, db, cfg.Database.MigrationsDir); err != nil {
		return err
	}

	store := repository.NewStore(db)
	users := service.NewUserService(store)
	clients := service.NewClientService(store)
	links := service.NewLinkService(store)
	inbounds := service.NewInboundService(store)
	outbounds := service.NewOutboundService(store)
	settings := service.NewSettingService(store)
	subscriptions := service.NewSubscriptionService(store, settings, links)
	telegram := service.NewTelegramService(settings)
	configs := service.NewConfigService(store, settings, inbounds, outbounds)
	system := service.NewSystemService(store, settings)
	stats := service.NewStatsService(store, cfg.Worker.StatsBucket.Duration(), cfg.Worker.StatsRetention.Duration())
	panel := service.NewPanelService(store, clients, inbounds, outbounds, settings, configs, stats)

	if err := settings.SetVersion(startupCtx, config.Version); err != nil {
		logger.Warning("unable to record the running version: ", err)
	}
	if err := bootstrapAdmin(startupCtx, users); err != nil {
		return err
	}

	tokens := middleware.NewTokenAuthenticator(users)
	if err := tokens.Reload(startupCtx); err != nil {
		return fmt.Errorf("load API tokens: %w", err)
	}

	engine, err := buildRouter(cfg, routerDeps{
		users:         users,
		clients:       clients,
		links:         links,
		subscriptions: subscriptions,
		inbounds:      inbounds,
		outbounds:     outbounds,
		configs:       configs,
		settings:      settings,
		telegram:      telegram,
		system:        system,
		stats:         stats,
		panel:         panel,
		tokens:        tokens,
		health:        database.NewHealth(db),
	})
	if err != nil {
		return err
	}

	subscriptionEngine, err := buildSubscriptionRouter(cfg, subscriptions)
	if err != nil {
		return err
	}

	return serve(cfg, engine, subscriptionEngine)
}

// buildSubscriptionRouter assembles the listener subscribers reach. It returns
// nil when subscriptions are switched off, which is a legitimate deployment for
// a panel that distributes configurations some other way.
func buildSubscriptionRouter(cfg *config.Config, subscriptions *service.SubscriptionService) (*gin.Engine, error) {
	if !cfg.Subscription.Enabled {
		logger.Info("subscriptions are disabled")
		return nil, nil
	}

	engine := gin.New()
	engine.Use(middleware.Recovery(), middleware.Logging())

	// Its own proxy list, because it is usually behind a different one: this
	// port faces every subscriber, the panel's faces an operator.
	if err := engine.SetTrustedProxies(cfg.Subscription.TrustedProxies); err != nil {
		return nil, err
	}
	if cfg.Subscription.Domain != "" {
		engine.Use(middleware.DomainValidator(cfg.Subscription.Domain))
	}
	// No gzip: the bodies are small, and a compressed response whose size
	// varies with the subscriber's data is a side channel worth not opening.

	handler.NewSubscriptionHandler(subscriptions).Register(engine.Group(cfg.Subscription.Base()))

	// Anything outside the mount point is answered as though nothing is here.
	engine.NoRoute(func(c *gin.Context) {
		c.Status(http.StatusNotFound)
	})
	return engine, nil
}

// bootstrapAdmin creates the first account when the panel has none.
//
// The credentials come from the environment and are never invented. A panel
// that bootstraps itself with a default password is reachable by anyone who
// read the README, and the window between install and the first sign-in is
// exactly when nobody is watching.
func bootstrapAdmin(ctx context.Context, users *service.UserService) error {
	username := os.Getenv(config.RootUsernameEnv)
	password := os.Getenv(config.RootPasswordEnv)
	if username == "" || password == "" {
		count, err := users.Count(ctx)
		if err != nil {
			return err
		}
		if count == 0 {
			logger.Warning("no operator account exists: create one with `x-ui-cli admin -username <name> -password <pass>`")
		}
		return nil
	}

	created, err := users.EnsureInitialUser(ctx, username, password)
	if err != nil {
		return fmt.Errorf("create the first operator account: %w", err)
	}
	if created {
		logger.Info("created the first operator account: ", username)
	}
	return nil
}

type routerDeps struct {
	users         *service.UserService
	clients       *service.ClientService
	links         *service.LinkService
	subscriptions *service.SubscriptionService
	inbounds      *service.InboundService
	outbounds     *service.OutboundService
	configs       *service.ConfigService
	settings      *service.SettingService
	telegram      *service.TelegramService
	system        *service.SystemService
	stats         *service.StatsService
	panel         *service.PanelService
	tokens        *middleware.TokenAuthenticator
	health        handler.Pinger
}

func buildRouter(cfg *config.Config, deps routerDeps) (*gin.Engine, error) {
	if cfg.Log.Debug() {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()
	engine.Use(middleware.Recovery(), middleware.Logging())

	// gin trusts every proxy by default, so any client could set
	// X-Forwarded-For and forge the address written to the sign-in log and
	// counted by the rate limiter. An empty list trusts none of them, and a
	// direct client is reported by the address it actually connected from.
	if err := engine.SetTrustedProxies(cfg.Server.TrustedProxies); err != nil {
		return nil, err
	}

	if cfg.Server.Domain != "" {
		engine.Use(middleware.DomainValidator(cfg.Server.Domain))
	}
	engine.Use(gzip.Gzip(gzip.DefaultCompression))

	secret, err := sessionSecret(cfg)
	if err != nil {
		return nil, err
	}
	store := cookie.NewStore(secret)
	// The per-session options set at sign-in only reach the cookie the sign-in
	// response writes. Without the same lifetime on the store, every later
	// response rewrites the cookie as a session cookie, so a configured
	// lifetime lasts until the browser closes whatever the operator set.
	store.Options(middleware.BaseSessionOptions(cfg.Session.MaxAge.Duration()))
	engine.Use(sessions.Sessions(middleware.SessionName, store))

	base := cfg.Server.Base()

	userHandler := handler.NewUserHandler(deps.users, deps.tokens, deps.telegram, cfg.Session.MaxAge.Duration())
	clientHandler := handler.NewClientHandler(deps.clients, deps.links, cfg.Subscription, deps.subscriptions)
	inboundHandler := handler.NewInboundHandler(deps.inbounds)
	outboundHandler := handler.NewOutboundHandler(deps.outbounds)
	configHandler := handler.NewConfigHandler(deps.configs)
	panelHandler := handler.NewPanelHandler(deps.panel)
	settingHandler := handler.NewSettingHandler(deps.settings, deps.telegram, cfg)
	systemHandler := handler.NewSystemHandler(deps.system)
	statsHandler := handler.NewStatsHandler(deps.stats, deps.settings, deps.health)
	upgradeHandler := handler.NewUpgradeHandler(service.NewUpgradeService(cfg))
	coreVersionHandler := handler.NewCoreVersionHandler(service.NewCoreVersionService(deps.settings))

	// Liveness sits at the root whatever the base path, and behind no
	// authentication, because a load balancer and the CLI's healthcheck have no
	// credentials. The panel is at the root too by default, but it only answers
	// what no route matched, so it never answers in place of this.
	statsHandler.RegisterHealth(engine)

	// Two ways in, the same endpoints behind each.
	//
	// The cookie API needs the same-origin check: a session travels
	// automatically, so without it any page an operator visits can act in their
	// name. The token API does not, because a cross-site page cannot set a
	// Token header without a CORS preflight the panel never answers.
	public := engine.Group(base+"api", middleware.SameOrigin(), handler.HostMaintenance(config.Dir()))
	userHandler.RegisterPublic(public)

	session := engine.Group(base+"api", middleware.SameOrigin(), middleware.RequireSession(), handler.HostMaintenance(config.Dir()))
	token := engine.Group(base+"apiv2", deps.tokens.RequireToken(), handler.HostMaintenance(config.Dir()))

	for _, group := range []*gin.RouterGroup{session, token} {
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

	mountWebUI(engine, cfg, base)
	return engine, nil
}

// mountWebUI serves the browser panel, which is not required. The built React
// panel is served when it is there, and without it the API is served alone --
// a legitimate deployment, since a node agent and a script need no panel.
func mountWebUI(engine *gin.Engine, cfg *config.Config, base string) {
	panelBuild := filepath.Join(cfg.Server.WebDir, "build")
	if _, err := os.Stat(filepath.Join(panelBuild, "index.html")); err != nil {
		logger.Warning("no panel at ", panelBuild, ": serving the API only. Build it with `npm run build` in web")
		return
	}

	mountPanel(engine, panelBuild, base)
}

// mountPanel serves the built single-page panel.
//
// Only `assets` is served as a directory. Vite puts everything it emits there
// under a hashed name, so there is nothing else to reach — and serving the
// build directory wholesale would answer for any path that happened to match a
// file in it.
func mountPanel(engine *gin.Engine, buildDir string, base string) {
	logger.Info("serving the panel from ", buildDir)
	engine.Static(base+"assets", filepath.Join(buildDir, "assets"))

	index := filepath.Join(buildDir, "index.html")
	// The build uses relative asset paths. This base also supplies the router
	// and API paths, so moving the panel does not require rebuilding its UI.
	runtime, _ := json.Marshal(map[string]string{"basePath": base})
	runtimeHTML := fmt.Sprintf(`<base href="%s"><script id="x-ui-runtime" type="application/json">%s</script>`, html.EscapeString(base), runtime)

	engine.NoRoute(underBase(base, func(c *gin.Context) {
		// The panel is one page: every path under the base returns it and the
		// client-side router decides what to render. A reload on a deep link
		// therefore works rather than 404ing.
		//
		// It is answered as no-store because the file names the hashed assets
		// for this build, and a cached one would name the last build's.
		c.Header("Cache-Control", "no-store")
		data, err := os.ReadFile(index)
		if err != nil {
			httputil.Internal(c)
			return
		}
		page := strings.Replace(string(data), "<head>", "<head>"+runtimeHTML, 1)
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(page))
	}))
}

// underBase answers a request for the panel, and refuses anything outside it.
func underBase(base string, serve gin.HandlerFunc) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path

		// /panel and /panel/ are the same place to whoever typed it, and only
		// one of them matches the prefix below. The root has no such twin.
		if path == strings.TrimSuffix(base, "/") {
			c.Redirect(http.StatusTemporaryRedirect, base)
			return
		}
		// Anything outside the base is not ours to answer.
		if !strings.HasPrefix(path, base) {
			c.Status(http.StatusNotFound)
			return
		}
		// An unrouted path under the API is still the API's. Handing back the
		// panel would answer a request for JSON with a page and a 200, and a
		// mistyped endpoint would look like it had worked.
		if underAPI(base, path) {
			httputil.Fail(c, http.StatusNotFound, "no such endpoint")
			return
		}
		serve(c)
	}
}

// underAPI reports whether a path belongs to one of the two API prefixes.
//
// Matched a segment at a time: `/apiary` is a page the panel may route to one
// day, and it is not `/api`.
func underAPI(base string, path string) bool {
	for _, prefix := range []string{base + "api", base + "apiv2"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

// sessionSecret returns the configured secret, or a generated one.
//
// A generated secret means every operator is logged out on restart, which is
// tolerable in development and is why the configuration refuses an empty one in
// production.
func sessionSecret(cfg *config.Config) ([]byte, error) {
	if cfg.Session.Secret != "" {
		return []byte(cfg.Session.Secret), nil
	}
	generated, err := service.RandomSecret(sessionSecretBytes)
	if err != nil {
		return nil, err
	}
	logger.Warning("no session secret configured: generated one, every session ends at restart")
	return []byte(generated), nil
}

// listenerSpec is everything one of the two servers needs to come up.
type listenerSpec struct {
	name     string
	addr     string
	base     string
	certFile string
	keyFile  string
	engine   *gin.Engine

	readHeaderTimeout time.Duration
	readTimeout       time.Duration
	writeTimeout      time.Duration
	idleTimeout       time.Duration
}

// start binds the address and serves on it, reporting any error that is not a
// clean shutdown on errCh.
func (spec listenerSpec) start(errCh chan<- error) (*http.Server, error) {
	listener, err := net.Listen("tcp", spec.addr)
	if err != nil {
		return nil, fmt.Errorf("listen for the %s: %w", spec.name, err)
	}

	scheme := "http"
	if spec.certFile != "" && spec.keyFile != "" {
		cert, err := tls.LoadX509KeyPair(spec.certFile, spec.keyFile)
		if err != nil {
			listener.Close()
			return nil, fmt.Errorf("load the %s TLS certificate: %w", spec.name, err)
		}
		listener = tls.NewListener(listener, &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		})
		scheme = "https"
	}
	logger.Info(spec.name, " listening on ", scheme, "://", listener.Addr(), spec.base)

	server := &http.Server{
		Handler: spec.engine,
		// Without a header deadline a connection that never finishes its
		// request headers holds a goroutine and a descriptor for good.
		ReadHeaderTimeout: spec.readHeaderTimeout,
		ReadTimeout:       spec.readTimeout,
		WriteTimeout:      spec.writeTimeout,
		IdleTimeout:       spec.idleTimeout,
	}

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	return server, nil
}

// serve runs the panel and, when it is enabled, the subscription listener
// beside it.
//
// They are separate listeners in one process rather than one listener serving
// both: the panel should be reachable by a handful of people and the
// subscription endpoint by everyone who was sold one, so they get their own
// port, their own certificate and their own host check. If a failure on either
// brings the process down, both stop — which is the right coupling, because a
// panel whose subscriptions are unreachable is not serving either.
func serve(cfg *config.Config, panel *gin.Engine, subscriptions *gin.Engine) error {
	errCh := make(chan error, 2)
	var servers []*http.Server

	stopAll := func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout.Duration())
		defer cancel()
		for _, server := range servers {
			if err := server.Shutdown(shutdownCtx); err != nil {
				// Shutdown returning means the deadline passed with requests
				// still in flight. Closing outright is the only thing left, and
				// saying so beats hanging until the supervisor kills us.
				logger.Warning("graceful shutdown timed out: ", err)
				_ = server.Close()
			}
		}
	}

	specs := []listenerSpec{{
		name:              "panel",
		addr:              cfg.Server.Addr(),
		base:              cfg.Server.Base(),
		certFile:          cfg.Server.CertFile,
		keyFile:           cfg.Server.KeyFile,
		engine:            panel,
		readHeaderTimeout: cfg.Server.ReadHeaderTimeout.Duration(),
		readTimeout:       cfg.Server.ReadTimeout.Duration(),
		writeTimeout:      cfg.Server.WriteTimeout.Duration(),
		idleTimeout:       cfg.Server.IdleTimeout.Duration(),
	}}
	if subscriptions != nil {
		specs = append(specs, listenerSpec{
			name:              "subscriptions",
			addr:              cfg.Subscription.Addr(),
			base:              cfg.Subscription.Base(),
			certFile:          cfg.Subscription.CertFile,
			keyFile:           cfg.Subscription.KeyFile,
			engine:            subscriptions,
			readHeaderTimeout: cfg.Subscription.ReadHeaderTimeout.Duration(),
			readTimeout:       cfg.Subscription.ReadTimeout.Duration(),
			writeTimeout:      cfg.Subscription.WriteTimeout.Duration(),
			idleTimeout:       cfg.Subscription.IdleTimeout.Duration(),
		})
	}

	for _, spec := range specs {
		server, err := spec.start(errCh)
		if err != nil {
			// Whatever came up already is taken down again, so a failure on the
			// second listener does not leave the first one orphaned.
			stopAll()
			return err
		}
		servers = append(servers, server)
	}
	if err := service.RecordPanelProcess("api", cfg); err != nil {
		logger.Warning("unable to record Panel restart readiness: ", err)
	}
	if err := service.CheckpointPanelConfiguration(cfg); err != nil {
		logger.Warning("unable to checkpoint Panel configuration: ", err)
	}

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		stopAll()
		return err
	case sig := <-sigCh:
		logger.Info("received ", sig, ", shutting down")
	}

	stopAll()
	logger.Info("stopped")
	return nil
}
