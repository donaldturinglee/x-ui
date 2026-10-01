package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/pkg/logger"
	"github.com/donaldturinglee/x-ui/pkg/validator"
)

// tokenBytes is the size of an API token before encoding. 32 bytes is beyond
// guessing and still fits in a header without wrapping.
const tokenBytes = 32

// UserService owns panel accounts, the sign-in path, and API tokens.
type UserService struct {
	store   *repository.Store
	limiter *signInLimiter
	codes   *totpReplay
}

func NewUserService(store *repository.Store) *UserService {
	return &UserService{
		store:   store,
		limiter: newSignInLimiter(),
		codes:   newTotpReplay(),
	}
}

// SignIn authenticates an operator and records the attempt.
//
// Every failure answers the same way whatever went wrong -- unknown account,
// wrong password -- because a message that distinguishes them turns the
// sign-in form into a way to find out which usernames exist.
//
// An account with two-factor authentication on takes a code from its
// authenticator app as well. It is asked for only once the password is right,
// so the question tells nobody anything who does not already know the password;
// a wrong code counts against the address as a wrong password does.
func (s *UserService) SignIn(ctx context.Context, username string, password string, code string, remoteIP string) (*domain.User, error) {
	if locked, remaining := s.limiter.LockedOut(remoteIP); locked {
		logger.Warning("sign-in refused, too many failures from ", remoteIP)
		return nil, domain.Forbiddenf("too many failed attempts, try again in %d minute(s)",
			int(remaining.Minutes())+1)
	}

	user, err := s.store.Users.FindByUsername(ctx, username)
	switch {
	case errors.Is(err, domain.ErrNotFound):
		// The same work a real check would do, so an unknown username cannot
		// be told from a known one by how long the answer takes.
		burnPasswordCheck(password)
		user = nil
	case err != nil:
		return nil, err
	case !checkPassword(password, user.Password):
		user = nil
	}

	if user == nil {
		s.noteFailure(remoteIP)
		return nil, domain.Unauthorizedf("wrong username or password")
	}

	if user.HasTwoFactor() {
		if strings.TrimSpace(code) == "" {
			return nil, domain.ErrCodeRequired
		}
		if !s.codes.accept(user.Id, user.TotpSecret, code, time.Now()) {
			s.noteFailure(remoteIP)
			return nil, domain.Unauthorizedf("wrong two-factor code")
		}
	}

	s.limiter.NoteSuccess(remoteIP)

	entry := time.Now().Format("2006-01-02 15:04:05") + " " + remoteIP
	if err := s.store.Users.SetLastSignIn(ctx, user.Id, entry); err != nil {
		// Not fatal: the operator is authenticated either way, and refusing the
		// sign-in over a bookkeeping write would lock them out of their panel.
		logger.Warning("unable to record last sign-in: ", err)
	}
	logger.Info("user ", user.Username, " signed in")
	return user, nil
}

func (s *UserService) noteFailure(remoteIP string) {
	if s.limiter.NoteFailure(remoteIP) {
		logger.Warning("sign-in locked out for ", remoteIP, " after ", maxSignInFailures, " failed attempts")
	}
}

// TwoFactorSetup mints a secret for the signed-in operator's authenticator app,
// with the address the app reads it from.
//
// Nothing is stored. Sign-in asks for codes only once one has been confirmed
// against the secret, so a setup abandoned half way locks nobody out of their
// panel.
func (s *UserService) TwoFactorSetup(ctx context.Context, signedInUser string) (string, string, error) {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return "", "", err
	}
	if user.HasTwoFactor() {
		return "", "", domain.Conflictf("two-factor authentication is already on: turn it off before setting it up again")
	}
	secret, err := newTotpSecret()
	if err != nil {
		return "", "", err
	}
	return secret, totpURI(user.Username, secret), nil
}

