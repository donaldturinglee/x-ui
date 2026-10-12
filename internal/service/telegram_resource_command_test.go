package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

type memoryTelegramResources struct {
	mu            sync.Mutex
	clients       []domain.Client
	outbounds     []domain.Outbound
	rules         []json.RawMessage
	revision      string
	clientLists   int
	outboundLists int
	details       int
	check         func(context.Context, uint) (OutboundCheckResult, error)
}

func (r *memoryTelegramResources) Clients(ctx context.Context, query string, limit, offset int) ([]domain.Client, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clientLists++
	var rows []domain.Client
	for _, client := range r.clients {
		if strings.Contains(strings.ToLower(client.Name), strings.ToLower(query)) {
			rows = append(rows, client)
		}
	}
	count := int64(len(rows))
	start := min(offset, len(rows))
	end := len(rows)
	if limit > 0 {
		end = min(start+limit, end)
	}
	return rows[start:end], count, ctx.Err()
}

func (r *memoryTelegramResources) Client(ctx context.Context, id uint, name string) (*domain.Client, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.details++
	for _, client := range r.clients {
		if (name != "" && client.Name == name) || (name == "" && client.Id == id) {
			return &client, ctx.Err()
		}
	}
	return nil, domain.ErrNotFound
}

func (r *memoryTelegramResources) Outbounds(ctx context.Context, query string, limit, offset int) ([]domain.Outbound, int64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.outboundLists++
	var rows []domain.Outbound
	for _, outbound := range r.outbounds {
		if strings.Contains(strings.ToLower(outbound.Tag), strings.ToLower(query)) {
			rows = append(rows, outbound)
		}
	}
	count := int64(len(rows))
	start, end := min(offset, len(rows)), len(rows)
	if limit > 0 {
		end = min(start+limit, end)
	}
	return rows[start:end], count, ctx.Err()
}

func (r *memoryTelegramResources) Outbound(ctx context.Context, id uint, tag string) (*domain.Outbound, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.details++
	for _, outbound := range r.outbounds {
		if (tag != "" && outbound.Tag == tag) || (tag == "" && outbound.Id == id) {
			return &outbound, ctx.Err()
		}
	}
	return nil, domain.ErrNotFound
}

func (r *memoryTelegramResources) Rules(ctx context.Context) ([]json.RawMessage, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]json.RawMessage(nil), r.rules...), r.revision, ctx.Err()
}

func (r *memoryTelegramResources) Check(ctx context.Context, id uint) (OutboundCheckResult, error) {
	if r.check != nil {
		return r.check(ctx, id)
	}
	return OutboundCheckResult{OK: true, Delay: 20}, nil
}

func testTelegramResources(reader *memoryTelegramResources) *TelegramResourceService {
	return &TelegramResourceService{reader: reader, location: time.FixedZone("TEST", 8*3600), now: func() time.Time { return time.Unix(1700000000, 0) }}
}

func resourceButton(t *testing.T, view *telegramCommandView, label string) telegramInlineButton {
	t.Helper()
	if view.Markup != nil {
		for _, row := range view.Markup.Rows {
			for _, button := range row {
				if strings.HasPrefix(button.Text, label) {
					return button
				}
			}
		}
	}
	t.Fatalf("button %q missing in %+v", label, view)
	return telegramInlineButton{}
}

func requestButton(t *testing.T, request commandAPIRequest, label string) telegramInlineButton {
	t.Helper()
	encoded, err := json.Marshal(request.body["reply_markup"])
	if err != nil {
		t.Fatal(err)
	}
	var keyboard telegramInlineKeyboard
	if err := json.Unmarshal(encoded, &keyboard); err != nil {
		t.Fatal(err)
	}
	return resourceButton(t, &telegramCommandView{Markup: &keyboard}, label)
}

func callbackUpdate(id, chat, user, message int64, data string) telegramCommandUpdate {
	callback := &telegramCommandCallback{ID: fmt.Sprint(id), From: &telegramBotUser{ID: user}, Data: data, Message: &telegramCommandMessage{ID: message, Date: 1}}
	callback.Message.Chat.ID, callback.Message.Chat.Type = chat, "private"
	return telegramCommandUpdate{ID: id, Callback: callback}
}

