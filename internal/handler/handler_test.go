package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
)

func TestASignInWantingACodeSaysSo(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/signin", nil)

	fail(c, domain.ErrCodeRequired)

	// Refused, as a sign-in that starts no session is, with the question where
	// the form branches rather than only in a sentence.
	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", recorder.Code)
	}
	var response httputil.Response
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	obj, _ := response.Obj.(map[string]interface{})
	if response.Success || obj["twoFactor"] != true {
		t.Errorf("response = %+v, want a refusal carrying twoFactor", response)
	}
}
