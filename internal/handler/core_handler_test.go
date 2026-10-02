package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
)

func TestCoreRestartRefusesCommandsAndMalformedBodies(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewSystemHandler(service.NewSystemService(nil, nil))
	for _, body := range []string{`{"command":"restart"}`, `{"unit":"x-ui-api"}`, `null`, `[]`, `{} {}`, `{"args":["sing-box"]}`} {
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/core/restart", strings.NewReader(body))
		handler.restartCore(c)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("core restart request %s returned %d", body, recorder.Code)
		}
	}
}