// EnableTwoFactor turns two-factor authentication on for the signed-in
// operator, with the secret their app was given and a code the app shows. The
// code is what proves the app holds the secret before sign-in depends on it.
func (s *UserService) EnableTwoFactor(ctx context.Context, signedInUser string, secret string, code string) error {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return err
	}
	if user.HasTwoFactor() {
		return domain.Conflictf("two-factor authentication is already on")
	}
	key, err := decodeTotpSecret(secret)
	if err != nil || len(key) < totpMinimumSecretBytes {
		return domain.Invalidf("that is not a secret this panel set up")
	}
	stored := totpEncoding.EncodeToString(key)
	if !s.codes.accept(user.Id, stored, code, time.Now()) {
		return domain.Invalidf("that code does not match: check the time on the device, and try the next code it shows")
	}

	if err := s.store.Users.SetTotpSecret(ctx, user.Id, stored); err != nil {
		return err
	}
	logger.Info("user ", signedInUser, " turned two-factor authentication on")
	logChange(ctx, s.store, signedInUser, "users", "edit", map[string]interface{}{"username": user.Username, "twoFactor": true})
	return nil
}

// DisableTwoFactor turns two-factor authentication off for the signed-in
// operator. It takes a code, as signing in does: a session left open on an
// unattended screen must not be enough to take the second factor away.
func (s *UserService) DisableTwoFactor(ctx context.Context, signedInUser string, code string) error {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return err
	}
	if !user.HasTwoFactor() {
		return domain.Conflictf("two-factor authentication is not on")
	}
	if !s.codes.accept(user.Id, user.TotpSecret, code, time.Now()) {
		return domain.Invalidf("wrong two-factor code")
	}

	if err := s.store.Users.SetTotpSecret(ctx, user.Id, ""); err != nil {
		return err
	}
	logger.Info("user ", signedInUser, " turned two-factor authentication off")
	logChange(ctx, s.store, signedInUser, "users", "edit", map[string]interface{}{"username": user.Username, "twoFactor": false})
	return nil
}

// ResetTwoFactor turns two-factor authentication off for an account without a
// code. It is the CLI's way back in for an operator who lost their
// authenticator, and like SetCredentials it is not reachable over HTTP.
func (s *UserService) ResetTwoFactor(ctx context.Context, username string) error {
	user, err := s.store.Users.FindByUsername(ctx, username)
	if err != nil {
		return err
	}
	if err := s.store.Users.SetTotpSecret(ctx, user.Id, ""); err != nil {
		return err
	}
	logChange(ctx, s.store, domain.ActorSystem, "users", "edit", map[string]interface{}{"username": user.Username, "twoFactor": false})
	return nil
}

// List returns every account, without password hashes.
func (s *UserService) List(ctx context.Context) ([]domain.User, error) {
	return s.store.Users.List(ctx)
}

// Count reports how many accounts exist, for callers that only need to know
// whether the panel has been set up yet.
func (s *UserService) Count(ctx context.Context) (int64, error) {
	return s.store.Users.Count(ctx)
}

// FindByUsername resolves an account, for callers holding only a session name.
func (s *UserService) FindByUsername(ctx context.Context, username string) (*domain.User, error) {
	return s.store.Users.FindByUsername(ctx, username)
}

// EnsureInitialUser creates the first account when there is none, and reports
// whether it created one.
//
// It does not invent a password. A panel that bootstraps itself with a
// well-known default is reachable by anyone who reads the project's README,
// and the window between install and the first sign-in is exactly when nobody
// is watching -- so the operator has to supply one.
func (s *UserService) EnsureInitialUser(ctx context.Context, username string, password string) (bool, error) {
	count, err := s.store.Users.Count(ctx)
	if err != nil {
		return false, err
	}
	if count > 0 {
		return false, nil
	}
	if err := validateCredentials(username, password); err != nil {
		return false, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return false, err
	}
	user := &domain.User{
		Username:  username,
		Password:  hash,
		CreatedAt: time.Now().Unix(),
	}
	if err := s.store.Users.Create(ctx, user); err != nil {
		return false, err
	}
	logChange(ctx, s.store, domain.ActorSystem, "users", "new", map[string]string{"username": username})
	return true, nil
}

// SetCredentials rewrites an account's username and password without knowing
// the old one. It is the CLI's account-recovery path, and is deliberately not
// reachable over HTTP: an authenticated session must prove the current
// password before it can change either.
func (s *UserService) SetCredentials(ctx context.Context, id uint, username string, password string) error {
	if err := validateCredentials(username, password); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	if err := s.store.Users.UpdateCredentials(ctx, id, username, hash); err != nil {
		return err
	}
	logChange(ctx, s.store, domain.ActorSystem, "users", "edit", map[string]string{"username": username})
	return nil
}

