package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/agent"
	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"gopkg.in/yaml.v3"
)

const nodeStatsTag = "x-ui-stats-api"

type nodeInstallState struct {
	PanelURL  string `json:"panel_url"`
	PanelHost string `json:"panel_host"`
}

func nodeCommand(args []string) error {
	fs := flag.NewFlagSet("node", flag.ContinueOnError)
	setup := fs.Bool("setup", false, "configure the local agent and native statistics API")
	check := fs.Bool("check", false, "verify configuration sync and authenticated statistics reading")
	checkPanel := fs.Bool("check-panel", false, "verify the authenticated panel connection")
	refresh := fs.Bool("refresh-panel", false, "refresh only the locally managed panel connection")
	directory := fs.String("directory", "/etc/x-ui", "private node configuration directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	selected := 0
	for _, value := range []bool{*setup, *check, *checkPanel, *refresh} {
		if value {
			selected++
		}
	}
	if selected != 1 || len(fs.Args()) != 0 {
		return errors.New("usage: x-ui-cli node -setup|-check|-check-panel|-refresh-panel [-directory path]")
	}
	if *checkPanel {
		return checkNodePanel(*directory)
	}
	if *check {
		return checkNode(*directory)
	}
	panel, err := config.Load()
	if err != nil {
		return err
	}
	if *refresh {
		return refreshNodePanel(*directory, panel)
	}
	return withStore(func(ctx context.Context, store *repository.Store) error {
		if err := setupNode(ctx, store, panel, *directory); err != nil {
			return err
		}
		fmt.Println("local node configuration and native statistics API ready")
		return nil
	})
}

// Refreshing a Panel listener must not initialize statistics, rewrite the core
// configuration or rotate the existing agent token.
func refreshNodePanel(directory string, panel *config.Config) error {
	for _, name := range []string{"agent.yaml", "agent.env", "install-state.json"} {
		info, err := os.Lstat(filepath.Join(directory, name))
		if name == "install-state.json" && os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("Local agent configuration must be regular files")
		}
	}
	environment, err := readNodeEnvironment(filepath.Join(directory, "agent.env"))
	if err != nil {
		return err
	}
	content, err := os.ReadFile(filepath.Join(directory, "agent.yaml"))
	if err != nil {
		return err
	}
	var document map[string]interface{}
	if err := yaml.Unmarshal(content, &document); err != nil {
		return err
	}
	section, ok := document["panel"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("The local agent has no panel connection")
	}
	current, _ := section["url"].(string)
	if environment["X_UI_AGENT_PANEL_URL"] != "" {
		current = environment["X_UI_AGENT_PANEL_URL"]
	}
	parsed, err := url.Parse(current)
	var installed nodeInstallState
	stateData, stateErr := os.ReadFile(filepath.Join(directory, "install-state.json"))
	if stateErr != nil && !os.IsNotExist(stateErr) {
		return stateErr
	}
	if stateErr == nil {
		if err := json.Unmarshal(stateData, &installed); err != nil {
			return err
		}
	}
	if err != nil || current != installed.PanelURL && !loopbackHost(parsed.Hostname()) {
		return fmt.Errorf("The agent targets a remote panel; its connection was preserved")
	}
	host := panel.Server.Listen
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if panel.Server.TLSEnabled() {
		scheme = "https"
	}
	updatedURL := scheme + "://" + net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(panel.Server.Port)) + panel.Server.Base() + "apiv2"
	section["url"], section["host"] = updatedURL, panel.Server.Domain
	section["insecure_skip_verify"] = panel.Server.TLSEnabled() && panel.Server.Domain == "" && loopbackHost(host)
	encoded, err := yaml.Marshal(document)
	if err != nil {
		return err
	}
	envPath := filepath.Join(directory, "agent.env")
	content, err = os.ReadFile(envPath)
	if err != nil {
		return err
	}
	lines := []string{}
	for _, line := range strings.Split(string(content), "\n") {
		key, _, _ := strings.Cut(strings.TrimSpace(line), "=")
		if key != "X_UI_AGENT_PANEL_URL" && key != "X_UI_AGENT_PANEL_HOST" && key != "X_UI_AGENT_PANEL_INSECURE_SKIP_VERIFY" {
			lines = append(lines, line)
		}
	}
	state, err := json.Marshal(nodeInstallState{PanelURL: updatedURL, PanelHost: panel.Server.Domain})
	if err != nil {
		return err
	}
	if err := writePrivateNodeFile(filepath.Join(directory, "agent.yaml"), encoded); err != nil {
		return err
	}
	if err := writePrivateNodeFile(envPath, []byte(strings.Join(lines, "\n"))); err != nil {
		return err
	}
	return writePrivateNodeFile(filepath.Join(directory, "install-state.json"), state)
}