func TestTelegramResourceParser(t *testing.T) {
	for _, tc := range []struct {
		text, resource, action, exact, query string
		id                                   uint
		valid                                bool
	}{
		{text: "/client", resource: "client", action: "list", valid: true},
		{text: "/client retrieve 123", resource: "client", action: "retrieve", id: 123, valid: true},
		{text: "/client retrieve name:123", resource: "client", action: "retrieve", exact: "123", valid: true},
		{text: "/client retrieve name:Alice Smith", resource: "client", action: "retrieve", exact: "Alice Smith", valid: true},
		{text: "/client search 123", resource: "client", action: "search", query: "123", valid: true},
		{text: "/outbound retrieve tag:HK Main", resource: "outbound", action: "retrieve", exact: "HK Main", valid: true},
		{text: "/outbound@x_ui_bot search hk%_!", resource: "outbound", action: "search", query: "hk%_!", valid: true},
		{text: "/outbound check all", resource: "outbound", action: "check", valid: true},
		{text: "/outbound check 2", resource: "outbound", action: "check", id: 2, valid: true},
		{text: "/rule retrieve 3", resource: "rule", action: "retrieve", id: 3, valid: true},
		{text: "/rule search example.com", resource: "rule", action: "search", query: "example.com", valid: true},
	} {
		t.Run(tc.text, func(t *testing.T) {
			req, valid := parseTelegramResource(tc.text)
			if valid != tc.valid || req.Resource != tc.resource || req.Action != tc.action || req.ID != tc.id || req.Exact != tc.exact || req.Query != tc.query {
				t.Fatalf("parsed %+v, %t", req, valid)
			}
		})
	}
	for _, text := range []string{"/client retrieve", "/client retrieve alice", "/client retrieve name:", "/client retrieve +1", "/client retrieve 0", "/client retrieve -1", "/client retrieve 999999999999999999999999", "/client find alice", "/client enable 1", "/outbound search", "/rule retrieve name:x", "/rule check all", "/clients"} {
		if _, valid := parseTelegramResource(text); valid {
			t.Errorf("accepted %q", text)
		}
	}
}

func TestTelegramResourceSearchPreservesPageAndExactRetrieval(t *testing.T) {
	reader := &memoryTelegramResources{}
	for i := 1; i <= 13; i++ {
		reader.clients = append(reader.clients, domain.Client{Id: uint(i), Name: fmt.Sprintf("Alice-%02d", i), Enable: true})
	}
	reader.clients = append(reader.clients, domain.Client{Id: 20, Name: "123"}, domain.Client{Id: 123, Name: "Other", Desc: "Alice"})
	s := newTelegramCommandSession(testTelegramResources(reader))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	list := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "client", Action: "search", Query: "ALICE", Page: 1})
	if !strings.Contains(list.Text, "13 result(s) · Page 2/2") || strings.Contains(list.Text, "Other") {
		t.Fatal(list.Text)
	}
	selected, ok := s.lookup(owner, 77, resourceButton(t, list, "#12").Data)
	if !ok {
		t.Fatal("missing detail request")
	}
	detail := s.view(context.Background(), owner, 77, selected)
	back, ok := s.lookup(owner, 77, resourceButton(t, detail, "Back").Data)
	if !ok || back.Query != "ALICE" || back.Page != 1 || back.Action != "search" {
		t.Fatalf("back = %+v", back)
	}
	list = s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "client", Action: "search", Query: "123"})
	if !strings.Contains(list.Text, "1 result(s)") || !strings.Contains(list.Text, "#20 123") || strings.Contains(list.Text, "Client #") {
		t.Fatal(list.Text)
	}
	byName := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "client", Action: "retrieve", Exact: "123"})
	byID := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "client", Action: "retrieve", ID: 123})
	if !strings.Contains(byName.Text, "Client #20") || !strings.Contains(byID.Text, "Client #123") {
		t.Fatalf("name: %s\nid: %s", byName.Text, byID.Text)
	}
	missing := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "client", Action: "retrieve", Exact: "Alice"})
	if !strings.Contains(missing.Text, "not found") {
		t.Fatal(missing.Text)
	}
	reader.mu.Lock()
	reader.clients = nil
	reader.mu.Unlock()
	deleted := s.view(context.Background(), owner, 77, selected)
	if !strings.Contains(deleted.Text, "not found") {
		t.Fatal(deleted.Text)
	}
}

