package service

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// SettingService owns the runtime options an operator changes from the panel.
type SettingService struct {
	store *repository.Store
}

func NewSettingService(store *repository.Store) *SettingService {
	return &SettingService{store: store}
}

// All returns the settings an operator may see, with anything never written
// filled in from the defaults.
//
// Keys that are not settings are dropped rather than passed through. The
// bookkeeping rows share this table, and the settings form posts back every
// key it was given -- so handing one over made the next save fail with
// "unknown setting" on a key the operator never touched.
func (s *SettingService) All(ctx context.Context) (map[string]string, error) {
	stored, err := s.store.Settings.All(ctx)
	if err != nil {
		return nil, err
	}

	values := make(map[string]string, len(domain.DefaultSettings))
	for key, fallback := range domain.DefaultSettings {
		if domain.ProtectedSettings[key] {
			continue
		}
		if value, ok := stored[key]; ok {
			values[key] = value
		} else {
			values[key] = fallback
		}
	}
	return values, nil
}

// Get returns one setting, falling back to its default when it has never been
// written. An unknown key is an error rather than an empty string: a typo that
// reads as "unset" is indistinguishable from a setting that is genuinely off.
func (s *SettingService) Get(ctx context.Context, key string) (string, error) {
	fallback, known := domain.DefaultSettings[key]
	if !known {
		return "", domain.Invalidf("unknown setting %q", key)
	}
	value, err := s.store.Settings.Get(ctx, key)
	if errors.Is(err, domain.ErrNotFound) {
		return fallback, nil
	}
	if err != nil {
		return "", err
	}
	return value, nil
}

func (s *SettingService) GetBool(ctx context.Context, key string) (bool, error) {
	value, err := s.Get(ctx, key)
	if err != nil {
		return false, err
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, domain.Invalidf("setting %q is not a boolean: %q", key, value)
	}
	return parsed, nil
}

func (s *SettingService) GetInt(ctx context.Context, key string) (int, error) {
	value, err := s.Get(ctx, key)
	if err != nil {
		return 0, err
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, domain.Invalidf("setting %q is not a number: %q", key, value)
	}
	return parsed, nil
}

// Save writes the settings an operator submitted.
//
// An unknown key is refused rather than stored: it would be written, read by
// nothing, and look to the operator like it had taken effect. A protected key
// is skipped rather than refused, because the settings form posts back
// everything it was given and refusing would make every save fail.
func (s *SettingService) Save(ctx context.Context, actor string, values map[string]string) error {
	accepted := make(map[string]string, len(values))
	for key, value := range values {
		if domain.ProtectedSettings[key] {
			continue
		}
		if _, known := domain.DefaultSettings[key]; !known {
			return domain.Invalidf("unknown setting %q", key)
		}
		// Surrounding whitespace is almost always a paste artefact, while
		// spaces inside a value can be meaningful.
		normalised, err := normaliseSetting(key, strings.TrimSpace(value))
		if err != nil {
			return err
		}
		accepted[key] = normalised
	}
	if len(accepted) == 0 {
		return nil
	}
	if err := s.checkTelegram(ctx, accepted); err != nil {
		return err
	}

	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Settings.SetMany(ctx, accepted); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "settings", "edit", keysOf(accepted))
	})
}

// Maintenance reports whether service is stopped on purpose.
func (s *SettingService) Maintenance(ctx context.Context) (bool, error) {
	return s.GetBool(ctx, domain.SettingMaintenance)
}

// SetMaintenance stops or resumes service.
//
// It has its own path rather than going through Save because it does more than
// write a flag, and because it is stored rather than held in memory: a restart
// in the middle of maintenance must not quietly put everyone back online.
func (s *SettingService) SetMaintenance(ctx context.Context, actor string, enabled bool) error {
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.Settings.Set(ctx, domain.SettingMaintenance, strconv.FormatBool(enabled)); err != nil {
			return err
		}
		action := "resume"
		if enabled {
			action = "maintenance"
		}
		return recordChange(ctx, tx, actor, "settings", action, map[string]bool{"maintenance": enabled})
	})
}

