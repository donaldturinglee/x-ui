package service

import (
	"strings"
	"testing"
)

func TestHashPasswordRoundTrips(t *testing.T) {
	const password = "correct horse battery staple"

	hash, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	if hash == password {
		t.Fatal("hashPassword returned the plaintext")
	}
	if !strings.HasPrefix(hash, "$2") {
		t.Errorf("hash = %q, want a bcrypt hash", hash)
	}
	if !checkPassword(password, hash) {
		t.Error("checkPassword rejected the password it was hashed from")
	}
	if checkPassword("wrong", hash) {
		t.Error("checkPassword accepted the wrong password")
	}
}

func TestHashesAreSalted(t *testing.T) {
	const password = "same password"

	first, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}
	second, err := hashPassword(password)
	if err != nil {
		t.Fatalf("hashPassword: %v", err)
	}

	// Two operators who pick the same password must not end up with the same
	// stored hash: otherwise a leaked table tells an attacker which accounts
	// to attack once.
	if first == second {
		t.Error("two hashes of the same password are identical, so they are not salted")
	}
	if !checkPassword(password, first) || !checkPassword(password, second) {
		t.Error("a salted hash failed to verify")
	}
}

func TestCheckPasswordRejectsMalformedHashes(t *testing.T) {
	// A row that is not a bcrypt hash -- truncated, empty, or a plaintext
	// password left by something that bypassed this package -- must fail
	// closed. Comparing it as text would authenticate whoever knows the value.
	for _, stored := range []string{"", "plaintext", "$2a$10$tooshort"} {
		if checkPassword(stored, stored) {
			t.Errorf("checkPassword accepted a malformed stored value %q", stored)
		}
	}
}

func TestBurnPasswordCheckAlwaysFails(t *testing.T) {
	// It exists to spend the same work a real check would, on the path where
	// no account matched. If it ever succeeded it would be an authentication
	// bypass for an unknown username.
	burnPasswordCheck("anything")
	if checkPassword("anything", dummyHash) {
		t.Error("the dummy hash matched a guessable password")
	}
}

func TestValidateCredentials(t *testing.T) {
	cases := map[string]struct {
		username string
		password string
		ok       bool
	}{
		"fine":               {username: "operator", password: "a-good-password", ok: true},
		"no username":        {username: "", password: "a-good-password", ok: false},
		"no password":        {username: "operator", password: "", ok: false},
		"password too short": {username: "operator", password: "short", ok: false},
		"password at the minimum": {
			username: "operator", password: "12345678", ok: true,
		},
		"password past bcrypt's limit": {
			// bcrypt silently ignores everything past 72 bytes, so a longer
			// password is not the password the operator thinks they set.
			username: "operator",
			password: strings.Repeat("x", 73),
			ok:       false,
		},
		"password exactly at bcrypt's limit": {
			username: "operator",
			password: strings.Repeat("x", 72),
			ok:       true,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := validateCredentials(tc.username, tc.password)
			if got := err == nil; got != tc.ok {
				t.Errorf("validateCredentials accepted = %v (%v), want %v", got, err, tc.ok)
			}
		})
	}
}
