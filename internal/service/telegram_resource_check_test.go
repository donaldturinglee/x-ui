package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestTelegramOutboundChecksAreBoundedResponsiveAndNotRepeated(t *testing.T) {
	started, release := make(chan uint, 20), make(chan struct{})
	var mu sync.Mutex
	active, maximum := 0, 0
	counts := make(map[uint]int)
	reader := &memoryTelegramResources{}
	for i := 1; i <= 13; i++ {
		reader.outbounds = append(reader.outbounds, domain.Outbound{Id: uint(i), Tag: fmt.Sprintf("HK-%02d", i), Type: "trojan"})
	}
	reader.outbounds[0].Type = domain.OutboundTypeBlock
	reader.check = func(ctx context.Context, id uint) (OutboundCheckResult, error) {
		mu.Lock()
		active++
		maximum = max(maximum, active)
		counts[id]++
		mu.Unlock()
		defer func() { mu.Lock(); active--; mu.Unlock() }()
		started <- id
		select {
		case <-ctx.Done():
			return OutboundCheckResult{}, ctx.Err()
		case <-release:
			return OutboundCheckResult{OK: true, Delay: 42}, nil
		}
	}
	settings, bot := newCommandSettings(), newCommandBot(t)
	bot.failSends, settings.failOffset = 1, 11
	startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) {
		commands.WithResources(testTelegramResources(reader))
		commands.retryDelay = 100 * time.Millisecond
	})
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(10, 1111, "private", "/outbound check all")}
	awaitTelegramCommand(t, bot.sends, "failed checking reply")
	select {
	case id := <-started:
		t.Fatalf("probe %d started before a successful reply", id)
	default:
	}
	awaitTelegramCommand(t, bot.sends, "checking reply retry")
	for range 4 {
		awaitTelegramCommand(t, started, "probe start")
	}
	awaitCommandCursor(t, settings, 11)
	awaitCommandPoll(t, bot, testBotToken, 11)
	bot.updates <- []telegramCommandUpdate{commandUpdate(11, 1111, "private", "/status"), commandUpdate(12, 1111, "private", "/outbound check 2")}
	awaitCommandCursor(t, settings, 13)
	awaitCommandPoll(t, bot, testBotToken, 13)
	sends := bot.called("sendMessage")
	if len(sends) != 4 || !strings.Contains(fmt.Sprint(sends[2].body["text"]), "X-UI Version:") || !strings.Contains(fmt.Sprint(sends[3].body["text"]), "already running") {
		t.Fatal(sends)
	}
	select {
	case id := <-started:
		t.Fatalf("fifth simultaneous probe %d", id)
	default:
	}
	// A failed final edit retries the result, never the probes.
	bot.mu.Lock()
	bot.failEdits = 1
	bot.failEditContains = "Outbound checks"
	bot.mu.Unlock()
	close(release)
	var final commandAPIRequest
	for {
		edit := awaitTelegramCommand(t, bot.edits, "check results")
		if strings.Contains(fmt.Sprint(edit.body["text"]), "Passed: 12") {
			final = edit
			break
		}
	}
	final = awaitTelegramCommand(t, bot.edits, "retried check results")
	if !strings.Contains(fmt.Sprint(final.body["text"]), "Skipped: 1") || !strings.Contains(fmt.Sprint(final.body["text"]), "This server") {
		t.Fatal(final)
	}
	mu.Lock()
	if maximum != 4 || len(counts) != 12 || counts[1] != 0 {
		t.Errorf("maximum=%d, probes=%v", maximum, counts)
	}
	for id, count := range counts {
		if count != 1 {
			t.Errorf("outbound %d checked %d times", id, count)
		}
	}
	mu.Unlock()
	reader.mu.Lock()
	lists := reader.outboundLists
	reader.mu.Unlock()
	if lists != 1 {
		t.Errorf("batch query ran %d times", lists)
	}
	next := requestButton(t, final, "Next")
	bot.updates <- []telegramCommandUpdate{callbackUpdate(13, 1111, 1111, 1, next.Data)}
	awaitCommandCursor(t, settings, 14)
	awaitCommandPoll(t, bot, testBotToken, 14)
	last := bot.called("editMessageText")
	if !strings.Contains(fmt.Sprint(last[len(last)-1].body["text"]), "Page 2/2") {
		t.Fatal(last)
	}
}

