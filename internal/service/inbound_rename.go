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

// The caller holds the tag lock and saves the edited inbound in this same
// transaction. References, history, aliases and the audit entry commit together.
func renameInboundDependents(ctx context.Context, tx *repository.Store, inbounds []domain.Inbound, id uint, oldTag, newTag string) error {
	if err := tx.Inbounds.ReserveTag(ctx, oldTag, id); err != nil {
		return err
	}
	base, err := tx.Settings.GetForUpdate(ctx, domain.SettingCoreConfig)
	if errors.Is(err, domain.ErrNotFound) {
		base = domain.DefaultCoreConfig
	} else if err != nil {
		return err
	}
	updated, changed, err := renameInboundReferences(domain.JSON(base), nil, oldTag, newTag)
	if err != nil {
		return err
	}
	if changed {
		if err := tx.Settings.Set(ctx, domain.SettingCoreConfig, string(updated)); err != nil {
			return err
		}
	}
	for i := range inbounds {
		inbound := &inbounds[i]
		if inbound.Id == id {
			continue
		}
		updated, changed, err := renameInboundReferences(inbound.Options, []string{"inbounds"}, oldTag, newTag)
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
	return tx.Stats.RenameTag(ctx, domain.ResourceInbound, oldTag, newTag)
}

func renameInboundReferences(document domain.JSON, path []string, oldTag, newTag string) (domain.JSON, bool, error) {
	if len(document) == 0 || oldTag == newTag {
		return document, false, nil
	}
	if !json.Valid(document) {
		return nil, false, domain.Invalidf("cannot rename inbound references in invalid JSON")
	}
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(document))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return nil, false, domain.Invalidf("cannot rename inbound references in invalid JSON: %v", err)
	}
	if value != nil {
		if _, ok := value.(map[string]interface{}); !ok {
			return nil, false, domain.Invalidf("inbound references must be in a JSON object")
		}
	}
	if !rewriteInboundReferences(value, path, oldTag, newTag) {
		return document, false, nil
	}
	updated, err := json.Marshal(value)
	return domain.JSON(updated), true, err
}

func rewriteInboundReferences(value interface{}, path []string, oldTag, newTag string) bool {
	changed := false
	switch value := value.(type) {
	case map[string]interface{}:
		for key, child := range value {
			if key == "headers" || key == "request_headers" || key == "response_headers" || key == "users" {
				continue
			}
			childPath := append(slices.Clone(path), key)
			if isInboundReference(childPath) {
				switch tags := child.(type) {
				case string:
					if tags == oldTag {
						value[key], changed = newTag, true
					}
				case []interface{}:
					for i, tag := range tags {
						if tag == oldTag {
							tags[i], changed = newTag, true
						}
					}
				}
			}
			changed = rewriteInboundReferences(child, childPath, oldTag, newTag) || changed
		}
	case []interface{}:
		for _, child := range value {
			changed = rewriteInboundReferences(child, path, oldTag, newTag) || changed
		}
	}
	return changed
}

func isInboundReference(path []string) bool {
	if slices.Equal(path, []string{"inbounds", "detour"}) ||
		slices.Equal(path, []string{"experimental", "v2ray_api", "stats", "inbounds"}) {
		return true
	}
	if len(path) < 3 || (path[0] != "route" && path[0] != "dns") || path[1] != "rules" || path[len(path)-1] != "inbound" {
		return false
	}
	// Logical conditions nest via rules only. Other objects under a rule may
	// carry unrelated user data that happens to contain the same field name.
	for _, key := range path[2 : len(path)-1] {
		if key != "rules" {
			return false
		}
	}
	return true
}
