package handler

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
)

func TestUpgradeHandlerRejectsUnconfirmedAndExecutableInputs(t *testing.T) {
	t.Setenv("X_UI_CONFIG_DIR", t.TempDir())
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewUpgradeHandler(service.NewUpgradeService(config.Default())).Register(engine.Group("/api"))
	for _, body := range []string{"null", "[]", "{}", `{"url":"https://other.example/file"}`, `{"command":"x-ui update"}`, `{"checkId":"a","expectedCurrentVersion":"v0.0.1","configRevision":"old"}`, "{} {}", strings.Repeat(" ", 2050) + "{}"} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/api/upgrade", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(response, request)
		if response.Code != 400 {
			t.Fatalf("%q: HTTP %d", body, response.Code)
		}
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest("GET", "/api/upgrade/jobs/../../other", nil))
	if response.Code == 200 {
		t.Fatal("invalid task path accepted")
	}
}

func TestHostMaintenanceBlocksWritesAndKeepsTaskReadsAvailable(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("X_UI_CONFIG_DIR", directory)
	maintenance := filepath.Join(directory, ".host-maintenance")
	if err := os.MkdirAll(maintenance, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(maintenance, "active.json"), []byte(`{"kind":"upgrade","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	group := engine.Group("/api", HostMaintenance(directory))
	group.POST("/clients", func(c *gin.Context) { c.Status(204) })
	group.GET("/upgrade/jobs/:id", func(c *gin.Context) { c.Status(204) })
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest("POST", "/api/clients", strings.NewReader("{}")))
	if response.Code != 409 {
		t.Fatal(response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest("GET", "/api/upgrade/jobs/id", nil))
	if response.Code != 204 {
		t.Fatal(response.Code)
	}
}
