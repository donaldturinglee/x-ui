package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnAccountSaysWhetherItTakesACodeAndNothingMore(t *testing.T) {
	user := User{
		Id:         1,
		Username:   "operator",
		Password:   "$2a$10$hash-value",
		TotpSecret: "JBSWY3DPEHPK3PXP",
	}

	encoded, err := json.Marshal(user)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, credential := range []string{"hash-value", "JBSWY3DPEHPK3PXP"} {
		if strings.Contains(string(encoded), credential) {
			t.Errorf("account = %s, which gives %q away", encoded, credential)
		}
	}

	var fields map[string]interface{}
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if fields["twoFactor"] != true || fields["username"] != "operator" {
		t.Errorf("account = %s, want its fields with twoFactor beside them", encoded)
	}

	user.TotpSecret = ""
	if encoded, _ := json.Marshal(user); !strings.Contains(string(encoded), `"twoFactor":false`) {
		t.Errorf("account = %s, want twoFactor false without a secret", encoded)
	}
}
