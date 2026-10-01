package domain

import (
	"encoding/json"
	"time"
)

// User is a panel operator. The panel has no self-service sign-up: accounts are
// created by an existing operator or from the CLI.
type User struct {
	Id       uint   `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Username string `json:"username" form:"username"`
	// Password is the bcrypt hash, never the plaintext. It is json:"-" so an
	// endpoint that returns a User cannot leak it by forgetting to select
	// around it -- which is how it used to be kept out, one query at a time.
	Password string `json:"-" form:"password"`
	// TotpSecret is the base32 secret the account's authenticator app derives
	// its codes from, or "" for an account signed in to with its password
	// alone. It is json:"-" for the reason the password is: it is a credential,
	// and an account's JSON says only whether there is one.
	TotpSecret string `json:"-" gorm:"column:totp_secret"`
	// LastSignIn is the last successful sign-in, as "2006-01-02 15:04:05 <ip>".
	LastSignIn string `json:"lastSignIn" gorm:"column:last_sign_in"`
	CreatedAt  int64  `json:"createdAt" gorm:"not null;default:0"`
}

func (User) TableName() string {
	return "users"
}

// HasTwoFactor reports whether signing in to the account takes a code as well
// as the password.
func (u User) HasTwoFactor() bool {
	return u.TotpSecret != ""
}

// MarshalJSON renders the account with `twoFactor` beside its fields, worked out
// from the secret rather than stored beside it, so the two cannot disagree and
// the secret itself never has to be read out to say it is there.
func (u User) MarshalJSON() ([]byte, error) {
	type fields User
	return json.Marshal(struct {
		fields
		TwoFactor bool `json:"twoFactor"`
	}{fields(u), u.HasTwoFactor()})
}

// Token authenticates a machine caller against the v2 API. It belongs to the
// user that created it, and carries exactly that user's authority.
type Token struct {
	Id    uint   `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Desc  string `json:"desc" form:"desc" gorm:"column:description"`
	Token string `json:"token" form:"token"`
	// Expiry is a unix time, or 0 for a token that does not expire.
	Expiry    int64 `json:"expiry" form:"expiry"`
	UserId    uint  `json:"userId" form:"userId"`
	User      *User `json:"user,omitempty" gorm:"foreignKey:UserId;references:Id"`
	CreatedAt int64 `json:"createdAt" gorm:"not null;default:0"`
}

func (Token) TableName() string {
	return "tokens"
}

// IsExpired reports whether the token has passed its expiry. A zero expiry
// never does.
func (t Token) IsExpired(now time.Time) bool {
	return t.Expiry > 0 && t.Expiry < now.Unix()
}
