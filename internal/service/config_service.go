package service

import (
	"context"
	"encoding/json"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// ConfigService assembles the document a node is configured from.
//
// It owns the base document -- everything that is not an object the panel
// models -- and composes the object services over it. Generation happens on
// read rather than being stored: a node that fetches its configuration should
// get what the database says now, not what it said when something was last
// saved.
type ConfigService struct {
	store     *repository.Store
	settings  *SettingService
	inbounds  *InboundService
	outbounds *OutboundService
}

func NewConfigService(
	store *repository.Store,
	settings *SettingService,
	inbounds *InboundService,
	outbounds *OutboundService,
) *ConfigService {
	return &ConfigService{
		store:     store,
		settings:  settings,
		inbounds:  inbounds,
		outbounds: outbounds,
	}
}

// Base returns the stored base document as the operator wrote it.
func (s *ConfigService) Base(ctx context.Context) (domain.JSON, error) {
	stored, err := s.settings.Get(ctx, domain.SettingCoreConfig)
	if err != nil {
		return nil, err
	}
	if !json.Valid([]byte(stored)) {
		// Stored documents are validated on the way in, so reaching this means
		// the row was written by something else. Saying so beats handing the
		// caller a body that will not parse.
		return nil, domain.Invalidf("the stored base configuration is not valid JSON")
	}
	return domain.JSON(stored), nil
}

// SaveBase replaces the base document.
//
// The managed keys are refused rather than stripped. Generation overwrites them
// from the database either way, so accepting them would store something that
// reads back as though it had taken effect and never does.
func (s *ConfigService) SaveBase(ctx context.Context, actor string, document domain.JSON) error {
	if len(document) == 0 {
		return domain.Invalidf("base configuration must not be empty")
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(document.Raw(), &fields); err != nil {
		return domain.Invalidf("base configuration must be a JSON object: %v", err)
	}
	for _, key := range domain.ManagedConfigKeys {
		if _, present := fields[key]; present {
			return domain.Invalidf("%q is managed as its own object and must not appear in the base configuration", key)
		}
	}

	// Round-tripped through the struct so a key the panel does not know about
	// is rejected here rather than silently dropped at the next generation.
	if err := s.rejectUnknownKeys(fields); err != nil {
		return err
	}

	normalised, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return err
	}

	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Settings.Set(ctx, domain.SettingCoreConfig, string(normalised)); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "config", "edit", keysOfRaw(fields))
	})
}

// GeneratedConfig is a rendered configuration and the one fact about it a node
// cannot work out for itself.
type GeneratedConfig struct {
	Document domain.JSON
	// Maintenance says the listeners were withheld on purpose. A node that
	// simply found no inbounds cannot tell that from an empty panel, and the
	// difference decides whether an operator should be alarmed.
	Maintenance bool
}

// Generate builds the full document: the base, with the modelled objects filled
// in from the database.
//
// Maintenance is enforced here rather than left as a flag nobody reads. The
// panel cannot reach into a node and stop it, but it decides what that node
// serves — so maintenance generates a configuration with no listeners, and the
// node stops accepting clients at its next sync.
//
// Outbounds -- the WireGuard ones among the endpoints -- are left in place, as is
// everything the base document carries. Maintenance means "accept no clients",
// not "tear down the machine": the node stays reachable, its own tunnels stay
// up, and turning maintenance off is one sync away from service resuming.
func (s *ConfigService) Generate(ctx context.Context) (*GeneratedConfig, error) {
	var generated *GeneratedConfig
	err := s.store.ReadSnapshot(ctx, func(tx *repository.Store) error {
		snapshot := NewConfigService(tx, NewSettingService(tx), NewInboundService(tx), NewOutboundService(tx))
		var err error
		generated, err = snapshot.generate(ctx)
		return err
	})
	return generated, err
}

func (s *ConfigService) generate(ctx context.Context) (*GeneratedConfig, error) {
	base, err := s.Base(ctx)
	if err != nil {
		return nil, err
	}

	var config domain.CoreConfig
	if err := json.Unmarshal(base.Raw(), &config); err != nil {
		return nil, err
	}

	maintenance, err := s.settings.Maintenance(ctx)
	if err != nil {
		return nil, err
	}

	if maintenance {
		// Declared and empty, not omitted: a core reads a missing key and an
		// empty list differently, and "serve nothing" has to be sayable.
		config.Inbounds = []domain.JSON{}
	} else if config.Inbounds, err = s.inbounds.Config(ctx); err != nil {
		return nil, err
	}
	// A WireGuard route comes back among the endpoints, which is the one place
	// the core runs it.
	config.Outbounds, config.Endpoints, err = s.outbounds.Config(ctx)
	if err != nil {
		return nil, err
	}
	// Emitted only when there is something to say: unlike inbounds and
	// outbounds, a node with no endpoints is the ordinary case.
	if len(config.Endpoints) == 0 {
		config.Endpoints = nil
	}

	generated, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, err
	}
	return &GeneratedConfig{Document: domain.JSON(generated), Maintenance: maintenance}, nil
}

// Reset puts the base document back to the shipped default.
func (s *ConfigService) Reset(ctx context.Context, actor string) error {
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Settings.Set(ctx, domain.SettingCoreConfig, domain.DefaultCoreConfig); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "config", "reset", "base")
	})
}

// knownConfigKeys is every top-level key domain.CoreConfig carries, derived
// from its own JSON tags so the two cannot drift apart.
var knownConfigKeys = configKeys()

func configKeys() map[string]bool {
	// A zero value marshals to only the keys without omitempty, so the tags are
	// read off the type instead.
	keys := map[string]bool{}
	for _, tag := range []string{
		"$schema", "log", "dns", "ntp",
		"certificate",
		"http_clients", "network_namespaces",
		"inbounds", "outbounds", "services", "endpoints",
		"route", "experimental",
	} {
		keys[tag] = true
	}
	return keys
}

// rejectUnknownKeys refuses a key the generated document has no room for.
// Storing one would look like it took effect and then vanish the next time a
// node fetched its configuration.
func (s *ConfigService) rejectUnknownKeys(fields map[string]json.RawMessage) error {
	for key := range fields {
		if !knownConfigKeys[key] {
			return domain.Invalidf("unknown base configuration key %q", key)
		}
	}
	return nil
}

func keysOfRaw(fields map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	return keys
}
