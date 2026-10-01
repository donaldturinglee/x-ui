package handler

import (
	"net/http"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// ConfigHandler serves the document a node is configured from: the generated
// one, and the base an operator edits.
type ConfigHandler struct {
	configs *service.ConfigService
}

func NewConfigHandler(configs *service.ConfigService) *ConfigHandler {
	return &ConfigHandler{configs: configs}
}

func (h *ConfigHandler) Register(g *gin.RouterGroup) {
	g.GET("/config", h.generated)
	g.GET("/config/download", h.download)
	g.GET("/config/base", h.base)
	g.POST("/config/base", h.saveBase)
	g.POST("/config/base/reset", h.resetBase)
}

// maintenanceHeader tells a node that its listeners were withheld on purpose.
//
// A node that found no inbounds cannot tell that from an empty panel, and the
// difference decides whether anyone should be alarmed. It travels as a header
// because the body is the core's own document and has no room for a field the
// core would refuse.
const maintenanceHeader = "X-UI-Maintenance"

// generated returns the full document, assembled now.
func (h *ConfigHandler) generated(c *gin.Context) {
	generated, err := h.configs.Generate(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{
		"config":      generated.Document,
		"maintenance": generated.Maintenance,
	})
}

// download returns the same document as a file, unwrapped.
//
// A node consuming this wants the document itself, not the envelope: the
// envelope exists for a panel deciding what to render, and a core parsing its
// own configuration would choke on it.
func (h *ConfigHandler) download(c *gin.Context) {
	generated, err := h.configs.Generate(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	filename := config.Name + "_" + time.Now().Format("20060102-150405") + ".json"
	c.Header("Content-Type", "application/json")
	c.Header("Content-Disposition", "attachment; filename=\""+filename+"\"")
	if generated.Maintenance {
		c.Header(maintenanceHeader, "true")
	}
	c.String(http.StatusOK, generated.Document.String())
}

// base returns the stored base document, without the managed objects.
func (h *ConfigHandler) base(c *gin.Context) {
	document, err := h.configs.Base(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, document)
}

func (h *ConfigHandler) saveBase(c *gin.Context) {
	// Read as a raw document rather than through a struct: this is the one
	// endpoint whose body is the operator's own JSON, and decoding it into a
	// shape here would quietly drop whatever that shape does not carry.
	var document domain.JSON
	if !bind(c, &document) {
		return
	}
	if err := h.configs.SaveBase(c.Request.Context(), middleware.CurrentUser(c), document); err != nil {
		fail(c, err)
		return
	}
	h.base(c)
}

func (h *ConfigHandler) resetBase(c *gin.Context) {
	if err := h.configs.Reset(c.Request.Context(), middleware.CurrentUser(c)); err != nil {
		fail(c, err)
		return
	}
	h.base(c)
}