// GlobalResetLast returns when the last global traffic reset ran.
func (s *SettingService) GlobalResetLast(ctx context.Context) (int64, error) {
	value, err := s.Get(ctx, domain.SettingGlobalResetLast)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func (s *SettingService) SetGlobalResetLast(ctx context.Context, at int64) error {
	return s.store.Settings.Set(ctx, domain.SettingGlobalResetLast, strconv.FormatInt(at, 10))
}

// SetVersion records the release the data was last written by.
func (s *SettingService) SetVersion(ctx context.Context, version string) error {
	return s.store.Settings.Set(ctx, domain.SettingVersion, version)
}

// Reset restores the operator-facing settings to their defaults, keeping the
// bookkeeping rows -- those are not settings anyone set, and dropping them
// makes the data read as a fresh install to whatever runs next.
//
// Named keys restore those alone, which is how one part of the settings page
// puts its own back without taking the rest with it: the subscription's
// defaults are no reason to forget the Telegram bot's token. None restores
// every one of them.
func (s *SettingService) Reset(ctx context.Context, actor string, keys []string) error {
	for _, key := range keys {
		if _, known := domain.DefaultSettings[key]; !known {
			return domain.Invalidf("unknown setting %q", key)
		}
		if domain.ProtectedSettings[key] {
			return domain.Invalidf("setting %q is not reset from here", key)
		}
	}
	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if len(keys) == 0 {
			if err := tx.Settings.ResetOperatorSettings(ctx); err != nil {
				return err
			}
			return recordChange(ctx, tx, actor, "settings", "reset", "all")
		}
		if err := tx.Settings.DeleteMany(ctx, keys); err != nil {
			return err
		}
		return recordChange(ctx, tx, actor, "settings", "reset", keys)
	})
}

// telegramToken is the shape @BotFather hands a token out in: the bot's id, a
// colon, and a secret of URL-safe characters.
var telegramToken = regexp.MustCompile(`^\d+:[A-Za-z0-9_-]{30,}$`)

// telegramChatId is one chat's id: positive for a person's chat with the bot,
// negative for a group's.
var telegramChatId = regexp.MustCompile(`^-?\d+$`)

// normaliseSetting refuses a value the key cannot hold and writes the rest in
// one spelling, so what is stored is what the reader of it expects. Only the
// Telegram bot's settings are judged: the others were saved unjudged before
// there were any, and a row written then must not start failing every save
// that touches it.
func normaliseSetting(key string, value string) (string, error) {
	switch key {
	case domain.SettingTgBotEnable, domain.SettingTgNotifySignIn, domain.SettingTgNotifyDeplete:
		on, err := strconv.ParseBool(value)
		if err != nil {
			return "", domain.Invalidf("setting %q is true or false, not %q", key, value)
		}
		return strconv.FormatBool(on), nil
	case domain.SettingTgBotToken:
		if value != "" && !telegramToken.MatchString(value) {
			return "", domain.Invalidf("that is not a Telegram bot token: @BotFather hands one out as the bot's id, a colon and a secret")
		}
	case domain.SettingTgBotChatIds:
		chats, err := telegramChats(value)
		if err != nil {
			return "", err
		}
		return strings.Join(chats, ","), nil
	}
	return value, nil
}

// telegramChats reads the chats a notification goes to, which are written
// comma separated. An empty entry is a stray comma rather than a chat.
func telegramChats(value string) ([]string, error) {
	var chats []string
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !telegramChatId.MatchString(part) {
			return nil, domain.Invalidf("%q is not a Telegram chat id: it is a number, negative for a group", part)
		}
		chats = append(chats, part)
	}
	return chats, nil
}

// checkTelegram refuses a save that would leave the bot switched on with
// nothing to send with or nowhere to send to, which would look set up and
// never send a thing. What the save does not carry is judged as it is stored,
// and a save that touches none of the bot's settings is not judged at all.
func (s *SettingService) checkTelegram(ctx context.Context, saving map[string]string) error {
	touched := false
	for _, key := range []string{domain.SettingTgBotEnable, domain.SettingTgBotToken, domain.SettingTgBotChatIds} {
		if _, ok := saving[key]; ok {
			touched = true
		}
	}
	if !touched {
		return nil
	}

	value := func(key string) (string, error) {
		if saved, ok := saving[key]; ok {
			return saved, nil
		}
		return s.Get(ctx, key)
	}
	enabled, err := value(domain.SettingTgBotEnable)
	if err != nil {
		return err
	}
	if enabled != "true" {
		return nil
	}
	token, err := value(domain.SettingTgBotToken)
	if err != nil {
		return err
	}
	chats, err := value(domain.SettingTgBotChatIds)
	if err != nil {
		return err
	}
	if token == "" || chats == "" {
		return domain.Invalidf("the Telegram bot needs its token and at least one chat before it is switched on")
	}
	return nil
}

func keysOf(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}
