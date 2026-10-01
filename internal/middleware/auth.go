package middleware

import (
	"context"
	"crypto/subtle"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
)

// SessionName is the cookie the session is stored in.
const SessionName = "x-ui"

// sessionUserKey is the session field holding the signed-in username.
const sessionUserKey = "signed_in_user"

// contextUserKey is where the resolved caller is put for handlers to read,
// whether they were authenticated by session or by token.
const contextUserKey = "x_ui_user"

// BaseSessionOptions are the cookie attributes that do not depend on the
// request, so the session store and every sign-in share one definition.
//
// HttpOnly keeps the session out of reach of script: the panel renders
// operator-supplied strings in several places, and without it any one of them
// turning into an XSS hands over the session outright.
//
// SameSite=Strict has nothing to do with TLS and is safe in both HTTP and
// HTTPS mode. It stops a cross-site request from carrying the session at all.
func BaseSessionOptions(maxAge time.Duration) sessions.Options {
	o := sessions.Options{
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	}
	if maxAge > 0 {
		o.MaxAge = int(maxAge / time.Second)
	}
	return o
}

func sessionOptions(c *gin.Context, maxAge time.Duration) sessions.Options {
	o := BaseSessionOptions(maxAge)
	o.Secure = requestIsHTTPS(c)
	return o
}

// requestIsHTTPS reports whether the browser reached the panel over TLS.
//
// It has to be derived per request, never hardcoded: a browser will not send a
// Secure cookie over plain HTTP, so a fixed true breaks signing in on every
// HTTP-only install, and a fixed false gives up the protection on HTTPS ones.
//
// Behind a reverse proxy the panel itself speaks plain HTTP, so the forwarded
// scheme is the only evidence. It is believed only from a loopback or private
// peer -- otherwise anyone who can reach an HTTP-only panel directly could set
// the header, make the browser refuse to send the cookie back, and lock the
// operator out of their own panel.
func requestIsHTTPS(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	if !strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https") {
		return false
	}
	ip := net.ParseIP(c.RemoteIP())
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}

// SetSignedInUser starts a session for an operator.
func SetSignedInUser(c *gin.Context, username string, maxAge time.Duration) error {
	s := sessions.Default(c)
	s.Set(sessionUserKey, username)
	s.Options(sessionOptions(c, maxAge))
	return s.Save()
}

// SignedInUser returns the session's operator, or "" when there is no session.
func SignedInUser(c *gin.Context) string {
	s := sessions.Default(c)
	value, ok := s.Get(sessionUserKey).(string)
	if !ok {
		return ""
	}
	return value
}

// IsSignedIn reports whether the request carries a session.
func IsSignedIn(c *gin.Context) bool {
	return SignedInUser(c) != ""
}

// ClearSession ends a session, which is what signing out does.
func ClearSession(c *gin.Context) {
	s := sessions.Default(c)
	s.Clear()
	// The same attributes as the cookie being replaced. A browser matches the
	// deletion against Path and Secure, so an expiry written with different
	// attributes leaves the original cookie in place.
	o := sessionOptions(c, 0)
	o.MaxAge = -1
	s.Options(o)
	if err := s.Save(); err != nil {
		logger.Warning("unable to clear session: ", err)
	}
}

// CurrentUser returns whoever the request authenticated as, by either scheme.
func CurrentUser(c *gin.Context) string {
	value, _ := c.Get(contextUserKey)
	username, _ := value.(string)
	return username
}

// RequireSession rejects a request without a session.
func RequireSession() gin.HandlerFunc {
	return func(c *gin.Context) {
		username := SignedInUser(c)
		if username == "" {
			// 401, not a redirect: this guards the API, and a client should not
			// have to notice it received a sign-in page instead of JSON.
			httputil.Fail(c, http.StatusUnauthorized, "not signed in")
			return
		}
		c.Set(contextUserKey, username)
		c.Next()
	}
}

// TokenSource loads the tokens the API accepts. It is an interface so the
// middleware does not depend on the service layer.
type TokenSource interface {
	ValidTokens(ctx context.Context) ([]domain.Token, error)
}

