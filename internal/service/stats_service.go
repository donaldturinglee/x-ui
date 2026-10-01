package service

import (
	"cmp"
	"context"
	"slices"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
)

// onlineWindow is how long after its last traffic a resource still counts as
// online. It has to be comfortably longer than a node's reporting interval, or
// everything blinks out between reports.
const onlineWindow = 5 * time.Minute

// maxChartBuckets caps how many points a traffic query returns. A month at
// one-minute resolution is forty thousand samples, and no chart is improved by
// receiving them.
const maxChartBuckets = 360

// Onlines is what is currently moving traffic, by resource.
type Onlines struct {
	Inbound  []string `json:"inbound"`
	Outbound []string `json:"outbound"`
	Client   []string `json:"client"`
}

// Series is a downsampled traffic chart: one [up, down] pair per bucket,
// keyed by bucket index from StartTime.
type Series struct {
	Stats      map[int64][]int64 `json:"stats"`
	StartTime  int64             `json:"startTime"`
	BucketSpan int64             `json:"bucketSpan"`
	NumBuckets int               `json:"numBuckets"`
}

// StatsService records reported traffic and answers questions about it.
type StatsService struct {
	store *repository.Store
	// bucketSeconds is the resolution samples are stored at.
	bucketSeconds int64
	// retention is how long samples are kept. Zero means per-bucket history is
	// not stored at all: traffic still counts against each client's quota, but
	// the charts stay empty.
	retention time.Duration
}

func NewStatsService(store *repository.Store, bucket time.Duration, retention time.Duration) *StatsService {
	bucketSeconds := int64(bucket / time.Second)
	if bucketSeconds < 1 {
		bucketSeconds = 1
	}
	return &StatsService{
		store:         store,
		bucketSeconds: bucketSeconds,
		retention:     retention,
	}
}

// Ingest records a reporting period's traffic.
//
// Reports are deltas, not running totals, and they are added to the stored
// counters in SQL. Two nodes reporting for the same client at the same moment
// therefore both count, rather than one overwriting the other with a total
// that never included the other's traffic.
func (s *StatsService) Ingest(ctx context.Context, reports []domain.TrafficReport) error {
	if len(reports) == 0 {
		return nil
	}

	now := time.Now().Unix()
	bucket := domain.Bucket(now, s.bucketSeconds)

	// Collapse the reports first: a node may report one client several times in
	// one batch, once per inbound it connected through.
	clientTraffic := map[string]domain.Traffic{}
	sampleIndex := map[domain.Stat]int64{}

	for _, report := range reports {
		if report.Tag == "" {
			return domain.Invalidf("traffic report is missing a tag")
		}
		if report.Up < 0 || report.Down < 0 {
			return domain.Invalidf("traffic report for %q is negative", report.Tag)
		}
		switch report.Resource {
		case domain.ResourceClient:
			t := clientTraffic[report.Tag]
			t.Up += report.Up
			t.Down += report.Down
			clientTraffic[report.Tag] = t
		case domain.ResourceInbound, domain.ResourceOutbound:
			// Nothing else to update: these have no counters of their own.
		default:
			return domain.Invalidf("unknown traffic resource %q", report.Resource)
		}

		if s.retention <= 0 {
			continue
		}
		if report.Up > 0 {
			key := domain.Stat{Resource: report.Resource, Tag: report.Tag, DateTime: bucket, Direction: domain.DirectionUp}
			sampleIndex[key] += report.Up
		}
		if report.Down > 0 {
			key := domain.Stat{Resource: report.Resource, Tag: report.Tag, DateTime: bucket, Direction: domain.DirectionDown}
			sampleIndex[key] += report.Down
		}
	}

	samples := make([]domain.Stat, 0, len(sampleIndex))
	for key, traffic := range sampleIndex {
		key.Traffic = traffic
		samples = append(samples, key)
	}

	return s.store.Tx(ctx, func(tx *repository.Store) error {
		if err := tx.LockTags(ctx, false); err != nil {
			return err
		}
		var inboundTags []string
		for _, sample := range samples {
			if sample.Resource == domain.ResourceInbound {
				inboundTags = append(inboundTags, sample.Tag)
			}
		}
		resolved, err := tx.Inbounds.ResolveTags(ctx, inboundTags)
		if err != nil {
			return err
		}
		// Both the old and new names can occur in the same retried batch. Fold
		// them after resolving, as PostgreSQL cannot upsert one bucket twice.
		samples = resolveInboundSamples(samples, resolved)
		if err := tx.Clients.AddTraffic(ctx, clientTraffic, now); err != nil {
			return err
		}
		return tx.Stats.AddSamples(ctx, samples)
	})
}

