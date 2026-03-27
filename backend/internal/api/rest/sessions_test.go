package rest

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

func TestCreateSessionHandler_ValidJWT(t *testing.T) {
	hub := websocket.NewHub()
	handler := createSessionHandler(hub, "8080", nil)

	body, _ := json.Marshal(createSessionRequest{
		Model: "gpt-4",
		DBContext: dbContext{
			DBName:    "testdb",
			DBVersion: "15.2",
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Host = "localhost:8080"

	// Add claims to context (simulating auth middleware)
	claims := &auth.Claims{SessionID: "auth-session-123"}
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp createSessionResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	// session_id must be a valid UUID
	if _, err := uuid.Parse(resp.SessionID); err != nil {
		t.Errorf("session_id is not a valid UUID: %q", resp.SessionID)
	}

	// ws_url must contain the session_id
	expectedWSURL := "ws://localhost:8080/ws/" + resp.SessionID
	if resp.WSURL != expectedWSURL {
		t.Errorf("expected ws_url %q, got %q", expectedWSURL, resp.WSURL)
	}

	// Session must be registered in hub
	conn := hub.Get(resp.SessionID)
	if conn == nil {
		t.Error("expected session to be registered in hub")
	}
	if conn != nil && conn.SessionID() != resp.SessionID {
		t.Errorf("hub session_id mismatch: %q vs %q", conn.SessionID(), resp.SessionID)
	}
}

func TestCreateSessionHandler_NoJWT(t *testing.T) {
	hub := websocket.NewHub()
	handler := createSessionHandler(hub, "8080", nil)

	body, _ := json.Marshal(createSessionRequest{Model: "gpt-4"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(body))
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestCreateSessionHandler_InvalidBody(t *testing.T) {
	hub := websocket.NewHub()
	handler := createSessionHandler(hub, "8080", nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader([]byte("not json")))
	claims := &auth.Claims{SessionID: "auth-session-123"}
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestCreateSessionHandler_SessionRegisteredInHub(t *testing.T) {
	hub := websocket.NewHub()
	handler := createSessionHandler(hub, "9090", nil)

	if hub.Len() != 0 {
		t.Fatalf("expected hub to be empty, got %d", hub.Len())
	}

	body, _ := json.Marshal(createSessionRequest{
		Model:     "claude-3",
		DBContext: dbContext{DBName: "mydb", DBVersion: "16.0"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", bytes.NewReader(body))
	claims := &auth.Claims{SessionID: "auth-session-456"}
	ctx := context.WithValue(req.Context(), auth.ClaimsContextKey, claims)
	req = req.WithContext(ctx)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d", rec.Code)
	}

	if hub.Len() != 1 {
		t.Errorf("expected 1 session in hub, got %d", hub.Len())
	}
}
