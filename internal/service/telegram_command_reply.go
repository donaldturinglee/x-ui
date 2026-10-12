package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/pkg/logger"
)

var errTelegramReplyUnavailable = errors.New("Telegram reply cannot be delivered")

func (t *TelegramCommandService) authorize(ctx context.Context, cfg telegramCommandConfig) error {
	current, err := t.configuration(ctx)
	if err != nil {
		return err
	}
	if current != cfg {
		return errTelegramCommandConfigChanged
	}
	return nil
}

func (t *TelegramCommandService) handleUpdate(ctx context.Context, cfg telegramCommandConfig, bot telegramBotUser, session *telegramCommandSession, update telegramCommandUpdate) error {
	var owner telegramOwner
	var req telegramResourceRequest
	var message int64
	var view *telegramCommandView
	if callback := update.Callback; callback != nil {
		if callback.From == nil || callback.From.IsBot || callback.Message == nil ||
			!cfg.allowedChat(callback.Message.Chat.ID, callback.Message.Chat.Type, callback.From.ID) {
			return nil
		}
		if err := t.authorize(ctx, cfg); err != nil {
			return err
		}
		owner = telegramOwner{Bot: bot.ID, Chat: callback.Message.Chat.ID, User: callback.From.ID}
		message = callback.Message.ID
		var ok bool
		if callback.Message.Date > 0 {
			req, ok = session.lookup(owner, message, callback.Data)
		}
		// Acknowledge once, before queries. An expired callback is not retried
		// indefinitely and cannot keep the long-polling consumer occupied.
		ack := map[string]interface{}{"callback_query_id": callback.ID}
		if !ok {
			ack["text"] = "Button unavailable or expired. Send a resource command to refresh."
			ack["show_alert"] = true
		}
		ackCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := t.call(ackCtx, cfg.token, "answerCallbackQuery", ack, nil)
		cancel()
		if err != nil && ctx.Err() == nil {
			logger.Warning("telegram callback acknowledgement failed: ", redactTelegramToken(err.Error(), cfg.token))
		}
		if !ok {
			return nil
		}
		// Connection-check progress gets its own message, so background edits
		// cannot replace a list or detail the user is currently browsing.
		if req.Action == "check" {
			message = 0
		}
	} else {
		if cfg.allowedCommand(update.Message, bot.Username) == "" {
			return nil
		}
		owner = telegramOwner{Bot: bot.ID, Chat: update.Message.Chat.ID, User: update.Message.From.ID}
		var valid bool
		req, valid = parseTelegramResource(update.Message.Text)
		if !valid {
			view = &telegramCommandView{Text: telegramResourceUsage(req.Resource)}
		}
	}
	var delivered int64
	err := t.retry(ctx, cfg.token, func() error {
		if err := t.authorize(ctx, cfg); err != nil {
			return err
		}
		if view == nil {
			queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			switch req.Resource {
			case "help":
				view = &telegramCommandView{Text: telegramHelpMessage}
			case "status":
				text := formatTelegramStatus(time.Now(), time.UTC, telegramStatusData{}).Text
				if t.status != nil {
					text = t.status.Report(queryCtx).Text
				}
				view = &telegramCommandView{Text: text}
			default:
				view = session.view(queryCtx, owner, message, req)
			}
			if req.Resource == "help" || req.Resource == "status" {
				view.row(session.button(owner, message, "Menu", telegramResourceRequest{Resource: "start"}))
			}
			cancel()
		}
		if err := t.authorize(ctx, cfg); err != nil {
			return err
		}
		var err error
		delivered, err = t.deliverReply(ctx, cfg.token, owner.Chat, message, view)
		return err
	})
	if errors.Is(err, errTelegramReplyUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	session.bind(view, owner, delivered)
	if len(view.Check) > 0 && delivered > 0 {
		t.startCheck(ctx, cfg, session, owner, delivered, view.Check)
	}
	return nil
}

func (t *TelegramCommandService) deliver(ctx context.Context, token string, chat, message int64, view *telegramCommandView) error {
	_, err := t.deliverReply(ctx, token, chat, message, view)
	return err
}

func (t *TelegramCommandService) deliverReply(ctx context.Context, token string, chat, message int64, view *telegramCommandView) (int64, error) {
	payload := map[string]interface{}{
		"chat_id": strconv.FormatInt(chat, 10), "text": view.Text,
		"disable_web_page_preview": true,
	}
	if view.Markup != nil {
		payload["reply_markup"] = view.Markup
	} else if message > 0 {
		// Explicitly clear the old keyboard when replacing a message with text.
		payload["reply_markup"] = telegramInlineKeyboard{Rows: [][]telegramInlineButton{}}
	}
	method := "sendMessage"
	if message > 0 {
		method = "editMessageText"
		payload["message_id"] = message
	}
	var result struct {
		ID int64 `json:"message_id"`
	}
	err := t.call(ctx, token, method, payload, &result)
	if err != nil {
		var apiError *telegramAPIError
		if errors.As(err, &apiError) {
			if message > 0 && apiError.statusCode == 400 && strings.Contains(strings.ToLower(err.Error()), "message is not modified") {
				return message, nil
			}
			if apiError.statusCode == 400 || apiError.statusCode == 403 || apiError.statusCode == 404 {
				logger.Warning("telegram reply could not be delivered: ", redactTelegramToken(err.Error(), token))
				return 0, fmt.Errorf("%w: %w", errTelegramReplyUnavailable, err)
			}
		}
		return 0, err
	}
	if message > 0 {
		return message, nil
	}
	if result.ID <= 0 {
		return 0, errors.New("Telegram sendMessage returned no message ID")
	}
	return result.ID, nil
}
