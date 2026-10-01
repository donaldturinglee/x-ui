package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// ClashStats reads per-connection counters from a sing-box Clash API and turns
// them into the deltas the panel expects.
//
// The API reports each live connection's cumulative upload and download. Those
// are not deltas, and a connection that closes stops being reported at all, so
// the conversion has to remember what each connection had already contributed:
//
//   - a connection seen before contributes the difference since last time;
//   - a connection seen for the first time contributes its whole total;
//   - a connection that has gone contributes nothing further, because whatever
//     it moved was already counted on the poll before it closed.
//
// The known limitation is the gap between polls: a connection that opens and
// closes entirely inside one interval is never seen, and its traffic is lost.
// Poll often enough that this is noise rather than a hole -- the default ten
// seconds is chosen for that, not for freshness.
type ClashStats struct {
	url          string
	secret       string
	http         *http.Client
	readSnapshot func(context.Context) (*clashConnections, error)

	// seen is the last reported total per connection id.
	seen map[string]connectionTotals
}

type connectionTotals struct {
	up   int64
	down int64
}

func NewClashStats(cfg StatsConfig) *ClashStats {
	stats := &ClashStats{
		url:    strings.TrimSuffix(cfg.URL, "/"),
		secret: cfg.Secret,
		http:   &http.Client{Timeout: cfg.Timeout.Duration()},
		seen:   map[string]connectionTotals{},
	}
	stats.readSnapshot = stats.fetch
	return stats
}

// clashConnections is the shape of the Clash API's /connections response.
type clashConnections struct {
	Connections []clashConnection `json:"connections"`
}

type clashConnection struct {
	ID       string `json:"id"`
	Upload   int64  `json:"upload"`
	Download int64  `json:"download"`
	Metadata struct {
		// User is the subscriber the connection authenticated as. It is
		// empty for traffic that did not come through an authenticated
		// inbound, which is not anyone's quota.
		User        string `json:"user"`
		InboundTag  string `json:"inboundName"`
		OutboundTag string `json:"outboundName"`
	} `json:"metadata"`
}

func (c *ClashStats) Read(ctx context.Context) ([]domain.TrafficReport, error) {
	snapshot, err := c.readSnapshot(ctx)
	if err != nil {
		return nil, err
	}

	// Aggregated before reporting: a busy subscriber has hundreds of live
	// connections, and one report each would be hundreds of rows for what is a
	// single number to the panel.
	type key struct {
		resource string
		tag      string
	}
	totals := map[key]*connectionTotals{}
	add := func(resource string, tag string, up int64, down int64) {
		if tag == "" || (up == 0 && down == 0) {
			return
		}
		k := key{resource, tag}
		if totals[k] == nil {
			totals[k] = &connectionTotals{}
		}
		totals[k].up += up
		totals[k].down += down
	}

	current := make(map[string]connectionTotals, len(snapshot.Connections))
	for _, connection := range snapshot.Connections {
		now := connectionTotals{up: connection.Upload, down: connection.Download}
		current[connection.ID] = now

		previous := c.seen[connection.ID]
		up, down := now.up-previous.up, now.down-previous.down
		// A counter that went backwards means the core restarted and reissued
		// the id. Counting the negative would subtract from the subscriber's
		// usage; taking the new total is the closest honest reading.
		if up < 0 {
			up = now.up
		}
		if down < 0 {
			down = now.down
		}

		add(domain.ResourceClient, connection.Metadata.User, up, down)
		add(domain.ResourceInbound, connection.Metadata.InboundTag, up, down)
		add(domain.ResourceOutbound, connection.Metadata.OutboundTag, up, down)
	}
	// Replaced rather than merged, so connections that have closed stop being
	// remembered and the map does not grow for the life of the process.
	c.seen = current

	reports := make([]domain.TrafficReport, 0, len(totals))
	for k, traffic := range totals {
		reports = append(reports, domain.TrafficReport{
			Resource: k.resource,
			Tag:      k.tag,
			Up:       traffic.up,
			Down:     traffic.down,
		})
	}
	return reports, nil
}

func (c *ClashStats) fetch(ctx context.Context) (*clashConnections, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url+"/connections", nil)
	if err != nil {
		return nil, err
	}
	if c.secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.secret)
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read the core's connections: %w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the core answered %s: %s", res.Status, summarise(body))
	}

	var snapshot clashConnections
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return nil, fmt.Errorf("unreadable answer from the core: %w", err)
	}
	return &snapshot, nil
}
