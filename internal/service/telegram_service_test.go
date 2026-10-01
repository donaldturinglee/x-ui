package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

const testBotToken = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"

// fakeSettings answers the notifier's reads from a map, with the defaults for
// whatever the test left out.
type fakeSettings map[string]string

func (f fakeSettings) Get(_ context.Context, key string) (string, error) {
	if value, ok := f[key]; ok {
		return value, nil
	}
	return domain.DefaultSettings[key], nil
}

// botServer stands in for the Bot API, recording what it was sent and
// answering with reply.
type botServer struct {
	mu       sync.Mutex
	paths    []string
	messages []map[string]interface{}
	server   *httptest.Server
}

func newBotServer(t *testing.T, reply string) *botServer {
	t.Helper()
	bot := &botServer{}
	bot.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var message map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&message)
		bot.mu.Lock()
		bot.paths = append(bot.paths, r.URL.Path)
		bot.messages = append(bot.messages, message)
		bot.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(bot.server.Close)
	return bot
}

func (b *botServer) sent() []map[string]interface{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]map[string]interface{}(nil), b.messages...)
}

func notifier(settings fakeSettings, api string) *TelegramService {
	return &TelegramService{settings: settings, client: http.DefaultClient, api: api}
}

func TestATestMessageGoesToEveryChat(t *testing.T) {
	bot := newBotServer(t, `{"ok": true}`)
	telegram := notifier(fakeSettings{
		domain.SettingTgBotToken:   testBotToken,
		domain.SettingTgBotChatIds: "1111,-100222",
	}, bot.server.URL)

	// Sent whether or not the bot is switched on, so a token can be tried
	// before anything depends on it.
	if err := telegram.SendTest(context.Background(), "operator"); err != nil {
		t.Fatalf("SendTest: %v", err)
	}

	sent := bot.sent()
	if len(sent) != 2 || sent[0]["chat_id"] != "1111" || sent[1]["chat_id"] != "-100222" {
		t.Fatalf("sent = %v, want one message to each chat", sent)
	}
	if !strings.Contains(sent[0]["text"].(string), "operator") {
		t.Errorf("text = %q, want it to say who sent it", sent[0]["text"])
	}
	if bot.paths[0] != "/bot"+testBotToken+"/sendMessage" {
		t.Errorf("posted to %s, want the bot's sendMessage", bot.paths[0])
	}
}

func TestATestMessageWantsSomewhereToGo(t *testing.T) {
	telegram := notifier(fakeSettings{domain.SettingTgBotToken: testBotToken}, "http://unused.invalid")

	if err := telegram.SendTest(context.Background(), "operator"); err == nil {
		t.Error("a test message with no chat to go to was sent")
	}
}

func TestWhatTelegramRefusedIsSaidWithoutTheToken(t *testing.T) {
	bot := newBotServer(t, `{"ok": false, "description": "Bad Request: chat not found"}`)
	telegram := notifier(fakeSettings{
		domain.SettingTgBotToken:   testBotToken,
		domain.SettingTgBotChatIds: "1111",
	}, bot.server.URL)

	err := telegram.SendTest(context.Background(), "operator")
	if err == nil || !strings.Contains(err.Error(), "chat not found") {
		t.Fatalf("err = %v, want Telegram's reason passed on", err)
	}
	if strings.Contains(err.Error(), testBotToken) {
		t.Errorf("err = %v, which gives the bot's token away", err)
	}
}

func TestATelegramThatCannotBeReachedIsSaidWithoutTheToken(t *testing.T) {
	// A server that has gone: the transport's own error names the address it
	// posted to, and the token is part of that address.
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	telegram := notifier(fakeSettings{
		domain.SettingTgBotToken:   testBotToken,
		domain.SettingTgBotChatIds: "1111",
	}, gone.URL)

	err := telegram.SendTest(context.Background(), "operator")
	if err == nil {
		t.Fatal("a message to a server that is not there was reported as sent")
	}
	if strings.Contains(err.Error(), testBotToken) {
		t.Errorf("err = %v, which gives the bot's token away", err)
	}
}

func TestANotificationIsSentOnlyWhenItsEventIsSwitchedOn(t *testing.T) {
	cases := map[string]struct {
		settings fakeSettings
		sent     int
	}{
		"bot off": {
			settings: fakeSettings{domain.SettingTgBotEnable: "false"},
			sent:     0,
		},
		"event off": {
			settings: fakeSettings{domain.SettingTgBotEnable: "true", domain.SettingTgNotifySignIn: "false"},
			sent:     0,
		},
		"both on": {
			settings: fakeSettings{domain.SettingTgBotEnable: "true", domain.SettingTgNotifySignIn: "true"},
			sent:     1,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			bot := newBotServer(t, `{"ok": true}`)
			tc.settings[domain.SettingTgBotToken] = testBotToken
			tc.settings[domain.SettingTgBotChatIds] = "1111"

			notifier(tc.settings, bot.server.URL).Notify(context.Background(), domain.SettingTgNotifySignIn, "signed in")

			if got := len(bot.sent()); got != tc.sent {
				t.Errorf("sent %d message(s), want %d", got, tc.sent)
			}
		})
	}
}

func TestANotifierThatIsNotThereSendsNothing(t *testing.T) {
	// A handler built without one, as the route tests build theirs.
	var telegram *TelegramService
	telegram.Notify(context.Background(), domain.SettingTgNotifySignIn, "signed in")
}