func TestTelegramOutboundChecksCancelAndJoinWhenChatIsRevoked(t *testing.T) {
	started, canceled := make(chan uint, 4), make(chan uint, 4)
	reader := &memoryTelegramResources{}
	for i := 1; i <= 8; i++ {
		reader.outbounds = append(reader.outbounds, domain.Outbound{Id: uint(i), Tag: fmt.Sprint(i), Type: "direct"})
	}
	reader.check = func(ctx context.Context, id uint) (OutboundCheckResult, error) {
		started <- id
		<-ctx.Done()
		canceled <- id
		return OutboundCheckResult{}, ctx.Err()
	}
	settings, bot := newCommandSettings(), newCommandBot(t)
	stop := startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) { commands.WithResources(testTelegramResources(reader)) })
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(10, 1111, "private", "/outbound check all")}
	for range 4 {
		awaitTelegramCommand(t, started, "cancelable probe")
	}
	awaitCommandCursor(t, settings, 11)
	awaitCommandPoll(t, bot, testBotToken, 11)
	settings.change(map[string]string{domain.SettingTgBotChatIds: "2222"})
	for range 4 {
		awaitTelegramCommand(t, canceled, "canceled probe")
	}
	awaitCommandPoll(t, bot, testBotToken, 11)
	stop()
	if edits := bot.called("editMessageText"); len(edits) != 0 {
		t.Fatal("revoked chat received check results", edits)
	}
	select {
	case id := <-started:
		t.Fatalf("queued probe %d ran after revocation", id)
	default:
	}
}

func TestTelegramOutboundChecksCancelOnWorkerShutdown(t *testing.T) {
	started, canceled := make(chan struct{}, 1), make(chan struct{}, 1)
	reader := &memoryTelegramResources{outbounds: []domain.Outbound{{Id: 1, Tag: "direct", Type: "direct"}}}
	reader.check = func(ctx context.Context, id uint) (OutboundCheckResult, error) {
		started <- struct{}{}
		<-ctx.Done()
		canceled <- struct{}{}
		return OutboundCheckResult{}, ctx.Err()
	}
	settings, bot := newCommandSettings(), newCommandBot(t)
	stop := startTelegramCommands(t, settings, bot, func(commands *TelegramCommandService) { commands.WithResources(testTelegramResources(reader)) })
	awaitCommandPoll(t, bot, testBotToken, 0)
	bot.updates <- []telegramCommandUpdate{commandUpdate(10, 1111, "private", "/outbound check 1")}
	awaitTelegramCommand(t, started, "shutdown probe")
	stop()
	awaitTelegramCommand(t, canceled, "joined shutdown probe")
}

func TestTelegramCheckResultsRequireOriginalOwnerAndMessage(t *testing.T) {
	s := newTelegramCommandSession(testTelegramResources(&memoryTelegramResources{}))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	s.jobs["job"] = telegramCheckSnapshot{Owner: owner, Message: 77, Expires: time.Now().Add(time.Minute), Rows: []telegramCheckRow{{Outbound: domain.Outbound{Id: 1, Tag: "HK"}, Result: OutboundCheckResult{OK: true, Delay: 20}}}}
	req := telegramResourceRequest{Resource: "outbound", Action: "results", Job: "job"}
	for _, view := range []*telegramCommandView{s.checkView(telegramOwner{Bot: 2, Chat: 1111, User: 1111}, 77, req), s.checkView(owner, 78, req)} {
		if !strings.Contains(view.Text, "expired") || strings.Contains(view.Text, "HK") {
			t.Fatal(view.Text)
		}
	}
}

func TestTelegramOutboundDetailShowsOnlyOwnersCompletedRecentCheck(t *testing.T) {
	outbound := domain.Outbound{Id: 1, Tag: "HK", Type: "trojan"}
	s := newTelegramCommandSession(testTelegramResources(&memoryTelegramResources{outbounds: []domain.Outbound{outbound}}))
	owner := telegramOwner{Bot: 1, Chat: 1111, User: 1111}
	now := time.Now()
	s.jobs["job"] = telegramCheckSnapshot{Owner: owner, Message: 77, Ended: now, Expires: now.Add(time.Minute), Rows: []telegramCheckRow{{Outbound: outbound, Done: true, Result: OutboundCheckResult{OK: true, Delay: 20}}}}
	view := s.detail(context.Background(), owner, 80, telegramResourceRequest{Resource: "outbound", Action: "retrieve", ID: 1})
	if !strings.Contains(view.Text, "Last bot check (this server): 20 ms at") || !strings.Contains(view.Text, "TEST") {
		t.Fatal(view.Text)
	}
	if s.lastCheck(telegramOwner{Bot: 1, Chat: 2222, User: 2222}, outbound) != "" {
		t.Fatal("another user received cached results")
	}
	outbound.Tag = "renamed"
	if s.lastCheck(owner, outbound) != "" {
		t.Fatal("renamed outbound received an old result")
	}
	// Keep the snapshot but expire it; expired history must not appear in details.
	s.now = func() time.Time { return now.Add(time.Minute) }
	outbound.Tag = "HK"
	if s.lastCheck(owner, outbound) != "" {
		t.Fatal("expired check appeared in details")
	}
}
