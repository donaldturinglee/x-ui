package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// RandomSecret returns n bytes of randomness as a URL-safe string.
//
// It reads crypto/rand and returns the error rather than falling back to a
// weaker source: every caller is minting something that authenticates a
// request, and a session secret or an API token that came out of a predictable
// generator is worse than one that was never issued.
func RandomSecret(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// recordChange appends one entry to the audit log.
//
// A failure here is logged and swallowed on purpose when the caller passes a
// store outside a transaction: losing the audit entry for a change that
// succeeded is bad, but refusing a change the operator already made because
// its audit entry would not write is worse. Inside a transaction the caller
// gets the error and the whole change rolls back together.
func recordChange(ctx context.Context, store *repository.Store, actor string, key string, action string, obj interface{}) error {
	encoded, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	return store.Stats.AddChange(ctx, &domain.Change{
		DateTime: time.Now().Unix(),
		Actor:    actor,
		Key:      key,
		Action:   action,
		Obj:      domain.JSON(encoded),
	})
}

// logChange records an audit entry and reports a failure to write it without
// failing the change it describes. For callers not already inside a
// transaction.
func logChange(ctx context.Context, store *repository.Store, actor string, key string, action string, obj interface{}) {
	if err := recordChange(ctx, store, actor, key, action, obj); err != nil {
		logger.Warning("unable to record change (", actor, " ", action, " ", key, "): ", err)
	}
}

// taggedRef is what the audit log stores for an outbound: enough to identify it
// later, and none of its options, which can carry keys.
func taggedRef(id uint, tag string) map[string]interface{} {
	return map[string]interface{}{"id": id, "tag": tag}
}
