package middleware

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// stubSource stands in for the user service.
type stubSource struct {
	tokens []domain.Token
	err    error
	calls  int
}

func (s *stubSource) ValidTokens(context.Context) ([]domain.Token, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	return s.tokens, nil
}

func token(value string, username string, expiry int64) domain.Token {
	return domain.Token{
		Token:  value,
		Expiry: expiry,
		User:   &domain.User{Username: username},
	}
}

func TestResolveMatchesAValidToken(t *testing.T) {
	source := &stubSource{tokens: []domain.Token{token("secret", "operator", 0)}}
	auth := NewTokenAuthenticator(source)
	if err := auth.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}

	if got := auth.resolve("secret"); got != "operator" {
		t.Errorf("resolve(valid) = %q, want %q", got, "operator")
	}
	if got := auth.resolve("wrong"); got != "" {
		t.Errorf("resolve(wrong) = %q, want %q", got, "")
	}
	if got := auth.resolve(""); got != "" {
		t.Errorf("resolve(empty) = %q, want %q", got, "")
	}
}

func TestResolveRejectsAnExpiredToken(t *testing.T) {
	past := time.Now().Add(-time.Hour).Unix()
	source := &stubSource{tokens: []domain.Token{token("stale", "operator", past)}}
	auth := NewTokenAuthenticator(source)
	if err := auth.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}

	if got := auth.resolve("stale"); got != "" {
		t.Errorf("resolve(expired) = %q, want %q", got, "")
	}
}

func TestAnExpiredTokenDoesNotHideALaterValidOne(t *testing.T) {
	past := time.Now().Add(-time.Hour).Unix()
	source := &stubSource{tokens: []domain.Token{
		token("stale", "operator", past),
		token("fresh", "operator", 0),
	}}
	auth := NewTokenAuthenticator(source)
	if err := auth.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}

	// Expired entries are skipped, never spliced out of the slice being
	// scanned: removing one shifts every later element back by one and the
	// scan steps over it, so a valid token stored immediately after an expired
	// one would stop authenticating.
	if got := auth.resolve("fresh"); got != "operator" {
		t.Errorf("resolve(fresh) = %q, want %q -- an expired entry hid it", got, "operator")
	}
}

func TestReloadKeepsTheOldTableOnFailure(t *testing.T) {
	source := &stubSource{tokens: []domain.Token{token("secret", "operator", 0)}}
	auth := NewTokenAuthenticator(source)
	if err := auth.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}

	source.err = errors.New("database is unreachable")
	if err := auth.Reload(context.Background()); err == nil {
		t.Fatal("Reload reported success on a failed load")
	}

	// Installing a half-built table on a failed load would revoke every
	// working token until the next successful reload -- turning a brief
	// database blip into a full outage for every machine caller.
	if got := auth.resolve("secret"); got != "operator" {
		t.Errorf("resolve after a failed reload = %q, want the previous table to stand", got)
	}
}

func TestReloadSkipsATokenWithNoOwner(t *testing.T) {
	orphan := domain.Token{Token: "orphan", Expiry: 0}
	source := &stubSource{tokens: []domain.Token{orphan, token("secret", "operator", 0)}}
	auth := NewTokenAuthenticator(source)
	if err := auth.Reload(context.Background()); err != nil {
		t.Fatalf("Reload: %v", err)
	}

	// A token whose owner did not load authenticates as nobody. Admitting it
	// with an empty username would pass the middleware's "username != \"\""
	// check nowhere, but it would also put an unattributable entry in the audit
	// log if it ever did.
	if got := auth.resolve("orphan"); got != "" {
		t.Errorf("resolve(orphan) = %q, want %q", got, "")
	}
	if got := auth.resolve("secret"); got != "operator" {
		t.Errorf("resolve(secret) = %q, want %q", got, "operator")
	}
}

func TestBaseSessionOptions(t *testing.T) {
	o := BaseSessionOptions(0)
	if !o.HttpOnly {
		t.Error("HttpOnly is off: a single XSS anywhere in the panel would hand over the session")
	}
	if o.Path != "/" {
		t.Errorf("Path = %q, want %q", o.Path, "/")
	}
	// 0 means a cookie that lasts until the browser closes, which is a
	// deliberate lifetime and not the same as "expire immediately".
	if o.MaxAge != 0 {
		t.Errorf("MaxAge = %d, want 0 for a session cookie", o.MaxAge)
	}

	o = BaseSessionOptions(2 * time.Hour)
	if o.MaxAge != 7200 {
		t.Errorf("MaxAge = %d, want 7200", o.MaxAge)
	}
}
