package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

type statusMemorySettings struct {
	mu                 sync.Mutex
	values             map[string]string
	failSentCheckpoint bool
	changeAfterSend    map[string]string
}

func newStatusSettings(activated time.Time) *statusMemorySettings {
	return &statusMemorySettings{values: map[string]string{
		domain.SettingTgBotEnable: "true", domain.SettingTgNotifyStatus: "true",
		domain.SettingTgBotToken: testBotToken, domain.SettingTgBotChatIds: "1111,2222",
		domain.SettingTgStatusEveryDays: "1", domain.SettingTgStatusSendTime: "00:00",
		domain.SettingTgStatusPolicyChangedAt: activated.Format(time.RFC3339Nano),
	}}
}

func (m *statusMemorySettings) telegramStatusSettings(ctx context.Context) (map[string]string, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	values := make(map[string]string)
	for k, v := range m.values {
		values[k] = v
	}
	return values, nil
}

func (m *statusMemorySettings) setTelegramStatusState(ctx context.Context, value string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var state telegramStatusScheduleState
	if err := json.Unmarshal([]byte(value), &state); err != nil {
		return err
	}
	if state.Batch != nil && state.Batch.Deliveries["1111"].Sent {
		if m.failSentCheckpoint {
			m.failSentCheckpoint = false
			return errors.New("temporary checkpoint failure")
		}
		for key, value := range m.changeAfterSend {
			m.values[key] = value
		}
		m.changeAfterSend = nil
	}
	m.values[domain.SettingTgStatusState] = value
	return nil
}

func (m *statusMemorySettings) change(values map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, value := range values {
		m.values[key] = value
	}
}

func scheduleFixture(settings *statusMemorySettings, bot *commandBotAPI, now *time.Time, reports *int) *TelegramStatusScheduleService {
	provider := telegramStatusFunc(func(context.Context) TelegramStatusSnapshot {
		*reports = *reports + 1
		return formatTelegramStatus(*now, time.UTC, telegramStatusData{})
	})
	sender := &TelegramService{client: bot.server.Client(), api: bot.server.URL}
	schedule := NewTelegramStatusScheduleService(nil, sender, provider, time.UTC)
	schedule.settings, schedule.now = settings, func() time.Time { return *now }
	return schedule
}