func TestTelegramResourceDetailsDoNotExposeCredentials(t *testing.T) {
	reader := &memoryTelegramResources{
		clients:   []domain.Client{{Id: 1, Name: "Alice", Enable: false, OnlineAt: 1700000000, Expiry: 1700000001, Up: 1024, Down: 2048, Config: domain.JSON(`{"password":"CLIENT-SECRET"}`)}},
		outbounds: []domain.Outbound{{Id: 2, Tag: "HK", Type: "trojan", Options: domain.JSON(`{"password":"OUTBOUND-SECRET"}`)}},
		rules:     []json.RawMessage{json.RawMessage(`{"domain":["example.com"],"outbound":"HK","nested":{"password":"RULE-SECRET","private_key":"PRIVATE-SECRET"},"number":9007199254740993}`)}, revision: "one",
	}
	s := newTelegramCommandSession(testTelegramResources(reader))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	for _, resource := range []string{"client", "outbound", "rule"} {
		id := uint(1)
		if resource == "outbound" {
			id = 2
		}
		view := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: resource, Action: "retrieve", ID: id})
		if strings.Contains(view.Text, "SECRET") {
			t.Fatal(view.Text)
		}
		if resource == "client" && (!strings.Contains(view.Text, "Enabled: false") || !strings.Contains(view.Text, "Last traffic:") || !strings.Contains(view.Text, "TEST")) {
			t.Fatal(view.Text)
		}
		if resource == "rule" && (!strings.Contains(view.Text, "[redacted]") || !strings.Contains(view.Text, "9007199254740993")) {
			t.Fatal(view.Text)
		}
	}
	secretSearch := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "rule", Action: "search", Query: "RULE-SECRET"})
	if !strings.Contains(secretSearch.Text, "0 result(s)") {
		t.Fatal(secretSearch.Text)
	}
}

func TestTelegramRuleButtonsRejectChangedRevisionAndFingerprint(t *testing.T) {
	reader := &memoryTelegramResources{rules: []json.RawMessage{json.RawMessage(`{"domain":["one"]}`), json.RawMessage(`{"domain":["example.com"]}`)}, revision: "one"}
	s := newTelegramCommandSession(testTelegramResources(reader))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	list := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "rule", Action: "search", Query: "example.com"})
	selected, ok := s.lookup(owner, 77, resourceButton(t, list, "#2").Data)
	if !ok || selected.ID != 2 {
		t.Fatal(selected)
	}
	reader.mu.Lock()
	reader.rules[0], reader.rules[1] = reader.rules[1], reader.rules[0]
	reader.revision = "two"
	reader.mu.Unlock()
	stale := s.view(context.Background(), owner, 77, selected)
	if !strings.Contains(stale.Text, "configuration changed") {
		t.Fatal(stale.Text)
	}
	refresh, ok := s.lookup(owner, 77, resourceButton(t, stale, "Refresh").Data)
	if !ok || refresh.Revision != "" || refresh.Query != "example.com" {
		t.Fatal(refresh)
	}
	newList := s.view(context.Background(), owner, 77, refresh)
	if !strings.Contains(newList.Text, "#1") {
		t.Fatal(newList.Text)
	}
	reader.mu.Lock()
	reader.revision = "one"
	reader.mu.Unlock()
	stale = s.view(context.Background(), owner, 77, selected)
	if !strings.Contains(stale.Text, "configuration changed") {
		t.Fatal(stale.Text)
	}
}

func TestTelegramLongRuleDetailsArePagedWithoutTruncation(t *testing.T) {
	large := strings.Repeat("😀example.com", 450)
	raw, _ := json.Marshal(map[string]string{"domain_suffix": large})
	reader := &memoryTelegramResources{rules: []json.RawMessage{raw}, revision: "one"}
	s := newTelegramCommandSession(testTelegramResources(reader))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	req := telegramResourceRequest{Resource: "rule", Action: "retrieve", ID: 1}
	var joined string
	for {
		view := s.view(context.Background(), owner, 77, req)
		if len(utf16.Encode([]rune(view.Text))) > 4096 {
			t.Fatalf("message too long: %d", len(utf16.Encode([]rune(view.Text))))
		}
		_, body, _ := strings.Cut(view.Text, "\n")
		_, body, _ = strings.Cut(body, "\n")
		joined += body
		var next string
		for _, row := range view.Markup.Rows {
			for _, button := range row {
				if button.Text == "Next details" {
					next = button.Data
				}
			}
		}
		if next == "" {
			break
		}
		var ok bool
		req, ok = s.lookup(owner, 77, next)
		if !ok {
			t.Fatal("missing next page")
		}
	}
	if joined != telegramRuleText(raw, true) {
		t.Fatal("paged details lost content")
	}
}

