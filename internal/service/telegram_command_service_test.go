package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type commandMemorySettings struct {
	mu            sync.Mutex
	values        map[string]string
	writes        chan telegramUpdateCursor
	enableReads   chan string
	writeAttempts map[int64]int
	failOffset    int64
}

func newCommandSettings() *commandMemorySettings {
	return &commandMemorySettings{
		values: map[string]string{
			domain.SettingTgBotEnable:     "true",
			domain.SettingTgBotToken:      testBotToken,
			domain.SettingTgBotChatIds:    "1111,2222,-100222",
			domain.SettingTgNotifySignIn:  "false",
			domain.SettingTgNotifyDeplete: "false",
		},
		writes: make(chan telegramUpdateCursor, 100), enableReads: make(chan string, 100),
		writeAttempts: make(map[int64]int), failOffset: -1,
	}
}

func (s *commandMemorySettings) Get(ctx context.Context, key string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	if !ok {
		value = domain.DefaultSettings[key]
	}
	if key == domain.SettingTgBotEnable {
		select {
		case s.enableReads <- value:
		default:
		}
	}
	return value, nil
}

func (s *commandMemorySettings) change(values map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, value := range values {
		s.values[key] = value
	}
}

func (s *commandMemorySettings) setTelegramUpdateCursor(ctx context.Context, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var cursor telegramUpdateCursor
	if err := json.Unmarshal([]byte(value), &cursor); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writeAttempts[cursor.Offset]++
	if cursor.Offset == s.failOffset && s.writeAttempts[cursor.Offset] == 1 {
		return errors.New("temporary checkpoint failure")
	}
	s.values[domain.SettingTgUpdateCursor] = value
	s.writes <- cursor
	return nil
}

type commandAPIRequest struct {
	method string
	token  string
	body   map[string]interface{}
}

// Updates block until a test supplies a batch or the client cancels. This
// exercises real HTTP cancellation as well as the JSON Bot API contract.
type commandBotAPI struct {
	mu                sync.Mutex
	history           []commandAPIRequest
	server            *httptest.Server
	updates           chan []telegramCommandUpdate
	polls             chan commandAPIRequest
	canceled          chan commandAPIRequest
	sends             chan commandAPIRequest
	requests          chan commandAPIRequest
	webhook           string
	failPolls         int
	failSends         int
	retryAfterSeconds int
}

