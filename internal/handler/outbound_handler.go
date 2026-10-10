package handler

import (
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// OutboundHandler serves the routes out of a node.
type OutboundHandler struct {
	outbounds *service.OutboundService
}

func NewOutboundHandler(outbounds *service.OutboundService) *OutboundHandler {
	return &OutboundHandler{outbounds: outbounds}
}

func (h *OutboundHandler) Register(g *gin.RouterGroup) {
	g.GET("/outbounds", h.list)
	g.POST("/outbounds", h.create)
	g.GET("/outbounds/:id", h.get)
	g.POST("/outbounds/:id", h.update)
	g.DELETE("/outbounds/:id", h.delete)
	g.POST("/outbounds/:id/check", h.check)
}

func (h *OutboundHandler) check(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	result, err := h.outbounds.Check(c.Request.Context(), id)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, result)
}

func (h *OutboundHandler) list(c *gin.Context) {
	outbounds, err := h.outbounds.List(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, outbounds)
}

func (h *OutboundHandler) get(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	outbound, err := h.outbounds.Get(c.Request.Context(), id)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, outbound)
}

func (h *OutboundHandler) create(c *gin.Context) {
	var outbound domain.Outbound
	if !bind(c, &outbound) {
		return
	}
	if err := h.outbounds.Create(c.Request.Context(), middleware.CurrentUser(c), &outbound); err != nil {
		fail(c, err)
		return
	}
	full, err := outbound.MarshalFull()
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Created(c, full)
}

func (h *OutboundHandler) update(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	var outbound domain.Outbound
	if !bind(c, &outbound) {
		return
	}
	// The path wins over the body. Otherwise a body naming a different id edits
	// that record instead, through a URL that says it edits this one.
	outbound.Id = id

	if err := h.outbounds.Update(c.Request.Context(), middleware.CurrentUser(c), &outbound); err != nil {
		fail(c, err)
		return
	}
	full, err := outbound.MarshalFull()
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, full)
}

func (h *OutboundHandler) delete(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if err := h.outbounds.Delete(c.Request.Context(), middleware.CurrentUser(c), id); err != nil {
		fail(c, err)
		return
	}
	httputil.OK(c)
}
