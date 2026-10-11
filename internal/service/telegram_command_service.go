package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

const telegramPollSeconds = 30

const telegramHelpMessage = `x-ui Telegram Bot

Available commands:
/help - Show this help message
/status - Show server status

Notifications:
- Successful panel sign-ins
- Subscribers taken offline for quota or expiry
- Scheduled server status reports

Configure notifications in the panel's Telegram Bot settings.`

var errTelegramCommandConfigChanged = errors.New("Telegram bot settings changed")

type telegramCommandSettings interface {
	settingReader
	setTelegramUpdateCursor(ctx context.Context, value string) error
}

type telegramCommandConfig struct {
	token string
	chats string
}

type telegramUpdateCursor struct {
	BotID  int64 `json:"botId"`
	Offset int64 `json:"offset"`
}

type telegramBotUser struct {
	ID       int64  `json:"id"`
	IsBot    bool   `json:"is_bot"`
	Username string `json:"username"`
}

type telegramCommandMessage struct {
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
	Text string `json:"text"`
}

type telegramCommandUpdate struct {
	ID      int64                   `json:"update_id"`
	Message *telegramCommandMessage `json:"message"`
}

// TelegramCommandService receives private /help and /status commands. Each
// token has one consumer; the API and worker can both keep sending notifications.
type TelegramCommandService struct {
	settings        telegramCommandSettings
	telegram        *TelegramService
	client          *http.Client
	refreshInterval time.Duration
	retryDelay      time.Duration
	status          telegramStatusProvider
}

func NewTelegramCommandService(settings *SettingService, telegram *TelegramService, status ...telegramStatusProvider) *TelegramCommandService {
	service := &TelegramCommandService{
		settings:        settings,
		telegram:        telegram,
		client:          &http.Client{Timeout: 40 * time.Second},
		refreshInterval: 5 * time.Second,
		retryDelay:      time.Second,
	}
	if len(status) > 0 {
		service.status = status[0]
	}
	return service
}

// Run watches saved settings until shutdown. A change cancels and joins the old
// consumer before starting another, including requests waiting for updates.
func (t *TelegramCommandService) Run(ctx context.Context) {
	ticker := time.NewTicker(t.refreshInterval)
	defer ticker.Stop()

	var current telegramCommandConfig
	var cancel context.CancelFunc
	var done chan struct{}
	stop := func() {
		if cancel != nil {
			cancel()
			<-done
			cancel, done = nil, nil
		}
	}
	defer stop()

	for ctx.Err() == nil {
		cfg, err := t.configuration(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Warning("telegram command settings could not be read: ", err)
			cfg = telegramCommandConfig{}
		}
		if cfg != current || done == nil {
			stop()
			current = cfg
			if cfg.token != "" {
				cancel, done = t.startConsumer(ctx, cfg)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-done:
			stop()
		}
	}
}

func (t *TelegramCommandService) startConsumer(ctx context.Context, cfg telegramCommandConfig) (context.CancelFunc, chan struct{}) {
	consumerCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		t.consume(consumerCtx, cfg)
	}()
	return cancel, done
}

func (t *TelegramCommandService) configuration(ctx context.Context) (telegramCommandConfig, error) {
	enabled, err := t.settings.Get(ctx, domain.SettingTgBotEnable)
	if err != nil || enabled != "true" {
		return telegramCommandConfig{}, err
	}
	token, err := t.settings.Get(ctx, domain.SettingTgBotToken)
	if err != nil {
		return telegramCommandConfig{}, err
	}
	written, err := t.settings.Get(ctx, domain.SettingTgBotChatIds)
	if err != nil {
		return telegramCommandConfig{}, err
	}
	chats, err := telegramChats(written)
	if err != nil {
		return telegramCommandConfig{}, err
	}
	if token == "" || len(chats) == 0 {
		return telegramCommandConfig{}, errors.New("the enabled Telegram bot needs a token and at least one chat")
	}
	return telegramCommandConfig{token: token, chats: strings.Join(chats, ",")}, nil
}

