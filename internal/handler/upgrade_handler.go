package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/gin-gonic/gin"
)

type UpgradeHandler struct{ upgrade *service.UpgradeService }

func NewUpgradeHandler(upgrade *service.UpgradeService) *UpgradeHandler {
	return &UpgradeHandler{upgrade: upgrade}
}

func (h *UpgradeHandler) Register(group *gin.RouterGroup) {
	group.GET("/upgrade", h.status)
	group.POST("/upgrade/check", h.check)
	group.POST("/upgrade", h.queue)
	group.GET("/upgrade/jobs/:id", h.job)
}

func (h *UpgradeHandler) status(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	state, err := h.upgrade.Status(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, state)
}

func upgradeBody(c *gin.Context, target any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2048)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		httputil.Fail(c, 400, "Send a valid upgrade JSON object")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		httputil.Fail(c, 400, "Send one JSON object")
		return false
	}
	return true
}

func (h *UpgradeHandler) check(c *gin.Context) {
	var request *struct{}
	if !upgradeBody(c, &request) {
		return
	}
	if request == nil {
		httputil.Fail(c, 400, "Send an empty JSON object")
		return
	}
	state, err := h.upgrade.Check(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, state)
}

func (h *UpgradeHandler) queue(c *gin.Context) {
	var request *service.UpgradeRequest
	if !upgradeBody(c, &request) {
		return
	}
	if request == nil {
		httputil.Fail(c, 400, "Confirm the checked release")
		return
	}
	job, err := h.upgrade.Queue(c.Request.Context(), middleware.CurrentUser(c), *request)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, httputil.Response{Success: true, Obj: job})
}

func (h *UpgradeHandler) job(c *gin.Context) {
	job, err := h.upgrade.Job(c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, job)
}

// Queues and startup settings own their gate in the service layer. Other
// writes hold it through their handler, including token-based traffic reports.
func HostMaintenance(directory string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions {
			c.Next()
			return
		}
		for _, suffix := range []string{"/upgrade", "/upgrade/check", "/settings/panel", "/settings/subscription", "/settings/apply", "/settings/panel/restart", "/core/restart", "/core/version", "/core/version/check", "/backup/restore"} {
			if strings.HasSuffix(c.FullPath(), suffix) {
				c.Next()
				return
			}
		}
		unlock, err := service.BeginHostWrite(directory)
		if err != nil {
			fail(c, err)
			return
		}
		defer unlock()
		c.Next()
	}
}
