package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

const telegramResourcePageSize = 10
const telegramButtonTTL = 10 * time.Minute
const telegramButtonLimit = 2048

type telegramResourceRequest struct {
	Resource, Action, Exact, Query string
	ID                             uint
	Page, DetailPage               int
	Revision, Fingerprint, Job     string
	Back                           *telegramResourceRequest
}

func telegramResourceUsage(resource string) string {
	switch resource {
	case "client":
		return "/client\n/client retrieve <id|name:exact name>\n/client search <name keyword>"
	case "outbound":
		return "/outbound\n/outbound retrieve <id|tag:exact tag>\n/outbound search <tag keyword>\n/outbound check <id|all>"
	case "rule":
		return "/rule\n/rule retrieve <position>\n/rule search <condition or action keyword>\n\nRule positions start at 1 and follow the current matching order."
	}
	return telegramHelpMessage
}

func parseTelegramResource(text string) (telegramResourceRequest, bool) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return telegramResourceRequest{}, false
	}
	root, _, _ := strings.Cut(fields[0], "@")
	req := telegramResourceRequest{Resource: strings.TrimPrefix(root, "/"), Action: "list"}
	if req.Resource == "start" || req.Resource == "help" || req.Resource == "status" {
		return req, true
	}
	if req.Resource != "client" && req.Resource != "outbound" && req.Resource != "rule" {
		return req, false
	}
	args := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), fields[0]))
	if args == "" || args == "list" {
		return req, true
	}
	verb := strings.Fields(args)[0]
	value := strings.TrimSpace(strings.TrimPrefix(args, verb))
	req.Action = verb
	switch verb {
	case "search":
		req.Query = value
		return req, value != ""
	case "retrieve":
		prefix := "name:"
		if req.Resource == "outbound" {
			prefix = "tag:"
		}
		if req.Resource != "rule" && strings.HasPrefix(value, prefix) {
			req.Exact = strings.TrimPrefix(value, prefix)
			return req, req.Exact != ""
		}
	case "check":
		if req.Resource != "outbound" {
			return req, false
		}
		if value == "all" {
			return req, true
		}
	default:
		return req, false
	}
	// ParseUint accepts a leading '+'. Command IDs deliberately accept digits only.
	if value == "" || strings.IndexFunc(value, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return req, false
	}
	id, err := strconv.ParseUint(value, 10, strconv.IntSize)
	req.ID = uint(id)
	return req, err == nil && id > 0
}

type telegramOwner struct{ Bot, Chat, User int64 }

type telegramInlineButton struct {
	Text string `json:"text"`
	Data string `json:"callback_data"`
}

type telegramInlineKeyboard struct {
	Rows [][]telegramInlineButton `json:"inline_keyboard"`
}

type telegramCommandView struct {
	Text   string
	Markup *telegramInlineKeyboard
	Check  []domain.Outbound
}

type telegramButtonState struct {
	Owner   telegramOwner
	Message int64
	Expires time.Time
	Request telegramResourceRequest
}

// A session belongs to one consumer. Restarting or changing bot settings
// invalidates its buttons, and its background work is canceled and joined.
type telegramCommandSession struct {
	resources *TelegramResourceService
	mu        sync.Mutex
	buttons   map[string]telegramButtonState
	jobs      map[string]telegramCheckSnapshot
	checking  bool
	workers   sync.WaitGroup
	now       func() time.Time
}

func newTelegramCommandSession(resources *TelegramResourceService) *telegramCommandSession {
	return &telegramCommandSession{
		resources: resources, buttons: make(map[string]telegramButtonState),
		jobs: make(map[string]telegramCheckSnapshot), now: time.Now,
	}
}

