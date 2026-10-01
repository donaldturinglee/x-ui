package service

import (
	"golang.org/x/crypto/bcrypt"
)

// dummyHash is a valid bcrypt hash of a value nobody can guess. It is compared
// against when no account matched, so a request for an unknown username costs
// the same as one for a known username with the wrong password. Without it the
// two differ by a whole bcrypt round, and usernames become enumerable by
// timing alone.
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

// minPasswordLength is enforced on every change. bcrypt makes each guess cost
// milliseconds, which buys nothing against a password from the top of a
// wordlist.
const minPasswordLength = 8

func hashPassword(plain string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func checkPassword(plain string, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// burnPasswordCheck spends the work checkPassword would, and always fails. It
// is what the no-such-user path calls instead of returning early.
func burnPasswordCheck(plain string) {
	_ = bcrypt.CompareHashAndPassword([]byte(dummyHash), []byte(plain))
}
