package validator

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// FieldError names the field that failed and why.
type FieldError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

// Errors is every field failure found in one pass. Validation collects instead
// of returning on the first problem so a client fixing a form is told about all
// of it at once rather than one field per round trip.
type Errors struct {
	Fields []FieldError `json:"fields"`
}

func (e *Errors) Error() string {
	parts := make([]string, 0, len(e.Fields))
	for _, f := range e.Fields {
		parts = append(parts, f.Field+" "+f.Reason)
	}
	return strings.Join(parts, "; ")
}

// Failed reports whether anything was collected. It exists so a caller can ask
// without comparing Err() against nil, which is the shape that goes wrong when
// a *Errors is assigned to an error variable.
func (e *Errors) Failed() bool {
	return e != nil && len(e.Fields) > 0
}

// Validator accumulates field failures.
type Validator struct {
	fields []FieldError
}

func New() *Validator {
	return &Validator{}
}

// Fail records an arbitrary failure. The other checks are written in terms of
// it, and a caller with a rule of its own can use it directly.
func (v *Validator) Fail(field string, reason string) {
	v.fields = append(v.fields, FieldError{Field: field, Reason: reason})
}

// Check records a failure when cond is false, so a caller reads as an assertion
// of what should hold.
func (v *Validator) Check(cond bool, field string, reason string) {
	if !cond {
		v.Fail(field, reason)
	}
}

// Required rejects an empty or whitespace-only value.
func (v *Validator) Required(field string, value string) {
	v.Check(strings.TrimSpace(value) != "", field, "must not be empty")
}

// MaxLen bounds a value in characters rather than bytes: the column limits it
// guards are declared in characters, and a name in a non-Latin script is
// otherwise rejected at a third of its apparent length.
func (v *Validator) MaxLen(field string, value string, n int) {
	v.Check(utf8.RuneCountInString(value) <= n, field, fmt.Sprintf("must be at most %d characters", n))
}

// MinLen bounds a value from below, in characters.
func (v *Validator) MinLen(field string, value string, n int) {
	v.Check(utf8.RuneCountInString(value) >= n, field, fmt.Sprintf("must be at least %d characters", n))
}

// NonNegative rejects a negative number. Quotas and traffic counters are
// unsigned in meaning but signed in storage, so this is where that is enforced.
func (v *Validator) NonNegative(field string, value int64) {
	v.Check(value >= 0, field, "must not be negative")
}

// Range bounds a number inclusively.
func (v *Validator) Range(field string, value int64, min int64, max int64) {
	v.Check(value >= min && value <= max, field, fmt.Sprintf("must be between %d and %d", min, max))
}

// In restricts a value to a fixed set.
func (v *Validator) In(field string, value string, allowed ...string) {
	for _, a := range allowed {
		if value == a {
			return
		}
	}
	v.Fail(field, "must be one of: "+strings.Join(allowed, ", "))
}

// Err returns the collected failures, or nil when everything passed.
func (v *Validator) Err() error {
	if len(v.fields) == 0 {
		return nil
	}
	return &Errors{Fields: v.fields}
}
