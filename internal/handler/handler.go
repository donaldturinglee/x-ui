package handler

import (
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/httputil"
	"github.com/donaldturinglee/x-ui/pkg/logger"
	"github.com/donaldturinglee/x-ui/pkg/validator"

	"github.com/gin-gonic/gin"
)

// fail turns an error from the layers below into a response.
//
// This is the only place that knows what a domain error means over HTTP, which
// is what lets a repository say "not found" without importing anything to do
// with the transport.
func fail(c *gin.Context, err error) {
	var fields *validator.Errors
	if errors.As(err, &fields) {
		// Validation answers with the offending fields, not just a sentence: a
		// client filling in a form can then mark them rather than guess.
		c.AbortWithStatusJSON(http.StatusBadRequest, httputil.Response{
			Success: false,
			Msg:     fields.Error(),
			Obj:     fields,
		})
		return
	}

	switch {
	case errors.Is(err, domain.ErrCodeRequired):
		// Refused as any sign-in is that starts no session, but carrying the
		// one thing a client needs to finish it: that there is a code to ask
		// for, said where a client branches rather than in a sentence.
		c.AbortWithStatusJSON(http.StatusUnauthorized, httputil.Response{
			Success: false,
			Msg:     err.Error(),
			Obj:     gin.H{"twoFactor": true},
		})
	case errors.Is(err, domain.ErrInvalid):
		httputil.Fail(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		httputil.Fail(c, http.StatusUnauthorized, err.Error())
	case errors.Is(err, domain.ErrForbidden):
		httputil.Fail(c, http.StatusForbidden, err.Error())
	case errors.Is(err, domain.ErrNotFound):
		httputil.Fail(c, http.StatusNotFound, err.Error())
	case errors.Is(err, domain.ErrConflict):
		httputil.Fail(c, http.StatusConflict, err.Error())
	default:
		// Anything unrecognised reached here from the database or the runtime.
		// Its text may name a table, a path or a DSN, so it goes to the log and
		// the caller is told only that it failed.
		logger.Error(c.Request.Method, " ", c.Request.URL.Path, ": ", err)
		httputil.Internal(c)
	}
}

// requestHost is the bare host the caller reached the panel on, without the
// port. It is the fallback address in a generated link: a panel and its nodes
// are often the same machine, and this saves configuring the obvious.
func requestHost(c *gin.Context) string {
	host := c.Request.Host
	if strings.LastIndex(host, ":") == -1 {
		return host
	}
	stripped, _, err := net.SplitHostPort(host)
	if err != nil {
		// An IPv6 literal with no port splits as an error. The original is
		// still the best answer available.
		return host
	}
	return stripped
}

// idParam reads a positive integer path parameter.
func idParam(c *gin.Context, name string) (uint, error) {
	raw := c.Param(name)
	value, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || value == 0 {
		return 0, domain.Invalidf("%s must be a positive integer, got %q", name, raw)
	}
	return uint(value), nil
}

// intQuery reads an integer query parameter, falling back when it is absent or
// unreadable. A malformed page size is not worth refusing a request over.
func intQuery(c *gin.Context, name string, fallback int) int {
	raw := c.Query(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

// int64Query reads an int64 query parameter, defaulting to 0.
func int64Query(c *gin.Context, name string) int64 {
	value, err := strconv.ParseInt(c.Query(name), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

// uintListQuery reads a comma-separated list of positive integers. An entry
// that is not one is skipped rather than failing the request: this only ever
// supplements the main action, and refusing the whole thing over a stray comma
// would be worse than doing slightly less.
func uintListQuery(c *gin.Context, name string) []uint {
	raw := c.Query(name)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var values []uint
	for _, part := range strings.Split(raw, ",") {
		value, err := strconv.ParseUint(strings.TrimSpace(part), 10, 32)
		if err != nil || value == 0 {
			continue
		}
		values = append(values, uint(value))
	}
	return values
}

// boolQuery reads an optional boolean query parameter. The pointer
// distinguishes "not asked for" from "asked for false", which is the
// difference between listing everything and listing only disabled records.
func boolQuery(c *gin.Context, name string) *bool {
	raw := c.Query(name)
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return nil
	}
	return &value
}

// bind decodes a JSON body, answering with a 400 and reporting whether it
// worked, so a handler can return on false without repeating the response.
func bind(c *gin.Context, target interface{}) bool {
	if err := c.ShouldBindJSON(target); err != nil {
		httputil.Fail(c, http.StatusBadRequest, "malformed request body: "+err.Error())
		return false
	}
	return true
}