func setupNode(ctx context.Context, store *repository.Store, panel *config.Config, directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	for _, name := range []string{"", "agent.env", "agent.yaml", "install-state.json"} {
		if info, err := os.Lstat(filepath.Join(directory, name)); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlinked node configuration: %s", name)
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return err
	}
	envPath := filepath.Join(directory, "agent.env")
	environment, err := readNodeEnvironment(envPath)
	if err != nil {
		return err
	}
	users := service.NewUserService(store)
	tokens, err := users.ValidTokens(ctx)
	if err != nil {
		return err
	}
	token := environment["X_UI_AGENT_PANEL_TOKEN"]
	valid := false
	for _, saved := range tokens {
		valid = valid || token != "" && saved.Token == token
	}
	if !valid {
		owner, err := users.First(ctx)
		if err != nil {
			return err
		}
		created, err := users.CreateToken(ctx, owner.Username, 0, "local x-ui-agent")
		if err != nil {
			return err
		}
		token = created.Token
	}
	settings := service.NewSettingService(store)
	configs := service.NewConfigService(store, settings, service.NewInboundService(store), service.NewOutboundService(store))
	base, err := configs.Base(ctx)
	if err != nil {
		return err
	}
	updated, statsURL, secret, err := prepareNativeStats(base, environment["X_UI_AGENT_STATS_SECRET"])
	if err != nil {
		return err
	}
	var state nodeInstallState
	if content, err := os.ReadFile(filepath.Join(directory, "install-state.json")); err == nil {
		if err := json.Unmarshal(content, &state); err != nil {
			return fmt.Errorf("read node install state: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	agentPath := filepath.Join(directory, "agent.yaml")
	var document map[string]interface{}
	if content, err := os.ReadFile(agentPath); err == nil {
		if err := yaml.Unmarshal(content, &document); err != nil {
			return fmt.Errorf("read agent configuration: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// EnvironmentFile settings win over YAML, so inspect the effective target
	// before replacing managed connection settings. Timing and log overrides
	// remain in the file; connection and core settings belong to agent.yaml.
	if current := environment["X_UI_AGENT_PANEL_URL"]; current != "" {
		section, _ := document["panel"].(map[string]interface{})
		if section == nil {
			section = map[string]interface{}{}
			if document == nil {
				document = map[string]interface{}{}
			}
			document["panel"] = section
		}
		section["url"] = current
	}
	document, state, err = prepareNodeDocument(document, state, panel, statsURL, directory)
	if err != nil {
		return err
	}
	encoded, err := yaml.Marshal(document)
	if err != nil {
		return err
	}
	stateJSON, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(jsonValue(base), jsonValue(updated)) {
		if err := configs.SaveBase(ctx, domain.ActorSystem, updated); err != nil {
			return err
		}
	}
	if err := updateNodeEnvironment(envPath, map[string]string{
		"X_UI_AGENT_PANEL_TOKEN":  token,
		"X_UI_AGENT_STATS_SECRET": secret,
	}); err != nil {
		return err
	}
	if err := writePrivateNodeFile(agentPath, encoded); err != nil {
		return err
	}
	return writePrivateNodeFile(filepath.Join(directory, "install-state.json"), stateJSON)
}

func prepareNativeStats(base []byte, savedSecret string) ([]byte, string, string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(base, &fields); err != nil || fields == nil {
		return nil, "", "", errors.New("the base configuration must be a JSON object")
	}
	var services []map[string]json.RawMessage
	if raw, ok := fields["services"]; ok {
		if err := json.Unmarshal(raw, &services); err != nil {
			return nil, "", "", fmt.Errorf("read core services: %w", err)
		}
	}
	var native map[string]json.RawMessage
	for _, current := range services {
		var tag string
		_ = json.Unmarshal(current["tag"], &tag)
		if tag == nodeStatsTag {
			if native != nil {
				return nil, "", "", errors.New("duplicate local statistics API tag")
			}
			native = current
		}
	}
	if native == nil {
		native = map[string]json.RawMessage{"type": json.RawMessage(`"api"`), "tag": json.RawMessage(`"x-ui-stats-api"`), "listen": json.RawMessage(`"127.0.0.1"`), "listen_port": json.RawMessage(`9091`)}
		services = append(services, native)
	}
	var kind, listen, secret string
	var port int
	_ = json.Unmarshal(native["type"], &kind)
	_ = json.Unmarshal(native["listen"], &listen)
	_ = json.Unmarshal(native["listen_port"], &port)
	_ = json.Unmarshal(native["secret"], &secret)
	if kind != "api" || net.ParseIP(listen) == nil || !net.ParseIP(listen).IsLoopback() || port < 1 || port > 65535 {
		return nil, "", "", errors.New("the local statistics API must use type api, a loopback address and a fixed port")
	}
	if raw := native["tls"]; len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
		var tls struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(raw, &tls); err != nil || tls.Enabled {
			return nil, "", "", errors.New("the installer-managed loopback statistics API must not enable TLS")
		}
	}
	if secret == "" {
		secret = savedSecret
	}
	if secret == "" {
		entropy := make([]byte, 32)
		if _, err := rand.Read(entropy); err != nil {
			return nil, "", "", err
		}
		secret = hex.EncodeToString(entropy)
	}
	if strings.ContainsAny(secret, "\r\n\x00") {
		return nil, "", "", errors.New("the statistics secret contains an unsupported control character")
	}
	native["secret"], _ = json.Marshal(secret)
	native["dashboard"] = json.RawMessage("false")
	fields["services"], _ = json.Marshal(services)
	encoded, err := json.MarshalIndent(fields, "", "  ")
	return encoded, "http://" + net.JoinHostPort(listen, strconv.Itoa(port)), secret, err
}

func prepareNodeDocument(document map[string]interface{}, state nodeInstallState, panel *config.Config, statsURL, directory string) (map[string]interface{}, nodeInstallState, error) {
	if document == nil {
		document = map[string]interface{}{}
	}
	section := func(key string) map[string]interface{} {
		value, _ := document[key].(map[string]interface{})
		if value == nil {
			value = map[string]interface{}{}
			document[key] = value
		}
		return value
	}
	panelSection := section("panel")
	currentURL, _ := panelSection["url"].(string)
	if currentURL != "" && currentURL != state.PanelURL {
		parsed, err := url.Parse(currentURL)
		if err != nil || !loopbackHost(parsed.Hostname()) {
			return nil, state, errors.New("the existing agent targets a remote panel; local installation requires a local agent configuration")
		}
	}
	listen := panel.Server.Listen
	if listen == "" || listen == "0.0.0.0" || listen == "::" || listen == "[::]" {
		listen = "127.0.0.1"
	}
	scheme := "http"
	if panel.Server.TLSEnabled() {
		scheme = "https"
	}
	panelURL := scheme + "://" + net.JoinHostPort(strings.Trim(listen, "[]"), strconv.Itoa(panel.Server.Port)) + panel.Server.Base() + "apiv2"
	panelSection["url"], panelSection["host"] = panelURL, panel.Server.Domain
	panelSection["token"] = ""
	panelSection["insecure_skip_verify"] = panel.Server.TLSEnabled() && panel.Server.Domain == "" && loopbackHost(listen)
	core := section("core")
	core["config_path"] = filepath.Join(directory, "config.json")
	core["applied_config_path"] = "/etc/sing-box/config.json"
	core["check_command"] = []string{"sing-box", "check", "-c", "{config}"}
	core["reload_command"] = []string{"/usr/local/x-ui/bin/x-ui-core-reload", filepath.Join(directory, "config.json"), "/etc/sing-box/config.json"}
	stats := section("stats")
	stats["source"], stats["url"], stats["secret"] = "sing-box", statsURL, ""
	return document, nodeInstallState{PanelURL: panelURL, PanelHost: panel.Server.Domain}, nil
}

func loopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	return host == "localhost" || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()
}

func readNodeEnvironment(path string) (map[string]string, error) {
	values, err := agent.ReadEnvironment(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	return values, err
}

func updateNodeEnvironment(path string, updates map[string]string) error {
	content, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := []string{}
	managed := map[string]bool{
		"X_UI_AGENT_PANEL_URL":                true,
		"X_UI_AGENT_PANEL_HOST":               true,
		"X_UI_AGENT_INSECURE_SKIP_VERIFY":     true,
		"X_UI_AGENT_CORE_CONFIG_PATH":         true,
		"X_UI_AGENT_CORE_APPLIED_CONFIG_PATH": true,
		"X_UI_AGENT_CORE_CHECK_COMMAND":       true,
		"X_UI_AGENT_CORE_RELOAD_COMMAND":      true,
		"X_UI_AGENT_STATS_SOURCE":             true,
		"X_UI_AGENT_STATS_URL":                true,
	}
	for _, line := range strings.Split(strings.TrimSuffix(string(content), "\n"), "\n") {
		key, _, found := strings.Cut(strings.TrimSpace(line), "=")
		_, replace := updates[key]
		if !found || !replace && !managed[key] {
			if line != "" {
				lines = append(lines, line)
			}
		}
	}
	for _, key := range []string{"X_UI_AGENT_PANEL_TOKEN", "X_UI_AGENT_STATS_SECRET"} {
		if value, ok := updates[key]; ok {
			lines = append(lines, key+"="+strconv.Quote(value))
		}
	}
	return writePrivateNodeFile(path, []byte(strings.Join(lines, "\n")+"\n"))
}

func writePrivateNodeFile(path string, content []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".x-ui-node-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}

func jsonValue(document []byte) interface{} {
	var value interface{}
	_ = json.Unmarshal(document, &value)
	return value
}

func checkNode(directory string) error {
	environment, err := readNodeEnvironment(filepath.Join(directory, "agent.env"))
	if err != nil {
		return err
	}
	cfg, err := agent.LoadWithEnvironment(filepath.Join(directory, "agent.yaml"), environment)
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	if cfg.Stats.Source != agent.StatsSourceSingBox || cfg.Stats.Secret == "" {
		return errors.New("native authenticated statistics are not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fetched, err := agent.NewPanelClient(cfg.Panel).FetchConfig(ctx)
	if err != nil {
		return err
	}
	for _, path := range []string{cfg.Core.ConfigPath, cfg.Core.AppliedConfigPath} {
		if path == "" {
			return errors.New("the applied core configuration path is missing")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !json.Valid(content) || !reflect.DeepEqual(jsonValue(content), jsonValue(fetched.Document)) {
			return errors.New("panel, agent and core configuration do not match")
		}
	}
	if _, err := agent.NewStatsSource(cfg.Stats).Read(ctx); err != nil {
		return fmt.Errorf("native statistics check: %w", err)
	}
	fmt.Println("configuration sync and authenticated statistics reading passed")
	return nil
}

// Applying Panel settings only needs to verify the existing agent's panel
// connection. Legacy agents may omit applied_config_path; checking or changing
// their native statistics and core configuration belongs to node -check/setup.
func checkNodePanel(directory string) error {
	environment, err := readNodeEnvironment(filepath.Join(directory, "agent.env"))
	if err != nil {
		return err
	}
	cfg, err := agent.LoadWithEnvironment(filepath.Join(directory, "agent.yaml"), environment)
	if err != nil {
		return err
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := agent.NewPanelClient(cfg.Panel).FetchConfig(ctx); err != nil {
		return err
	}
	fmt.Println("authenticated panel connection passed")
	return nil
}