func TestTelegramButtonsAreBoundToBotUserChatMessageAndExpiry(t *testing.T) {
	s := newTelegramCommandSession(nil)
	now := time.Unix(1700000000, 0)
	s.now = func() time.Time { return now }
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	button := s.button(owner, 0, "Clients", telegramResourceRequest{Resource: "client"})
	if len(button.Data) > 64 || strings.Contains(button.Data, "client") {
		t.Fatal(button.Data)
	}
	if _, ok := s.lookup(owner, 77, button.Data); ok {
		t.Fatal("unbound button accepted")
	}
	s.bind(&telegramCommandView{Markup: &telegramInlineKeyboard{Rows: [][]telegramInlineButton{{button}}}}, owner, 77)
	if _, ok := s.lookup(owner, 77, button.Data); !ok {
		t.Fatal("bound button rejected")
	}
	for _, other := range []telegramOwner{{Bot: 2, Chat: 1111, User: 1111}, {Bot: 1, Chat: 2222, User: 1111}, {Bot: 1, Chat: 1111, User: 2222}} {
		if _, ok := s.lookup(other, 77, button.Data); ok {
			t.Fatalf("accepted owner %+v", other)
		}
	}
	if _, ok := s.lookup(owner, 78, button.Data); ok {
		t.Fatal("another message accepted")
	}
	now = now.Add(telegramButtonTTL)
	if _, ok := s.lookup(owner, 77, button.Data); ok {
		t.Fatal("expired button accepted")
	}
	for range telegramButtonLimit + 20 {
		s.button(owner, 77, "Menu", telegramResourceRequest{Resource: "start"})
	}
	if len(s.buttons) != telegramButtonLimit {
		t.Fatal(len(s.buttons))
	}
}

func TestTelegramResourceTransportRetriesReuseQueryAndButtons(t *testing.T) {
	reader := &memoryTelegramResources{}
	for i := 1; i <= 12; i++ {
		reader.clients = append(reader.clients, domain.Client{Id: uint(i), Name: fmt.Sprintf("Alice-%02d", i)})
	}
	settings, bot := newCommandSettings(), newCommandBot(t)
	bot.failSends, settings.failOffset = 1, 11
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) { commands.WithResources(testTelegramResources(reader)) })
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(10, 1111, "private", "/client search Alice")}
	awaitCommandCursor(t, settings, 11)
	awaitCommandPoll(t, bot, testBotToken, 11)
	sends := bot.called("sendMessage")
	if len(sends) != 2 {
		t.Fatal(sends)
	}
	first, _ := json.Marshal(sends[0].body)
	second, _ := json.Marshal(sends[1].body)
	if string(first) != string(second) {
		t.Fatal("send retry changed the prepared reply")
	}
	reader.mu.Lock()
	calls := reader.clientLists
	reader.mu.Unlock()
	if calls != 1 {
		t.Fatalf("query ran %d times", calls)
	}
	next := requestButton(t, sends[1], "Next")
	bot.updates <- []telegramCommandUpdate{callbackUpdate(11, 1111, 1111, 99, next.Data), callbackUpdate(12, 2222, 2222, 1, next.Data)}
	awaitCommandCursor(t, settings, 13)
	awaitCommandPoll(t, bot, testBotToken, 13)
	if len(bot.called("editMessageText")) != 0 {
		t.Fatal("foreign callback edited a resource")
	}
	bot.mu.Lock()
	bot.failEdits = 1
	bot.mu.Unlock()
	bot.updates <- []telegramCommandUpdate{callbackUpdate(13, 1111, 1111, 1, next.Data)}
	awaitCommandCursor(t, settings, 14)
	awaitCommandPoll(t, bot, testBotToken, 14)
	edits := bot.called("editMessageText")
	if len(edits) != 2 || !strings.Contains(fmt.Sprint(edits[1].body["text"]), "Page 2/2") {
		t.Fatal(edits)
	}
	reader.mu.Lock()
	calls = reader.clientLists
	reader.mu.Unlock()
	if calls != 2 {
		t.Fatalf("edit retries ran %d queries, want 2 total", calls)
	}
	if len(bot.called("answerCallbackQuery")) != 3 {
		t.Fatal("callback was not acknowledged once")
	}
	inaccessible := callbackUpdate(14, 1111, 1111, 1, next.Data)
	inaccessible.Callback.Message.Date = 0
	bot.updates <- []telegramCommandUpdate{inaccessible}
	awaitCommandCursor(t, settings, 15)
	awaitCommandPoll(t, bot, testBotToken, 15)
	if len(bot.called("editMessageText")) != 2 || len(bot.called("answerCallbackQuery")) != 4 {
		t.Fatal("inaccessible callback was not safely acknowledged")
	}
}

