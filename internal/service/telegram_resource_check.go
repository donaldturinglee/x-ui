package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

const telegramCheckBatchLimit = 1000

type telegramCheckRow struct {
	Outbound domain.Outbound
	Result   OutboundCheckResult
	Done     bool
}

type telegramCheckSnapshot struct {
	Owner   telegramOwner
	Message int64
	Rows    []telegramCheckRow
	Expires time.Time
	Ended   time.Time
}

func (s *telegramCommandSession) prepareCheck(ctx context.Context, owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	s.mu.Lock()
	busy := s.checking
	s.mu.Unlock()
	if busy {
		return &telegramCommandView{Text: "An outbound check is already running on this bot. Wait for its results."}
	}
	var rows []domain.Outbound
	var err error
	if req.ID != 0 {
		var outbound *domain.Outbound
		outbound, err = s.resources.reader.Outbound(ctx, req.ID, "")
		if err == nil {
			// Keep only safe metadata in the job and its result cache.
			rows = []domain.Outbound{{Id: outbound.Id, Tag: outbound.Tag, Type: outbound.Type}}
		}
	} else {
		var count int64
		rows, count, err = s.resources.reader.Outbounds(ctx, "", telegramCheckBatchLimit, 0)
		if err == nil && count > telegramCheckBatchLimit {
			return &telegramCommandView{Text: "A bot batch supports up to 1000 outbounds. Check individual IDs instead."}
		}
	}
	if err != nil {
		return telegramResourceError(err)
	}
	if len(rows) == 0 {
		return &telegramCommandView{Text: "No outbounds to check."}
	}
	for i := range rows {
		rows[i].Options = nil
	}
	return &telegramCommandView{
		Text:  fmt.Sprintf("Checking %d outbound(s) on this server…\nUp to 4 probes run at once. Block outbounds are skipped.\nUse /status or other commands while this runs.", len(rows)),
		Check: rows,
	}
}

// Only called after the initial checking message was delivered. Transport and
// checkpoint retries therefore never start the same set of probes twice.
func (t *TelegramCommandService) startCheck(ctx context.Context, cfg telegramCommandConfig, s *telegramCommandSession, owner telegramOwner, message int64, rows []domain.Outbound) {
	s.mu.Lock()
	if s.checking {
		s.mu.Unlock()
		return
	}
	s.checking = true
	s.mu.Unlock()
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer func() { s.mu.Lock(); s.checking = false; s.mu.Unlock() }()
		t.runCheck(ctx, cfg, s, owner, message, rows)
	}()
}

func (t *TelegramCommandService) runCheck(ctx context.Context, cfg telegramCommandConfig, s *telegramCommandSession, owner telegramOwner, message int64, outbounds []domain.Outbound) {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	rows := make([]telegramCheckRow, len(outbounds))
	queue := make(chan int, len(rows))
	for i, outbound := range outbounds {
		rows[i].Outbound = outbound
		queue <- i
	}
	close(queue)
	type completedCheck struct {
		index  int
		result OutboundCheckResult
	}
	completed := make(chan completedCheck, len(rows))
	var probes sync.WaitGroup
	for range min(outboundCheckConcurrency, len(rows)) {
		probes.Add(1)
		go func() {
			defer probes.Done()
			for index := range queue {
				if probeCtx.Err() != nil {
					return
				}
				var result OutboundCheckResult
				if err := t.authorize(probeCtx, cfg); err != nil {
					cancel()
					return
				}
				if outbounds[index].Type == domain.OutboundTypeBlock {
					result = OutboundCheckResult{Skipped: true, Error: "Block outbound"}
				} else {
					var err error
					result, err = s.resources.reader.Check(probeCtx, outbounds[index].Id)
					if err != nil {
						result = OutboundCheckResult{Error: "Outbound could not be checked."}
						if errors.Is(err, domain.ErrNotFound) {
							result.Error = "Outbound no longer exists."
						} else if probeCtx.Err() != nil {
							result.Error = "Check canceled or batch deadline reached."
						}
					}
				}
				completed <- completedCheck{index: index, result: result}
			}
		}()
	}
	go func() { probes.Wait(); close(completed) }()
	// Join every probe caller even if sending progress fails or settings change.
	defer probes.Wait()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	finished, dirty := 0, false
	for completed != nil {
		select {
		case item, open := <-completed:
			if !open {
				completed = nil
				continue
			}
			rows[item.index].Result, rows[item.index].Done = item.result, true
			finished++
			dirty = true
		case <-ticker.C:
			if dirty && ctx.Err() == nil {
				progressCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				if t.authorize(progressCtx, cfg) == nil {
					_ = t.deliver(progressCtx, cfg.token, owner.Chat, message, &telegramCommandView{Text: fmt.Sprintf("Checking outbounds on this server…\n%d/%d completed. Other commands remain available.", finished, len(rows))})
				}
				stop()
				dirty = false
			}
		case <-ctx.Done():
			cancel()
			return
		}
	}
	if ctx.Err() != nil || t.authorize(ctx, cfg) != nil {
		return
	}
	for i := range rows {
		if !rows[i].Done {
			rows[i].Result = OutboundCheckResult{Error: "Not checked: batch deadline reached."}
		}
	}
	job := fmt.Sprintf("%d:%d", owner.Chat, message)
	s.mu.Lock()
	now := s.now()
	for key, snapshot := range s.jobs {
		if !snapshot.Expires.After(now) {
			delete(s.jobs, key)
		}
	}
	if len(s.jobs) >= 8 {
		var oldest string
		for key, snapshot := range s.jobs {
			if oldest == "" || snapshot.Ended.Before(s.jobs[oldest].Ended) {
				oldest = key
			}
		}
		delete(s.jobs, oldest)
	}
	s.jobs[job] = telegramCheckSnapshot{Owner: owner, Message: message, Rows: rows, Ended: now, Expires: now.Add(telegramButtonTTL)}
	s.mu.Unlock()
	view := s.checkView(owner, message, telegramResourceRequest{Resource: "outbound", Action: "results", Job: job})
	replyCtx, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	_ = t.retry(replyCtx, cfg.token, func() error {
		if err := t.authorize(replyCtx, cfg); err != nil {
			return err
		}
		return t.deliver(replyCtx, cfg.token, owner.Chat, message, view)
	})
}

