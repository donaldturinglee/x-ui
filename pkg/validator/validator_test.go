package validator

import (
	"strings"
	"testing"
)

func TestErrIsNilWhenNothingFailed(t *testing.T) {
	v := New()
	v.Required("name", "set")
	v.MaxLen("name", "set", 10)
	v.NonNegative("volume", 0)

	if err := v.Err(); err != nil {
		t.Errorf("Err() = %v, want nil", err)
	}
}

func TestCollectsEveryFailure(t *testing.T) {
	v := New()
	v.Required("name", "")
	v.Required("group", "   ")
	v.NonNegative("volume", -1)

	err := v.Err()
	if err == nil {
		t.Fatal("Err() = nil, want three failures")
	}

	errs, ok := err.(*Errors)
	if !ok {
		t.Fatalf("Err() returned %T, want *Errors", err)
	}
	// Validation collects rather than returning on the first problem, so a
	// client filling in a form is told about all of it at once instead of one
	// field per round trip.
	if len(errs.Fields) != 3 {
		t.Fatalf("got %d field errors, want 3: %v", len(errs.Fields), errs.Fields)
	}

	message := err.Error()
	for _, field := range []string{"name", "group", "volume"} {
		if !strings.Contains(message, field) {
			t.Errorf("Error() = %q, want it to name %q", message, field)
		}
	}
}

func TestRequiredRejectsWhitespace(t *testing.T) {
	v := New()
	// A name of spaces is stored, listed, and looks like a blank row. It is
	// empty for every purpose the check exists for.
	v.Required("name", " \t\n ")

	if v.Err() == nil {
		t.Error("Required accepted a whitespace-only value")
	}
}

func TestLengthIsCountedInCharacters(t *testing.T) {
	// Six characters, eighteen bytes. Counted in bytes, a name in a non-Latin
	// script is rejected at a third of its apparent length.
	const name = "日本語テスト名"

	v := New()
	v.MaxLen("name", name, 10)
	if err := v.Err(); err != nil {
		t.Errorf("MaxLen rejected a 7-character name with a limit of 10: %v", err)
	}

	v = New()
	v.MaxLen("name", name, 5)
	if v.Err() == nil {
		t.Error("MaxLen accepted a 7-character name with a limit of 5")
	}

	v = New()
	v.MinLen("password", "12345678", 8)
	if err := v.Err(); err != nil {
		t.Errorf("MinLen rejected an 8-character value with a minimum of 8: %v", err)
	}
}

func TestRange(t *testing.T) {
	cases := []struct {
		value int64
		ok    bool
	}{
		{value: -1, ok: false},
		{value: 0, ok: true},
		{value: 180, ok: true},
		{value: 365, ok: true},
		{value: 366, ok: false},
	}

	for _, tc := range cases {
		v := New()
		v.Range("resetDays", tc.value, 0, 365)
		if got := v.Err() == nil; got != tc.ok {
			t.Errorf("Range(%d, 0, 365) accepted = %v, want %v", tc.value, got, tc.ok)
		}
	}
}

func TestIn(t *testing.T) {
	v := New()
	v.In("resource", "client", "inbound", "outbound", "client")
	if err := v.Err(); err != nil {
		t.Errorf("In rejected a permitted value: %v", err)
	}

	v = New()
	v.In("resource", "router", "inbound", "outbound", "client")
	err := v.Err()
	if err == nil {
		t.Fatal("In accepted a value outside the set")
	}
	// Naming the permitted values is the difference between a message a caller
	// can act on and one that sends them to the source.
	if !strings.Contains(err.Error(), "inbound") {
		t.Errorf("Error() = %q, want it to list the permitted values", err)
	}
}

func TestCheckRecordsOnlyOnFalse(t *testing.T) {
	v := New()
	v.Check(true, "autoReset", "should not appear")
	if err := v.Err(); err != nil {
		t.Errorf("Check(true) recorded a failure: %v", err)
	}

	v.Check(false, "resetDays", "must be set when autoReset is on")
	if v.Err() == nil {
		t.Error("Check(false) recorded nothing")
	}
}

func TestFailed(t *testing.T) {
	var none *Errors
	if none.Failed() {
		t.Error("a nil *Errors reports as failed")
	}

	if (&Errors{}).Failed() {
		t.Error("an empty *Errors reports as failed")
	}

	if !(&Errors{Fields: []FieldError{{Field: "name", Reason: "must not be empty"}}}).Failed() {
		t.Error("a populated *Errors reports as not failed")
	}
}
