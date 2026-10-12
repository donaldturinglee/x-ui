package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestTelegramTokenSettingsHTTPContract(t *testing.T) {
	t.Setenv("X_UI_CONFIG_DIR", t.TempDir())
	const token = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0"
	storedToken := token
	db, err := gorm.Open(postgres.Open("host=127.0.0.1 port=1 user=test dbname=test sslmode=disable"), &gorm.Config{
		DisableAutomaticPing: true, Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	// Only reads are intercepted. Any accidental write or transaction would
	// reach the unavailable database and fail this test.
	if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
		row := domain.Setting{Key: domain.SettingTgBotToken, Value: storedToken}
		switch rows := tx.Statement.Dest.(type) {
		case *[]domain.Setting:
			*rows = []domain.Setting{row, {Key: "tgBotTokenSet", Value: "true"}}
		case *domain.Setting:
			*rows = row
		default:
			t.Fatalf("unexpected settings read %T", rows)
		}
		tx.RowsAffected = 1
	}); err != nil {
		t.Fatal(err)
	}
	settings := service.NewSettingService(repository.NewStore(db))
	gin.SetMode(gin.TestMode)
	router := gin.New()
	NewSettingHandler(settings, nil, config.Default()).Register(router.Group("/api"))
	call := func(method, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, "/api/settings", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	check := func(response *httptest.ResponseRecorder, wantFlag string) {
		t.Helper()
		var reply struct {
			Obj map[string]string `json:"obj"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &reply) != nil {
			t.Fatalf("settings = %d %s", response.Code, response.Body)
		}
		if _, exposed := reply.Obj[domain.SettingTgBotToken]; exposed || strings.Contains(response.Body.String(), token) {
			t.Fatal("settings response exposed the saved token")
		}
		if reply.Obj["tgBotTokenSet"] != wantFlag {
			t.Fatalf("configured flag = %q, want %s", reply.Obj["tgBotTokenSet"], wantFlag)
		}
	}
	check(call(http.MethodGet, ""), "true")
	for _, body := range []string{`{}`, `{"tgBotToken":""}`, `{"tgBotToken":"  \t ","tgBotTokenSet":"false"}`} {
		check(call(http.MethodPost, body), "true")
	}
	if actual, err := settings.Get(t.Context(), domain.SettingTgBotToken); err != nil || actual != token {
		t.Fatal("the internal token read changed")
	}
	if response := call(http.MethodPost, `{"tgBotToken":"invalid-token"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid replacement = %d %s", response.Code, response.Body)
	}
	check(call(http.MethodGet, ""), "true")
	storedToken = ""
	// A stored or submitted flag cannot claim that a token exists.
	check(call(http.MethodGet, ""), "false")
	if response := call(http.MethodPost, `{"tgBotEnable":"true","tgBotChatIds":"1111","tgBotTokenSet":"true"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("enable without a token = %d %s", response.Code, response.Body)
	}
}

func TestSubscriptionSettingsHTTPContract(t *testing.T) {
	t.Setenv("X_UI_CONFIG_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(config.Dir(), "config.yaml"), []byte("server:\n  port: 8000\ndatabase:\n  password: confidential\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	NewSettingHandler(nil, nil, cfg).Register(router.Group("/api"))
	call := func(method, path string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://panel.example:8000/api"+path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	response := call(http.MethodGet, "/settings/subscription", nil)
	var envelope struct {
		Obj service.SubscriptionSettingsState `json:"obj"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &envelope) != nil {
		t.Fatalf("read = %d %s", response.Code, response.Body)
	}
	if envelope.Obj.RunningURI != "http://panel.example:8443/sub/" || response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "confidential") {
		t.Fatalf("read response = %s", response.Body)
	}
	revision := envelope.Obj.Revision
	values := envelope.Obj.Saved
	values.PublicURL = "https://sub.example/proxy"
	values.BasePath = "/subscriptions/"
	raw, _ := json.Marshal(map[string]any{"revision": revision, "values": values})
	response = call(http.MethodPost, "/settings/subscription", raw)
	if response.Code != 200 {
		t.Fatalf("save = %d %s", response.Code, response.Body)
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Obj.SavedURI != "https://sub.example/proxy/subscriptions/" || envelope.Obj.RunningURI != "http://panel.example:8443/sub/" {
		t.Fatalf("saved/running URI = %+v", envelope.Obj)
	}
	if stale := call(http.MethodPost, "/settings/subscription", raw); stale.Code != 409 {
		t.Fatalf("stale = %d", stale.Code)
	}
	for _, body := range []string{
		`{"revision":"` + envelope.Obj.Revision + `","values":{}}`,
		`{"revision":"` + envelope.Obj.Revision + `","values":null}`,
		string(raw) + ` {}`,
		`{"revision":"` + envelope.Obj.Revision + `","values":{},"database":{}}`,
	} {
		if bad := call(http.MethodPost, "/settings/subscription", []byte(body)); bad.Code != 400 {
			t.Fatalf("bad request = %d %s", bad.Code, bad.Body)
		}
	}
	for _, body := range []string{`{}`, `{"revision":"` + envelope.Obj.Revision + `","scopes":["subscription"],"unexpected":true}`} {
		if bad := call(http.MethodPost, "/settings/apply", []byte(body)); bad.Code != 400 {
			t.Fatalf("bad apply = %d", bad.Code)
		}
	}
}

func TestTelegramStatusSettingsUseTheWorkerTimeZone(t *testing.T) {
	t.Setenv("X_UI_CONFIG_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(config.Dir(), "config.yaml"), []byte("server:\n  port: 8000\ndatabase:\n  password: confidential\nworker:\n  time_location: UTC\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	NewSettingHandler(nil, nil, cfg).Register(router.Group("/api"))
	read := func(want string) {
		t.Helper()
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/telegram/status-settings", nil))
		var reply struct {
			Obj struct {
				TimeZone string `json:"timeZone"`
			} `json:"obj"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &reply) != nil || reply.Obj.TimeZone != want || strings.Contains(response.Body.String(), "confidential") {
			t.Fatalf("settings = %d %s, want zone %s", response.Code, response.Body, want)
		}
	}
	read("UTC")
	worker := *cfg
	worker.Worker.TimeLocation = "Asia/Shanghai"
	if err := service.RecordPanelProcess("worker", &worker); err != nil {
		t.Fatal(err)
	}
	read("Asia/Shanghai")
}