func (s *telegramCommandSession) checkView(owner telegramOwner, message int64, req telegramResourceRequest) *telegramCommandView {
	s.mu.Lock()
	snapshot, ok := s.jobs[req.Job]
	s.mu.Unlock()
	if !ok || snapshot.Owner != owner || snapshot.Message != message || !snapshot.Expires.After(s.now()) {
		return &telegramCommandView{Text: "These check results expired. Send /outbound check <id|all> to run a new check."}
	}
	passed, failed, skipped := 0, 0, 0
	for _, row := range snapshot.Rows {
		switch {
		case row.Result.Skipped:
			skipped++
		case row.Result.OK:
			passed++
		default:
			failed++
		}
	}
	pages := max(1, (len(snapshot.Rows)+telegramResourcePageSize-1)/telegramResourcePageSize)
	req.Page = min(max(req.Page, 0), pages-1)
	v := &telegramCommandView{Text: fmt.Sprintf("Outbound checks · This server\nPassed: %d · Failed/uncompleted: %d · Skipped: %d\nPage %d/%d\n", passed, failed, skipped, req.Page+1, pages)}
	for _, row := range snapshot.Rows[req.Page*telegramResourcePageSize : min((req.Page+1)*telegramResourcePageSize, len(snapshot.Rows))] {
		v.Text += fmt.Sprintf("\n#%d %s · %s", row.Outbound.Id, telegramLine(row.Outbound.Tag, 40), telegramCheckLabel(row.Result))
	}
	s.navigation(v, owner, message, req, pages)
	return v
}

func telegramCheckLabel(result OutboundCheckResult) string {
	if result.OK {
		return fmt.Sprintf("%d ms", result.Delay)
	}
	if result.Skipped {
		return "Skipped (block)"
	}
	return "Failed: " + telegramLine(result.Error, 70)
}

func (s *telegramCommandSession) lastCheck(owner telegramOwner, outbound domain.Outbound) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest time.Time
	var result OutboundCheckResult
	for _, snapshot := range s.jobs {
		if snapshot.Owner != owner || !snapshot.Expires.After(s.now()) || !snapshot.Ended.After(latest) {
			continue
		}
		for _, row := range snapshot.Rows {
			if row.Done && row.Outbound.Id == outbound.Id && row.Outbound.Tag == outbound.Tag && row.Outbound.Type == outbound.Type {
				latest, result = snapshot.Ended, row.Result
			}
		}
	}
	if latest.IsZero() {
		return ""
	}
	return telegramCheckLabel(result) + " at " + s.resources.date(latest.Unix())
}
