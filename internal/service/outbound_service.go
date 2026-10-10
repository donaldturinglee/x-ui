package service

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/validator"
)

// OutboundService owns the routes out of a node.
type OutboundService struct {
	store  *repository.Store
	checks *outboundChecker
}

func NewOutboundService(store *repository.Store) *OutboundService {
	return &OutboundService{store: store, checks: newOutboundChecker(store.Outbounds.FindById)}
}

// List returns every outbound in the panel's own shape, with the stored options
// flattened back out alongside the columns.
func (s *OutboundService) List(ctx context.Context) ([]map[string]interface{}, error) {
	outbounds, err := s.store.Outbounds.List(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]map[string]interface{}, 0, len(outbounds))
	for _, outbound := range outbounds {
		full, err := outbound.MarshalFull()
		if err != nil {
			return nil, err
		}
		result = append(result, full)
	}
	return result, nil
}

func (s *OutboundService) Get(ctx context.Context, id uint) (map[string]interface{}, error) {
	outbound, err := s.store.Outbounds.FindById(ctx, id)
	if err != nil {
		return nil, err
	}
	return outbound.MarshalFull()
}

// Config renders every outbound the way the proxy core expects them, split
// between the two lists the core reads them from: its outbounds, and its
// endpoints for a WireGuard route, which it runs as one. Each keeps the order
// the table lists them in.
func (s *OutboundService) Config(ctx context.Context) ([]domain.JSON, []domain.JSON, error) {
	outbounds, err := s.store.Outbounds.List(ctx)
	if err != nil {
		return nil, nil, err
	}
	config := make([]domain.JSON, 0, len(outbounds))
	endpoints := []domain.JSON{}
	for _, outbound := range outbounds {
		encoded, err := json.Marshal(outbound)
		if err != nil {
			return nil, nil, err
		}
		if outbound.IsEndpoint() {
			endpoints = append(endpoints, domain.JSON(encoded))
		} else {
			config = append(config, domain.JSON(encoded))
		}
	}
	return config, endpoints, nil
}

func (s *OutboundService) Create(ctx context.Context, actor string, outbound *domain.Outbound) error {
	outbound.Tag = strings.TrimSpace(outbound.Tag)
	outbound.Id = 0
	if err := s.validate(ctx, outbound); err != nil {
		return err
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Outbounds.Create(ctx, outbound); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "outbounds", "new", taggedRef(outbound.Id, outbound.Tag))
	})
}

func (s *OutboundService) Update(ctx context.Context, actor string, outbound *domain.Outbound) error {
	outbound.Tag = strings.TrimSpace(outbound.Tag)
	if outbound.Id == 0 {
		return domain.Invalidf("outbound id is required")
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.LockTags(ctx, true); err != nil {
			return err
		}
		outbounds, err := tx.Outbounds.ListForUpdate(ctx)
		if err != nil {
			return err
		}
		var previous *domain.Outbound
		for i := range outbounds {
			if outbounds[i].Id == outbound.Id {
				previous = &outbounds[i]
				break
			}
		}
		if previous == nil {
			return domain.NotFoundf("outbound %d", outbound.Id)
		}
		if err := NewOutboundService(tx).validate(ctx, outbound); err != nil {
			return err
		}
		if previous.Tag != outbound.Tag {
			options, _, err := renameOutboundReferences(outbound.Options,
				[]string{"outbounds", outbound.Type}, previous.Tag, outbound.Tag)
			if err != nil {
				return err
			}
			outbound.Options = options
			if err := renameOutboundDependents(ctx, tx, outbounds, outbound.Id, previous.Tag, outbound.Tag); err != nil {
				return err
			}
		}
		if err := tx.Outbounds.Save(ctx, outbound); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "outbounds", "edit", taggedRef(outbound.Id, outbound.Tag))
	})
}

// Delete removes an outbound, refusing to remove the last one.
//
// A configuration with inbounds and no outbounds routes nothing, and the core
// refuses to start on it. Catching that here means the operator is told before
// the node stops working, rather than after.
func (s *OutboundService) Delete(ctx context.Context, actor string, id uint) error {
	outbound, err := s.store.Outbounds.FindById(ctx, id)
	if err != nil {
		return err
	}
	count, err := s.store.Outbounds.Count(ctx)
	if err != nil {
		return err
	}
	if count <= 1 {
		return domain.Conflictf("outbound %q is the only one left, and a configuration with none routes nothing", outbound.Tag)
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Outbounds.Delete(ctx, id); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "outbounds", "del", taggedRef(outbound.Id, outbound.Tag))
	})
}

func (s *OutboundService) validate(ctx context.Context, outbound *domain.Outbound) error {
	v := validator.New()
	v.Required("type", outbound.Type)
	v.MaxLen("type", outbound.Type, 64)
	v.Required("tag", outbound.Tag)
	v.MaxLen("tag", outbound.Tag, 64)

	// A block route takes nothing but its type and its tag, and a WireGuard route
	// none of the options its old outbound took, and the core refuses the whole
	// configuration over an option like that left on one. Each is refused here by
	// name, as the fields above are, rather than stopping every node at its next
	// sync.
	stray, err := outbound.StrayOptions()
	if err != nil {
		return err
	}
	for _, key := range stray {
		v.Fail(key, "is not an option a "+outbound.Type+" outbound takes")
	}
	if err := v.Err(); err != nil {
		return err
	}

	taken, err := s.store.Outbounds.TagTaken(ctx, outbound.Tag, outbound.Id)
	if err != nil {
		return err
	}
	if taken {
		return domain.Conflictf("outbound tag %q is already in use", outbound.Tag)
	}
	return nil
}
