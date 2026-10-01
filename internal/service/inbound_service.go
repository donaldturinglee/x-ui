package service

import (
	"context"
	"encoding/json"
	"strings"
	"unicode"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
	"github.com/donaldturinglee/x-ui/pkg/validator"
)

// InboundService owns listeners, the TLS each one terminates with among them.
type InboundService struct {
	store *repository.Store
}

func NewInboundService(store *repository.Store) *InboundService {
	return &InboundService{store: store}
}

// List returns every inbound in the panel's own shape, with the stored options
// flattened back out alongside the columns.
func (s *InboundService) List(ctx context.Context) ([]map[string]interface{}, error) {
	inbounds, err := s.store.Inbounds.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]interface{}, 0, len(inbounds))
	for _, inbound := range inbounds {
		full, err := inbound.MarshalFull()
		if err != nil {
			return nil, err
		}
		result = append(result, full)
	}
	return result, nil
}

func (s *InboundService) Get(ctx context.Context, id uint) (map[string]interface{}, error) {
	inbound, err := s.store.Inbounds.FindById(ctx, id)
	if err != nil {
		return nil, err
	}
	return inbound.MarshalFull()
}

// Config renders every inbound the way the proxy core expects them, for the
// generated configuration a node fetches.
//
// Each is rendered with its users: the subscribers it lets in, as the reference
// fills them in when it assembles the core's configuration. Without them a
// listener that authenticates lets nobody in, and one that authenticates only
// when it has users -- socks, http, naive -- lets everybody in.
func (s *InboundService) Config(ctx context.Context) ([]domain.JSON, error) {
	inbounds, err := s.store.Inbounds.List(ctx)
	if err != nil {
		return nil, err
	}
	config := make([]domain.JSON, 0, len(inbounds))
	for i := range inbounds {
		encoded, err := s.withUsers(ctx, &inbounds[i])
		if err != nil {
			return nil, err
		}
		config = append(config, domain.JSON(encoded))
	}
	return config, nil
}

// withUsers renders one inbound for the core, with the users it lets in when its
// type authenticates any. A listener nobody has been given is rendered without
// the key, which is how the core reads a snell listener with one key for all.
func (s *InboundService) withUsers(ctx context.Context, inbound *domain.Inbound) ([]byte, error) {
	encoded, err := json.Marshal(inbound)
	if err != nil {
		return nil, err
	}
	options, err := decodeObject(inbound.Options, "inbound options")
	if err != nil {
		return nil, err
	}
	if len(identityKeysFor(inbound.Type, options)) == 0 {
		return encoded, nil
	}

	clients, err := s.store.Clients.ListEnabledByInbound(ctx, inbound.Id)
	if err != nil {
		return nil, err
	}
	users, problems := inboundUsers(inbound, options, clients)
	for _, problem := range problems {
		logger.Warning("inbound ", inbound.Tag, " leaves a subscriber out: ", problem)
	}
	if len(users) == 0 {
		return encoded, nil
	}

	var document map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &document); err != nil {
		return nil, err
	}
	if document["users"], err = json.Marshal(users); err != nil {
		return nil, err
	}
	return json.Marshal(document)
}

// provisionClients mints the identities an inbound's subscribers need for it.
//
// A client's own edit mints what its listeners ask for, but a listener can also
// change what it asks for -- another type, a shadowsocks method with a different
// key -- or be given subscribers from its own side. Either way a subscriber would
// otherwise hold nothing the node could let them in with. Only what is missing
// is minted, and only the identities are written: a subscriber's traffic
// counters are not this edit's to put back.
func provisionClients(ctx context.Context, store *repository.Store, inbound *domain.Inbound) error {
	options, err := decodeObject(inbound.Options, "inbound options")
	if err != nil {
		return err
	}
	keys := identityKeysFor(inbound.Type, options)
	if len(keys) == 0 {
		return nil
	}

	clients, err := store.Clients.ListByInbound(ctx, inbound.Id)
	if err != nil {
		return err
	}
	for i := range clients {
		client := &clients[i]
		lacking, err := lacksIdentities(client, keys)
		if err != nil {
			// The client's own edit is where an unreadable config is put right;
			// it must not block a change to the inbound.
			logger.Warning("skipping identities for client ", client.Name, ": ", err)
			continue
		}
		if !lacking {
			continue
		}
		if err := ensureIdentities(client, keys); err != nil {
			return err
		}
		if err := store.Clients.SetConfig(ctx, client.Id, client.Config); err != nil {
			return err
		}
	}
	return nil
}

// Create stores a new inbound and, when clientIds are given, assigns it to
// those subscribers in the same transaction.
//
// Assigning at creation is worth supporting because the alternative -- create
// the inbound, then edit every subscriber -- is what operators actually do, one
// request at a time, and it is where an inbound ends up assigned to almost
// everyone.
func (s *InboundService) Create(ctx context.Context, actor string, inbound *domain.Inbound, clientIds []uint) error {
	inbound.Tag = strings.TrimSpace(inbound.Tag)
	inbound.Id = 0
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.LockTags(ctx, true); err != nil {
			return err
		}
		if err := NewInboundService(tx).validate(ctx, inbound); err != nil {
			return err
		}
		if err := tx.Inbounds.Create(ctx, inbound); err != nil {
			return err
		}
		if err := tx.Inbounds.ReserveTag(ctx, inbound.Tag, inbound.Id); err != nil {
			return err
		}
		if len(clientIds) > 0 {
			assigned, err := tx.Clients.AddInboundReference(ctx, inbound.Id, clientIds)
			if err != nil {
				return err
			}
			logger.Info("inbound ", inbound.Tag, " assigned to ", assigned, " client(s)")
			if err := provisionClients(ctx, tx, inbound); err != nil {
				return err
			}
		}
		return recordChange(ctx, tx, actor, "inbounds", "new", inboundRef(inbound))
	})
}

