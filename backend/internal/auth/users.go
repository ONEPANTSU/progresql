package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// User represents a registered user.
type User struct {
	ID               string  `json:"id"`
	Email            string  `json:"email"`
	Name             string  `json:"name"`
	PasswordHash     string  `json:"password_hash,omitempty"`
	CreatedAt        string  `json:"created_at"`
	EmailVerified    bool    `json:"email_verified"`
	Plan             string  `json:"plan,omitempty"`
	PlanExpiresAt    *string `json:"plan_expires_at,omitempty"`
	TrialEndsAt      *string `json:"trial_ends_at,omitempty"`
	MarketingConsent bool    `json:"marketing_consent"`
}

var (
	ErrUserExists           = errors.New("user with this email already exists")
	ErrEmailAlreadyVerified = errors.New("email already registered")
	ErrUserNotFound         = errors.New("user not found")
	ErrInvalidPassword      = errors.New("invalid password")
	ErrInvalidInput         = errors.New("invalid input")
)

// UserStore manages user accounts with PostgreSQL persistence.
type UserStore struct {
	db *pgxpool.Pool
}

// NewUserStore creates a new PostgreSQL-backed UserStore.
func NewUserStore(db *pgxpool.Pool) *UserStore {
	return &UserStore{db: db}
}

// Register creates a new user with the given name, email, and password.
func (s *UserStore) Register(name, email, password string, marketingConsent bool) (*User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	name = strings.TrimSpace(name)

	if email == "" || password == "" {
		return nil, ErrInvalidInput
	}
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hashing password: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Check if user with this email already exists.
	var existing User
	var existingPlanExp, existingTrialEnd *time.Time
	err = s.db.QueryRow(ctx,
		`SELECT id, email, name, password_hash, email_verified, plan, plan_expires_at, trial_ends_at, created_at, marketing_consent
		 FROM users WHERE LOWER(email) = $1`, email).Scan(
		&existing.ID, &existing.Email, &existing.Name, &existing.PasswordHash,
		&existing.EmailVerified, &existing.Plan, &existingPlanExp, &existingTrialEnd, &existing.CreatedAt,
		&existing.MarketingConsent,
	)

	if err == nil {
		// User exists.
		if existing.EmailVerified {
			return nil, ErrEmailAlreadyVerified
		}
		// User exists but email not verified — update credentials.
		_, err = s.db.Exec(ctx,
			`UPDATE users SET name = $1, password_hash = $2, marketing_consent = $3 WHERE id = $4`,
			name, string(hash), marketingConsent, existing.ID)
		if err != nil {
			return nil, fmt.Errorf("updating unverified user: %w", err)
		}
		existing.Name = name
		existing.PasswordHash = string(hash)
		existing.MarketingConsent = marketingConsent
		return &existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("checking existing user: %w", err)
	}

	// New user.
	trialEnd := time.Now().UTC().Add(3 * 24 * time.Hour)
	trialEndStr := trialEnd.Format(time.RFC3339)
	id := uuid.New().String()
	now := time.Now().UTC()

	_, err = s.db.Exec(ctx,
		`INSERT INTO users (id, email, name, password_hash, marketing_consent, trial_ends_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		id, email, name, string(hash), marketingConsent, trialEnd, now)
	if err != nil {
		return nil, fmt.Errorf("inserting user: %w", err)
	}

	return &User{
		ID:               id,
		Email:            email,
		Name:             name,
		CreatedAt:        now.Format(time.RFC3339),
		TrialEndsAt:      &trialEndStr,
		Plan:             "free",
		MarketingConsent: marketingConsent,
	}, nil
}

// Authenticate validates email and password, returning the user on success.
func (s *UserStore) Authenticate(email, password string) (*User, error) {
	email = strings.TrimSpace(strings.ToLower(email))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	user, err := s.queryUser(ctx, `LOWER(email) = $1`, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("querying user: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, ErrInvalidPassword
	}

	return user, nil
}

// GetByID returns a user by ID.
func (s *UserStore) GetByID(id string) (*User, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	user, err := s.queryUser(ctx, `id = $1`, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("querying user: %w", err)
	}
	return user, nil
}

// GetByEmail returns a user by email address.
func (s *UserStore) GetByEmail(email string) (*User, error) {
	email = strings.TrimSpace(strings.ToLower(email))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	user, err := s.queryUser(ctx, `LOWER(email) = $1`, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("querying user: %w", err)
	}
	return user, nil
}

// SetEmailVerified marks the user as email-verified.
func (s *UserStore) SetEmailVerified(userID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tag, err := s.db.Exec(ctx, `UPDATE users SET email_verified = TRUE WHERE id = $1`, userID)
	if err != nil {
		return fmt.Errorf("updating email_verified: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	return nil
}

// SetPlan updates the subscription plan for a user.
func (s *UserStore) SetPlan(userID, plan string, expiresAt *string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var expTime *time.Time
	if expiresAt != nil {
		t, err := time.Parse(time.RFC3339, *expiresAt)
		if err == nil {
			expTime = &t
		}
	}

	tag, err := s.db.Exec(ctx,
		`UPDATE users SET plan = $1, plan_expires_at = $2 WHERE id = $3`,
		plan, expTime, userID)
	if err != nil {
		return fmt.Errorf("updating plan: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	return nil
}

// UpdatePassword changes the password for a user.
func (s *UserStore) UpdatePassword(userID, newPassword string) error {
	if err := ValidatePassword(newPassword); err != nil {
		return err
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hashing password: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	tag, err := s.db.Exec(ctx, `UPDATE users SET password_hash = $1 WHERE id = $2`, string(hash), userID)
	if err != nil {
		return fmt.Errorf("updating password: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	return nil
}

// queryUser scans a single user row with the given WHERE clause.
func (s *UserStore) queryUser(ctx context.Context, where string, args ...any) (*User, error) {
	query := fmt.Sprintf(
		`SELECT id, email, name, password_hash, email_verified, plan, plan_expires_at, trial_ends_at, created_at, marketing_consent
		 FROM users WHERE %s`, where)

	var u User
	var planExpires, trialEnds *time.Time
	var createdAt time.Time

	err := s.db.QueryRow(ctx, query, args...).Scan(
		&u.ID, &u.Email, &u.Name, &u.PasswordHash,
		&u.EmailVerified, &u.Plan, &planExpires, &trialEnds, &createdAt,
		&u.MarketingConsent,
	)
	if err != nil {
		return nil, err
	}

	u.CreatedAt = createdAt.Format(time.RFC3339)
	if planExpires != nil {
		s := planExpires.Format(time.RFC3339)
		u.PlanExpiresAt = &s
	}
	if trialEnds != nil {
		s := trialEnds.Format(time.RFC3339)
		u.TrialEndsAt = &s
	}

	return &u, nil
}

// ValidatePassword checks password complexity requirements:
// at least 8 characters, 1 uppercase, 1 lowercase, 1 digit, 1 special character.
func ValidatePassword(password string) error {
	if len(password) < 8 {
		return fmt.Errorf("%w: password must be at least 8 characters", ErrInvalidInput)
	}

	var hasUpper, hasLower, hasDigit, hasSpecial bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			hasSpecial = true
		}
	}

	var missing []string
	if !hasUpper {
		missing = append(missing, "uppercase letter")
	}
	if !hasLower {
		missing = append(missing, "lowercase letter")
	}
	if !hasDigit {
		missing = append(missing, "digit")
	}
	if !hasSpecial {
		missing = append(missing, "special character")
	}

	if len(missing) > 0 {
		return fmt.Errorf("%w: password must contain at least one %s", ErrInvalidInput, strings.Join(missing, ", "))
	}
	return nil
}

// PasswordStrength returns "weak", "medium", or "strong" based on password characteristics.
func PasswordStrength(password string) string {
	if len(password) < 8 {
		return "weak"
	}

	var hasUpper, hasLower, hasDigit, hasSpecial bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			hasSpecial = true
		}
	}

	score := 0
	if hasUpper {
		score++
	}
	if hasLower {
		score++
	}
	if hasDigit {
		score++
	}
	if hasSpecial {
		score++
	}
	if len(password) >= 12 {
		score++
	}

	switch {
	case score <= 2:
		return "weak"
	case score <= 3:
		return "medium"
	default:
		return "strong"
	}
}