func tickStatus(t *testing.T, schedule *TelegramStatusScheduleService) {
	t.Helper()
	if err := schedule.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTelegramStatusStartsAtNextMidnightAndSurvivesRestart(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	settings, bot, reports := newStatusSettings(now), newCommandBot(t), 0
	schedule := scheduleFixture(settings, bot, &now, &reports)
	tickStatus(t, schedule)
	if reports != 0 || len(bot.called("sendMessage")) != 0 || schedule.state.AnchorDate != "2026-10-12" {
		t.Fatal("activation sent immediately instead of scheduling next midnight")
	}
	now = time.Date(2026, 10, 11, 23, 59, 59, 0, time.UTC)
	tickStatus(t, schedule)
	if reports != 0 {
		t.Fatal("report sent before midnight")
	}
	now = now.Add(time.Second)
	tickStatus(t, schedule)
	sends := bot.called("sendMessage")
	if len(sends) != 2 || sends[0].body["text"] != sends[1].body["text"] || !strings.Contains(sends[0].body["text"].(string), "DateTime: 2026-10-12 00:00:00") {
		t.Fatalf("batch = %+v", sends)
	}
	tickStatus(t, schedule)
	now = now.Add(time.Hour)
	tickStatus(t, scheduleFixture(settings, bot, &now, &reports))
	if reports != 1 || len(bot.called("sendMessage")) != 2 {
		t.Fatal("restart or another tick repeated a completed batch")
	}
}

func TestTelegramStatusCalendarDaysAcrossMonthsAndDST(t *testing.T) {
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	policy := telegramStatusPolicy{days: 2}
	for _, check := range []struct {
		day  string
		want bool
	}{{"2026-10-31", true}, {"2026-11-01", false}, {"2026-11-02", true}, {"2026-11-03", false}, {"2026-11-04", true}} {
		now, err := time.ParseInLocation("2006-01-02 15:04", check.day+" 00:00", location)
		if err != nil {
			t.Fatal(err)
		}
		got, err := telegramStatusDue(now, "2026-10-31", policy, location)
		if err != nil || got != check.want {
			t.Errorf("%s due = %v (%v), want %v", check.day, got, err, check.want)
		}
	}
}

func TestTelegramStatusSkipsNonexistentDSTSendTime(t *testing.T) {
	location, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	policy := telegramStatusPolicy{days: 1, hour: 2, minute: 30}
	after := time.Date(2026, 3, 7, 12, 0, 0, 0, location)
	if got := firstTelegramStatusDate(after, policy, location); got != "2026-03-09" {
		t.Fatalf("first date = %s, want the next date with a real 02:30", got)
	}
	for _, hour := range []int{1, 3, 23} {
		now := time.Date(2026, 3, 8, hour, 45, 0, 0, location)
		if due, err := telegramStatusDue(now, "2026-03-07", policy, location); err != nil || due {
			t.Fatalf("nonexistent send time due at %v: %v (%v)", now, due, err)
		}
	}
	now := time.Date(2026, 3, 9, 2, 30, 0, 0, location)
	if due, err := telegramStatusDue(now, "2026-03-07", policy, location); err != nil || !due {
		t.Fatalf("schedule did not resume at the next valid send time: %v (%v)", due, err)
	}
}

func TestTelegramStatusSkipsHistoricalDatesAndUsesEveryNDays(t *testing.T) {
	activated := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	now := time.Date(2026, 10, 11, 10, 0, 0, 0, time.UTC)
	settings, bot, reports := newStatusSettings(activated), newCommandBot(t), 0
	settings.change(map[string]string{domain.SettingTgStatusEveryDays: "3"})
	schedule := scheduleFixture(settings, bot, &now, &reports)
	tickStatus(t, schedule)
	if reports != 1 || len(bot.called("sendMessage")) != 2 {
		t.Fatal("recovery should collect only today's due batch")
	}
	now = now.AddDate(0, 0, 1)
	tickStatus(t, schedule)
	if reports != 1 {
		t.Fatal("sent on an off day")
	}
	now = now.AddDate(0, 0, 2)
	tickStatus(t, schedule)
	if reports != 2 || len(bot.called("sendMessage")) != 4 {
		t.Fatal("did not follow the original three-day anchor")
	}
}

func TestTelegramStatusRetriesOnlyFailedChatsUsingPersistedSnapshot(t *testing.T) {
	activated := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	now := activated.Add(12 * time.Hour)
	settings, bot, reports := newStatusSettings(activated), newCommandBot(t), 0
	bot.failSends = 1
	schedule := scheduleFixture(settings, bot, &now, &reports)
	tickStatus(t, schedule)
	now = now.Add(time.Minute)
	tickStatus(t, scheduleFixture(settings, bot, &now, &reports))
	sends := bot.called("sendMessage")
	if reports != 1 || len(sends) != 3 || sends[2].body["chat_id"] != "1111" || sends[0].body["text"] != sends[2].body["text"] {
		t.Fatalf("retry = %+v, reports %d", sends, reports)
	}
}

func TestTelegramStatusCheckpointFailureDoesNotResendWithinTheWorker(t *testing.T) {
	activated := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	now := activated.Add(12 * time.Hour)
	settings, bot, reports := newStatusSettings(activated), newCommandBot(t), 0
	settings.failSentCheckpoint = true
	schedule := scheduleFixture(settings, bot, &now, &reports)
	if err := schedule.tick(context.Background()); err == nil {
		t.Fatal("checkpoint failure was ignored")
	}
	if len(bot.called("sendMessage")) != 1 {
		t.Fatal("continued sending without a durable checkpoint")
	}
	tickStatus(t, schedule)
	if reports != 1 || len(bot.called("sendMessage")) != 2 {
		t.Fatal("checkpoint retry repeated a successful send")
	}
}

func TestTelegramStatusPolicyChangesStopQueuedRecipientsAndRearm(t *testing.T) {
	activated := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	now := activated.Add(12 * time.Hour)
	settings, bot, reports := newStatusSettings(activated), newCommandBot(t), 0
	settings.changeAfterSend = map[string]string{domain.SettingTgNotifyStatus: "false", domain.SettingTgStatusPolicyChangedAt: now.Format(time.RFC3339Nano)}
	schedule := scheduleFixture(settings, bot, &now, &reports)
	tickStatus(t, schedule)
	if len(bot.called("sendMessage")) != 1 {
		t.Fatal("continued sending after the schedule was disabled")
	}
	tickStatus(t, schedule)
	var saved telegramStatusScheduleState
	if err := json.Unmarshal([]byte(settings.values[domain.SettingTgStatusState]), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Batch != nil || saved.LastBatch == nil || !saved.LastBatch.Deliveries["1111"].Sent || saved.LastBatch.Deliveries["2222"].Sent {
		t.Fatal("disabling lost the previous snapshot or its per-chat delivery records")
	}
	now = now.Add(time.Hour)
	settings.change(map[string]string{domain.SettingTgNotifyStatus: "true", domain.SettingTgStatusSendTime: "02:00", domain.SettingTgStatusPolicyChangedAt: now.Format(time.RFC3339Nano)})
	tickStatus(t, schedule)
	if len(bot.called("sendMessage")) != 1 {
		t.Fatal("enabling sent immediately")
	}
	now = now.Add(time.Hour)
	tickStatus(t, schedule)
	if len(bot.called("sendMessage")) != 3 {
		t.Fatal("new saved time was not applied")
	}
}

func TestTelegramStatusRateLimitDoesNotBlockOtherChatsOrShutdown(t *testing.T) {
	activated := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	settings, bot, reports := newStatusSettings(activated), newCommandBot(t), 0
	bot.failSends, bot.retryAfterSeconds = 1, 3600
	now := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	schedule := scheduleFixture(settings, bot, &now, &reports)
	tickStatus(t, schedule)
	if len(bot.called("sendMessage")) != 2 {
		t.Fatal("a rate-limited chat held up the other recipient")
	}
	now = now.Add(time.Minute)
	tickStatus(t, schedule)
	if len(bot.called("sendMessage")) != 2 {
		t.Fatal("retried before Telegram's retry_after")
	}
	ctx, cancel := context.WithCancel(context.Background())
	schedule.interval = 20 * time.Millisecond
	done := make(chan struct{})
	go func() { defer close(done); schedule.Run(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("rate limit blocked shutdown")
	}
}
