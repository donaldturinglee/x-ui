package handler

import (
	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// SettingHandler serves the runtime options an operator changes from the
// panel. Anything the process needs in order to start comes from configs/ and
// is shown here as the process read it, never written: a panel that rewrote its
// own listener could leave itself unreachable.
type SettingHandler struct {
	settings *service.SettingService
	telegram *service.TelegramService
	startup  config.Shown
}

func NewSettingHandler(settings *service.SettingService, telegram *service.TelegramService, startup config.Shown) *SettingHandler {
	return &SettingHandler{settings: settings, telegram: telegram, startup: startup}
}

func (h *SettingHandler) Register(g *gin.RouterGroup) {
	g.GET("/settings", h.list)
	g.POST("/settings", h.save)
	g.POST("/settings/reset", h.reset)
	g.GET("/settings/startup", h.startupSettings)
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
