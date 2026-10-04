package handler

import (
	"context"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/middleware"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-gonic/gin"
)

// notificationTimeout bounds a notification sent from a request, which goes on
// after the request has been answered and so outlives its context.
const notificationTimeout = 30 * time.Second

// UserHandler serves the sign-in path, operator accounts and API tokens.
type UserHandler struct {
	users         *service.UserService
	tokens        *middleware.TokenAuthenticator
	telegram      *service.TelegramService
	sessionMaxAge time.Duration
}

func NewUserHandler(users *service.UserService, tokens *middleware.TokenAuthenticator, telegram *service.TelegramService, sessionMaxAge time.Duration) *UserHandler {
	return &UserHandler{
		users:         users,
		tokens:        tokens,
		telegram:      telegram,
		sessionMaxAge: sessionMaxAge,
	}
}

// RegisterPublic mounts the endpoints that must work without a session. They
// are still behind the same-origin check: a cross-site page must not be able to
// sign the operator out, or in as somebody else.
func (h *UserHandler) RegisterPublic(g *gin.RouterGroup) {
	g.GET("/signin/config", h.signInConfig)
	g.POST("/signin", h.signIn)
	g.POST("/signout", h.signOut)
}

func (h *UserHandler) signInConfig(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	config, err := h.users.SignInConfig(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, config)
}

func (h *UserHandler) Register(g *gin.RouterGroup) {
	g.GET("/me", h.me)
	g.POST("/me/credentials", h.changeCredentials)
	g.POST("/me/two-factor/setup", h.twoFactorSetup)
	g.POST("/me/two-factor/enable", h.enableTwoFactor)
	g.POST("/me/two-factor/disable", h.disableTwoFactor)
	g.GET("/users", h.listUsers)
	g.GET("/tokens", h.listTokens)
	g.POST("/tokens", h.createToken)
	g.DELETE("/tokens/:id", h.deleteToken)
}

type signInRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// Code is the authenticator app's, for an account with two-factor
	// authentication on. Sent without one, such a sign-in is answered with the
	// question rather than a session.
	Code string `json:"code"`
}

func (h *UserHandler) signIn(c *gin.Context) {
	var req signInRequest
	if !bind(c, &req) {
		return
	}

	// ClientIP, not the header directly: gin resolves it against the configured
	// trusted proxies, so a client cannot choose the address that ends up in
	// the sign-in log and in the rate limiter's key.
	user, err := h.users.SignIn(c.Request.Context(), req.Username, req.Password, req.Code, c.ClientIP())
	if err != nil {
		fail(c, err)
		return
	}

	if err := middleware.SetSignedInUser(c, user.Username, h.sessionMaxAge); err != nil {
		// Reported, not logged and swallowed: answering "success" with no
		// cookie set sends the panel straight back to the sign-in form with
		// nothing to explain why.
		logger.Warning("sign-in failed to start a session: ", err)
		fail(c, err)
		return
	}

	// Sent after the answer rather than before it: a Telegram that is slow or
	// unreachable is no reason to keep an operator waiting on their panel.
	username, address := user.Username, c.ClientIP()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), notificationTimeout)
		defer cancel()
		h.telegram.Notify(ctx, domain.SettingTgNotifySignIn,
			"x-ui: "+username+" signed in to the panel from "+address+".")
	}()

	httputil.Data(c, gin.H{"username": user.Username})
}

func (h *UserHandler) signOut(c *gin.Context) {
	if username := middleware.SignedInUser(c); username != "" {
		logger.Info("user ", username, " signed out")
	}
	middleware.ClearSession(c)
	httputil.OK(c)
}

func (h *UserHandler) me(c *gin.Context) {
	user, err := h.users.FindByUsername(c.Request.Context(), middleware.CurrentUser(c))
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, user)
}

type changeCredentialsRequest struct {
	OldPassword string `json:"oldPassword"`
	NewUsername string `json:"newUsername"`
	NewPassword string `json:"newPassword"`
}