// TokenAuthenticator authenticates machine callers by the Token header.
//
// Tokens are held in memory and refreshed explicitly, rather than looked up per
// request: this is on the path of every API call, and a database round trip
// per call turns a token into a way to load the database from outside.
type TokenAuthenticator struct {
	source TokenSource

	// mu guards tokens. Every request reads the slice while Reload replaces it
	// from a handler on another connection.
	mu     sync.RWMutex
	tokens []tokenEntry
}

type tokenEntry struct {
	value    string
	expiry   int64
	username string
}

func NewTokenAuthenticator(source TokenSource) *TokenAuthenticator {
	return &TokenAuthenticator{source: source}
}

// Reload rebuilds the in-memory token table.
func (a *TokenAuthenticator) Reload(ctx context.Context) error {
	tokens, err := a.source.ValidTokens(ctx)
	if err != nil {
		// The old table is left in place. Installing a half-built one on a
		// failed load would revoke every working token until the next reload.
		return err
	}

	entries := make([]tokenEntry, 0, len(tokens))
	for _, token := range tokens {
		if token.User == nil {
			continue
		}
		entries = append(entries, tokenEntry{
			value:    token.Token,
			expiry:   token.Expiry,
			username: token.User.Username,
		})
	}

	a.mu.Lock()
	a.tokens = entries
	a.mu.Unlock()
	return nil
}

// resolve returns the operator a token belongs to, or "".
func (a *TokenAuthenticator) resolve(value string) string {
	if value == "" {
		return ""
	}

	a.mu.RLock()
	defer a.mu.RUnlock()

	now := time.Now().Unix()
	for _, entry := range a.tokens {
		// Expired entries are skipped, not removed: deleting from the slice
		// being ranged over shifts every later element back by one and skips
		// it, so one expired token could hide the valid token stored right
		// after it.
		if entry.expiry > 0 && entry.expiry < now {
			continue
		}
		// Constant time, so how long a wrong token takes to reject does not
		// reveal how many leading characters were right.
		if subtle.ConstantTimeCompare([]byte(entry.value), []byte(value)) == 1 {
			return entry.username
		}
	}
	return ""
}

// RequireToken rejects a request without a valid Token header.
func (a *TokenAuthenticator) RequireToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		username := a.resolve(c.GetHeader("Token"))
		if username == "" {
			httputil.Fail(c, http.StatusUnauthorized, "invalid token")
			return
		}
		c.Set(contextUserKey, username)
		c.Next()
	}
}

// SameOrigin rejects state-changing requests that did not come from the
// panel's own pages.
//
// The session is a cookie, so without this any page an operator visits while
// signed in can post to the panel in their name -- adding a client, changing
// the password, resetting traffic. SameSite=Strict on the cookie already covers
// current browsers; this is the half that does not depend on the browser being
// current.
//
// Only the host is compared, never a hardcoded scheme. The panel has to work
// on plain HTTP as well as HTTPS, and behind a TLS-terminating proxy the scheme
// the browser used and the one the panel sees differ anyway -- so requiring
// https:// here would reject every legitimate request in two of the three
// deployments.
func SameOrigin() gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}

		origin := c.GetHeader("Origin")
		if origin == "" {
			origin = c.GetHeader("Referer")
		}
		if origin == "" {
			// Neither header. A cross-site form post cannot set a custom
			// header, so the panel's own XHR marker tells the two apart.
			if c.GetHeader("X-Requested-With") == "XMLHttpRequest" {
				c.Next()
				return
			}
			httputil.Fail(c, http.StatusForbidden, "cross-origin request refused")
			return
		}

		u, err := url.Parse(origin)
		if err != nil || u.Host == "" || !strings.EqualFold(u.Host, c.Request.Host) {
			httputil.Fail(c, http.StatusForbidden, "cross-origin request refused")
			return
		}
		c.Next()
	}
}

// DomainValidator answers only on the configured host name, so a panel found
// by scanning the address range is not served at all.
func DomainValidator(expected string) gin.HandlerFunc {
	return func(c *gin.Context) {
		host := c.Request.Host
		if strings.LastIndex(host, ":") != -1 {
			if stripped, _, err := net.SplitHostPort(host); err == nil {
				host = stripped
			}
		}
		if !strings.EqualFold(host, expected) {
			c.AbortWithStatus(http.StatusForbidden)
			return
		}
		c.Next()
	}
}
