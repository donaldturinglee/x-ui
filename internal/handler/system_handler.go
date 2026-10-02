package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// maxBackupUpload caps a restore. The file is parsed in memory, so the upload
// is bounded by something other than trust.
const maxBackupUpload = 256 << 20

// SystemHandler serves the tools an operator reaches for around the panel
// rather than inside it: what the host is doing, key material, a look at
// somebody's certificate, and a copy of everything.
type SystemHandler struct {
	system *service.SystemService
	core   *service.CoreService
}

func NewSystemHandler(system *service.SystemService) *SystemHandler {
	return &SystemHandler{system: system, core: service.NewCoreService(system.Settings())}
}

func (h *SystemHandler) Register(g *gin.RouterGroup) {
	g.GET("/system", h.status)
	g.GET("/core", h.coreStatus)
	g.POST("/core/restart", h.restartCore)
	g.GET("/core/restart/:id", h.coreRestartJob)
	g.GET("/core/logs", h.coreLogs)
	g.GET("/keypairs", h.keypair)
	g.POST("/cert-probe", h.certProbe)
	g.GET("/backup", h.backup)
	g.POST("/backup/restore", h.restore)
}

func (h *SystemHandler) coreStatus(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, h.core.Status(c.Request.Context()))
}

func (h *SystemHandler) restartCore(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1024)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	var request *struct{}
	if err := decoder.Decode(&request); err != nil || request == nil {
		httputil.Fail(c, http.StatusBadRequest, "Send an empty JSON object to restart the local sing-box service")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		httputil.Fail(c, http.StatusBadRequest, "Send one JSON object")
		return
	}
	job, err := h.core.Queue(c.Request.Context(), middleware.CurrentUser(c))
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, httputil.Response{Success: true, Obj: job})
}

func (h *SystemHandler) coreRestartJob(c *gin.Context) {
	job, err := h.core.Job(c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, job)
}

func (h *SystemHandler) coreLogs(c *gin.Context) {
	lines, err := h.core.Logs(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, struct {
		Lines []string `json:"lines"`
	}{Lines: lines})
}

func (h *SystemHandler) status(c *gin.Context) {
	httputil.Data(c, h.system.Status(c.Request.Context()))
}

func (h *SystemHandler) keypair(c *gin.Context) {
	keypair, err := h.system.Keypair(c.Query("kind"), c.Query("options"))
	if err != nil {
		fail(c, err)
		return
	}
	// Generated, returned once, never stored. Caches in between have no
	// business keeping a copy of a private key.
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, keypair)
}

type certProbeRequest struct {
	Domain string `json:"domain"`
	Port   string `json:"port"`
}

func (h *SystemHandler) certProbe(c *gin.Context) {
	var req certProbeRequest
	if !bind(c, &req) {
		return
	}
	probe, err := h.system.ProbeCertificate(c.Request.Context(), req.Domain, req.Port)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, probe)
}

// backup returns a copy of the panel's data as a file.
func (h *SystemHandler) backup(c *gin.Context) {
	var exclude []string
	if raw := strings.TrimSpace(c.Query("exclude")); raw != "" {
		for _, name := range strings.Split(raw, ",") {
			if name = strings.TrimSpace(name); name != "" {
				exclude = append(exclude, name)
			}
		}
	}

	document, err := h.system.Backup(c.Request.Context(), middleware.CurrentUser(c), exclude)
	if err != nil {
		fail(c, err)
		return
	}

	filename := config.Name + "_" + time.Now().Format("20060102-150405") + ".backup.json"
	c.Header("Content-Type", "application/json")
	c.Header("Content-Disposition", "attachment; filename=\""+filename+"\"")
	// It contains every credential the panel holds.
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, "application/json", document)
}

// restore replaces the panel's data with an uploaded backup.
func (h *SystemHandler) restore(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBackupUpload)

	file, _, err := c.Request.FormFile("backup")
	if err != nil {
		httputil.Fail(c, http.StatusBadRequest, "attach the backup as a file field named \"backup\": "+err.Error())
		return
	}
	defer file.Close()

	if err := h.system.Restore(c.Request.Context(), middleware.CurrentUser(c), file); err != nil {
		fail(c, err)
		return
	}
	// The operator's own account came from the backup, so whatever session or
	// token they used may no longer exist. Saying so beats the next request
	// failing with no explanation.
	httputil.Message(c, "data restored; sign in again, the accounts are the ones from the backup")
}