// First returns the oldest account, which is the one the CLI acts on by
// default.
func (s *UserService) First(ctx context.Context) (*domain.User, error) {
	return s.store.Users.First(ctx)
}

// ChangeCredentials rewrites the logged-in operator's own username and
// password.
//
// The account comes from the session, never from an id in the request. With an
// id from the request, any authenticated operator could rewrite anyone else's
// credentials by posting a different number -- and on a single-admin panel
// that is the whole panel.
func (s *UserService) ChangeCredentials(ctx context.Context, signedInUser string, oldPassword string, newUsername string, newPassword string) error {
	if signedInUser == "" {
		return domain.Unauthorizedf("not signed in")
	}
	if err := validateCredentials(newUsername, newPassword); err != nil {
		return err
	}

	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return err
	}
	if !checkPassword(oldPassword, user.Password) {
		return domain.Unauthorizedf("wrong password")
	}
	if newUsername != user.Username {
		if _, err := s.store.Users.FindByUsername(ctx, newUsername); err == nil {
			return domain.Conflictf("username %q is already in use", newUsername)
		} else if !errors.Is(err, domain.ErrNotFound) {
			return err
		}
	}

	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}
	if err := s.store.Users.UpdateCredentials(ctx, user.Id, newUsername, hash); err != nil {
		return err
	}
	logger.Info("user ", signedInUser, " changed their credentials")
	logChange(ctx, s.store, signedInUser, "users", "edit", map[string]string{"username": newUsername})
	return nil
}

// ValidTokens returns every unexpired token with its owner's name, for the
// middleware's in-memory table.
func (s *UserService) ValidTokens(ctx context.Context) ([]domain.Token, error) {
	return s.store.Users.ListValidTokens(ctx, time.Now())
}

// Tokens returns one operator's own tokens, with the secrets masked.
func (s *UserService) Tokens(ctx context.Context, signedInUser string) ([]domain.Token, error) {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return nil, err
	}
	return s.store.Users.ListTokensByUser(ctx, user.Id)
}

// CreateToken mints an API token for the logged-in operator and returns its
// value. This is the only time the value is returned: it is stored to be
// compared against, not to be handed back out.
func (s *UserService) CreateToken(ctx context.Context, signedInUser string, expiryDays int64, desc string) (*domain.Token, error) {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return nil, err
	}

	v := validator.New()
	v.NonNegative("expiry", expiryDays)
	v.MaxLen("desc", desc, 200)
	if err := v.Err(); err != nil {
		return nil, err
	}

	secret, err := RandomSecret(tokenBytes)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	token := &domain.Token{
		Token:     secret,
		Desc:      desc,
		UserId:    user.Id,
		CreatedAt: now.Unix(),
	}
	if expiryDays > 0 {
		token.Expiry = now.AddDate(0, 0, int(expiryDays)).Unix()
	}
	if err := s.store.Users.CreateToken(ctx, token); err != nil {
		return nil, err
	}
	logChange(ctx, s.store, signedInUser, "tokens", "new", map[string]interface{}{"id": token.Id, "desc": desc})
	return token, nil
}

// DeleteToken revokes one of the logged-in operator's own tokens.
func (s *UserService) DeleteToken(ctx context.Context, signedInUser string, tokenId uint) error {
	user, err := s.store.Users.FindByUsername(ctx, signedInUser)
	if err != nil {
		return err
	}
	if err := s.store.Users.DeleteToken(ctx, tokenId, user.Id); err != nil {
		return err
	}
	logChange(ctx, s.store, signedInUser, "tokens", "del", map[string]interface{}{"id": tokenId})
	return nil
}

// PurgeExpiredTokens drops tokens nothing can authenticate with any more.
func (s *UserService) PurgeExpiredTokens(ctx context.Context) (int64, error) {
	return s.store.Users.DeleteExpiredTokens(ctx, time.Now())
}

func validateCredentials(username string, password string) error {
	v := validator.New()
	v.Required("username", username)
	v.MaxLen("username", username, 64)
	v.Required("password", password)
	v.MinLen("password", password, minPasswordLength)
	// bcrypt silently ignores everything past 72 bytes, so a longer password
	// is not the password the operator thinks they set.
	v.Check(len(password) <= 72, "password", "must be at most 72 bytes")
	return v.Err()
}
