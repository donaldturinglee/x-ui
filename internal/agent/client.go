package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

// maxResponseBytes caps what the agent will read from the panel.
//
// A node reads whatever the panel sends straight into memory, so the panel
// being wrong -- or being something else entirely -- must not be able to
// exhaust it. A generated configuration is kilobytes; this is orders of
// magnitude above anything legitimate.
const maxResponseBytes = 32 << 20

// PanelClient talks to the panel's token API.
type PanelClient struct {
	baseURL string
	token   string
	host    string
	http    *http.Client
}

func NewPanelClient(cfg PanelConfig) *PanelClient {
	transport := http.DefaultTransport
	if cfg.InsecureSkipVerify || cfg.Host != "" {
		// Preserve the default transport settings while making the TLS name
		// match the panel's Host header when the URL dials loopback.
		custom := http.DefaultTransport.(*http.Transport).Clone()
		custom.TLSClientConfig = &tls.Config{
			ServerName:         cfg.Host,
			InsecureSkipVerify: cfg.InsecureSkipVerify,
		}
		transport = custom
	}
	return &PanelClient{
		baseURL: strings.TrimSuffix(cfg.URL, "/"),
		token:   cfg.Token,
		host:    cfg.Host,
		http: &http.Client{
			Timeout:   cfg.Timeout.Duration(),
			Transport: transport,
		},
	}
}

// envelope is the shape every panel endpoint answers with.
type envelope struct {
	Success bool            `json:"success"`
	Msg     string          `json:"msg"`
	Obj     json.RawMessage `json:"obj"`
}

// NodeConfig is what the panel says this node should be serving.
type NodeConfig struct {
	Document []byte
	// Maintenance says the listeners were withheld on purpose rather than
	// simply not existing. Worth saying out loud on a node that has just
	// stopped accepting clients.
	Maintenance bool
}

// FetchConfig returns the configuration this node should be serving.
//
// The download endpoint is used rather than the wrapped one: it returns the
// document itself, which is what gets written to disk, and avoids the agent
// having to unwrap and re-encode it -- a round trip that would reorder keys and
// make every poll look like a change.
func (c *PanelClient) FetchConfig(ctx context.Context) (*NodeConfig, error) {
	body, header, err := c.get(ctx, "/config/download")
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("the panel returned a configuration that is not valid JSON")
	}
	return &NodeConfig{
		Document:    body,
		Maintenance: strings.EqualFold(header.Get("X-UI-Maintenance"), "true"),
	}, nil
}

// ReportTraffic sends a reporting period's measurements.
func (c *PanelClient) ReportTraffic(ctx context.Context, reports []domain.TrafficReport) error {
	if len(reports) == 0 {
		return nil
	}
	payload, err := json.Marshal(map[string]interface{}{"reports": reports})
	if err != nil {
		return err
	}

	body, _, err := c.do(ctx, http.MethodPost, "/traffic", payload)
	if err != nil {
		return err
	}

	var response envelope
	if err := json.Unmarshal(body, &response); err != nil {
		return fmt.Errorf("unreadable answer from the panel: %w", err)
	}
	if !response.Success {
		return fmt.Errorf("the panel refused the report: %s", response.Msg)
	}
	return nil
}

// get reads a path and hands back the response headers alongside the body,
// which is how the panel says things the document itself has no room for.
func (c *PanelClient) get(ctx context.Context, path string) ([]byte, http.Header, error) {
	return c.do(ctx, http.MethodGet, path, nil)
}

func (c *PanelClient) do(ctx context.Context, method string, path string, payload []byte) ([]byte, http.Header, error) {
	var reader io.Reader
	if payload != nil {
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Token", c.token)
	if c.host != "" {
		req.Host = c.host
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.http.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes))
	if err != nil {
		return nil, nil, err
	}
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusCreated {
		// The status is what an operator needs; the body may be an HTML error
		// page from something in between, so only a short prefix is quoted.
		return nil, nil, fmt.Errorf("%s %s: %s: %s", method, path, res.Status, summarise(body))
	}
	return body, res.Header, nil
}

// summarise trims a response body down to something that fits in a log line.
func summarise(body []byte) string {
	const limit = 200
	text := strings.TrimSpace(string(body))
	if len(text) > limit {
		return text[:limit] + "…"
	}
	return text
}
