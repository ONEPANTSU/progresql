package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/onepantsu/progressql/backend/internal/api/rest"
	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/logger"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

func TestServerStartsAndServesHealth(t *testing.T) {
	cfg := &config.Config{
		ServerPort:  "18080",
		LogLevel:    "info",
		Environment: "development",
		Version:     "0.1.0-test",
	}

	log, err := logger.Init(cfg.LogLevel, cfg.Environment)
	if err != nil {
		t.Fatalf("failed to init logger: %v", err)
	}

	hub := websocket.NewHub()
	userStore, _ := auth.NewUserStore("")
	router := rest.NewRouter(cfg, log, hub, userStore, nil)

	srv := &http.Server{
		Addr:    ":" + cfg.ServerPort,
		Handler: router,
	}

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			t.Errorf("server failed: %v", err)
		}
	}()
	defer srv.Close()

	// Wait for server to start
	time.Sleep(200 * time.Millisecond)

	// Test 1: Health endpoint returns 200
	resp, err := http.Get("http://localhost:18080/api/v1/health")
	if err != nil {
		t.Fatalf("failed to GET /api/v1/health: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	// Verify JSON body contains status and version
	var body struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode health response: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", body.Status)
	}
	if body.Version != "0.1.0-test" {
		t.Errorf("expected version '0.1.0-test', got %q", body.Version)
	}

	// Test 2: Root returns some response (even 404)
	resp2, err := http.Get("http://localhost:18080/")
	if err != nil {
		t.Fatalf("failed to GET /: %v", err)
	}
	defer resp2.Body.Close()

	if resp2.StatusCode == 0 {
		t.Error("expected non-zero status code for root")
	}
	t.Logf("Root status: %d (any response is fine)", resp2.StatusCode)
}
