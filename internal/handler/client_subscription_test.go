package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/gin-gonic/gin"
)

type subscriptionInfoStub struct {
	info *service.ClientSubscriptionInfo
	err  error
	id   uint
	host string
}

func (s *subscriptionInfoStub) Info(_ context.Context, id uint, host string) (*service.ClientSubscriptionInfo, error) {
	s.id, s.host = id, host
	return s.info, s.err
}

func TestClientSubscriptionInfoHTTPContract(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &subscriptionInfoStub{info: &service.ClientSubscriptionInfo{
		Enabled: false,
		Formats: map[string]service.SubscriptionFormatInfo{
			service.FormatClash: {NodeCount: 0, OmittedProtocols: []string{"snell"}},
		},
	}}
	router := gin.New()
	NewClientHandler(nil, nil, config.SubscriptionConfig{}, stub).Register(router.Group("/api"))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://panel.example:8000/api/clients/7/subscription-info", nil))
	var envelope struct {
		Obj service.ClientSubscriptionInfo `json:"obj"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &envelope) != nil {
		t.Fatalf("response = %d %s", response.Code, response.Body)
	}
	if stub.id != 7 || stub.host != "panel.example" || envelope.Obj.Enabled || envelope.Obj.Formats[service.FormatClash].NodeCount != 0 {
		t.Fatalf("request or response mismatch: id=%d host=%q info=%+v", stub.id, stub.host, envelope.Obj)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("subscriber availability must not be cached by an intermediary")
	}
	stub.err = domain.NotFoundf("client")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/clients/8/subscription-info", nil))
	if response.Code != 404 {
		t.Fatalf("missing subscriber = %d, want 404", response.Code)
	}
	stub.id = 0
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/clients/invalid/subscription-info", nil))
	if response.Code != 400 || stub.id != 0 {
		t.Fatalf("invalid id reached the service: %d, id=%d", response.Code, stub.id)
	}
}
