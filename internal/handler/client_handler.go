package handler

import (
	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

// defaultPageSize bounds a listing that did not ask for one, and maxPageSize
// bounds one that asked for too much. A panel with tens of thousands of
// subscribers should not be able to ask for all of them by accident.
const (
	defaultPageSize = 100
	maxPageSize     = 1000
)

// ClientHandler serves subscribers.
type ClientHandler struct {
	clients *service.ClientService
	links   *service.LinkService
	// The subscription listener's own configuration, for telling an operator
	// where a subscriber fetches from. It is read rather than served by this
	// process: the two listeners are configured separately on purpose.
	subscription config.SubscriptionConfig
}

func NewClientHandler(
	clients *service.ClientService,
	links *service.LinkService,
	subscription config.SubscriptionConfig,
) *ClientHandler {
	return &ClientHandler{clients: clients, links: links, subscription: subscription}
}

func (h *ClientHandler) Register(g *gin.RouterGroup) {
	g.GET("/clients", h.list)
	g.POST("/clients", h.create)
	g.GET("/clients/:id", h.get)
	g.POST("/clients/:id", h.update)
	g.DELETE("/clients/:id", h.delete)
	g.GET("/clients/:id/links", h.clientLinks)
	g.POST("/clients/:id/reset-traffic", h.resetTraffic)
	// Distinct path rather than /clients/groups: a static segment beside the
	// :id parameter at the same position is exactly the shape that makes a
	// router ambiguous.
	g.GET("/client-groups", h.groups)
	// Where a subscriber fetches from. One answer for the deployment rather
	// than one per subscriber: a subscriber's own URL is this with their name
	// on the end, and the panel can put the two together itself.
	g.GET("/subscription-uri", h.subscriptionURI)
	// The global reset is not addressed to one client, so it does not hang off
	// the collection.
	g.POST("/traffic/reset", h.resetAllTraffic)
}

func (h *ClientHandler) list(c *gin.Context) {
	limit := intQuery(c, "limit", defaultPageSize)
	if limit < 1 || limit > maxPageSize {
		limit = defaultPageSize
	}
	filter := repository.ClientFilter{
		Group:   c.Query("group"),
		Search:  c.Query("search"),
		Enabled: boolQuery(c, "enabled"),
		Limit:   limit,
		Offset:  intQuery(c, "offset", 0),
	}

	ctx := c.Request.Context()
	clients, err := h.clients.List(ctx, filter)
	if err != nil {
		fail(c, err)
		return
	}
	total, err := h.clients.Count(ctx, filter)
	if err != nil {
		fail(c, err)
		return
	}

	httputil.Data(c, gin.H{
		"clients": clients,
		"total":   total,
		"limit":   filter.Limit,
		"offset":  filter.Offset,
	})
}

func (h *ClientHandler) get(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	client, err := h.clients.Get(c.Request.Context(), id)
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, client)
}

func (h *ClientHandler) create(c *gin.Context) {
	var client domain.Client
	if !bind(c, &client) {
		return
	}
	if err := h.clients.Create(c.Request.Context(), middleware.CurrentUser(c), &client); err != nil {
		fail(c, err)
		return
	}
	httputil.Created(c, client)
}

func (h *ClientHandler) update(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	var client domain.Client
	if !bind(c, &client) {
		return
	}
	// The path wins over the body. Otherwise a body naming a different id
	// edits that record instead, through a URL that says it edits this one.
	client.Id = id

	if err := h.clients.Update(c.Request.Context(), middleware.CurrentUser(c), &client); err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, client)
}

func (h *ClientHandler) delete(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if err := h.clients.Delete(c.Request.Context(), middleware.CurrentUser(c), id); err != nil {
		fail(c, err)
		return
	}
	httputil.OK(c)
}

// clientLinks returns the connection URIs this subscriber can use, built now
// from the inbounds they are assigned to.
//
// They are generated on read rather than stored, so a change to an inbound or
// its TLS is reflected the next time they are fetched.
func (h *ClientHandler) clientLinks(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	links, err := h.links.LinksForClient(c.Request.Context(), id, requestHost(c))
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, links)
}

// subscriptionURI reports where subscribers fetch from, so the panel can show
// an operator the link to hand over rather than leaving them to assemble it
// from a port and a path they have to go and look up.
//
// Answered even when subscriptions are switched off. The address is still what
// it would be, and a panel that said nothing here would look broken rather than
// switched off.
func (h *ClientHandler) subscriptionURI(c *gin.Context) {
	httputil.Data(c, gin.H{
		"uri":     h.subscription.PublicBase(requestHost(c)),
		"enabled": h.subscription.Enabled,
	})
}

func (h *ClientHandler) resetTraffic(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if err := h.clients.ResetTraffic(c.Request.Context(), middleware.CurrentUser(c), id); err != nil {
		fail(c, err)
		return
	}
	httputil.OK(c)
}

func (h *ClientHandler) resetAllTraffic(c *gin.Context) {
	affected, err := h.clients.ResetAllTraffic(c.Request.Context(), middleware.CurrentUser(c))
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{"reset": affected})
}

func (h *ClientHandler) groups(c *gin.Context) {
	groups, err := h.clients.Groups(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, groups)
}
