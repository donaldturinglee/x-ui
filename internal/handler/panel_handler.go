package handler

import (
	"strconv"

	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// PanelHandler serves the aggregate poll a panel front end runs on.
type PanelHandler struct {
	panel *service.PanelService
}

func NewPanelHandler(panel *service.PanelService) *PanelHandler {
	return &PanelHandler{panel: panel}
}

func (h *PanelHandler) Register(g *gin.RouterGroup) {
	g.GET("/load", h.load)
}

// load returns everything the panel renders, in one response.
//
// `lu` is the cursor from the previous answer. Sending it back means the panel
// gets a short reply when nothing has changed, and the whole state when
// something has — rather than polling eight endpoints and diffing them.
func (h *PanelHandler) load(c *gin.Context) {
	var since uint64
	if raw := c.Query("lu"); raw != "" {
		// An unreadable cursor is treated as no cursor: the client gets a full
		// snapshot, which is correct, rather than an error it cannot act on.
		since, _ = strconv.ParseUint(raw, 10, 64)
	}

	snapshot, err := h.panel.Load(c.Request.Context(), since)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, snapshot)
}
