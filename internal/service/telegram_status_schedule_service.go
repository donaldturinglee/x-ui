package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

type telegramScheduleSettings interface {
	telegramStatusSettings(context.Context) (map[string]string, error)
	setTelegramStatusState(context.Context, string) error
}

type telegramStatusPolicy struct {
	enabled      bool
	token        string
	chats        []string
	days         int
	hour, minute int
	changedAt    time.Time
	fingerprint  string
}

type telegramStatusDelivery struct {
	Sent     bool      `json:"sent"`
	Attempts int       `json:"attempts"`
	RetryAt  time.Time `json:"retryAt,omitempty"`
}

type telegramStatusBatch struct {
	Date       string                            `json:"date"`
	Snapshot   TelegramStatusSnapshot            `json:"snapshot"`
	Deliveries map[string]telegramStatusDelivery `json:"deliveries"`
}

type telegramStatusScheduleState struct {
	Fingerprint string               `json:"fingerprint"`
	TimeZone    string               `json:"timeZone"`
	AnchorDate  string               `json:"anchorDate,omitempty"`
	LastDate    string               `json:"lastDate,omitempty"`
	Batch       *telegramStatusBatch `json:"batch,omitempty"`
	LastBatch   *telegramStatusBatch `json:"lastBatch,omitempty"`
}

// The single worker owns the schedule. HTTP retries are deferred to later ticks
// so a rate-limited chat does not hold up the other recipients or shutdown.
type TelegramStatusScheduleService struct {
	mu            sync.Mutex
	settings      telegramScheduleSettings
	telegram      *TelegramService
	status        telegramStatusProvider
	location      *time.Location
	now           func() time.Time
	interval      time.Duration
	state         telegramStatusScheduleState
	loaded, dirty bool
}

func NewTelegramStatusScheduleService(settings *SettingService, telegram *TelegramService, status telegramStatusProvider, location *time.Location) *TelegramStatusScheduleService {
	if location == nil {
		location = time.UTC
	}
	return &TelegramStatusScheduleService{settings: settings, telegram: telegram, status: status,
		location: location, now: time.Now, interval: time.Minute}
}

