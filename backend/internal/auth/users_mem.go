package auth

import (
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// memUser is the in-memory representation of a user (includes mutable fields).
type memUser struct {
	User
	passwordHash string
}

// memStore is a thread-safe in-memory user store used when no DB is configured.
type memStore struct {
	mu    sync.RWMutex
	byID  map[string]*memUser
	byEmail map[string]*memUser
}

func newMemStore() *memStore {
	return &memStore{
		byID:    make(map[string]*memUser),
		byEmail: make(map[string]*memUser),
	}
}

func (m *memStore) register(name, email, password string, marketingConsent bool) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.byEmail[email]; ok {
		if existing.EmailVerified {
			return nil, ErrEmailAlreadyVerified
		}
		// Update unverified user.
		existing.Name = name
		existing.passwordHash = string(hash)
		existing.MarketingConsent = marketingConsent
		u := existing.User
		return &u, nil
	}

	trialEnd := time.Now().UTC().Add(3 * 24 * time.Hour)
	trialEndStr := trialEnd.Format(time.RFC3339)
	id := uuid.New().String()
	now := time.Now().UTC().Format(time.RFC3339)

	mu := &memUser{
		User: User{
			ID:               id,
			Email:            email,
			Name:             name,
			CreatedAt:        now,
			Plan:             "free",
			TrialEndsAt:      &trialEndStr,
			MarketingConsent: marketingConsent,
		},
		passwordHash: string(hash),
	}
	m.byID[id] = mu
	m.byEmail[email] = mu

	u := mu.User
	return &u, nil
}

func (m *memStore) authenticate(email, password string) (*User, error) {
	m.mu.RLock()
	mu, ok := m.byEmail[email]
	m.mu.RUnlock()

	if !ok {
		return nil, ErrUserNotFound
	}
	if err := bcrypt.CompareHashAndPassword([]byte(mu.passwordHash), []byte(password)); err != nil {
		return nil, ErrInvalidPassword
	}
	u := mu.User
	return &u, nil
}

func (m *memStore) getByID(id string) (*User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	mu, ok := m.byID[id]
	if !ok {
		return nil, ErrUserNotFound
	}
	u := mu.User
	return &u, nil
}

func (m *memStore) getByEmail(email string) (*User, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	mu, ok := m.byEmail[email]
	if !ok {
		return nil, ErrUserNotFound
	}
	u := mu.User
	return &u, nil
}

func (m *memStore) setEmailVerified(userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mu, ok := m.byID[userID]
	if !ok {
		return ErrUserNotFound
	}
	mu.EmailVerified = true
	return nil
}

func (m *memStore) setPlan(userID, plan string, expiresAt *string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mu, ok := m.byID[userID]
	if !ok {
		return ErrUserNotFound
	}
	mu.Plan = plan
	mu.PlanExpiresAt = expiresAt
	return nil
}

func (m *memStore) updatePassword(userID, newPassword string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.MinCost)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	mu, ok := m.byID[userID]
	if !ok {
		return ErrUserNotFound
	}
	mu.passwordHash = string(hash)
	return nil
}

// ── UserStore in-memory dispatch ─────────────────────────────────────────────

// NewInMemoryUserStore creates a UserStore backed by an in-memory map.
// Intended for tests only.
func NewInMemoryUserStore() *UserStore {
	return &UserStore{mem: newMemStore()}
}

func (s *UserStore) usingMem() bool { return s.mem != nil }

// ── Updated methods (dispatch to mem when db == nil) ─────────────────────────

func (s *UserStore) registerMem(name, email, password string, marketingConsent bool) (*User, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	name = strings.TrimSpace(name)
	if email == "" || password == "" {
		return nil, ErrInvalidInput
	}
	if err := ValidatePassword(password); err != nil {
		return nil, err
	}
	return s.mem.register(name, email, password, marketingConsent)
}
