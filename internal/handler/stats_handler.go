package handler

import (
	"context"
	"net/http"
	"runtime"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-gonic/gin"
)

// maxReportsPerRequest bounds one ingest batch. A node with a thousand busy
// clients still fits comfortably; anything past this is a client that has
// stopped reporting and is now trying to catch up in one request.
const maxReportsPerRequest = 10000

// healthTimeout bounds the database check behind /healthz, so a probe answers
// promptly even when the database is the thing that is wrong.
const healthTimeout = 3 * time.Second

// Pinger reports whether the datastore is reachable.
type Pinger interface {
	Ping(ctx context.Context) error
}

// StatsHandler serves traffic reporting, the charts built from it, the audit
// log and the panel's own status.
type StatsHandler struct {
	stats     *service.StatsService
	settings  *service.SettingService
	pinger    Pinger
	startedAt time.Time
}

func NewStatsHandler(stats *service.StatsService, settings *service.SettingService, pinger Pinger) *StatsHandler {
	return &StatsHandler{
		stats:     stats,
		settings:  settings,
		pinger:    pinger,
		startedAt: time.Now(),
	}
}

func (h *StatsHandler) Register(g *gin.RouterGroup) {
	g.POST("/traffic", h.ingest)
	g.GET("/stats", h.query)
	g.GET("/onlines", h.onlines)
	g.GET("/changes", h.changes)
	g.GET("/logs", h.logs)
	g.GET("/status", h.status)
}

// RegisterHealth mounts the unauthenticated liveness endpoint. It is separate
// because a load balancer and the CLI's healthcheck have no credentials, and
// it answers with nothing an anonymous caller could learn from.
func (h *StatsHandler) RegisterHealth(r gin.IRoutes) {
	r.GET("/healthz", h.health)
}

type ingestRequest struct {
	Reports []domain.TrafficReport `json:"reports"`
}

func (h *StatsHandler) ingest(c *gin.Context) {
	var req ingestRequest
	if !bind(c, &req) {
		return
	}
	if len(req.Reports) > maxReportsPerRequest {
		httputil.Fail(c, http.StatusRequestEntityTooLarge, "too many reports in one request")
		return
	}
	if err := h.stats.Ingest(c.Request.Context(), req.Reports); err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{"accepted": len(req.Reports)})
}

func (h *StatsHandler) query(c *gin.Context) {
	series, err := h.stats.Query(
		c.Request.Context(),
		c.Query("resource"),
		c.Query("tag"),
		intQuery(c, "hours", 24),
		int64Query(c, "start"),
		int64Query(c, "end"),
	)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, series)
}

func (h *StatsHandler) onlines(c *gin.Context) {
	onlines, err := h.stats.Onlines(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, onlines)
}

func (h *StatsHandler) changes(c *gin.Context) {
	changes, err := h.stats.Changes(c.Request.Context(), repository.ChangeFilter{
		Actor: c.Query("actor"),
		Key:   c.Query("key"),
		Limit: intQuery(c, "limit", 100),
	})
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, changes)
}

func (h *StatsHandler) logs(c *gin.Context) {
	count := intQuery(c, "count", 100)
	if count < 1 || count > 1000 {
		count = 100
	}
	level := c.DefaultQuery("level", "info")
	httputil.Data(c, logger.GetLogs(count, level))
}

func (h *StatsHandler) status(c *gin.Context) {
	maintenance, err := h.settings.Maintenance(c.Request.Context())
	if err != nil {
		// Worth reporting, not worth refusing the whole status over: an
		// operator asking for status is usually asking because something is
		// already wrong.
		logger.Warning("unable to read maintenance setting: ", err)
	}

	httputil.Data(c, gin.H{
		"name":        config.Name,
		"version":     config.Version,
		"go":          runtime.Version(),
		"os":          runtime.GOOS,
		"uptime":      int64(time.Since(h.startedAt).Seconds()),
		"maintenance": maintenance,
	})
}

func (h *StatsHandler) health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), healthTimeout)
	defer cancel()

	if err := h.pinger.Ping(ctx); err != nil {
		logger.Warning("health check failed: ", err)
		// The reason goes to the log, not to an unauthenticated caller: it
		// names the database host and user.
		httputil.Fail(c, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	httputil.Data(c, gin.H{"status": "ok", "version": config.Version})
}
