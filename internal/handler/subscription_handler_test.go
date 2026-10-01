package handler

import (
	"strings"
	"testing"
)

func TestContentDispositionCarriesBothSpellings(t *testing.T) {
	got := contentDisposition("Alice")

	// The plain spelling for clients that read only ASCII, and the RFC 5987
	// one so a title in any script survives.
	if !strings.Contains(got, `filename="Alice"`) {
		t.Errorf("Content-Disposition = %q, want the plain filename", got)
	}
	if !strings.Contains(got, "filename*=UTF-8''Alice") {
		t.Errorf("Content-Disposition = %q, want the encoded filename", got)
	}
}

func TestContentDispositionEscapesOperatorText(t *testing.T) {
	// A title is operator-supplied. A quote or a backslash interpolated raw
	// ends the filename parameter early and lets the rest of the string be read
	// as further header parameters.
	got := contentDisposition(`Ali"ce\`)
	if strings.Contains(got, `"Ali"ce`) {
		t.Errorf("Content-Disposition = %q, want the quote neutralised", got)
	}
	if !strings.Contains(got, `filename="Ali_ce_"`) {
		t.Errorf("Content-Disposition = %q, want quote and backslash replaced", got)
	}
}

func TestContentDispositionHandlesNonAscii(t *testing.T) {
	got := contentDisposition("日本語")

	// Nothing of the original survives the ASCII pass, so the fallback name is
	// used rather than an empty filename.
	if !strings.Contains(got, `filename="subscription"`) {
		t.Errorf("Content-Disposition = %q, want the ASCII fallback", got)
	}
	// The encoded spelling carries the real name, percent-encoded per byte.
	if !strings.Contains(got, "filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E") {
		t.Errorf("Content-Disposition = %q, want the percent-encoded name", got)
	}
}

func TestContentDispositionFallsBackOnAnEmptyTitle(t *testing.T) {
	for _, title := range []string{"", "   ", "\t"} {
		got := contentDisposition(title)
		if !strings.Contains(got, `filename="subscription"`) {
			t.Errorf("contentDisposition(%q) = %q, want the fallback name", title, got)
		}
	}
}

func TestRfc5987EncodeLeavesSafeCharacters(t *testing.T) {
	got := rfc5987Encode("a-b_c.1~")
	if got != "a-b_c.1~" {
		t.Errorf("rfc5987Encode = %q, want the safe characters untouched", got)
	}
	// A space is not an attr-char and has to be encoded.
	if got := rfc5987Encode("a b"); got != "a%20b" {
		t.Errorf("rfc5987Encode(\"a b\") = %q, want %q", got, "a%20b")
	}
}
