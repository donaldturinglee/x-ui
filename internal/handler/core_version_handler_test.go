package handler

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
)

func TestCoreVersionRoutesRejectCommandsInvalidVersionsAndUnconfirmedChanges(t *testing.T) {
	t.Setenv("X_UI_CONFIG_DIR", t.TempDir())
	engine := gin.New()
	NewCoreVersionHandler(service.NewCoreVersionService(nil)).Register(engine.Group("/api"))
	for _, test := range []struct{ path, body string }{
		{"/core/version/check", `null`},
		{"/core/version/check", `{"version":"1.13.9"}`},
		{"/core/version/check", `{"version":"1.14.0-alpha.1"}`},
		{"/core/version/check", `{"version":"../../bin"}`},
		{"/core/version/check", `{"version":"1.14.1","command":"touch /tmp/file"}`},
		{"/core/version", `null`},
		{"/core/version", `{}`},
		{"/core/version", `{"checkId":"../file","expectedCurrentVersion":"1.14.2","configRevision":"x"}`},
		{"/core/version", `{"version":"1.14.1","url":"https://evil.example"}`},
		{"/core/version", `{} {}`},
	} {
		request := httptest.NewRequest("POST", "/api"+test.path, strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("%s %s: %d %s", test.path, test.body, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest("GET", "/api/core/versions", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"supported":false`) {
		t.Fatal(response.Code, response.Body.String())
	}
}
