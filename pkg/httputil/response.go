package httputil

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Response is the envelope every endpoint answers with. `success` is what a
// client branches on; `msg` carries a human-readable reason and `obj` the
// payload, so a caller can tell an empty result from a failed one without
// having to inspect the status line.
type Response struct {
	Success bool        `json:"success"`
	Msg     string      `json:"msg"`
	Obj     interface{} `json:"obj"`
}

// Data answers with a payload.
func Data(c *gin.Context, obj interface{}) {
	c.JSON(http.StatusOK, Response{Success: true, Obj: obj})
}

// Message answers with a bare acknowledgement.
func Message(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, Response{Success: true, Msg: msg})
}

// Created answers a POST that made something new.
func Created(c *gin.Context, obj interface{}) {
	c.JSON(http.StatusCreated, Response{Success: true, Obj: obj})
}

// OK answers a successful request with nothing to return. It still carries the
// envelope rather than an empty body, so every response parses the same way.
func OK(c *gin.Context) {
	c.JSON(http.StatusOK, Response{Success: true})
}

// Fail answers with an explicit status and aborts the chain, so a handler that
// forgets to return cannot go on to write a second body.
func Fail(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, Response{Success: false, Msg: msg})
}

// Internal answers a failure the client can do nothing about.
//
// The message is fixed on purpose: an unrecognised error's text may name a
// table, a file path or a connection string, and none of that is something to
// hand a client. The detail belongs in the log.
func Internal(c *gin.Context) {
	Fail(c, http.StatusInternalServerError, "internal server error")
}
