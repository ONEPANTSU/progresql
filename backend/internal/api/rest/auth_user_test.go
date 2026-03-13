package rest

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	websocketpkg "github.com/onepantsu/progressql/backend/internal/websocket"
)

func authTestRouter(t *testing.T) (http.Handler, *auth.UserStore) {
	t.Helper()
	cfg := &config.Config{
		ServerPort: "0",
		JWTSecret:  "test-secret",
	}
	hub := websocketpkg.NewHub()
	store := auth.NewUserStore(nil)
	router := NewRouter(cfg, zap.NewNop(), hub, store, nil)
	return router, store
}

func TestAuth_RegisterAndLogin(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register
	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("register: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	if regResp.Token == "" {
		t.Error("register: expected non-empty token")
	}
	if regResp.User.Email != "alice@example.com" {
		t.Errorf("register: expected email alice@example.com, got %s", regResp.User.Email)
	}
	if regResp.User.Name != "Alice" {
		t.Errorf("register: expected name Alice, got %s", regResp.User.Name)
	}
	if regResp.User.ID == "" {
		t.Error("register: expected non-empty user ID")
	}

	// Login with same credentials
	body = `{"email":"alice@example.com","password":"P@ssw0rd123"}`
	req = httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("login: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var loginResp authUserResponse
	json.NewDecoder(w.Body).Decode(&loginResp)

	if loginResp.Token == "" {
		t.Error("login: expected non-empty token")
	}
	if loginResp.User.Email != "alice@example.com" {
		t.Errorf("login: expected email alice@example.com, got %s", loginResp.User.Email)
	}
}

func TestAuth_RegisterDuplicate_Unverified(t *testing.T) {
	router, _ := authTestRouter(t)

	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`

	// First register
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d", w.Code)
	}

	// Re-register with unverified email should succeed (201).
	req = httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("unverified re-register: expected 201, got %d", w.Code)
	}
}

func TestAuth_RegisterDuplicate_Verified(t *testing.T) {
	router, store := authTestRouter(t)

	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`

	// Register
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("first register: expected 201, got %d", w.Code)
	}

	// Mark email as verified.
	user, err := store.GetByEmail("alice@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetEmailVerified(user.ID); err != nil {
		t.Fatal(err)
	}

	// Re-register with verified email should return 409.
	req = httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("verified re-register: expected 409, got %d", w.Code)
	}
}

func TestAuth_LoginWrongPassword(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register first
	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	// Login with wrong password
	body = `{"email":"alice@example.com","password":"wrongpassword"}`
	req = httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewBufferString(body))
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAuth_LoginNonexistentUser(t *testing.T) {
	router, _ := authTestRouter(t)

	body := `{"email":"nobody@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/login", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAuth_Profile(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register to get a token
	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	// Fetch profile
	req = httptest.NewRequest("GET", "/api/v1/auth/profile", nil)
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("profile: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var profile userInfo
	json.NewDecoder(w.Body).Decode(&profile)

	if profile.Email != "alice@example.com" {
		t.Errorf("expected email alice@example.com, got %s", profile.Email)
	}
	if profile.Name != "Alice" {
		t.Errorf("expected name Alice, got %s", profile.Name)
	}
}

func TestAuth_ProfileUnauthorized(t *testing.T) {
	router, _ := authTestRouter(t)

	req := httptest.NewRequest("GET", "/api/v1/auth/profile", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestAuth_RegisterInvalidBody(t *testing.T) {
	router, _ := authTestRouter(t)

	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString("not json"))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAuth_RegisterShortPassword(t *testing.T) {
	router, _ := authTestRouter(t)

	body := `{"name":"Alice","email":"alice@example.com","password":"12345"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAuth_RegisterWeakPassword(t *testing.T) {
	router, _ := authTestRouter(t)

	// No uppercase, no special char
	body := `{"name":"Alice","email":"alice@example.com","password":"password1"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for weak password, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAuth_TokenFromRegisterWorksForSessions(t *testing.T) {
	router, _ := authTestRouter(t)

	// Register
	body := `{"name":"Alice","email":"alice@example.com","password":"P@ssw0rd123"}`
	req := httptest.NewRequest("POST", "/api/v1/auth/register", bytes.NewBufferString(body))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var regResp authUserResponse
	json.NewDecoder(w.Body).Decode(&regResp)

	// Use token to create session
	sessBody := `{"model":"test-model","db_context":{"db_name":"test","db_version":"16"}}`
	req = httptest.NewRequest("POST", "/api/v1/sessions", bytes.NewBufferString(sessBody))
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("session creation: expected 201, got %d: %s", w.Code, w.Body.String())
	}
}
