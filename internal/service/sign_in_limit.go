package service

import (
	"sync"
	"time"
)

// A panel is normally reachable from the whole internet, and the only thing
// between an attacker and an operator account is one password. bcrypt makes
// each attempt cost milliseconds, which is not a rate limit: a single host can
// still run thousands of guesses an hour, and nothing in the log distinguishes
// that from ordinary traffic.
//
// Attempts are counted per source address, never per username: counting per
// username would let anyone lock an operator out of their own panel by
// guessing at their name from somewhere else.
const (
	maxSignInFailures = 10
	signInLockout     = 10 * time.Minute
	signInFailureTTL  = 30 * time.Minute
)

type signInFailures struct {
	count    int
	last     time.Time
	lockedAt time.Time
}

// signInLimiter holds the recent failures per source address.
//
// It is in memory, which means it is per process and is forgotten on restart.
// That is the right trade for what it defends against -- a sustained guessing
// run -- and it keeps a failed sign-in off the write path of the database,
// where an attacker could otherwise drive load by failing on purpose.
type signInLimiter struct {
	mu        sync.Mutex
	attempts  map[string]*signInFailures
	lastSweep time.Time
}

func newSignInLimiter() *signInLimiter {
	return &signInLimiter{attempts: map[string]*signInFailures{}}
}

// LockedOut reports whether this address has failed often enough recently to
// be held off, and for how much longer.
func (l *signInLimiter) LockedOut(remoteIP string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	f := l.attempts[remoteIP]
	if f == nil || f.lockedAt.IsZero() {
		return false, 0
	}
	if remaining := signInLockout - now.Sub(f.lockedAt); remaining > 0 {
		return true, remaining
	}
	// The lockout has run out. Clearing the count as well means the next
	// attempt starts from zero rather than re-locking on a single failure.
	delete(l.attempts, remoteIP)
	return false, 0
}

// NoteFailure records a failed attempt and reports whether it tripped the
// lockout.
func (l *signInLimiter) NoteFailure(remoteIP string) bool {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)

	f := l.attempts[remoteIP]
	if f == nil {
		f = &signInFailures{}
		l.attempts[remoteIP] = f
	}
	// A slow trickle of failures is not an attack. Counting only what arrives
	// inside the window stops an operator who mistypes once a week from
	// eventually being locked out.
	if !f.last.IsZero() && now.Sub(f.last) > signInFailureTTL {
		f.count = 0
	}
	f.count++
	f.last = now
	if f.count >= maxSignInFailures && f.lockedAt.IsZero() {
		f.lockedAt = now
		return true
	}
	return false
}

// NoteSuccess forgets an address's failures.
func (l *signInLimiter) NoteSuccess(remoteIP string) {
	l.mu.Lock()
	delete(l.attempts, remoteIP)
	l.mu.Unlock()
}

// sweepLocked drops entries nothing is counting any more, so a flood from
// changing source addresses cannot grow the map without bound.
func (l *signInLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < signInFailureTTL {
		return
	}
	l.lastSweep = now
	for ip, f := range l.attempts {
		if now.Sub(f.last) > signInFailureTTL && (f.lockedAt.IsZero() || now.Sub(f.lockedAt) > signInLockout) {
			delete(l.attempts, ip)
		}
	}
}
