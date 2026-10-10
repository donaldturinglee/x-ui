package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/donaldturinglee/x-ui/internal/agent"
	"github.com/donaldturinglee/x-ui/internal/domain"
)

const outboundCheckURL = "https://www.gstatic.com/generate_204"
const outboundCheckTimeout = 15 * time.Second
const outboundCheckConcurrency = 4

// OutboundCheckResult is transient: it never becomes part of the core config.
type OutboundCheckResult struct {
	OK      bool   `json:"ok"`
	Delay   uint16 `json:"delay"`
	Error   string `json:"error"`
	Skipped bool   `json:"skipped,omitempty"`
}

type clashCheckEndpoint struct {
	URL    string
	Secret string
}

type outboundCheckKey struct {
	ID       uint
	Tag      string
	Type     string
	Options  string
	Endpoint clashCheckEndpoint
}

type outboundCheckCall struct {
	done   chan struct{}
	result OutboundCheckResult
}

type outboundChecker struct {
	find     func(context.Context, uint) (*domain.Outbound, error)
	endpoint func() (clashCheckEndpoint, error)
	client   *http.Client
	slots    chan struct{}
	mu       sync.Mutex
	calls    map[outboundCheckKey]*outboundCheckCall
}

func newOutboundChecker(find func(context.Context, uint) (*domain.Outbound, error)) *outboundChecker {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// A local core request must not send its secret through an environment proxy.
	transport.Proxy = nil
	transport.DialContext = (&net.Dialer{Timeout: 3 * time.Second}).DialContext
	return &outboundChecker{
		find: find, endpoint: localClashCheckEndpoint,
		client: &http.Client{
			Transport: transport, Timeout: outboundCheckTimeout + 2*time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		slots: make(chan struct{}, outboundCheckConcurrency),
		calls: make(map[outboundCheckKey]*outboundCheckCall),
	}
}

func (s *OutboundService) Check(ctx context.Context, id uint) (OutboundCheckResult, error) {
	return s.checks.check(ctx, id)
}

func (s *outboundChecker) check(ctx context.Context, id uint) (OutboundCheckResult, error) {
	outbound, err := s.find(ctx, id)
	if err != nil {
		return OutboundCheckResult{}, err
	}
	if outbound.Type == domain.OutboundTypeBlock {
		return OutboundCheckResult{Skipped: true, Error: "Block outbounds do not accept connections."}, nil
	}
	if err := ctx.Err(); err != nil {
		return OutboundCheckResult{}, err
	}
	endpoint, err := s.endpoint()
	if err != nil {
		return OutboundCheckResult{Error: err.Error()}, nil
	}
	key := outboundCheckKey{ID: id, Tag: outbound.Tag, Type: outbound.Type, Options: string(outbound.Options), Endpoint: endpoint}
	s.mu.Lock()
	call, exists := s.calls[key]
	if !exists {
		select {
		case s.slots <- struct{}{}:
		default:
			s.mu.Unlock()
			return OutboundCheckResult{Error: "Other outbound checks are running. Try again shortly."}, nil
		}
		call = &outboundCheckCall{done: make(chan struct{})}
		s.calls[key] = call
		// A canceled browser request must not cancel another caller's shared check.
		// Work remains bounded by four slots and a 17-second deadline.
		go func() {
			probeCtx, cancel := context.WithTimeout(context.Background(), outboundCheckTimeout+2*time.Second)
			defer cancel()
			call.result = s.probe(probeCtx, endpoint, outbound.Tag)
			s.mu.Lock()
			<-s.slots
			delete(s.calls, key)
			close(call.done)
			s.mu.Unlock()
		}()
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return OutboundCheckResult{}, ctx.Err()
	case <-call.done:
		return call.result, nil
	}
}

func (s *outboundChecker) probe(ctx context.Context, endpoint clashCheckEndpoint, tag string) OutboundCheckResult {
	query := url.Values{"url": {outboundCheckURL}, "timeout": {strconv.FormatInt(outboundCheckTimeout.Milliseconds(), 10)}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL+"/proxies/"+url.PathEscape(tag)+"/delay?"+query.Encode(), nil)
	if err != nil {
		return OutboundCheckResult{Error: "The local Clash API address is invalid."}
	}
	if endpoint.Secret != "" {
		request.Header.Set("Authorization", "Bearer "+endpoint.Secret)
	}
	response, err := s.client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return OutboundCheckResult{Error: "Connection check timed out (15 s)."}
		}
		return OutboundCheckResult{Error: "Cannot reach the local Clash API. Check that sing-box is running and Clash API is enabled."}
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
		var result struct {
			Delay *uint16 `json:"delay"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result) != nil || result.Delay == nil || *result.Delay == 0 {
			return OutboundCheckResult{Error: "The Clash API returned an invalid delay."}
		}
		return OutboundCheckResult{OK: true, Delay: *result.Delay}
	case http.StatusUnauthorized, http.StatusForbidden:
		return OutboundCheckResult{Error: "Clash API authentication failed. Check the configured secret."}
	case http.StatusNotFound:
		return OutboundCheckResult{Error: "Outbound is not active in sing-box. Wait for configuration sync, then try again."}
	case http.StatusGatewayTimeout:
		return OutboundCheckResult{Error: "Connection check timed out (15 s)."}
	case http.StatusServiceUnavailable:
		return OutboundCheckResult{Error: "Connection check failed. Check the outbound configuration, DNS and remote server."}
	default:
		return OutboundCheckResult{Error: fmt.Sprintf("Clash API returned HTTP %d.", response.StatusCode)}
	}
}

// Read the applied core file, because a panel edit may not have synced yet.
func localClashCheckEndpoint() (clashCheckEndpoint, error) {
	environment, err := agent.ReadEnvironment("/etc/x-ui/agent.env")
	if err != nil {
		return clashCheckEndpoint{}, errors.New("Connection checks require a local x-ui agent and sing-box core.")
	}
	cfg, err := agent.LoadWithEnvironment("/etc/x-ui/agent.yaml", environment)
	if err != nil {
		return clashCheckEndpoint{}, errors.New("Cannot read the local agent configuration.")
	}
	configPath := cfg.Core.AppliedConfigPath
	if configPath == "" {
		configPath = cfg.Core.ConfigPath
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return clashCheckEndpoint{}, errors.New("Cannot read the applied sing-box configuration.")
	}
	return clashCheckEndpointFromConfig(data)
}

func clashCheckEndpointFromConfig(data []byte) (clashCheckEndpoint, error) {
	var config struct {
		Experimental struct {
			ClashAPI struct {
				Controller string `json:"external_controller"`
				Secret     string `json:"secret"`
			} `json:"clash_api"`
		} `json:"experimental"`
	}
	if json.Unmarshal(data, &config) != nil {
		return clashCheckEndpoint{}, errors.New("Cannot parse the applied sing-box configuration.")
	}
	clash := config.Experimental.ClashAPI
	if clash.Controller == "" {
		return clashCheckEndpoint{}, errors.New("Enable Clash API in Settings → Experimental, then wait for the core configuration to sync.")
	}
	host, port, err := net.SplitHostPort(clash.Controller)
	portNumber, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || portNumber < 1 || portNumber > 65535 {
		return clashCheckEndpoint{}, errors.New("Configure Clash API with a local address and port, such as 127.0.0.1:9090.")
	}
	switch host {
	case "", "0.0.0.0", "localhost":
		host = "127.0.0.1"
	case "::":
		host = "::1"
	default:
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return clashCheckEndpoint{}, errors.New("Connection checks require a Clash API on the panel's local host.")
		}
	}
	return clashCheckEndpoint{URL: "http://" + net.JoinHostPort(host, port), Secret: clash.Secret}, nil
}
