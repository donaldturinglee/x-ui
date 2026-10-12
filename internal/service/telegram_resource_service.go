package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// The resource reader has no write methods. Credentials are never rendered by
// the bot; outbound listings do not even fetch their stored options.
type telegramResourceReader interface {
	Clients(context.Context, string, int, int) ([]domain.Client, int64, error)
	Client(context.Context, uint, string) (*domain.Client, error)
	Outbounds(context.Context, string, int, int) ([]domain.Outbound, int64, error)
	Outbound(context.Context, uint, string) (*domain.Outbound, error)
	Rules(context.Context) ([]json.RawMessage, string, error)
	Check(context.Context, uint) (OutboundCheckResult, error)
}

type TelegramResourceService struct {
	reader   telegramResourceReader
	location *time.Location
	now      func() time.Time
}

func NewTelegramResourceService(clients *ClientService, outbounds *OutboundService, config *ConfigService, location *time.Location) *TelegramResourceService {
	if location == nil {
		location = time.UTC
	}
	return &TelegramResourceService{
		reader:   &telegramServiceResources{clients: clients, outbounds: outbounds, config: config},
		location: location, now: time.Now,
	}
}

type telegramServiceResources struct {
	clients   *ClientService
	outbounds *OutboundService
	config    *ConfigService
}

func (s *telegramServiceResources) Clients(ctx context.Context, search string, limit, offset int) ([]domain.Client, int64, error) {
	filter := repository.ClientFilter{NameSearch: search, Limit: limit, Offset: offset}
	count, err := s.clients.Count(ctx, filter)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.clients.List(ctx, filter)
	return rows, count, err
}

func (s *telegramServiceResources) Client(ctx context.Context, id uint, name string) (*domain.Client, error) {
	if name != "" {
		return s.clients.GetByName(ctx, name)
	}
	return s.clients.Get(ctx, id)
}

func (s *telegramServiceResources) Outbounds(ctx context.Context, search string, limit, offset int) ([]domain.Outbound, int64, error) {
	return s.outbounds.store.Outbounds.ListSummaries(ctx, search, limit, offset)
}

func (s *telegramServiceResources) Outbound(ctx context.Context, id uint, tag string) (*domain.Outbound, error) {
	if tag != "" {
		return s.outbounds.store.Outbounds.FindByTag(ctx, tag)
	}
	return s.outbounds.store.Outbounds.FindById(ctx, id)
}

func (s *telegramServiceResources) Rules(ctx context.Context) ([]json.RawMessage, string, error) {
	document, err := s.config.Base(ctx)
	if err != nil {
		return nil, "", err
	}
	var base struct {
		Route struct {
			Rules []json.RawMessage `json:"rules"`
		} `json:"route"`
	}
	if err := json.Unmarshal(document, &base); err != nil {
		return nil, "", domain.Invalidf("the stored route rules could not be read")
	}
	return base.Route.Rules, telegramFingerprint(document), nil
}

func (s *telegramServiceResources) Check(ctx context.Context, id uint) (OutboundCheckResult, error) {
	return s.outbounds.Check(ctx, id)
}

func telegramFingerprint(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