func (h *UserHandler) changeCredentials(c *gin.Context) {
	var req changeCredentialsRequest
	if !bind(c, &req) {
		return
	}

	err := h.users.ChangeCredentials(
		c.Request.Context(),
		middleware.CurrentUser(c),
		req.OldPassword,
		req.NewUsername,
		req.NewPassword,
	)
	if err != nil {
		fail(c, err)
		return
	}
	// The session names the operator, and the name just changed. Clearing it
	// forces a fresh sign-in rather than leaving a session pointing at an
	// account that no longer answers to that name.
	middleware.ClearSession(c)
	httputil.Message(c, "credentials changed, please sign in again")
}

// twoFactorSetup hands the signed-in operator a secret for their authenticator
// app, and the otpauth:// address a QR code of it holds. Nothing is stored until
// a code from the app confirms it.
func (h *UserHandler) twoFactorSetup(c *gin.Context) {
	secret, uri, err := h.users.TwoFactorSetup(c.Request.Context(), middleware.CurrentUser(c))
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, gin.H{"secret": secret, "uri": uri})
}

type enableTwoFactorRequest struct {
	Secret string `json:"secret"`
	Code   string `json:"code"`
}

func (h *UserHandler) enableTwoFactor(c *gin.Context) {
	var req enableTwoFactorRequest
	if !bind(c, &req) {
		return
	}
	if err := h.users.EnableTwoFactor(c.Request.Context(), middleware.CurrentUser(c), req.Secret, req.Code); err != nil {
		fail(c, err)
		return
	}
	httputil.Message(c, "two-factor authentication is on")
}

type disableTwoFactorRequest struct {
	Code string `json:"code"`
}

func (h *UserHandler) disableTwoFactor(c *gin.Context) {
	var req disableTwoFactorRequest
	if !bind(c, &req) {
		return
	}
	if err := h.users.DisableTwoFactor(c.Request.Context(), middleware.CurrentUser(c), req.Code); err != nil {
		fail(c, err)
		return
	}
	httputil.Message(c, "two-factor authentication is off")
}

func (h *UserHandler) listUsers(c *gin.Context) {
	users, err := h.users.List(c.Request.Context())
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, users)
}

func (h *UserHandler) listTokens(c *gin.Context) {
	tokens, err := h.users.Tokens(c.Request.Context(), middleware.CurrentUser(c))
	if err != nil {
		fail(c, err)
		return
	}
	httputil.Data(c, tokens)
}

type createTokenRequest struct {
	// ExpiryDays of 0 mints a token that does not expire.
	ExpiryDays int64  `json:"expiryDays"`
	Desc       string `json:"desc"`
}

func (h *UserHandler) createToken(c *gin.Context) {
	var req createTokenRequest
	if !bind(c, &req) {
		return
	}

	token, err := h.users.CreateToken(c.Request.Context(), middleware.CurrentUser(c), req.ExpiryDays, req.Desc)
	if err != nil {
		fail(c, err)
		return
	}
	h.reloadTokens(c)

	// The value is returned exactly once. It is stored to be compared against,
	// and every later read of this token masks it.
	httputil.Created(c, gin.H{
		"id":     token.Id,
		"token":  token.Token,
		"desc":   token.Desc,
		"expiry": token.Expiry,
	})
}

func (h *UserHandler) deleteToken(c *gin.Context) {
	id, err := idParam(c, "id")
	if err != nil {
		fail(c, err)
		return
	}
	if err := h.users.DeleteToken(c.Request.Context(), middleware.CurrentUser(c), id); err != nil {
		fail(c, err)
		return
	}
	h.reloadTokens(c)
	httputil.OK(c)
}

// reloadTokens refreshes the middleware's in-memory table after a change.
//
// A failure is logged rather than returned: the change itself is committed, and
// reporting it as failed would invite the operator to make it again. The table
// is rebuilt on the next successful reload or restart.
func (h *UserHandler) reloadTokens(c *gin.Context) {
	if h.tokens == nil {
		return
	}
	if err := h.tokens.Reload(c.Request.Context()); err != nil {
		logger.Error("unable to reload API tokens: ", err)
	}
}