func (s *TelegramStatusScheduleService) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		tickCtx, cancel := context.WithTimeout(ctx, 50*time.Second)
		err := s.tick(tickCtx)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Warning("telegram status schedule failed: ", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func parseTelegramSendTime(value string) (time.Time, error) {
	if len(value) != 5 || value[2] != ':' || value[0] < '0' || value[0] > '9' || value[1] < '0' || value[1] > '9' || value[3] < '0' || value[3] > '9' || value[4] < '0' || value[4] > '9' {
		return time.Time{}, domain.Invalidf("status notification time must use HH:mm, from 00:00 to 23:59")
	}
	clock, err := time.Parse("15:04", value)
	if err != nil {
		return time.Time{}, domain.Invalidf("status notification time must use HH:mm, from 00:00 to 23:59")
	}
	return clock, nil
}

func telegramSettingValue(values map[string]string, key string) string {
	if value, exists := values[key]; exists {
		return value
	}
	return domain.DefaultSettings[key]
}

func readTelegramStatusPolicy(values map[string]string, location *time.Location) (telegramStatusPolicy, error) {
	get := func(key string) string { return telegramSettingValue(values, key) }
	policy := telegramStatusPolicy{enabled: get(domain.SettingTgBotEnable) == "true" && get(domain.SettingTgNotifyStatus) == "true", token: get(domain.SettingTgBotToken)}
	days, err := normaliseSetting(domain.SettingTgStatusEveryDays, get(domain.SettingTgStatusEveryDays))
	if err != nil {
		return policy, err
	}
	policy.days, _ = strconv.Atoi(days)
	clock, err := parseTelegramSendTime(get(domain.SettingTgStatusSendTime))
	if err != nil {
		return policy, err
	}
	policy.hour, policy.minute = clock.Hour(), clock.Minute()
	chats, err := telegramChats(get(domain.SettingTgBotChatIds))
	if err != nil {
		return policy, err
	}
	seen := make(map[string]bool)
	for _, written := range chats {
		id, err := strconv.ParseInt(written, 10, 64)
		if err != nil || id == 0 {
			return policy, domain.Invalidf("status notification chat IDs must be nonzero signed 64-bit integers")
		}
		chat := strconv.FormatInt(id, 10)
		if !seen[chat] {
			seen[chat] = true
			policy.chats = append(policy.chats, chat)
		}
	}
	if policy.enabled && (policy.token == "" || len(policy.chats) == 0) {
		return policy, domain.Invalidf("scheduled status notifications need a bot token and at least one chat")
	}
	changedAt := get(domain.SettingTgStatusPolicyChangedAt)
	if changedAt != "" {
		policy.changedAt, err = time.Parse(time.RFC3339Nano, changedAt)
		if err != nil {
			return policy, errors.New("Telegram status policy activation time is invalid")
		}
	}
	material := strings.Join([]string{get(domain.SettingTgBotEnable), get(domain.SettingTgNotifyStatus), policy.token,
		strings.Join(policy.chats, ","), days, clock.Format("15:04"), changedAt, location.String()}, "\n")
	policy.fingerprint = fmt.Sprintf("%x", sha256.Sum256([]byte(material)))
	return policy, nil
}

func firstTelegramStatusDate(after time.Time, policy telegramStatusPolicy, location *time.Location) string {
	after = after.In(location)
	y, m, d := after.Date()
	day := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	for {
		planned, exists := telegramStatusPlannedTime(day, policy, location)
		if exists && planned.After(after) {
			return day.Format(time.DateOnly)
		}
		day = day.AddDate(0, 0, 1)
	}
}

func telegramStatusPlannedTime(day time.Time, policy telegramStatusPolicy, location *time.Location) (time.Time, bool) {
	y, m, d := day.Date()
	planned := time.Date(y, m, d, policy.hour, policy.minute, 0, 0, location)
	py, pm, pd := planned.Date()
	// time.Date can normalize a nonexistent DST time to an earlier wall clock.
	// Skip that date rather than delivering before the configured send time.
	exists := py == y && pm == m && pd == d && planned.Hour() == policy.hour && planned.Minute() == policy.minute
	return planned, exists
}

func telegramStatusDue(now time.Time, anchor string, policy telegramStatusPolicy, location *time.Location) (bool, error) {
	start, err := time.Parse(time.DateOnly, anchor)
	if err != nil {
		return false, errors.New("Telegram status schedule anchor date is invalid")
	}
	local := now.In(location)
	y, m, d := local.Date()
	// UTC date ordinals count natural days across month/year and DST changes.
	day := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	difference := (day.Unix() - start.Unix()) / 86400
	if difference < 0 || difference%int64(policy.days) != 0 {
		return false, nil
	}
	planned, exists := telegramStatusPlannedTime(day, policy, location)
	return exists && !now.Before(planned), nil
}

func (s *TelegramStatusScheduleService) save(ctx context.Context) error {
	if !s.dirty {
		return nil
	}
	raw, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	if err := s.settings.setTelegramStatusState(ctx, string(raw)); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

func (s *TelegramStatusScheduleService) tick(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	values, err := s.settings.telegramStatusSettings(ctx)
	if err != nil {
		return err
	}
	policy, err := readTelegramStatusPolicy(values, s.location)
	if err != nil {
		return err
	}
	if !s.loaded {
		if raw := telegramSettingValue(values, domain.SettingTgStatusState); raw != "" {
			if err := json.Unmarshal([]byte(raw), &s.state); err != nil {
				return errors.New("Telegram status schedule state could not be read")
			}
		}
		s.loaded = true
	}
	now := s.now()
	if s.state.Fingerprint != policy.fingerprint {
		base := policy.changedAt
		if base.IsZero() || base.After(now) || (s.state.TimeZone != "" && s.state.TimeZone != s.location.String()) {
			base = now
		}
		previous := s.state.LastBatch
		if s.state.Batch != nil {
			previous = s.state.Batch
		}
		s.state = telegramStatusScheduleState{Fingerprint: policy.fingerprint, TimeZone: s.location.String(), LastBatch: previous}
		if policy.enabled {
			s.state.AnchorDate = firstTelegramStatusDate(base, policy, s.location)
		}
		s.dirty = true
	}
	// An unsaved successful delivery is checkpointed before any more sends.
	if err := s.save(ctx); err != nil {
		return err
	}
	if !policy.enabled {
		return nil
	}
	today := now.In(s.location).Format(time.DateOnly)
	if s.state.Batch != nil && s.state.Batch.Date != today {
		s.state.LastBatch = s.state.Batch
		s.state.Batch = nil
		s.dirty = true
	}
	if s.state.Batch == nil && s.state.LastDate != today {
		due, err := telegramStatusDue(now, s.state.AnchorDate, policy, s.location)
		if err != nil {
			return err
		}
		if due {
			snapshot := formatTelegramStatus(now, s.location, telegramStatusData{})
			if s.status != nil {
				snapshot = s.status.Report(ctx)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if snapshot.Text == "" || snapshot.CapturedAt.IsZero() {
				return errors.New("Telegram status report is empty")
			}
			s.state.LastDate = today
			s.state.Batch = &telegramStatusBatch{Date: today, Snapshot: snapshot, Deliveries: make(map[string]telegramStatusDelivery)}
			s.dirty = true
		}
	}
	if err := s.save(ctx); err != nil {
		return err
	}
	batch := s.state.Batch
	if batch == nil {
		return nil
	}
	if batch.Deliveries == nil || batch.Snapshot.Text == "" || batch.Snapshot.CapturedAt.IsZero() {
		return errors.New("Telegram status batch state is invalid")
	}
	for _, chat := range policy.chats {
		delivery := batch.Deliveries[chat]
		if delivery.Sent || delivery.Attempts >= 3 || now.Before(delivery.RetryAt) {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		current, err := s.settings.telegramStatusSettings(ctx)
		if err != nil {
			return err
		}
		latest, err := readTelegramStatusPolicy(current, s.location)
		if err != nil {
			return err
		}
		if latest.fingerprint != policy.fingerprint {
			return nil
		}
		if s.now().In(s.location).Format(time.DateOnly) != today {
			return nil
		}
		err = s.telegram.sendOne(ctx, policy.token, chat, batch.Snapshot.Text)
		if err == nil {
			delivery.Sent = true
		} else {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			delivery.Attempts++
			delay := time.Minute * time.Duration(1<<(delivery.Attempts-1))
			var apiError *telegramAPIError
			if errors.As(err, &apiError) && apiError.retryAfter > delay {
				delay = apiError.retryAfter
			}
			delivery.RetryAt = s.now().Add(delay)
			logger.Warning("telegram scheduled status not sent: ", redactTelegramToken(err.Error(), policy.token))
		}
		batch.Deliveries[chat] = delivery
		s.dirty = true
		if err := s.save(ctx); err != nil {
			return err
		}
	}
	return nil
}
