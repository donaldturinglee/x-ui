package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/gin-gonic/gin"
)

func TestPanelSettingsRequestRejectsUnknownFieldsAndMultipleObjects(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, body := range []string{
		`{"revision":"x","values":{"database":{"password":"overwrite"}}}`,
		`{"revision":"x","values":{"secret":"overwrite"}}`,
		`{"revision":"x","values":null}`,
		`{"revision":"x","values":{}} {}`,
		`{"values":{}}`,
		`{"revision":"x","values":{},"extra":true}`,
		`{"revision":"x","values":{"port":8000,"statsBucketSeconds":60,"timeLocation":"UTC","logLevel":"info"}}`,
	} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/settings/panel", strings.NewReader(body))
		handler := NewSettingHandler(nil, nil, config.Default())
		handler.savePanelSettings(c)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, recorder.Code)
		}
	}
}

func TestPanelRestartRequestRejectsCommandsAndMalformedTasks(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, body := range []string{`{}`, `{"revision":"x"}`, `{"revision":"x","command":"restart sing-box"}`, `{"revision":"x"} {}`} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/settings/panel/restart", strings.NewReader(body))
		NewSettingHandler(nil, nil, config.Default()).restartPanel(c)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("restart body %s returned %d", body, recorder.Code)
		}
	}
}
