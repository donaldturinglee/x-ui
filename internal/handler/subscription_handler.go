package handler

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-gonic/gin"
)

// SubscriptionHandler serves subscribers rather than operators.
//
// It is mounted on its own listener and has no authentication: the
// subscription id is the only secret, which is why it is a generated name
// rather than a sequential one, and why every failure answers the same way.
type SubscriptionHandler struct {
	subscriptions *service.SubscriptionService
}

func NewSubscriptionHandler(subscriptions *service.SubscriptionService) *SubscriptionHandler {
	return &SubscriptionHandler{subscriptions: subscriptions}
}

func (h *SubscriptionHandler) Register(g *gin.RouterGroup) {
	g.GET("/:name", h.fetch)
	// HEAD lets a client refresh the quota it displays without downloading the
	// whole subscription, which some do every few minutes.
	g.HEAD("/:name", h.head)
}

func (h *SubscriptionHandler) fetch(c *gin.Context) {
	name := c.Param("name")
	format := c.DefaultQuery("format", service.FormatLinks)

	subscription, err := h.subscriptions.Render(c.Request.Context(), name, format, requestHost(c))
	if err != nil {
		h.refuse(c, name, err)
		return
	}

	h.writeHeaders(c, subscription)
	c.String(http.StatusOK, subscription.Body)
}

func (h *SubscriptionHandler) head(c *gin.Context) {
	name := c.Param("name")

	subscription, err := h.subscriptions.Meta(c.Request.Context(), name)
	if err != nil {
		h.refuse(c, name, err)
		return
	}

	h.writeHeaders(c, subscription)
	c.Status(http.StatusOK)
}

// refuse answers a failed fetch.
//
// Every failure looks the same from outside, whatever went wrong: this
// endpoint is unauthenticated and reachable by anyone, so distinguishing "no
// such subscription" from "that one is disabled" or "the database is down"
// would let a caller map which ids exist. The reason goes to the log.
func (h *SubscriptionHandler) refuse(c *gin.Context, name string, err error) {
	if !errors.Is(err, domain.ErrNotFound) {
		logger.Warning("subscription ", name, " failed: ", err)
	}
	c.String(http.StatusNotFound, "")
}

// writeHeaders attaches the metadata client applications read.
func (h *SubscriptionHandler) writeHeaders(c *gin.Context, subscription *service.Subscription) {
	c.Header("Subscription-Userinfo", subscription.UserInfo)
	c.Header("Profile-Update-Interval", fmt.Sprintf("%d", subscription.UpdateInterval))
	c.Header("Profile-Title", subscription.Title)
	c.Header("Content-Disposition", contentDisposition(subscription.Title))
	if subscription.ContentType != "" {
		c.Header("Content-Type", subscription.ContentType)
	}
	// A subscription is per-subscriber and changes as their quota does, so no
	// cache between here and them should keep a copy.
	c.Header("Cache-Control", "no-store")
}

// contentDisposition names the downloaded file.
//
// Both spellings are emitted: the plain one for clients that read only ASCII,
// and the RFC 5987 one so a title in any script survives. A title is
// operator-supplied text, so neither is interpolated raw.
func contentDisposition(title string) string {
	name := strings.TrimSpace(title)
	if name == "" {
		name = "subscription"
	}
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s",
		asciiSafeFilename(name), rfc5987Encode(name))
}

func asciiSafeFilename(name string) string {
	var builder strings.Builder
	for _, r := range name {
		switch {
		case r == '"' || r == '\\':
			builder.WriteByte('_')
		case r >= 0x20 && r <= 0x7e:
			builder.WriteRune(r)
		}
	}
	if fallback := strings.TrimSpace(builder.String()); fallback != "" {
		return fallback
	}
	return "subscription"
}

func rfc5987Encode(name string) string {
	const hex = "0123456789ABCDEF"

	var builder strings.Builder
	for _, b := range []byte(name) {
		if isRFC5987AttrChar(b) {
			builder.WriteByte(b)
			continue
		}
		builder.WriteByte('%')
		builder.WriteByte(hex[b>>4])
		builder.WriteByte(hex[b&0x0f])
	}
	return builder.String()
}

func isRFC5987AttrChar(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
		return true
	}
	switch b {
	case '!', '#', '$', '&', '+', '-', '.', '^', '_', '`', '|', '~':
		return true
	}
	return false
}
