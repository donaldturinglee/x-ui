package handler

import (
	"net/http"

	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/gin-gonic/gin"
)

type CoreVersionHandler struct{ versions *service.CoreVersionService }

func NewCoreVersionHandler(versions *service.CoreVersionService) *CoreVersionHandler {
	return &CoreVersionHandler{versions: versions}
}

func (h *CoreVersionHandler) Register(group *gin.RouterGroup) {
	group.GET("/core/versions", h.status)
	group.POST("/core/version/check", h.check)
	group.POST("/core/version", h.queue)
	group.GET("/core/version/jobs/:id", h.job)
}

func (h *CoreVersionHandler) status(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	state, err := h.versions.Status(c.Request.Context(), c.Query("refresh") == "true")
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, state)
}

func (h *CoreVersionHandler) check(c *gin.Context) {
	var request *struct {
		Version string `json:"version"`
	}
	if !upgradeBody(c, &request) {
		return
	}
	if request == nil {
		httputil.Fail(c, 400, "Select one official target version")
		return
	}
	checked, err := h.versions.Check(c.Request.Context(), request.Version)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	// Keep installation paths and the private recovery snapshot on the server.
	httputil.Data(c, gin.H{"checkId": checked.ID, "checkedAt": checked.CheckedAt, "currentVersion": checked.CurrentVersion,
		"configRevision": checked.ConfigRevision, "direction": checked.Direction, "target": checked.Target})
}

func (h *CoreVersionHandler) queue(c *gin.Context) {
	var request *service.CoreVersionRequest
	if !upgradeBody(c, &request) {
		return
	}
	if request == nil {
		httputil.Fail(c, 400, "Confirm the checked version")
		return
	}
	job, err := h.versions.Queue(c.Request.Context(), middleware.CurrentUser(c), *request)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, httputil.Response{Success: true, Obj: job})
}

func (h *CoreVersionHandler) job(c *gin.Context) {
	job, err := h.versions.Job(c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, job)
}