func (s *InboundService) Update(ctx context.Context, actor string, inbound *domain.Inbound) error {
	inbound.Tag = strings.TrimSpace(inbound.Tag)
	if inbound.Id == 0 {
		return domain.Invalidf("inbound id is required")
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.LockTags(ctx, true); err != nil {
			return err
		}
		inbounds, err := tx.Inbounds.ListForUpdate(ctx)
		if err != nil {
			return err
		}
		var previous *domain.Inbound
		for i := range inbounds {
			if inbounds[i].Id == inbound.Id {
				previous = &inbounds[i]
				break
			}
		}
		if previous == nil {
			return domain.NotFoundf("inbound %d", inbound.Id)
		}
		if err := NewInboundService(tx).validate(ctx, inbound); err != nil {
			return err
		}
		ref := inboundRef(inbound)
		if previous.Tag != inbound.Tag {
			options, _, err := renameInboundReferences(inbound.Options, []string{"inbounds"}, previous.Tag, inbound.Tag)
			if err != nil {
				return err
			}
			inbound.Options = options
			if err := renameInboundDependents(ctx, tx, inbounds, inbound.Id, previous.Tag, inbound.Tag); err != nil {
				return err
			}
			ref["oldTag"] = previous.Tag
			ref["newTag"] = inbound.Tag
		}
		if err := tx.Inbounds.ReserveTag(ctx, inbound.Tag, inbound.Id); err != nil {
			return err
		}
		if err := tx.Inbounds.Save(ctx, inbound); err != nil {
			return err
		}
		if err := provisionClients(ctx, tx, inbound); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "inbounds", "edit", ref)
	})
}

// Delete removes an inbound and drops it from every subscriber that referenced
// it, in one transaction.
//
// The cascade is the point. There is no foreign key to do it -- the references
// live inside a jsonb array -- so without this a deleted inbound leaves its id
// in every list that named it. Nothing reports an error; the id simply resolves
// to nothing, and the subscription silently comes back one node short.
func (s *InboundService) Delete(ctx context.Context, actor string, id uint) error {
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.LockTags(ctx, true); err != nil {
			return err
		}
		inbound, err := tx.Inbounds.FindById(ctx, id)
		if err != nil {
			return err
		}
		if err := tx.Inbounds.ReserveTag(ctx, inbound.Tag, inbound.Id); err != nil {
			return err
		}
		if err := tx.Inbounds.Delete(ctx, id); err != nil {
			return err
		}
		detached, err := tx.Clients.RemoveInboundReference(ctx, id)
		if err != nil {
			return err
		}
		if detached > 0 {
			logger.Info("inbound ", inbound.Tag, " removed from ", detached, " client(s)")
		}
		return recordChange(ctx, tx, actor, "inbounds", "del", map[string]interface{}{
			"id":              inbound.Id,
			"tag":             inbound.Tag,
			"detachedClients": detached,
		})
	})
}

func (s *InboundService) validate(ctx context.Context, inbound *domain.Inbound) error {
	v := validator.New()
	v.Required("type", inbound.Type)
	v.MaxLen("type", inbound.Type, 64)
	v.Required("tag", inbound.Tag)
	v.MaxLen("tag", inbound.Tag, 64)
	v.Check(strings.IndexFunc(inbound.Tag, unicode.IsSpace) < 0, "tag", "must not contain whitespace")
	if err := v.Err(); err != nil {
		return err
	}

	taken, err := s.store.Inbounds.TagTaken(ctx, inbound.Tag, inbound.Id)
	if err != nil {
		return err
	}
	if taken {
		return domain.Conflictf("inbound tag %q is already in use", inbound.Tag)
	}
	reserved, err := s.store.Inbounds.TagReserved(ctx, inbound.Tag, inbound.Id)
	if err != nil {
		return err
	}
	if reserved {
		return domain.Conflictf("inbound tag %q is reserved by another inbound", inbound.Tag)
	}

	// The TLS block is written into the node's configuration as it is, and a
	// core that cannot read it refuses the whole configuration, every other
	// listener with it.
	server, _, err := inbound.TLS()
	if err != nil {
		return domain.Invalidf("the inbound's tls cannot be read: %v", err)
	}
	if server == nil {
		return nil
	}
	var block map[string]json.RawMessage
	if err := json.Unmarshal(server.Raw(), &block); err != nil || block == nil {
		return domain.Invalidf("tls must be an object")
	}

	// This feature is no longer generated. Reject a stale reference rather than
	// serving a listener whose TLS names a provider the core cannot find.
	if _, present := block["certificate_provider"]; present {
		return domain.Invalidf("tls.certificate_provider is no longer supported; configure a certificate and key directly")
	}
	return nil
}

func inboundRef(inbound *domain.Inbound) map[string]interface{} {
	return map[string]interface{}{
		"id":  inbound.Id,
		"tag": inbound.Tag,
	}
}
