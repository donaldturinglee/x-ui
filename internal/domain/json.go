package domain

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
)

// JSON is a document stored in a jsonb column.
//
// json.RawMessage on its own is a []byte, and a []byte reaches the driver as
// bytea -- Postgres then refuses to store it in a jsonb column, and a value
// that did get through would not be queryable as JSON. The Valuer/Scanner pair
// below is what keeps the column a real jsonb.
type JSON json.RawMessage

// Value renders the document for the driver. An empty document is stored as
// NULL rather than as the four bytes "null", so "no value" and "the JSON value
// null" stay distinguishable.
func (j JSON) Value() (driver.Value, error) {
	if len(j) == 0 {
		return nil, nil
	}
	if !json.Valid(j) {
		return nil, fmt.Errorf("domain: refusing to store invalid JSON")
	}
	return string(j), nil
}

func (j *JSON) Scan(src interface{}) error {
	switch v := src.(type) {
	case nil:
		*j = nil
	case []byte:
		// Copied: the driver reuses its read buffer between rows, so keeping
		// the slice hands the next row's bytes to whoever holds this one.
		*j = append(JSON(nil), v...)
	case string:
		*j = JSON(v)
	default:
		return fmt.Errorf("domain: cannot scan %T into JSON", src)
	}
	return nil
}

// MarshalJSON embeds the document as-is rather than as a base64 string, which
// is what a []byte would otherwise become.
func (j JSON) MarshalJSON() ([]byte, error) {
	if len(j) == 0 {
		return []byte("null"), nil
	}
	return j, nil
}

func (j *JSON) UnmarshalJSON(data []byte) error {
	if j == nil {
		return fmt.Errorf("domain: UnmarshalJSON on nil JSON")
	}
	*j = append((*j)[0:0], data...)
	return nil
}

// GormDataType tells GORM the column is jsonb, so a generated clause quotes and
// casts it correctly.
func (JSON) GormDataType() string {
	return "jsonb"
}

// String renders the document for logs and errors.
func (j JSON) String() string {
	if len(j) == 0 {
		return ""
	}
	return string(j)
}

// Raw converts to the encoding/json type, for callers that unmarshal it.
func (j JSON) Raw() json.RawMessage {
	return json.RawMessage(j)
}