func newCommandBot(t *testing.T) *commandBotAPI {
	t.Helper()
	b := &commandBotAPI{
		updates: make(chan []telegramCommandUpdate, 20), polls: make(chan commandAPIRequest, 100),
		canceled: make(chan commandAPIRequest, 100), sends: make(chan commandAPIRequest, 100),
		requests: make(chan commandAPIRequest, 100),
	}
	b.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, method, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/bot"), "/")
		request := commandAPIRequest{token: token, method: method}
		if err := json.NewDecoder(r.Body).Decode(&request.body); err != nil {
			t.Errorf("request body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		b.mu.Lock()
		b.history = append(b.history, request)
		webhook, retryAfter := b.webhook, b.retryAfterSeconds
		fail := false
		if method == "getUpdates" && b.failPolls > 0 {
			b.failPolls--
			fail = true
		}
		if method == "sendMessage" && b.failSends > 0 {
			b.failSends--
			fail = true
		}
		b.mu.Unlock()
		b.requests <- request
		w.Header().Set("Content-Type", "application/json")
		writeResult := func(result interface{}) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "result": result})
		}
		switch method {
		case "getMe":
			id, _, _ := strings.Cut(token, ":")
			botID, _ := strconv.ParseInt(id, 10, 64)
			writeResult(map[string]interface{}{"id": botID, "is_bot": true, "username": "x_ui_bot"})
		case "getWebhookInfo":
			writeResult(map[string]string{"url": webhook})
		case "setMyCommands":
			writeResult(true)
		case "sendMessage":
			b.sends <- request
			if fail {
				if retryAfter > 0 {
					w.WriteHeader(http.StatusTooManyRequests)
					_ = json.NewEncoder(w).Encode(map[string]interface{}{
						"ok": false, "description": "retry later",
						"parameters": map[string]int{"retry_after": retryAfter},
					})
					return
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"ok":false,"description":"temporarily unavailable"}`))
				return
			}
			writeResult(map[string]interface{}{"message_id": 1})
		case "getUpdates":
			b.polls <- request
			if fail {
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"ok": false, "description": "retry later",
					"parameters": map[string]int{"retry_after": retryAfter},
				})
				return
			}
			select {
			case updates := <-b.updates:
				writeResult(updates)
			case <-r.Context().Done():
				b.canceled <- request
			}
		default:
			t.Errorf("unexpected Bot API method %s", method)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(b.server.Close)
	return b
}

func (b *commandBotAPI) called(method string) []commandAPIRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	var requests []commandAPIRequest
	for _, request := range b.history {
		if method == "" || request.method == method {
			requests = append(requests, request)
		}
	}
	return requests
}

func startTelegramCommands(t *testing.T, settings *commandMemorySettings, bot *commandBotAPI, configure ...func(*TelegramCommandService)) func() {
	t.Helper()
	notifications := &TelegramService{settings: settings, client: bot.server.Client(), api: bot.server.URL}
	commands := NewTelegramCommandService(nil, notifications)
	commands.settings = settings
	commands.refreshInterval = 20 * time.Millisecond
	commands.retryDelay = 5 * time.Millisecond
	for _, apply := range configure {
		apply(commands)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); commands.Run(ctx) }()
	stop := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("commands did not stop after cancellation")
		}
	}
	t.Cleanup(stop)
	return stop
}

func awaitTelegramCommand[T any](t *testing.T, values <-chan T, description string) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
		var zero T
		return zero
	}
}

func awaitCommandPoll(t *testing.T, bot *commandBotAPI, token string, offset int64) commandAPIRequest {
	t.Helper()
	for {
		request := awaitTelegramCommand(t, bot.polls, "command poll")
		if request.token == token && request.body["offset"] == float64(offset) {
			return request
		}
	}
}

func awaitCommandCursor(t *testing.T, settings *commandMemorySettings, offset int64) telegramUpdateCursor {
	t.Helper()
	for {
		cursor := awaitTelegramCommand(t, settings.writes, "saved command cursor")
		if cursor.Offset == offset {
			return cursor
		}
	}
}

func commandUpdate(id, chat int64, kind, text string) telegramCommandUpdate {
	message := &telegramCommandMessage{Text: text}
	message.Chat.ID, message.Chat.Type = chat, kind
	return telegramCommandUpdate{ID: id, Message: message}
}

func TestTelegramHelpRepliesOnlyToAllowedPrivateChats(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	settings.change(map[string]string{domain.SettingTgBotChatIds: "0001111,2222,-100222"})
	startTelegramCommands(t, settings, bot)
	poll := awaitCommandPoll(t, bot, testBotToken, 0)
	if poll.body["timeout"] != float64(30) || fmt.Sprint(poll.body["allowed_updates"]) != "[message]" {
		t.Errorf("poll = %v, want long polling for messages", poll.body)
	}
	menus := bot.called("setMyCommands")
	if len(menus) != 1 || fmt.Sprint(menus[0].body["scope"]) != "map[type:all_private_chats]" ||
		!strings.Contains(fmt.Sprint(menus[0].body["commands"]), "command:help") {
		t.Fatalf("command menus = %+v, want /help in private chats", menus)
	}
	bot.updates <- []telegramCommandUpdate{
		commandUpdate(10, 1111, "private", "/help"),
		commandUpdate(11, 3333, "private", "/help"),
		commandUpdate(12, -100222, "supergroup", "/help"),
		commandUpdate(13, 1111, "private", "/helpful"),
		commandUpdate(14, 2222, "private", "/help@x_ui_bot"),
		commandUpdate(15, 1111, "private", "/help@other_bot"),
		{ID: 16},
		commandUpdate(17, 1111, "private", "hello /help"),
	}
	cursor := awaitCommandCursor(t, settings, 18)
	awaitCommandPoll(t, bot, testBotToken, 18)
	if cursor.BotID != 123456789 {
		t.Errorf("cursor belongs to bot %d", cursor.BotID)
	}
	sent := bot.called("sendMessage")
	if len(sent) != 2 || sent[0].body["chat_id"] != "1111" || sent[1].body["chat_id"] != "2222" {
		t.Fatalf("replies = %+v, want one reply to each allowed command", sent)
	}
	for _, reply := range sent {
		text, _ := reply.body["text"].(string)
		if !strings.Contains(text, "/help - Show this help message") || !strings.Contains(text, "x-ui Telegram Bot") {
			t.Errorf("help text = %q", text)
		}
	}
	bot.updates <- []telegramCommandUpdate{
		commandUpdate(10, 1111, "private", "/help"),
		commandUpdate(18, 1111, "private", "ordinary message"),
	}
	awaitCommandCursor(t, settings, 19)
	awaitCommandPoll(t, bot, testBotToken, 19)
	if got := len(bot.called("sendMessage")); got != 2 {
		t.Errorf("sent %d replies after a repeated update, want 2", got)
	}
}

func TestTelegramCommandsFollowSwitchAndBotChanges(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	settings.change(map[string]string{domain.SettingTgBotEnable: "false"})
	startTelegramCommands(t, settings, bot)
	for range 2 {
		if value := awaitTelegramCommand(t, settings.enableReads, "disabled settings read"); value != "false" {
			t.Fatalf("bot is %s, want disabled", value)
		}
	}
	if calls := bot.called(""); len(calls) != 0 {
		t.Fatalf("disabled bot made requests: %+v", calls)
	}
	settings.change(map[string]string{domain.SettingTgBotEnable: "true"})
	awaitCommandPoll(t, bot, testBotToken, 0)
	settings.change(map[string]string{domain.SettingTgBotEnable: "false"})
	canceled := awaitTelegramCommand(t, bot.canceled, "canceled long poll")
	if canceled.token != testBotToken {
		t.Error("wrong bot's long poll was canceled")
	}
	const otherToken = "987654321:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
	settings.change(map[string]string{
		domain.SettingTgBotEnable: "true", domain.SettingTgBotToken: otherToken,
		domain.SettingTgBotChatIds: "2222",
	})
	awaitCommandPoll(t, bot, otherToken, 0)
	bot.updates <- []telegramCommandUpdate{
		commandUpdate(30, 1111, "private", "/help"),
		commandUpdate(31, 2222, "private", "/help"),
	}
	cursor := awaitCommandCursor(t, settings, 32)
	awaitCommandPoll(t, bot, otherToken, 32)
	sent := bot.called("sendMessage")
	if cursor.BotID != 987654321 || len(sent) != 1 || sent[0].token != otherToken || sent[0].body["chat_id"] != "2222" {
		t.Errorf("cursor = %+v, replies = %+v, want the new bot and whitelist", cursor, sent)
	}
}

func TestTelegramCursorSurvivesRestartAndTokenRotation(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	stop := startTelegramCommands(t, settings, bot)
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(100, 1111, "private", "/help")}
	awaitCommandCursor(t, settings, 101)
	awaitCommandPoll(t, bot, testBotToken, 101)
	stop()

	stop = startTelegramCommands(t, settings, bot)
	awaitCommandPoll(t, bot, testBotToken, 101)
	bot.updates <- []telegramCommandUpdate{
		commandUpdate(100, 1111, "private", "/help"),
		commandUpdate(101, 1111, "private", "ordinary message"),
	}
	awaitCommandCursor(t, settings, 102)
	awaitCommandPoll(t, bot, testBotToken, 102)
	stop()
	if got := len(bot.called("sendMessage")); got != 1 {
		t.Fatalf("restart repeated a reply: sent %d, want 1", got)
	}

	const rotatedToken = "123456789:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
	settings.change(map[string]string{domain.SettingTgBotToken: rotatedToken})
	startTelegramCommands(t, settings, bot)
	awaitCommandPoll(t, bot, rotatedToken, 102)
	bot.updates <- []telegramCommandUpdate{commandUpdate(102, 2222, "private", "/help")}
	awaitCommandCursor(t, settings, 103)
	awaitCommandPoll(t, bot, rotatedToken, 103)
	if got := len(bot.called("sendMessage")); got != 2 {
		t.Errorf("sent %d replies after token rotation, want 2", got)
	}
}

func TestTelegramCheckpointRetryDoesNotRepeatAReply(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	settings.failOffset, bot.failPolls = 71, 1
	startTelegramCommands(t, settings, bot)
	awaitCommandPoll(t, bot, testBotToken, 0)
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(70, 1111, "private", "/help")}
	awaitCommandCursor(t, settings, 71)
	awaitCommandPoll(t, bot, testBotToken, 71)
	if got := len(bot.called("sendMessage")); got != 1 {
		t.Errorf("sent %d replies after checkpoint failure, want 1", got)
	}
	settings.mu.Lock()
	defer settings.mu.Unlock()
	if attempts := settings.writeAttempts[71]; attempts != 2 {
		t.Errorf("checkpoint was attempted %d times, want 2", attempts)
	}
}

func TestTelegramRevokingAChatCancelsFailedReplies(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	bot.failSends = 1
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) {
		commands.retryDelay = 200 * time.Millisecond
	})
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(40, 1111, "private", "/help")}
	awaitTelegramCommand(t, bot.sends, "failed help reply")
	settings.change(map[string]string{domain.SettingTgBotChatIds: "2222"})
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(40, 1111, "private", "/help")}
	awaitCommandCursor(t, settings, 41)
	awaitCommandPoll(t, bot, testBotToken, 41)
	if got := len(bot.called("sendMessage")); got != 1 {
		t.Errorf("revoked chat got another reply: sent %d, want 1 attempt", got)
	}
}

func TestTelegramRateLimitWaitCanBeCanceled(t *testing.T) {
	for _, method := range []string{"getUpdates", "sendMessage"} {
		t.Run(method, func(t *testing.T) {
			settings, bot := newCommandSettings(), newCommandBot(t)
			bot.retryAfterSeconds = 3600
			if method == "getUpdates" {
				bot.failPolls = 1
			} else {
				bot.failSends = 1
			}
			stop := startTelegramCommands(t, settings, bot)
			awaitCommandPoll(t, bot, testBotToken, 0)
			if method == "sendMessage" {
				bot.updates <- []telegramCommandUpdate{commandUpdate(80, 1111, "private", "/help")}
				awaitTelegramCommand(t, bot.sends, "rate-limited help reply")
			}
			for len(settings.enableReads) > 0 {
				<-settings.enableReads
			}
			for range 3 {
				awaitTelegramCommand(t, settings.enableReads, "settings refresh during rate limit wait")
			}
			if got := len(bot.called(method)); got != 1 {
				t.Errorf("%s was attempted %d times before retry_after elapsed, want 1", method, got)
			}
			stop()
		})
	}
}

func TestTelegramCommandsLeaveAnExistingWebhookAlone(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	bot.webhook = "https://example.invalid/existing-hook"
	stop := startTelegramCommands(t, settings, bot)
	seen := 0
	for seen < 2 {
		request := awaitTelegramCommand(t, bot.requests, "webhook check")
		if request.method == "getWebhookInfo" {
			seen++
		}
	}
	stop()
	for _, method := range []string{"deleteWebhook", "setWebhook", "setMyCommands", "getUpdates"} {
		if calls := bot.called(method); len(calls) != 0 {
			t.Errorf("bot with an active webhook called %s", method)
		}
	}
}

type commandErrorTransport struct{}

func (commandErrorTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("transport could not reach %s", request.URL)
}

func TestTelegramCommandErrorsKeepTheTokenPrivate(t *testing.T) {
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": false, "description": "failed for " + testBotToken,
			"parameters": map[string]int{"retry_after": 2},
		})
	}))
	defer bot.Close()
	commands := NewTelegramCommandService(nil, &TelegramService{api: bot.URL})
	err := commands.call(context.Background(), testBotToken, "getMe", nil, nil)
	var apiError *telegramAPIError
	if !errors.As(err, &apiError) || apiError.retryAfter != 2*time.Second {
		t.Fatalf("error = %v, want Telegram's retry delay", err)
	}
	if strings.Contains(err.Error(), testBotToken) {
		t.Error("Bot API error exposed the token")
	}
	sender := &TelegramService{api: bot.URL, client: bot.Client()}
	err = sender.sendOne(context.Background(), testBotToken, "1111", "test")
	if !errors.Is(err, domain.ErrInvalid) || !errors.As(err, &apiError) || apiError.retryAfter != 2*time.Second {
		t.Fatalf("send error = %v, want the original classification and retry delay", err)
	}
	if strings.Contains(err.Error(), testBotToken) {
		t.Error("send error exposed the token")
	}
	commands.client = &http.Client{Transport: commandErrorTransport{}}
	err = commands.call(context.Background(), testBotToken, "getMe", nil, nil)
	if err == nil || strings.Contains(err.Error(), testBotToken) {
		t.Errorf("transport error = %v, want an error without the token", err)
	}
}

func TestTelegramBookkeepingCannotBeReadWrittenOrResetByTheSettingsForm(t *testing.T) {
	db, err := gorm.Open(postgres.Open("host=127.0.0.1 port=1 user=test dbname=test sslmode=disable"), &gorm.Config{
		DisableAutomaticPing: true, Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		rows := tx.Statement.Dest.(*[]domain.Setting)
		*rows = []domain.Setting{
			{Key: domain.SettingTgUpdateCursor, Value: `{"botId":123456789,"offset":99}`},
			{Key: domain.SettingTgStatusState, Value: `{"fingerprint":"internal","lastDate":"2026-10-11"}`},
			{Key: domain.SettingTgStatusPolicyChangedAt, Value: "2026-10-11T12:00:00Z"},
		}
		tx.RowsAffected = 3
	}); err != nil {
		t.Fatal(err)
	}
	settings := NewSettingService(repository.NewStore(db))
	values, err := settings.All(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{domain.SettingTgUpdateCursor, domain.SettingTgStatusState, domain.SettingTgStatusPolicyChangedAt} {
		if _, exposed := values[key]; exposed {
			t.Errorf("settings form was given %s", key)
		}
		if err := settings.Save(context.Background(), "operator", map[string]string{key: "overwrite"}); err != nil {
			t.Errorf("saving protected %s should make no database write: %v", key, err)
		}
		if err := settings.Reset(context.Background(), "operator", []string{key}); !errors.Is(err, domain.ErrInvalid) {
			t.Errorf("reset %s = %v, want a protected setting refused", key, err)
		}
	}
}
