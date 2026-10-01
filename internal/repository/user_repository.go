package repository

import (
	"context"
	"time"

	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"

	"gorm.io/gorm"
)

// UserRepository persists panel operators and the API tokens they own. Tokens
// live here rather than in a repository of their own because they are never
// reached except through their owner.
type UserRepository struct {
	db *gorm.DB
}

func (r *UserRepository) Count(ctx context.Context) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&domain.User{}).Count(&count).Error
	return count, err
}

func (r *UserRepository) Create(ctx context.Context, user *domain.User) error {
	return r.db.WithContext(ctx).Create(user).Error
}

func (r *UserRepository) Save(ctx context.Context, user *domain.User) error {
	return r.db.WithContext(ctx).Save(user).Error
}

// First returns the oldest account, which is the one the CLI operates on when
// no username is given.
func (r *UserRepository) First(ctx context.Context) (*domain.User, error) {
	var user domain.User
	err := r.db.WithContext(ctx).Order("id ASC").First(&user).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("no user account exists")
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) FindById(ctx context.Context, id uint) (*domain.User, error) {
	var user domain.User
	err := r.db.WithContext(ctx).First(&user, id).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("user %d", id)
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) FindByUsername(ctx context.Context, username string) (*domain.User, error) {
	var user domain.User
	err := r.db.WithContext(ctx).Where("username = ?", username).First(&user).Error
	if database.IsNotFound(err) {
		return nil, domain.NotFoundf("user %q", username)
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// List returns every account without its password hash. The column is excluded
// in the query as well as in the JSON tag: a hash that never leaves the
// database cannot be leaked by a later change to how users are serialised.
//
// The two-factor secret is read, because an account's JSON says whether it has
// one, and hidden by its JSON tag as the hash is.
func (r *UserRepository) List(ctx context.Context) ([]domain.User, error) {
	var users []domain.User
	err := r.db.WithContext(ctx).
		Model(&domain.User{}).
		Select("id", "username", "totp_secret", "last_sign_in", "created_at").
		Order("id ASC").
		Find(&users).Error
	if err != nil {
		return nil, err
	}
	return users, nil
}

// UpdateCredentials rewrites one account's username and password hash.
func (r *UserRepository) UpdateCredentials(ctx context.Context, id uint, username string, passwordHash string) error {
	return r.db.WithContext(ctx).
		Model(&domain.User{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{"username": username, "password": passwordHash}).Error
}

// UpdatePassword rewrites one account's password hash, leaving the username.
func (r *UserRepository) UpdatePassword(ctx context.Context, id uint, passwordHash string) error {
	return r.db.WithContext(ctx).
		Model(&domain.User{}).
		Where("id = ?", id).
		Update("password", passwordHash).Error
}

// SetTotpSecret sets or clears the secret an account's two-factor codes are
// checked against. Empty turns two-factor authentication off.
func (r *UserRepository) SetTotpSecret(ctx context.Context, id uint, secret string) error {
	return r.db.WithContext(ctx).
		Model(&domain.User{}).
		Where("id = ?", id).
		Update("totp_secret", secret).Error
}

// SetLastSignIn records a successful sign-in.
func (r *UserRepository) SetLastSignIn(ctx context.Context, id uint, entry string) error {
	return r.db.WithContext(ctx).
		Model(&domain.User{}).
		Where("id = ?", id).
		Update("last_sign_in", entry).Error
}

func (r *UserRepository) CreateToken(ctx context.Context, token *domain.Token) error {
	return r.db.WithContext(ctx).Create(token).Error
}

// ListValidTokens returns every unexpired token with its owner's username, for
// the in-memory table the token middleware checks against.
func (r *UserRepository) ListValidTokens(ctx context.Context, now time.Time) ([]domain.Token, error) {
	var tokens []domain.Token
	err := r.db.WithContext(ctx).
		Preload("User").
		Where("expiry = 0 OR expiry > ?", now.Unix()).
		Find(&tokens).Error
	if err != nil {
		return nil, err
	}
	return tokens, nil
}

// ListTokensByUser returns one operator's tokens with the secret masked. The
// value is shown exactly once, when it is created: storing it is unavoidable,
// handing it back out on every page load is not.
func (r *UserRepository) ListTokensByUser(ctx context.Context, userId uint) ([]domain.Token, error) {
	var tokens []domain.Token
	err := r.db.WithContext(ctx).
		Model(&domain.Token{}).
		Select("id", "description", "'****' AS token", "expiry", "user_id", "created_at").
		Where("user_id = ?", userId).
		Order("id ASC").
		Find(&tokens).Error
	if err != nil {
		return nil, err
	}
	return tokens, nil
}

// DeleteToken removes one of an operator's own tokens.
//
// The owner is part of the WHERE clause, not checked beforehand: with the id
// alone, any authenticated operator could revoke anyone else's tokens by
// counting upwards.
func (r *UserRepository) DeleteToken(ctx context.Context, id uint, userId uint) error {
	res := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, userId).
		Delete(&domain.Token{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return domain.NotFoundf("token %d", id)
	}
	return nil
}

// DeleteExpiredTokens drops tokens nothing can authenticate with any more.
func (r *UserRepository) DeleteExpiredTokens(ctx context.Context, now time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Where("expiry > 0 AND expiry < ?", now.Unix()).
		Delete(&domain.Token{})
	return res.RowsAffected, res.Error
}
