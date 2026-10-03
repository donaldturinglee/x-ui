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
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
)

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
