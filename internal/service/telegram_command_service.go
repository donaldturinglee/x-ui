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
/start - Show the resource menu
/help - Show this help message
/status - Show server status
/client - List clients
/client retrieve <id|name:exact name> - Get one client
/client search <name keyword> - Search client names
/outbound - List outbounds
/outbound retrieve <id|tag:exact tag> - Get one outbound
/outbound search <tag keyword> - Search outbound tags
/outbound check <id|all> - Check connections on this server
/rule - List rules in matching order
/rule retrieve <position> - Get one rule (positions start at 1)
/rule search <keyword> - Search rule conditions and actions

Use name: or tag: for numeric names and tags. Search always returns a list.
Buttons expire after 10 minutes or a worker/settings restart.

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
	ID   int64            `json:"message_id"`
	Date int64            `json:"date"`
	From *telegramBotUser `json:"from"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
	Text string `json:"text"`
}

type telegramCommandCallback struct {
	ID      string                  `json:"id"`
	From    *telegramBotUser        `json:"from"`
	Message *telegramCommandMessage `json:"message"`
	Data    string                  `json:"data"`
}

type telegramCommandUpdate struct {
	ID       int64                    `json:"update_id"`
	Message  *telegramCommandMessage  `json:"message"`
	Callback *telegramCommandCallback `json:"callback_query"`
}

// TelegramCommandService receives authorized private resource commands. Each
// token has one consumer; the API and worker can both keep sending notifications.
type TelegramCommandService struct {
	settings        telegramCommandSettings
	telegram        *TelegramService
	client          *http.Client
	refreshInterval time.Duration
	retryDelay      time.Duration
	status          telegramStatusProvider
	resources       *TelegramResourceService
}

// WithResources wires read-only resource access before Run starts.
func (t *TelegramCommandService) WithResources(resources *TelegramResourceService) *TelegramCommandService {
	t.resources = resources
	return t
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
	jobCtx, cancelJobs := context.WithCancel(ctx)
	session := newTelegramCommandSession(t.resources)
	defer func() { cancelJobs(); session.workers.Wait() }()
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
			"commands": []map[string]string{
				{"command": "start", "description": "Show resource menu"},
				{"command": "help", "description": "Show help"},
				{"command": "status", "description": "Show server status"},
				{"command": "client", "description": "List, retrieve or search clients"},
				{"command": "outbound", "description": "List, retrieve, search or check outbounds"},
				{"command": "rule", "description": "List, retrieve or search rules"},
			},
			"scope": map[string]string{"type": "all_private_chats"},
		}, nil)
	}); err != nil {
		return
	}

	for ctx.Err() == nil {
		var updates []telegramCommandUpdate
		if err := t.retry(ctx, cfg.token, func() error {
			return t.call(ctx, cfg.token, "getUpdates", map[string]interface{}{
				"offset": cursor.Offset, "timeout": telegramPollSeconds,
				"allowed_updates": []string{"message", "callback_query"},
			}, &updates)
		}); err != nil {
			return
		}
		for _, update := range updates {
			if update.ID < cursor.Offset {
				continue
			}
			if err := t.handleUpdate(jobCtx, cfg, bot, session, update); err != nil {
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
	if message == nil || message.From == nil || message.From.IsBot || message.ID <= 0 ||
		!cfg.allowedChat(message.Chat.ID, message.Chat.Type, message.From.ID) {
		return ""
	}
	fields := strings.Fields(message.Text)
	if len(fields) == 0 {
		return ""
	}
	command, mentioned, addressed := strings.Cut(fields[0], "@")
	if (command != "/start" && command != "/help" && command != "/status" && command != "/client" && command != "/outbound" && command != "/rule") ||
		(addressed && !strings.EqualFold(mentioned, username)) {
		return ""
	}
	return command
}

func (cfg telegramCommandConfig) allowedChat(chatID int64, kind string, userID int64) bool {
	if kind != "private" || userID <= 0 || userID != chatID {
		return false
	}
	for _, chat := range strings.Split(cfg.chats, ",") {
		if id, err := strconv.ParseInt(chat, 10, 64); err == nil && id == chatID {
			return true
		}
	}
	return false
}

func (t *TelegramCommandService) saveCursor(ctx context.Context, cursor telegramUpdateCursor) error {
	value, err := json.Marshal(cursor)
	if err != nil {
		return err
	}
	return t.settings.setTelegramUpdateCursor(ctx, string(value))
}

// call decodes the Bot API envelope and keeps the token-bearing request address
// out of errors. Only getUpdates uses a long wait; other methods use the
// notifier's shorter HTTP timeout.
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
	client := t.client
	if method != "getUpdates" && t.telegram.client != nil {
		client = t.telegram.client
	}
	response, err := client.Do(request)
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
			statusCode: response.StatusCode,
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
		if err == nil || errors.Is(err, errTelegramCommandConfigChanged) || errors.Is(err, errTelegramReplyUnavailable) {
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