func (s *telegramCommandSession) button(owner telegramOwner, message int64, text string, req telegramResourceRequest) telegramInlineButton {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return telegramInlineButton{}
	}
	data := "r:" + base64.RawURLEncoding.EncodeToString(token[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, state := range s.buttons {
		if !state.Expires.After(now) {
			delete(s.buttons, key)
		}
	}
	if len(s.buttons) >= telegramButtonLimit {
		var oldest string
		var expires time.Time
		for key, state := range s.buttons {
			if oldest == "" || state.Expires.Before(expires) {
				oldest, expires = key, state.Expires
			}
		}
		delete(s.buttons, oldest)
	}
	s.buttons[data] = telegramButtonState{Owner: owner, Message: message, Expires: now.Add(telegramButtonTTL), Request: req}
	return telegramInlineButton{Text: telegramLine(text, 60), Data: data}
}

func (s *telegramCommandSession) bind(view *telegramCommandView, owner telegramOwner, message int64) {
	if view.Markup == nil || message <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, row := range view.Markup.Rows {
		for _, button := range row {
			state, ok := s.buttons[button.Data]
			if ok && state.Owner == owner {
				state.Message = message
				s.buttons[button.Data] = state
			}
		}
	}
}

func (s *telegramCommandSession) lookup(owner telegramOwner, message int64, data string) (telegramResourceRequest, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.buttons[data]
	if !ok || message <= 0 || state.Message != message || state.Owner != owner || !state.Expires.After(s.now()) {
		return telegramResourceRequest{}, false
	}
	return state.Request, true
}

func (v *telegramCommandView) row(buttons ...telegramInlineButton) {
	var valid []telegramInlineButton
	for _, button := range buttons {
		if button.Data != "" {
			valid = append(valid, button)
		}
	}
	if len(valid) > 0 {
		if v.Markup == nil {
			v.Markup = &telegramInlineKeyboard{}
		}
		v.Markup.Rows = append(v.Markup.Rows, valid)
	}
}

func (s *telegramCommandSession) view(ctx context.Context, owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	button := func(label string, target telegramResourceRequest) telegramInlineButton {
		return s.button(owner, message, label, target)
	}
	v := &telegramCommandView{}
	if req.Resource == "start" {
		v.Text = "x-ui Telegram Bot\nChoose a resource or send /help for command examples."
		v.row(button("Status", telegramResourceRequest{Resource: "status"}), button("Help", telegramResourceRequest{Resource: "help"}))
		v.row(button("Clients", telegramResourceRequest{Resource: "client", Action: "list"}), button("Outbounds", telegramResourceRequest{Resource: "outbound", Action: "list"}), button("Rules", telegramResourceRequest{Resource: "rule", Action: "list"}))
		return v
	}
	if s.resources == nil || s.resources.reader == nil {
		v.Text = "Resource commands are unavailable on this worker."
		return v
	}
	if req.Action == "check" {
		return s.prepareCheck(ctx, owner, message, req)
	}
	if req.Action == "results" {
		return s.checkView(owner, message, req)
	}
	if req.Action == "retrieve" {
		return s.detail(ctx, owner, message, req)
	}
	return s.list(ctx, owner, message, req)
}

func (s *telegramCommandSession) list(ctx context.Context, owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	v := &telegramCommandView{}
	var count int64
	var err error
	title := strings.ToUpper(req.Resource[:1]) + req.Resource[1:] + "s"
	if req.Action == "search" {
		title += " matching " + strconv.Quote(telegramLine(req.Query, 80))
	}
	var labels []string
	var targets []telegramResourceRequest
	load := func() {
		labels, targets = nil, nil
		switch req.Resource {
		case "client":
			var rows []domain.Client
			rows, count, err = s.resources.reader.Clients(ctx, req.Query, telegramResourcePageSize, req.Page*telegramResourcePageSize)
			for _, row := range rows {
				labels = append(labels, fmt.Sprintf("#%d %s · %s", row.Id, telegramLine(row.Name, 70), telegramEnabled(row.Enable)))
				targets = append(targets, telegramResourceRequest{Resource: req.Resource, Action: "retrieve", ID: row.Id})
			}
		case "outbound":
			var rows []domain.Outbound
			rows, count, err = s.resources.reader.Outbounds(ctx, req.Query, telegramResourcePageSize, req.Page*telegramResourcePageSize)
			for _, row := range rows {
				labels = append(labels, fmt.Sprintf("#%d %s · %s", row.Id, telegramLine(row.Tag, 60), telegramLine(row.Type, 25)))
				targets = append(targets, telegramResourceRequest{Resource: req.Resource, Action: "retrieve", ID: row.Id})
			}
		case "rule":
			var rules []json.RawMessage
			var revision string
			rules, revision, err = s.resources.reader.Rules(ctx)
			if err != nil {
				return
			}
			if req.Revision != "" && revision != req.Revision {
				v = s.staleRule(owner, message, req)
				return
			}
			req.Revision = revision
			for i, rule := range rules {
				redacted := telegramRuleText(rule, false)
				if req.Query != "" && !strings.Contains(strings.ToLower(redacted), strings.ToLower(req.Query)) {
					continue
				}
				position := count
				count++
				if position < int64(req.Page*telegramResourcePageSize) || len(labels) >= telegramResourcePageSize {
					continue
				}
				labels = append(labels, fmt.Sprintf("#%d %s", i+1, telegramLine(redacted, 110)))
				targets = append(targets, telegramResourceRequest{Resource: "rule", Action: "retrieve", ID: uint(i + 1), Revision: revision, Fingerprint: telegramFingerprint(rule)})
			}
		}
	}
	load()
	if err != nil {
		return telegramResourceError(err)
	}
	if v.Text != "" { // A changed rule revision has already produced a refresh view.
		return v
	}
	pages := max(1, int((count+telegramResourcePageSize-1)/telegramResourcePageSize))
	if req.Page >= pages {
		req.Page = pages - 1
		count = 0
		load()
		if err != nil {
			return telegramResourceError(err)
		}
		if v.Text != "" {
			return v
		}
	}
	v.Text = fmt.Sprintf("%s\n%d result(s) · Page %d/%d", title, count, req.Page+1, pages)
	if count == 0 {
		v.Text += "\nNo matching resources."
	}
	for i, label := range labels {
		v.Text += "\n" + label
		target := targets[i]
		back := req
		target.Back = &back
		v.row(s.button(owner, message, label, target))
	}
	s.navigation(v, owner, message, req, pages)
	if req.Resource == "outbound" && req.Action == "list" && count > 0 {
		v.row(s.button(owner, message, "Check all on this server", telegramResourceRequest{Resource: "outbound", Action: "check"}))
	}
	return v
}

func (s *telegramCommandSession) navigation(v *telegramCommandView, owner telegramOwner, message int64, req telegramResourceRequest, pages int) {
	var row []telegramInlineButton
	if req.Page > 0 {
		prev := req
		prev.Page--
		row = append(row, s.button(owner, message, "Previous", prev))
	}
	refresh := req
	refresh.Revision, refresh.Fingerprint = "", ""
	row = append(row, s.button(owner, message, "Refresh", refresh))
	if req.Page+1 < pages {
		next := req
		next.Page++
		row = append(row, s.button(owner, message, "Next", next))
	}
	v.row(row...)
	if req.Action == "search" || req.Action == "results" {
		v.row(s.button(owner, message, "All "+req.Resource+"s", telegramResourceRequest{Resource: req.Resource, Action: "list"}))
	}
	v.row(s.button(owner, message, "Menu", telegramResourceRequest{Resource: "start"}))
}

func (s *telegramCommandSession) detail(ctx context.Context, owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	v := &telegramCommandView{}
	var err error
	switch req.Resource {
	case "client":
		var client *domain.Client
		client, err = s.resources.reader.Client(ctx, req.ID, req.Exact)
		if err == nil {
			expiry, activity := "Never", "No recorded traffic"
			if client.DelayStart {
				expiry = "Waiting for first use"
			} else if client.Expiry > 0 {
				expiry = s.resources.date(client.Expiry)
				if client.Expired(s.resources.now().Unix()) {
					expiry += " (expired)"
				}
			}
			if client.OnlineAt > 0 {
				activity = "Last traffic: " + s.resources.date(client.OnlineAt)
			}
			quota := "Unlimited"
			if client.Volume > 0 {
				quota = telegramBytes(uint64(client.Volume))
			}
			used := uint64(max(client.Up, 0)) + uint64(max(client.Down, 0))
			v.Text = fmt.Sprintf("Client #%d\nName: %s\nEnabled: %t\nActivity: %s\nTraffic: %s (↑%s, ↓%s)\nQuota: %s\nExpiry: %s\nGroup: %s", client.Id, telegramLine(client.Name, 200), client.Enable, activity, telegramBytes(used), telegramBytes(uint64(max(client.Up, 0))), telegramBytes(uint64(max(client.Down, 0))), quota, expiry, telegramLine(client.Group, 100))
		}
	case "outbound":
		var outbound *domain.Outbound
		outbound, err = s.resources.reader.Outbound(ctx, req.ID, req.Exact)
		if err == nil {
			v.Text = fmt.Sprintf("Outbound #%d\nTag: %s\nType: %s", outbound.Id, telegramLine(outbound.Tag, 200), telegramLine(outbound.Type, 60))
			if checked := s.lastCheck(owner, *outbound); checked != "" {
				v.Text += "\nLast bot check (this server): " + checked
			}
			v.row(s.button(owner, message, "Check on this server", telegramResourceRequest{Resource: "outbound", Action: "check", ID: outbound.Id}))
		}
	case "rule":
		var rules []json.RawMessage
		var revision string
		rules, revision, err = s.resources.reader.Rules(ctx)
		if err == nil {
			if req.Revision != "" && revision != req.Revision {
				return s.staleRule(owner, message, req)
			}
			if req.ID == 0 || uint(len(rules)) < req.ID {
				err = domain.ErrNotFound
			} else {
				rule := rules[req.ID-1]
				if req.Fingerprint != "" && req.Fingerprint != telegramFingerprint(rule) {
					return s.staleRule(owner, message, req)
				}
				req.Revision, req.Fingerprint = revision, telegramFingerprint(rule)
				chunks := telegramTextChunks(telegramRuleText(rule, true), 1500)
				req.DetailPage = min(max(req.DetailPage, 0), len(chunks)-1)
				v.Text = fmt.Sprintf("Rule #%d · Current matching order\nDetails %d/%d\n%s", req.ID, req.DetailPage+1, len(chunks), chunks[req.DetailPage])
				var row []telegramInlineButton
				if req.DetailPage > 0 {
					prev := req
					prev.DetailPage--
					row = append(row, s.button(owner, message, "Previous details", prev))
				}
				if req.DetailPage+1 < len(chunks) {
					next := req
					next.DetailPage++
					row = append(row, s.button(owner, message, "Next details", next))
				}
				v.row(row...)
			}
		}
	}
	if err != nil {
		v = telegramResourceError(err)
	}
	back := telegramResourceRequest{Resource: req.Resource, Action: "list", Revision: req.Revision}
	if req.Back != nil {
		back = *req.Back
	}
	v.row(s.button(owner, message, "Back to list", back))
	return v
}

func (s *telegramCommandSession) staleRule(owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	refresh := telegramResourceRequest{Resource: "rule", Action: "list"}
	if req.Back != nil {
		refresh = *req.Back
	} else if req.Action != "retrieve" {
		refresh = req
	}
	refresh.Revision, refresh.Fingerprint = "", ""
	v := &telegramCommandView{Text: "The rule configuration changed. Refresh the list before selecting a rule."}
	v.row(s.button(owner, message, "Refresh rules", refresh))
	return v
}

func telegramResourceError(err error) *telegramCommandView {
	if errors.Is(err, domain.ErrNotFound) {
		return &telegramCommandView{Text: "Resource not found. Refresh the list or check the exact ID, name or tag."}
	}
	return &telegramCommandView{Text: "Resources could not be read. Try again shortly."}
}

func (s *TelegramResourceService) date(unix int64) string {
	return time.Unix(unix, 0).In(s.location).Format("2006-01-02 15:04:05 MST")
}

func telegramEnabled(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

func telegramLine(value string, limit int) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return ' '
		}
		return r
	}, value)
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return value
}

func telegramTextChunks(value string, size int) []string {
	runes := []rune(value)
	var chunks []string
	for len(runes) > size {
		chunks = append(chunks, string(runes[:size]))
		runes = runes[size:]
	}
	return append(chunks, string(runes))
}

func telegramRuleText(raw json.RawMessage, pretty bool) string {
	var value interface{}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return "Invalid rule JSON"
	}
	var redact func(interface{})
	redact = func(value interface{}) {
		switch value := value.(type) {
		case map[string]interface{}:
			for key, nested := range value {
				lower := strings.ToLower(key)
				secret := false
				for _, part := range []string{"password", "secret", "token", "uuid", "private_key", "credential", "authorization"} {
					secret = secret || strings.Contains(lower, part)
				}
				if secret {
					value[key] = "[redacted]"
				} else {
					redact(nested)
				}
			}
		case []interface{}:
			for _, nested := range value {
				redact(nested)
			}
		}
	}
	redact(value)
	var encoded []byte
	if pretty {
		encoded, _ = json.MarshalIndent(value, "", "  ")
	} else {
		encoded, _ = json.Marshal(value)
	}
	return string(encoded)
}
