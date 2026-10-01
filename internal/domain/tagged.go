package domain

import "encoding/json"

// The core identifies an outbound by a type and a tag, and everything else about
// it is options the panel stores verbatim so a new core release needs no
// migration.
//
// How one is taken apart on the way in and put back together on the way out is
// written here, apart from the type, so the rules the two shapes follow read on
// their own. The whole point of the blob is that nothing between the request and
// the generated config touches its contents.

// splitCoreObject pulls the modelled fields out of an incoming core object and
// returns everything else as the options blob.
func splitCoreObject(data []byte) (uint, string, string, JSON, error) {
	var raw map[string]interface{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return 0, "", "", nil, err
	}

	var id uint
	if value, exists := raw["id"].(float64); exists {
		id = uint(value)
	}
	delete(raw, "id")

	// Comma-ok on both: a request whose type or tag is a number rather than a
	// string would otherwise panic here instead of failing validation.
	objectType, _ := raw["type"].(string)
	delete(raw, "type")
	tag, _ := raw["tag"].(string)
	delete(raw, "tag")

	options, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return 0, "", "", nil, err
	}
	return id, objectType, tag, JSON(options), nil
}

// coreShape rebuilds the object the way the core expects it: the modelled
// fields with the options flattened back out alongside them.
func coreShape(objectType string, tag string, options JSON) (map[string]interface{}, error) {
	combined := map[string]interface{}{
		"type": objectType,
		"tag":  tag,
	}
	if err := flattenOptions(combined, options); err != nil {
		return nil, err
	}

	// A TLS block that is switched off is noise in a generated config, and some
	// core versions treat its presence as intent rather than reading `enabled`.
	// The panel stores it either way, so the operator's settings survive being
	// toggled off and on.
	if raw, ok := combined["tls"].(json.RawMessage); ok {
		var tls map[string]interface{}
		if json.Unmarshal(raw, &tls) == nil {
			if enabled, _ := tls["enabled"].(bool); !enabled {
				delete(combined, "tls")
			}
		}
	}
	return combined, nil
}

// panelShape rebuilds the object the way the panel's own API returns it: the
// same flattening, plus the id the core config has no use for.
func panelShape(id uint, objectType string, tag string, options JSON) (map[string]interface{}, error) {
	combined := map[string]interface{}{
		"id":   id,
		"type": objectType,
		"tag":  tag,
	}
	if err := flattenOptionsAny(combined, options); err != nil {
		return nil, err
	}
	return combined, nil
}

// flattenOptions copies the stored options into combined as raw JSON, which
// keeps them byte-for-byte on the way to the core.
func flattenOptions(combined map[string]interface{}, options JSON) error {
	if len(options) == 0 {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(options.Raw(), &fields); err != nil {
		return err
	}
	for key, value := range fields {
		combined[key] = value
	}
	return nil
}

// flattenOptionsAny does the same as decoded values, which is what a panel
// client wants to read rather than re-parse.
func flattenOptionsAny(combined map[string]interface{}, options JSON) error {
	if len(options) == 0 {
		return nil
	}
	var fields map[string]interface{}
	if err := json.Unmarshal(options.Raw(), &fields); err != nil {
		return err
	}
	for key, value := range fields {
		combined[key] = value
	}
	return nil
}
