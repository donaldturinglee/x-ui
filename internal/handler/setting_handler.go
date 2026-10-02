package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// SettingHandler serves the runtime options an operator changes from the
// panel. Startup options are saved separately to configs/config.yaml and take
// effect when the API and worker are restarted.
type SettingHandler struct {
	settings *service.SettingService
	telegram *service.TelegramService
	startup  config.Shown
	panel    *service.PanelSettingsService
	restart  *service.PanelRestartService
}

func NewSettingHandler(settings *service.SettingService, telegram *service.TelegramService, cfg *config.Config) *SettingHandler {
	panel := service.NewPanelSettingsService(settings, cfg)
	return &SettingHandler{settings: settings, telegram: telegram, startup: cfg.Shown(), panel: panel, restart: service.NewPanelRestartService(panel)}
}

func (h *SettingHandler) Register(g *gin.RouterGroup) {
	g.GET("/settings", h.list)
	g.POST("/settings", h.save)
	g.POST("/settings/reset", h.reset)
	g.GET("/settings/startup", h.startupSettings)
	g.GET("/settings/panel", h.panelSettings)
	g.POST("/settings/panel", h.savePanelSettings)
	g.POST("/settings/panel/restart", h.restartPanel)
	g.GET("/settings/panel/restart/:id", h.panelRestartStatus)
	g.POST("/telegram/test", h.telegramTest)
	g.GET("/maintenance", h.getMaintenance)
	g.POST("/maintenance", h.setMaintenance)
}

func (h *SettingHandler) list(c *gin.Context) {
	settings, err := h.settings.All(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, settings)
}

func (h *SettingHandler) save(c *gin.Context) {
	var values map[string]string
	if !bind(c, &values) {
		return
	}
	if err := h.settings.Save(c.Request.Context(), middleware.CurrentUser(c), values); err != nil {
		fail(c, err)
		return
	}
	h.list(c)
}

type resetRequest struct {
	// Keys are the settings to put back, or none for every one of them.
	Keys []string `json:"keys"`
}

// reset puts settings back to their defaults. A request without a body puts
// back all of them, as it always has.
func (h *SettingHandler) reset(c *gin.Context) {
	var req resetRequest
	if c.Request.ContentLength != 0 && !bind(c, &req) {
		return
	}
	if err := h.settings.Reset(c.Request.Context(), middleware.CurrentUser(c), req.Keys); err != nil {
		fail(c, err)
		return
	}
	h.list(c)
}

// startupSettings returns what the process read from configs/ and the
// environment when it started, with nothing secret in it.
func (h *SettingHandler) startupSettings(c *gin.Context) {
	httputil.Data(c, h.startup)
}

func (h *SettingHandler) panelSettings(c *gin.Context) {
	state, err := h.panel.Read()
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, state)
}

func (h *SettingHandler) savePanelSettings(c *gin.Context) {
	var req struct {
		Revision string                 `json:"revision"`
		Values   *service.PanelSettings `json:"values"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		fail(c, domain.Invalidf("Invalid Panel settings request: %v", err))
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF || req.Values == nil || req.Revision == "" {
		fail(c, domain.Invalidf("Send one settings object with values and the current revision"))
		return
	}
	state, err := h.panel.Save(c.Request.Context(), middleware.CurrentUser(c), req.Revision, *req.Values)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, state)
}

func (h *SettingHandler) restartPanel(c *gin.Context) {
	var req struct {
		Revision string `json:"revision"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		fail(c, domain.Invalidf("Send the saved configuration revision"))
		return
	}
	if decoder.Decode(new(any)) != io.EOF || len(req.Revision) != 64 {
		fail(c, domain.Invalidf("Send one restart request with the saved configuration revision"))
		return
	}
	job, err := h.restart.Queue(c.Request.Context(), middleware.CurrentUser(c), req.Revision)
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusAccepted, httputil.Response{Success: true, Obj: job})
}

func (h *SettingHandler) panelRestartStatus(c *gin.Context) {
	job, err := h.restart.Get(c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	httputil.Data(c, job)
}

// telegramTest sends a message to the Telegram bot's chats as they are saved,
// and says what Telegram made of it.
func (h *SettingHandler) telegramTest(c *gin.Context) {
	if err := h.telegram.SendTest(c.Request.Context(), middleware.CurrentUser(c)); err != nil {
		fail(c, err)
		return
	}
	httputil.Message(c, "test message sent")
}

func (h *SettingHandler) getMaintenance(c *gin.Context) {
	enabled, err := h.settings.Maintenance(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{"maintenance": enabled})
}

type maintenanceRequest struct {
	Enable bool `json:"enable"`
}

func (h *SettingHandler) setMaintenance(c *gin.Context) {
	var req maintenanceRequest
	if !bind(c, &req) {
		return
	}
	if err := h.settings.SetMaintenance(c.Request.Context(), middleware.CurrentUser(c), req.Enable); err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{"maintenance": req.Enable})
}
