package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// renameOutboundDependents runs inside the same transaction as the outbound
// edit. A failed reference update must leave both the tag and its users intact.
func renameOutboundDependents(ctx context.Context, tx *repository.Store, outbounds []domain.Outbound, id uint, oldTag, newTag string) error {
	base, err := tx.Settings.GetForUpdate(ctx, domain.SettingCoreConfig)
	if errors.Is(err, domain.ErrNotFound) {
		base = domain.DefaultCoreConfig
	} else if err != nil {
		return err
	}
	updated, changed, err := renameOutboundReferences(domain.JSON(base), nil, oldTag, newTag)
	if err != nil {
		return err
	}
	if changed {
		if err := tx.Settings.Set(ctx, domain.SettingCoreConfig, string(updated)); err != nil {
			return err
		}
	}
	for i := range outbounds {
		outbound := &outbounds[i]
		if outbound.Id == id {
			continue // The incoming edit, including its options, is saved by Update.
		}
		updated, changed, err := renameOutboundReferences(outbound.Options,
			[]string{"outbounds", outbound.Type}, oldTag, newTag)
		if err != nil {
			return err
		}
		if changed {
			outbound.Options = updated
			if err := tx.Outbounds.Save(ctx, outbound); err != nil {
				return err
			}
		}
	}
	inbounds, err := tx.Inbounds.ListForUpdate(ctx)
	if err != nil {
		return err
	}
	for i := range inbounds {
		inbound := &inbounds[i]
		updated, changed, err := renameOutboundReferences(inbound.Options, []string{"inbounds"}, oldTag, newTag)
		if err != nil {
			return err
		}
		if changed {
			inbound.Options = updated
			if err := tx.Inbounds.Save(ctx, inbound); err != nil {
				return err
			}
		}
	}
	return tx.Stats.RenameTag(ctx, domain.ResourceOutbound, oldTag, newTag)
}

// Only reference fields are changed: an equal DNS tag, inbound tag, password,
// hostname, or HTTP header belongs to a different namespace. UseNumber keeps
// large integers in otherwise untouched options exact when the document is saved.
func renameOutboundReferences(document domain.JSON, path []string, oldTag, newTag string) (domain.JSON, bool, error) {
	if len(document) == 0 || oldTag == newTag {
		return document, false, nil
	}
	if !json.Valid(document) {
		return nil, false, domain.Invalidf("cannot rename outbound references in invalid JSON")
	}
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, false, domain.Invalidf("cannot rename outbound references in invalid JSON: %v", err)
	}
	if value != nil {
		if _, ok := value.(map[string]interface{}); !ok {
			return nil, false, domain.Invalidf("outbound references must be in a JSON object")
		}
	}
	if !rewriteOutboundReferences(value, path, oldTag, newTag) {
		return document, false, nil
	}
	updated, err := json.Marshal(value)
	return domain.JSON(updated), true, err
}

func rewriteOutboundReferences(value interface{}, path []string, oldTag, newTag string) bool {
	changed := false
	switch value := value.(type) {
	case map[string]interface{}:
		for key, child := range value {
			// These are user data, not nested core configuration objects.
			if key == "headers" || key == "request_headers" || key == "response_headers" || key == "users" {
				continue
			}
			childPath := append(slices.Clone(path), key)
			if isOutboundReference(childPath) {
				switch tags := child.(type) {
				case string:
					if tags == oldTag {
						value[key] = newTag
						changed = true
					}
				case []interface{}:
					for i, tag := range tags {
						if tag == oldTag {
							tags[i] = newTag
							changed = true
						}
					}
				}
			}
			changed = rewriteOutboundReferences(child, childPath, oldTag, newTag) || changed
		}
	case []interface{}:
		for _, child := range value {
			changed = rewriteOutboundReferences(child, path, oldTag, newTag) || changed
		}
	}
	return changed
}

func isOutboundReference(path []string) bool {
	key := path[len(path)-1]
	switch key {
	case "detour":
		// An inbound's own detour forwards to another inbound. Nested dial
		// fields, such as its ACME HTTP client, reference outbounds instead.
		return !slices.Equal(path, []string{"inbounds", "detour"})
	case "download_detour", "external_ui_download_detour":
		return true
	case "outbound":
		return len(path) >= 3 && (path[0] == "route" || path[0] == "dns") && path[1] == "rules"
	case "final":
		return slices.Equal(path, []string{"route", "final"})
	case "outbounds":
		return (len(path) == 3 && path[0] == "outbounds" && (path[1] == "selector" || path[1] == "urltest")) ||
			slices.Equal(path, []string{"experimental", "v2ray_api", "stats", "outbounds"})
	case "default":
		return slices.Equal(path, []string{"outbounds", "selector", "default"})
	}
	return false
}
