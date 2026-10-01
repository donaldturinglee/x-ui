package middleware

import (
	"net/http"
	"time"

	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"github.com/gin-gonic/gin"
)

// Logging records one line per request: method, path, status, size, how long
// it took and who asked.
//
// The query string is deliberately not logged. Subscription links and token
// lookups travel in it, and a log an operator pastes into an issue should not
// hand over a working credential.
func Logging() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path

		c.Next()

		status := c.Writer.Status()
		fields := []interface{}{
			c.Request.Method, " ", path,
			" ", status,
			" ", c.Writer.Size(), "b",
			" ", time.Since(start).Round(time.Millisecond),
			" ", c.ClientIP(),
		}

		// A 5xx is the panel's own fault and belongs at error level; a 4xx is
		// the caller's and is worth seeing without being alarming; everything
		// else is noise at anything above debug.
		switch {
		case status >= http.StatusInternalServerError:
			logger.Error(fields...)
		case status >= http.StatusBadRequest:
			logger.Warning(fields...)
		default:
			logger.Debug(fields...)
		}
	}
}

// Recovery turns a panic into a 500 and a logged stack, so one bad request
// cannot take the server down with it.
func Recovery() gin.HandlerFunc {
	return gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, recovered interface{}) {
		logger.Error("panic serving ", c.Request.Method, " ", c.Request.URL.Path, ": ", recovered)
		// The panic value can name internals and is not returned to the caller.
		httputil.Internal(c)
	})
}
