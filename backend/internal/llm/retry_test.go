package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestChatCompletion_Retry429ThenSuccess(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":{"message":"rate limited"}}`))
			return
		}
		resp := ChatResponse{
			ID:    "chatcmpl-retry",
			Model: "test-model",
			Choices: []Choice{{
				Message:      Message{Role: "assistant", Content: "success after retry"},
				FinishReason: "stop",
			}},
			Usage: Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     3,
			BaseDelay:      10 * time.Millisecond,
			MaxDelay:       50 * time.Millisecond,
			RequestTimeout: 5 * time.Second,
		}),
	)

	resp, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err != nil {
		t.Fatalf("expected success after retry, got: %v", err)
	}
	if resp.Choices[0].Message.Content != "success after retry" {
		t.Errorf("content = %s", resp.Choices[0].Message.Content)
	}
	if atomic.LoadInt32(&attempts) != 3 {
		t.Errorf("attempts = %d, want 3", atomic.LoadInt32(&attempts))
	}
}

func TestChatCompletion_Retry500Exhausted(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"internal error"}}`))
	}))
	defer srv.Close()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     3,
			BaseDelay:      10 * time.Millisecond,
			MaxDelay:       50 * time.Millisecond,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err == nil {
		t.Fatal("expected error after retries exhausted")
	}

	// Should have made 4 attempts: 1 initial + 3 retries
	if n := atomic.LoadInt32(&attempts); n != 4 {
		t.Errorf("attempts = %d, want 4", n)
	}

	// Error should mention max retries
	if apiErr, ok := IsAPIError(err); ok {
		// The wrapped error should still be an API error
		_ = apiErr
	}
}

func TestChatCompletion_NoRetryOn400(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"bad request"}}`))
	}))
	defer srv.Close()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     3,
			BaseDelay:      10 * time.Millisecond,
			MaxDelay:       50 * time.Millisecond,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err == nil {
		t.Fatal("expected error for 400")
	}

	// Should NOT retry on 400
	if n := atomic.LoadInt32(&attempts); n != 1 {
		t.Errorf("attempts = %d, want 1 (no retry for 400)", n)
	}

	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != 400 {
		t.Errorf("status = %d, want 400", apiErr.StatusCode)
	}
}

func TestChatCompletion_RequestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate slow response — sleep longer than request timeout
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(ChatResponse{
			ID:    "late",
			Model: "test",
			Choices: []Choice{{
				Message:      Message{Role: "assistant", Content: "too late"},
				FinishReason: "stop",
			}},
		})
	}))
	defer srv.Close()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithHTTPClient(&http.Client{}), // No client-level timeout
		WithRetryConfig(RetryConfig{
			MaxRetries:     0, // No retries — fail immediately
			BaseDelay:      10 * time.Millisecond,
			MaxDelay:       50 * time.Millisecond,
			RequestTimeout: 200 * time.Millisecond,
		}),
	)

	start := time.Now()
	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected timeout error")
	}

	// Should timeout around 200ms, not wait the full 2s
	if elapsed > 1*time.Second {
		t.Errorf("elapsed = %v, expected < 1s (request timeout should have fired at 200ms)", elapsed)
	}
}

func TestChatCompletion_ContextCanceledDuringRetry(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     10,
			BaseDelay:      500 * time.Millisecond, // Long enough to trigger context cancel
			MaxDelay:       2 * time.Second,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletion(ctx, ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err == nil {
		t.Fatal("expected error from context cancelation")
	}

	// Should have stopped early, not exhausted all retries
	if n := atomic.LoadInt32(&attempts); n > 3 {
		t.Errorf("attempts = %d, expected ≤ 3 (context should cancel)", n)
	}
}

func TestChatCompletion_Retry502ThenSuccess(t *testing.T) {
	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"error":{"message":"bad gateway"}}`))
			return
		}
		resp := ChatResponse{
			ID:    "chatcmpl-502",
			Model: "test-model",
			Choices: []Choice{{
				Message:      Message{Role: "assistant", Content: "recovered"},
				FinishReason: "stop",
			}},
			Usage: Usage{PromptTokens: 5, CompletionTokens: 3, TotalTokens: 8},
		}
		json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	client := NewClient("test-key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     3,
			BaseDelay:      10 * time.Millisecond,
			MaxDelay:       50 * time.Millisecond,
			RequestTimeout: 5 * time.Second,
		}),
	)

	resp, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "test-model",
		Messages: []Message{{Role: "user", Content: "test"}},
	})
	if err != nil {
		t.Fatalf("expected success after 502 retry, got: %v", err)
	}
	if resp.Choices[0].Message.Content != "recovered" {
		t.Errorf("content = %s", resp.Choices[0].Message.Content)
	}
	if n := atomic.LoadInt32(&attempts); n != 2 {
		t.Errorf("attempts = %d, want 2", n)
	}
}

func TestRetryConfig_Defaults(t *testing.T) {
	cfg := DefaultRetryConfig()
	if cfg.MaxRetries != 3 {
		t.Errorf("MaxRetries = %d, want 3", cfg.MaxRetries)
	}
	if cfg.BaseDelay != 1*time.Second {
		t.Errorf("BaseDelay = %v, want 1s", cfg.BaseDelay)
	}
	if cfg.MaxDelay != 10*time.Second {
		t.Errorf("MaxDelay = %v, want 10s", cfg.MaxDelay)
	}
	if cfg.RequestTimeout != 30*time.Second {
		t.Errorf("RequestTimeout = %v, want 30s", cfg.RequestTimeout)
	}
}

func TestIsRetryableStatus(t *testing.T) {
	tests := []struct {
		code int
		want bool
	}{
		{200, false},
		{400, false},
		{401, false},
		{403, false},
		{404, false},
		{429, true},
		{500, true},
		{502, true},
		{503, true},
	}
	for _, tc := range tests {
		if got := isRetryableStatus(tc.code); got != tc.want {
			t.Errorf("isRetryableStatus(%d) = %v, want %v", tc.code, got, tc.want)
		}
	}
}

func TestBackoff_ExponentialWithCap(t *testing.T) {
	cfg := RetryConfig{
		BaseDelay: 100 * time.Millisecond,
		MaxDelay:  1 * time.Second,
	}

	// Run many samples to verify bounds
	for attempt := 0; attempt < 5; attempt++ {
		for i := 0; i < 100; i++ {
			d := backoff(attempt, cfg)
			maxExpected := float64(cfg.BaseDelay) * float64(uint(1)<<uint(attempt))
			if maxExpected > float64(cfg.MaxDelay) {
				maxExpected = float64(cfg.MaxDelay)
			}
			if d < 0 || d > time.Duration(maxExpected) {
				t.Errorf("attempt %d: backoff = %v, expected [0, %v]", attempt, d, time.Duration(maxExpected))
			}
		}
	}
}

func TestWithMaxRetries(t *testing.T) {
	client := NewClient("key", WithMaxRetries(5))
	if client.retryCfg.MaxRetries != 5 {
		t.Errorf("MaxRetries = %d, want 5", client.retryCfg.MaxRetries)
	}
}
