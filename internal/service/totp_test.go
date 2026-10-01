package service

import (
	"strings"
	"testing"
	"time"
)

// The test vectors RFC 6238 gives for HMAC-SHA1: eight digits, the ASCII
// secret below, and the code for each moment.
func TestTotpMatchesTheRFCsVectors(t *testing.T) {
	key := []byte("12345678901234567890")
	vectors := map[int64]string{
		59:          "94287082",
		1111111109:  "07081804",
		1111111111:  "14050471",
		1234567890:  "89005924",
		2000000000:  "69279037",
		20000000000: "65353130",
	}
	for at, want := range vectors {
		if got := hotp(key, uint64(at/totpPeriod), 8); got != want {
			t.Errorf("code at %d = %s, want %s", at, got, want)
		}
	}
}

func TestACodeIsTakenInForAPeriodEitherSideOfNow(t *testing.T) {
	key := []byte("12345678901234567890")
	now := time.Unix(1111111111, 0)
	step := now.Unix() / totpPeriod

	// A phone's clock a little behind or ahead, or a code typed as it turned
	// over, is still let in...
	for _, offset := range []int64{-1, 0, 1} {
		code := hotp(key, uint64(step+offset), totpDigits)
		if got, ok := matchTotp(key, code, now); !ok || got != step+offset {
			t.Errorf("the code %d period(s) from now was refused", offset)
		}
	}
	// ...and one from further away is not.
	if _, ok := matchTotp(key, hotp(key, uint64(step-2), totpDigits), now); ok {
		t.Error("a code two periods old was taken")
	}
}

func TestACodeIsReadAsPeopleTypeOne(t *testing.T) {
	key := []byte("12345678901234567890")
	now := time.Unix(1234567890, 0)
	code := hotp(key, uint64(now.Unix()/totpPeriod), totpDigits)

	if _, ok := matchTotp(key, " "+code[:3]+" "+code[3:]+" ", now); !ok {
		t.Error("a code with the spaces an app shows it with was refused")
	}
	for _, wrong := range []string{"", code[:5], code + "0", "abcdef"} {
		if _, ok := matchTotp(key, wrong, now); ok {
			t.Errorf("%q was taken as a code", wrong)
		}
	}
}

func TestACodeIsTakenOnce(t *testing.T) {
	secret, err := newTotpSecret()
	if err != nil {
		t.Fatalf("newTotpSecret: %v", err)
	}
	key, _ := decodeTotpSecret(secret)
	now := time.Now()
	code := hotp(key, uint64(now.Unix()/totpPeriod), totpDigits)

	codes := newTotpReplay()
	if !codes.accept(1, secret, code, now) {
		t.Fatal("the current code was refused")
	}
	// Seen once, it is spent: over a shoulder or in a log, it is no good again.
	if codes.accept(1, secret, code, now) {
		t.Error("the same code was taken twice")
	}
	// Another account's use of a period is not this one's.
	if !codes.accept(2, secret, code, now) {
		t.Error("one account's code spent another's")
	}
	// The next period's code is a new code.
	next := now.Add(totpPeriod * time.Second)
	if !codes.accept(1, secret, hotp(key, uint64(next.Unix()/totpPeriod), totpDigits), next) {
		t.Error("the next period's code was refused")
	}
}

func TestASecretIsReadAsPeopleCopyOne(t *testing.T) {
	secret, err := newTotpSecret()
	if err != nil {
		t.Fatalf("newTotpSecret: %v", err)
	}
	key, err := decodeTotpSecret(secret)
	if err != nil || len(key) != totpSecretBytes {
		t.Fatalf("a minted secret decodes to %d bytes (%v), want %d", len(key), err, totpSecretBytes)
	}

	// Lower case, grouped in fours and padded, it is still the same secret.
	var grouped []string
	for i := 0; i < len(secret); i += 4 {
		grouped = append(grouped, strings.ToLower(secret[i:min(i+4, len(secret))]))
	}
	copied, err := decodeTotpSecret(strings.Join(grouped, " ") + "====")
	if err != nil || string(copied) != string(key) {
		t.Errorf("the copied secret read as %x (%v), want %x", copied, err, key)
	}
}

func TestTheAddressAnAppScansNamesThePanelAndTheAccount(t *testing.T) {
	uri := totpURI("ops admin", "JBSWY3DPEHPK3PXP")

	for _, want := range []string{
		"otpauth://totp/x-ui:ops%20admin?",
		"secret=JBSWY3DPEHPK3PXP",
		"issuer=x-ui",
		"digits=6",
		"period=30",
	} {
		if !strings.Contains(uri, want) {
			t.Errorf("uri = %s, want it to carry %q", uri, want)
		}
	}
}