func TestTelegramResourceMenuNavigatesAndRegistersSingularRoots(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) {
		commands.WithResources(testTelegramResources(&memoryTelegramResources{}))
	})
	awaitCommandPoll(t, bot, testBotToken, 0)
	menus := bot.called("setMyCommands")
	for _, root := range []string{"start", "help", "status", "client", "outbound", "rule"} {
		if !strings.Contains(fmt.Sprint(menus[0].body["commands"]), "command:"+root) {
			t.Fatalf("menu omits /%s", root)
		}
	}
	bot.updates <- []telegramCommandUpdate{commandUpdate(10, 1111, "private", "/start")}
	awaitCommandCursor(t, settings, 11)
	awaitCommandPoll(t, bot, testBotToken, 11)
	clients := requestButton(t, bot.called("sendMessage")[0], "Clients")
	bot.updates <- []telegramCommandUpdate{callbackUpdate(11, 1111, 1111, 1, clients.Data)}
	awaitCommandCursor(t, settings, 12)
	awaitCommandPoll(t, bot, testBotToken, 12)
	edits := bot.called("editMessageText")
	if len(edits) != 1 || !strings.Contains(fmt.Sprint(edits[0].body["text"]), "0 result(s)") {
		t.Fatal(edits)
	}
	menu := requestButton(t, edits[0], "Menu")
	bot.updates <- []telegramCommandUpdate{callbackUpdate(12, 1111, 1111, 1, menu.Data)}
	awaitCommandCursor(t, settings, 13)
	awaitCommandPoll(t, bot, testBotToken, 13)
	edits = bot.called("editMessageText")
	if len(edits) != 2 || !strings.Contains(fmt.Sprint(edits[1].body["text"]), "Choose a resource") {
		t.Fatal(edits)
	}
}

func TestTelegramOutboundSearchAlwaysListsAndNumericTagsAreExact(t *testing.T) {
	reader := &memoryTelegramResources{outbounds: []domain.Outbound{{Id: 1, Tag: "123", Type: "trojan"}, {Id: 123, Tag: "HK", Type: "direct"}}}
	s := newTelegramCommandSession(testTelegramResources(reader))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	search := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "outbound", Action: "search", Query: "123"})
	if !strings.Contains(search.Text, "1 result(s)") || !strings.Contains(search.Text, "#1 123") || strings.Contains(search.Text, "Outbound #") {
		t.Fatal(search.Text)
	}
	byTag := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "outbound", Action: "retrieve", Exact: "123"})
	byID := s.view(context.Background(), owner, 77, telegramResourceRequest{Resource: "outbound", Action: "retrieve", ID: 123})
	if !strings.Contains(byTag.Text, "Outbound #1\n") || !strings.Contains(byID.Text, "Outbound #123\n") {
		t.Fatalf("tag: %s\nid: %s", byTag.Text, byID.Text)
	}
}

func TestTelegramResourceMessagesRequirePrivateSenderIdentity(t *testing.T) {
	settings, bot := newCommandSettings(), newCommandBot(t)
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) {
		commands.WithResources(testTelegramResources(&memoryTelegramResources{}))
	})
	awaitCommandPoll(t, bot, testBotToken, 0)
	missing := commandUpdate(10, 1111, "private", "/client")
	missing.Message.From = nil
	wrong := commandUpdate(11, 1111, "private", "/client")
	wrong.Message.From.ID = 2222
	bot.updates <- []telegramCommandUpdate{missing, wrong, commandUpdate(12, 1111, "private", "/client@other_bot"), commandUpdate(13, 1111, "private", "/client retrieve name:Alice")}
	awaitCommandCursor(t, settings, 14)
	awaitCommandPoll(t, bot, testBotToken, 14)
	if sends := bot.called("sendMessage"); len(sends) != 1 || !strings.Contains(fmt.Sprint(sends[0].body["text"]), "not found") {
		t.Fatal(sends)
	}
}
