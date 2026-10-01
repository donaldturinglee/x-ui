package domain

import (
	"errors"
	"fmt"
)

// The vocabulary every layer below the transport speaks when something goes
// wrong. A repository or a service says what kind of failure this was; only the
// handler knows what that means over HTTP.
//
// They are sentinels rather than types so a caller can add context with %w and
// still be recognised: fmt.Errorf("client %q: %w", name, domain.ErrNotFound).
var (
	ErrInvalid      = errors.New("invalid")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("conflict")

	// ErrCodeRequired is a sign-in whose password was right for an account that
	// also takes a code from an authenticator app, sent without one. It is not a
	// failure but the second half of the sign-in, and the transport says so in a
	// way the form can ask for the code by.
	ErrCodeRequired = errors.New("enter the code from your authenticator app")
)

// NotFoundf reports a missing record, e.g. NotFoundf("client %d", id).
func NotFoundf(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), ErrNotFound)
}

// Invalidf reports input the caller has to fix.
func Invalidf(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), ErrInvalid)
}

// Conflictf reports a request that collides with what is already stored.
func Conflictf(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), ErrConflict)
}

// Unauthorizedf reports a caller the panel does not recognise.
func Unauthorizedf(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), ErrUnauthorized)
}

// Forbiddenf reports a caller the panel recognises but will not let through.
func Forbiddenf(format string, args ...interface{}) error {
	return fmt.Errorf("%s: %w", fmt.Sprintf(format, args...), ErrForbidden)
}
