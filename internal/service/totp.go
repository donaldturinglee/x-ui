package service

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Two-factor codes are the ones every authenticator app computes: RFC 6238's
// time-based one-time passwords over HMAC-SHA1, six digits for each thirty
// seconds. None of it is configurable, because an app handed any other choice
// tends to ignore it and show codes that never match.
const (
	totpDigits = 6
	// totpPeriod is how long one code lasts, in seconds.
	totpPeriod = 30
	// totpSkew is how many periods either side of now a code is still taken in,
	// for a phone whose clock has drifted or a code typed as it turned over.
	totpSkew = 1
	// totpSecretBytes is the size of a minted secret: the 160 bits RFC 4226
	// recommends for an HMAC-SHA1 key.
	totpSecretBytes = 20
	// totpMinimumSecretBytes is the smallest secret an account takes, the 128
	// bits RFC 4226 requires. A secret is only ever one this panel minted, but it
	// comes back from the browser to be confirmed, so it is checked there.
	totpMinimumSecretBytes = 16
	// totpIssuer is what an authenticator app files the account's codes under.
	totpIssuer = "x-ui"
)

// totpEncoding is base32 the way apps write it: without padding.
var totpEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// newTotpSecret mints a secret for an authenticator app.
func newTotpSecret() (string, error) {
	buf := make([]byte, totpSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return totpEncoding.EncodeToString(buf), nil
}

// decodeTotpSecret reads a secret the way an app does: case, spaces and padding
// are how people copy one, not part of it.
func decodeTotpSecret(secret string) ([]byte, error) {
	cleaned := strings.ToUpper(strings.ReplaceAll(secret, " ", ""))
	return totpEncoding.DecodeString(strings.TrimRight(cleaned, "="))
}

// hotp is RFC 4226's one-time password for one value of the counter, digits
// long. A time-based code is this with the counter counting periods.
func hotp(key []byte, counter uint64, digits int) string {
	var message [8]byte
	binary.BigEndian.PutUint64(message[:], counter)
	mac := hmac.New(sha1.New, key)
	mac.Write(message[:])
	sum := mac.Sum(nil)

	// Dynamic truncation: four bytes from where the last nibble points, less
	// their top bit, so the number is the same whatever signedness reads it.
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff

	modulus := uint32(1)
	for i := 0; i < digits; i++ {
		modulus *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%modulus)
}

// matchTotp reports the period a code is for, looking a period either side of
// now, or false for a code that matches none of them. Every candidate is
// compared in constant time, so how long a wrong code takes to refuse says
// nothing about how close it was.
func matchTotp(key []byte, code string, now time.Time) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != totpDigits {
		return 0, false
	}
	current := now.Unix() / totpPeriod
	for step := current - totpSkew; step <= current+totpSkew; step++ {
		if subtle.ConstantTimeCompare([]byte(hotp(key, uint64(step), totpDigits)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// totpURI is the address an authenticator app is given a secret by, which is
// what the QR code it scans holds: the panel as the issuer and the account's
// name as the label, so an operator with several panels can tell them apart.
func totpURI(account string, secret string) string {
	query := url.Values{}
	query.Set("secret", secret)
	query.Set("issuer", totpIssuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(totpDigits))
	query.Set("period", strconv.Itoa(totpPeriod))
	return "otpauth://totp/" + url.PathEscape(totpIssuer+":"+account) + "?" + query.Encode()
}

// totpReplay remembers the last period each account had a code accepted for,
// so a code seen once -- over a shoulder, in a proxy's log -- cannot be used
// again in the minute or so it would otherwise stay good.
//
// It is in memory, as the sign-in limiter is and for the same reasons. A
// restart forgets it, which reopens that minute for a code seen just before it.
type totpReplay struct {
	mu   sync.Mutex
	last map[uint]int64
}

func newTotpReplay() *totpReplay {
	return &totpReplay{last: map[uint]int64{}}
}

// accept takes a code for an account once: it has to match the secret, and be
// for a later period than the last code the account had accepted.
func (r *totpReplay) accept(userId uint, secret string, code string, now time.Time) bool {
	key, err := decodeTotpSecret(secret)
	if err != nil {
		return false
	}
	step, ok := matchTotp(key, code, now)
	if !ok {
		return false
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if step <= r.last[userId] {
		return false
	}
	r.last[userId] = step
	return true
}