func (t *TelegramCommandService) consume(ctx context.Context, cfg telegramCommandConfig) {
	var bot telegramBotUser
	var cursor telegramUpdateCursor
	if err := t.retry(ctx, cfg.token, func() error {
		if err := t.call(ctx, cfg.token, "getMe", nil, &bot); err != nil {
			return err
		}
		if bot.ID <= 0 || !bot.IsBot {
			return errors.New("Telegram getMe did not identify a bot")
		}
		var webhook struct {
			URL string `json:"url"`
		}
		if err := t.call(ctx, cfg.token, "getWebhookInfo", nil, &webhook); err != nil {
			return err
		}
		if webhook.URL != "" {
			return errors.New("Telegram commands need long polling, but this bot has an active webhook")
		}
		value, err := t.settings.Get(ctx, domain.SettingTgUpdateCursor)
		if err != nil {
			return err
		}
		cursor = telegramUpdateCursor{}
		if value != "" {
			if err := json.Unmarshal([]byte(value), &cursor); err != nil {
				return fmt.Errorf("Telegram command cursor could not be read: %w", err)
			}
		}
		if cursor.BotID < 0 || cursor.Offset < 0 {
			return errors.New("Telegram command cursor must have a nonnegative bot ID and offset")
		}
		if cursor.BotID != bot.ID {
			cursor = telegramUpdateCursor{BotID: bot.ID}
			if err := t.saveCursor(ctx, cursor); err != nil {
				return err
			}
		}
		return t.call(ctx, cfg.token, "setMyCommands", map[string]interface{}{
			"commands": []map[string]string{{"command": "help", "description": "Show help"}, {"command": "status", "description": "Show server status"}},
			"scope":    map[string]string{"type": "all_private_chats"},
		}, nil)
	}); err != nil {
		return
	}

	for ctx.Err() == nil {
		var updates []telegramCommandUpdate
		if err := t.retry(ctx, cfg.token, func() error {
			return t.call(ctx, cfg.token, "getUpdates", map[string]interface{}{
				"offset": cursor.Offset, "timeout": telegramPollSeconds,
				"allowed_updates": []string{"message"},
			}, &updates)
		}); err != nil {
			return
		}
		for _, update := range updates {
			if update.ID < cursor.Offset {
				continue
			}
			var reply string
			if err := t.retry(ctx, cfg.token, func() error {
				// Recheck before replying, including after a failed send. Revoking
				// a chat or switching the bot off must stop queued replies too.
				current, err := t.configuration(ctx)
				if err != nil {
					return err
				}
				if current != cfg {
					return errTelegramCommandConfigChanged
				}
				command := cfg.allowedCommand(update.Message, bot.Username)
				if command == "" {
					return nil
				}
				if reply == "" {
					reply = telegramHelpMessage
					if command == "/status" {
						if t.status != nil {
							reply = t.status.Report(ctx).Text
						} else {
							reply = formatTelegramStatus(time.Now(), time.UTC, telegramStatusData{}).Text
						}
					}
				}
				// Collection can take seconds. Recheck authorization after it too.
				current, err = t.configuration(ctx)
				if err != nil {
					return err
				}
				if current != cfg {
					return errTelegramCommandConfigChanged
				}
				return t.telegram.sendOne(ctx, cfg.token,
					strconv.FormatInt(update.Message.Chat.ID, 10), reply)
			}); err != nil {
				return
			}
			cursor.Offset = update.ID + 1
			// Retry this write rather than sending the same reply again if the
			// database is temporarily unavailable. Confirm only saved progress.
			if err := t.retry(ctx, cfg.token, func() error { return t.saveCursor(ctx, cursor) }); err != nil {
				return
			}
		}
	}
}

func (cfg telegramCommandConfig) allowedCommand(message *telegramCommandMessage, username string) string {
	if message == nil || message.Chat.Type != "private" {
		return ""
	}
	fields := strings.Fields(message.Text)
	if len(fields) == 0 {
		return ""
	}
	command, mentioned, addressed := strings.Cut(fields[0], "@")
	if (command != "/help" && command != "/status") || (addressed && !strings.EqualFold(mentioned, username)) {
		return ""
	}
	for _, chat := range strings.Split(cfg.chats, ",") {
		if id, err := strconv.ParseInt(chat, 10, 64); err == nil && id == message.Chat.ID {
			return command
		}
	}
	return ""
}

func (t *TelegramCommandService) saveCursor(ctx context.Context, cursor telegramUpdateCursor) error {
	value, err := json.Marshal(cursor)
	if err != nil {
		return err
	}
	return t.settings.setTelegramUpdateCursor(ctx, string(value))
}

// call decodes the Bot API envelope and keeps the token-bearing request address
// out of errors. Only getUpdates uses a long wait; replies use the notifier.
func (t *TelegramCommandService) call(ctx context.Context, token, method string, payload, result interface{}) error {
	if payload == nil {
		payload = struct{}{}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		t.telegram.api+"/bot"+token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return errors.New("the Telegram bot's token cannot be sent")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := t.client.Do(request)
	if err != nil {
		var addressed *url.Error
		if errors.As(err, &addressed) {
			err = addressed.Err
		}
		return fmt.Errorf("Telegram %s could not be reached: %s", method, redactTelegramToken(err.Error(), token))
	}
	defer response.Body.Close()
	var reply struct {
		Ok          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		Description string          `json:"description"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&reply); err != nil {
		return fmt.Errorf("Telegram %s did not return a Bot API response (status %d)", method, response.StatusCode)
	}
	if !reply.Ok || response.StatusCode < 200 || response.StatusCode >= 300 {
		return &telegramAPIError{
			err:        domain.Invalidf("Telegram %s failed (status %d): %s", method, response.StatusCode, redactTelegramToken(reply.Description, token)),
			retryAfter: time.Duration(reply.Parameters.RetryAfter) * time.Second,
		}
	}
	if result != nil {
		if err := json.Unmarshal(reply.Result, result); err != nil {
			return fmt.Errorf("Telegram %s returned an invalid result: %w", method, err)
		}
	}
	return nil
}

func (t *TelegramCommandService) retry(ctx context.Context, token string, operation func() error) error {
	delay := t.retryDelay
	for ctx.Err() == nil {
		err := operation()
		if err == nil || errors.Is(err, errTelegramCommandConfigChanged) {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		logger.Warning("telegram command operation failed: ", redactTelegramToken(err.Error(), token))
		pause := delay
		var apiError *telegramAPIError
		if errors.As(err, &apiError) && apiError.retryAfter > pause {
			pause = apiError.retryAfter
		}
		timer := time.NewTimer(pause)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
	return ctx.Err()
}