func resolveInboundSamples(samples []domain.Stat, resolved map[string]string) []domain.Stat {
	merged := make(map[domain.Stat]int64, len(samples))
	for _, sample := range samples {
		if sample.Resource == domain.ResourceInbound {
			if tag, ok := resolved[sample.Tag]; ok {
				sample.Tag = tag
			}
		}
		traffic := sample.Traffic
		sample.Traffic = 0
		merged[sample] += traffic
	}
	result := make([]domain.Stat, 0, len(merged))
	for sample, traffic := range merged {
		sample.Traffic = traffic
		result = append(result, sample)
	}
	// Keep lock acquisition during bucket upserts deterministic across reports.
	slices.SortFunc(result, func(a, b domain.Stat) int {
		if order := strings.Compare(a.Resource, b.Resource); order != 0 {
			return order
		}
		if order := strings.Compare(a.Tag, b.Tag); order != 0 {
			return order
		}
		if a.DateTime != b.DateTime {
			return cmp.Compare(a.DateTime, b.DateTime)
		}
		if a.Direction == b.Direction {
			return 0
		}
		if !a.Direction {
			return -1
		}
		return 1
	})
	return result
}

// Query returns a downsampled traffic series for one resource and tag.
//
// A custom range is used when both ends are given; otherwise it is the last
// `hours` hours up to now.
func (s *StatsService) Query(ctx context.Context, resource string, tag string, hours int, start int64, end int64) (*Series, error) {
	if tag == "" {
		return nil, domain.Invalidf("tag is required")
	}

	resources := []string{resource}
	switch resource {
	case domain.ResourceInbound, domain.ResourceOutbound, domain.ResourceClient:
	case "":
		return nil, domain.Invalidf("resource is required")
	default:
		return nil, domain.Invalidf("unknown traffic resource %q", resource)
	}

	var startTime, endTime int64
	if start > 0 && end > start {
		startTime, endTime = start, end
	} else {
		if hours < 1 {
			hours = 24
		}
		endTime = time.Now().Unix()
		startTime = endTime - int64(hours)*3600
	}

	stats, err := s.store.Stats.Query(ctx, resources, tag, startTime, endTime)
	if err != nil {
		return nil, err
	}
	return s.downsample(stats, startTime, endTime), nil
}

func (s *StatsService) downsample(stats []domain.Stat, startTime int64, endTime int64) *Series {
	numBuckets := maxChartBuckets
	if stored := (endTime - startTime) / s.bucketSeconds; stored < int64(numBuckets) {
		numBuckets = int(stored)
	}
	if numBuckets < 1 {
		numBuckets = 1
	}

	span := (endTime - startTime) / int64(numBuckets)
	if span < 1 {
		span = 1
	}

	series := make(map[int64][]int64)
	for _, stat := range stats {
		bucket := (stat.DateTime - startTime) / span
		if bucket < 0 {
			bucket = 0
		}
		if bucket >= int64(numBuckets) {
			bucket = int64(numBuckets) - 1
		}
		if _, ok := series[bucket]; !ok {
			series[bucket] = []int64{0, 0}
		}
		if stat.Direction == domain.DirectionUp {
			series[bucket][0] += stat.Traffic
		} else {
			series[bucket][1] += stat.Traffic
		}
	}

	return &Series{
		Stats:      series,
		StartTime:  startTime,
		BucketSpan: span,
		NumBuckets: numBuckets,
	}
}

// Onlines reports what has moved traffic recently.
func (s *StatsService) Onlines(ctx context.Context) (*Onlines, error) {
	since := time.Now().Add(-onlineWindow).Unix()

	clients, err := s.store.Clients.ListOnlineNames(ctx, since)
	if err != nil {
		return nil, err
	}
	// Inbounds and outbounds are read from the samples rather than from a
	// column, so with retention off they are simply not reported -- there is
	// nowhere else that knows.
	inbounds, err := s.store.Stats.ListRecentTags(ctx, domain.ResourceInbound, domain.Bucket(since, s.bucketSeconds))
	if err != nil {
		return nil, err
	}
	outbounds, err := s.store.Stats.ListRecentTags(ctx, domain.ResourceOutbound, domain.Bucket(since, s.bucketSeconds))
	if err != nil {
		return nil, err
	}

	return &Onlines{
		Inbound:  orEmpty(inbounds),
		Outbound: orEmpty(outbounds),
		Client:   orEmpty(clients),
	}, nil
}

// Purge drops samples past the retention window and reports how many went.
func (s *StatsService) Purge(ctx context.Context) (int64, error) {
	if s.retention <= 0 {
		// Retention off means nothing is stored, so there is nothing to purge.
		// Purging everything here would instead delete whatever was collected
		// before the setting was turned off, which is not what turning it off
		// asks for.
		return 0, nil
	}
	before := time.Now().Add(-s.retention).Unix()
	return s.store.Stats.DeleteOlderThan(ctx, before)
}

// Changes returns the audit log, newest first.
func (s *StatsService) Changes(ctx context.Context, filter repository.ChangeFilter) ([]domain.Change, error) {
	return s.store.Stats.ListChanges(ctx, filter)
}

// orEmpty turns a nil slice into an empty one, so the JSON is [] rather than
// null and a client can iterate it without a guard.
func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
