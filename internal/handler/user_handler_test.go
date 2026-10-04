package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/httputil"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestSignInConfig(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name   string
		secret string
		err    error
		status int
		show   bool
	}{
		{name: "disabled", status: http.StatusOK},
		{name: "enabled", secret: "PRIVATE-TOTP-SECRET", status: http.StatusOK, show: true},
		{name: "no account", err: gorm.ErrRecordNotFound, status: http.StatusOK},
		{name: "database failure", err: errors.New("private database error"), status: http.StatusInternalServerError},
	} {
		t.Run(test.name, func(t *testing.T) {
			// Replace the database read at the ORM boundary. No connection is
			// opened, and the real repository/service/HTTP response still run.
			db, err := gorm.Open(postgres.Open("host=127.0.0.1 port=1 user=test dbname=test sslmode=disable"), &gorm.Config{
				DisableAutomaticPing: true,
				Logger:               logger.Default.LogMode(logger.Silent),
			})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { sqlDB.Close() })
			if err := db.Callback().Query().Replace("gorm:query", func(tx *gorm.DB) {
				if test.err != nil {
					tx.AddError(test.err)
					return
				}
				user := tx.Statement.Dest.(*domain.User)
				*user = domain.User{Id: 1, Username: "PRIVATE-USERNAME", Password: "PRIVATE-PASSWORD-HASH", TotpSecret: test.secret}
				tx.RowsAffected = 1
			}); err != nil {
				t.Fatal(err)
			}

			handler := NewUserHandler(service.NewUserService(repository.NewStore(db)), nil, nil, 0)
			engine := gin.New()
			handler.RegisterPublic(engine.Group("/api"))
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/signin/config", nil))

			if recorder.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, test.status, recorder.Body)
			}
			if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
				t.Errorf("Cache-Control = %q, want no-store", got)
			}
			var response httputil.Response
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if test.status == http.StatusOK {
				want := map[string]interface{}{"showTwoFactor": test.show}
				if !response.Success || !reflect.DeepEqual(response.Obj, want) {
					t.Errorf("response = %+v, want only %+v", response, want)
				}
			} else if response.Success || response.Obj != nil || response.Msg == test.err.Error() {
				t.Errorf("database failure was exposed or treated as disabled: %+v", response)
			}
			if len(recorder.Result().Cookies()) != 0 {
				t.Error("configuration read must not create a session")
			}
		})
	}
}
