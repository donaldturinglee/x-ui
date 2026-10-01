package handler

import (
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// InboundHandler serves listeners, each with the TLS it terminates with among
// its options.
type InboundHandler struct {
	inbounds *service.InboundService
}

func NewInboundHandler(inbounds *service.InboundService) *InboundHandler {
	return &InboundHandler{inbounds: inbounds}
}

func (h *InboundHandler) Register(g *gin.RouterGroup) {
	g.GET("/inbounds", h.list)
	g.POST("/inbounds", h.create)
	g.GET("/inbounds/:id", h.get)
	g.POST("/inbounds/:id", h.update)
	g.DELETE("/inbounds/:id", h.delete)
}

func (h *InboundHandler) list(c *gin.Context) {
	inbounds, err := h.inbounds.List(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, inbounds)
}

func (h *InboundHandler) get(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	inbound, err := h.inbounds.Get(c.Request.Context(), id)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, inbound)
}

func (h *InboundHandler) create(c *gin.Context) {
	var inbound domain.Inbound
	if !bind(c, &inbound) {
		return
	}
	// initClients assigns the new inbound to those subscribers as it is
	// created. It is read from the query rather than the body because the body
	// is the inbound itself, and the core has no such field.
	initClients := uintListQuery(c, "initClients")

	if err := h.inbounds.Create(c.Request.Context(), middleware.CurrentUser(c), &inbound, initClients); err != nil {
		fail(c, err)
		return
	}
	full, err := inbound.MarshalFull()
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Created(c, full)
}

func (h *InboundHandler) update(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	var inbound domain.Inbound
	if !bind(c, &inbound) {
		return
	}
	inbound.Id = id

	if err := h.inbounds.Update(c.Request.Context(), middleware.CurrentUser(c), &inbound); err != nil {
		fail(c, err)
		return
	}
	full, err := inbound.MarshalFull()
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, full)
}

func (h *InboundHandler) delete(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if err := h.inbounds.Delete(c.Request.Context(), middleware.CurrentUser(c), id); err != nil {
		fail(c, err)
		return
	}
	httputil.OK(c)
}
