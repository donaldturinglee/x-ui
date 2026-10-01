package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// The panel is mounted at the root unless the configuration moves it, so the
// root is what these check first. A moved panel is checked as well, for what
// only a base below the root has: a twin without the trailing slash, and paths
// that are not its own.
const (
	testBase  = "/"
	movedBase = "/panel/"
)

func TestUnderAPIMatchesWholeSegments(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/api", true},
		{"/api/clients", true},
		{"/apiv2", true},
		{"/apiv2/config/download", true},

		// A page whose name happens to start with the prefix is not the API.
		{"/apiary", false},
		{"/apiv2x", false},
		{"/clients", false},
		{"/", false},
	}

	for _, c := range cases {
		if got := underAPI(testBase, c.path); got != c.want {
			t.Errorf("underAPI(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

// served reports what underBase did with a path: the status, and whether the
// handler it wraps was reached at all.
func served(t *testing.T, base string, path string) (int, bool, string) {
	t.Helper()

	reached := false
	handler := underBase(base, func(c *gin.Context) {
		reached = true
		c.String(http.StatusOK, "panel")
	})

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, path, nil)

	handler(c)

	// A status with no body is held on the writer until the chain ends, which
	// is gin's own doing and not this handler's. Nothing ends the chain here,
	// so it is flushed the way gin would.
	c.Writer.WriteHeaderNow()

	return recorder.Code, reached, recorder.Body.String()
}

func TestUnderBaseServesThePanelForItsOwnPaths(t *testing.T) {
	for _, base := range []string{testBase, movedBase} {
		for _, page := range []string{"", "clients", "audit"} {
			path := base + page
			status, reached, _ := served(t, base, path)

			if !reached || status != http.StatusOK {
				t.Errorf("%s: status %d, handler reached %v; want 200 and reached", path, status, reached)
			}
		}
	}
}

func TestUnderBaseRedirectsTheBaseWithoutItsSlash(t *testing.T) {
	status, reached, _ := served(t, movedBase, "/panel")

	if status != http.StatusTemporaryRedirect {
		t.Errorf("status = %d, want %d", status, http.StatusTemporaryRedirect)
	}
	if reached {
		t.Error("the panel was served for a path that should have been redirected")
	}
}

func TestUnderBaseRefusesWhatIsNotItsOwn(t *testing.T) {
	// Outside the base entirely: not this handler's to answer.
	status, reached, body := served(t, movedBase, "/healthz")

	if status != http.StatusNotFound || reached {
		t.Errorf("/healthz: status %d, handler reached %v; want 404 and not reached", status, reached)
	}
	if body != "" {
		t.Errorf("/healthz: body = %q, want empty", body)
	}
}

// An unrouted path under the API reaches this handler like any other, and
// answering it with the panel would hand a 200 and a page to something that
// asked for JSON.
func TestUnderBaseAnswersAnUnroutedAPIPathAsTheAPI(t *testing.T) {
	for _, base := range []string{testBase, movedBase} {
		for _, prefix := range []string{"api", "apiv2"} {
			path := base + prefix + "/nonexistent"
			status, reached, body := served(t, base, path)

			if status != http.StatusNotFound || reached {
				t.Errorf("%s: status %d, handler reached %v; want 404 and not reached", path, status, reached)
			}
			if want := `{"success":false,"msg":"no such endpoint","obj":null}`; body != want {
				t.Errorf("%s: body = %q, want %q", path, body, want)
			}
		}
	}
}
