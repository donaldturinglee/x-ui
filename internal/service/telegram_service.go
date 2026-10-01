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
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/logger"
)

// telegramAPI is where the Bot API answers.
const telegramAPI = "https://api.telegram.org"

// telegramTimeout bounds one message. Telegram answers in well under a second
// when it can be reached at all, and waiting longer only holds up whatever
// sent it.
const telegramTimeout = 15 * time.Second

// settingReader is what the notifier needs of the settings, which is to read
// them. An interface so a test can hand it settings without a database.
type settingReader interface {
	Get(ctx context.Context, key string) (string, error)
}

// TelegramService sends the panel's notifications to the operators' Telegram
// chats through the Bot API.
//
// It holds nothing open and answers nothing: each message is one HTTPS request
// to Telegram, made when something happens, so the bot needs no process of its
// own and a panel with it switched off does no work for it at all. What it
// sends is chosen per kind of event, each switched by a setting of its own.
type TelegramService struct {
	settings settingReader
	client   *http.Client
	api      string
}

func NewTelegramService(settings *SettingService) *TelegramService {
	return &TelegramService{
		settings: settings,
		client:   &http.Client{Timeout: telegramTimeout},
		api:      telegramAPI,
	}
}

// Notify sends text to every chat when the bot is switched on and so is the
// event, named by the setting that switches it. It never fails its caller: a
// notification that cannot be sent is worth a line in the log, not a sign-in
// or a pass of the worker.
func (t *TelegramService) Notify(ctx context.Context, event string, text string) {
	if t == nil {
		return
	}
	on, err := t.flag(ctx, domain.SettingTgBotEnable)
	if err != nil || !on {
		return
	}
	if wanted, err := t.flag(ctx, event); err != nil || !wanted {
		return
	}
	token, chats, err := t.bot(ctx)
	if err != nil {
		logger.Warning("telegram notification not sent: ", err)
		return
	}
	if err := t.send(ctx, token, chats, text); err != nil {
		logger.Warning("telegram notification not sent: ", err)
	}
}

// SendTest sends a message whatever the events are switched to, and says what
// went wrong, for the settings page to show. It uses the bot as it is saved,
// switched on or not, so a token can be tried before anything depends on it.
func (t *TelegramService) SendTest(ctx context.Context, actor string) error {
	token, chats, err := t.bot(ctx)
	if err != nil {
		return err
	}
	if token == "" || len(chats) == 0 {
		return domain.Invalidf("save the bot's token and at least one chat before sending a test message")
	}
	return t.send(ctx, token, chats, fmt.Sprintf(
		"x-ui: %s sent this from the panel's settings. The panel's notifications arrive in this chat.", actor))
}

// flag reads one of the bot's switches.
func (t *TelegramService) flag(ctx context.Context, key string) (bool, error) {
	value, err := t.settings.Get(ctx, key)
	if err != nil {
		return false, err
	}
	return value == "true", nil
}

// bot reads what a message is sent with and to.
func (t *TelegramService) bot(ctx context.Context) (string, []string, error) {
	token, err := t.settings.Get(ctx, domain.SettingTgBotToken)
	if err != nil {
		return "", nil, err
	}
	written, err := t.settings.Get(ctx, domain.SettingTgBotChatIds)
	if err != nil {
		return "", nil, err
	}
	chats, err := telegramChats(written)
	if err != nil {
		return "", nil, err
	}
	return token, chats, nil
}

// telegramReply is the part of the Bot API's answer that says whether it worked.
type telegramReply struct {
	Ok          bool   `json:"ok"`
	Description string `json:"description"`
}

// send delivers text to each chat in turn. Every chat is tried whatever the ones
// before it said, and the first refusal is the one reported.
func (t *TelegramService) send(ctx context.Context, token string, chats []string, text string) error {
	var first error
	for _, chat := range chats {
		if err := t.sendOne(ctx, token, chat, text); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// sendOne posts one message.
//
// The token is part of the address the message is posted to, so an error from
// the transport -- which names the address -- is never passed on as it came: it
// would put the bot's token in the log, or in front of whoever pressed the
// button that sent a test.
func (t *TelegramService) sendOne(ctx context.Context, token string, chat string, text string) error {
	body, err := json.Marshal(map[string]interface{}{
		"chat_id":                  chat,
		"text":                     text,
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, t.api+"/bot"+token+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return domain.Invalidf("the Telegram bot's token cannot be sent")
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := t.client.Do(request)
	if err != nil {
		var addressed *url.Error
		if errors.As(err, &addressed) {
			err = addressed.Err
		}
		return domain.Invalidf("Telegram could not be reached: %v", err)
	}
	defer response.Body.Close()

	var reply telegramReply
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&reply); err != nil {
		return domain.Invalidf("Telegram answered the message to chat %s with something other than the Bot API (status %d)", chat, response.StatusCode)
	}
	if !reply.Ok {
		return domain.Invalidf("Telegram refused the message to chat %s: %s", chat, reply.Description)
	}
	return nil
}
