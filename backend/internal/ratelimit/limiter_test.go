package ratelimit

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestAllow_UnderLimit(t *testing.T) {
	limiter := New(5, time.Minute)
	for i := 0; i < 5; i++ {
		if err := limiter.Allow("session-1"); err != nil {
			t.Fatalf("request %d should be allowed: %v", i+1, err)
		}
	}
}

func TestAllow_ExceedsLimit(t *testing.T) {
	limiter := New(3, time.Minute)
	for i := 0; i < 3; i++ {
		if err := limiter.Allow("session-1"); err != nil {
			t.Fatalf("request %d should be allowed: %v", i+1, err)
		}
	}
	err := limiter.Allow("session-1")
	if err == nil {
		t.Fatal("4th request should be rate limited")
	}
	if !IsRateLimited(err) {
		t.Fatalf("expected RateLimitedError, got: %T", err)
	}
	rle := err.(*RateLimitedError)
	if rle.Limit != 3 {
		t.Errorf("expected limit 3, got %d", rle.Limit)
	}
	if rle.SessionID != "session-1" {
		t.Errorf("expected session-1, got %s", rle.SessionID)
	}
	if rle.RetryAfter <= 0 {
		t.Errorf("expected positive RetryAfter, got %s", rle.RetryAfter)
	}
}

func TestAllow_SeparateSessions(t *testing.T) {
	limiter := New(2, time.Minute)
	// Fill session-1
	for i := 0; i < 2; i++ {
		limiter.Allow("session-1")
	}
	// session-2 should still be allowed
	if err := limiter.Allow("session-2"); err != nil {
		t.Fatalf("session-2 should be allowed: %v", err)
	}
	// session-1 should be blocked
	if err := limiter.Allow("session-1"); err == nil {
		t.Fatal("session-1 should be rate limited")
	}
}

func TestAllow_WindowExpiry(t *testing.T) {
	limiter := New(2, 50*time.Millisecond)
	limiter.Allow("s1")
	limiter.Allow("s1")

	// Should be rate limited now.
	if err := limiter.Allow("s1"); err == nil {
		t.Fatal("should be rate limited")
	}

	// Wait for window to expire.
	time.Sleep(60 * time.Millisecond)

	// Should be allowed again.
	if err := limiter.Allow("s1"); err != nil {
		t.Fatalf("should be allowed after window: %v", err)
	}
}

func TestCleanup(t *testing.T) {
	limiter := New(10, 50*time.Millisecond)
	limiter.Allow("s1")
	limiter.Allow("s2")
	limiter.Allow("s3")

	time.Sleep(60 * time.Millisecond)
	limiter.Cleanup()

	limiter.mu.Lock()
	remaining := len(limiter.sessions)
	limiter.mu.Unlock()

	if remaining != 0 {
		t.Errorf("expected 0 sessions after cleanup, got %d", remaining)
	}
}

func TestIsRateLimited_Nil(t *testing.T) {
	if IsRateLimited(nil) {
		t.Error("nil error should not be rate limited")
	}
}

func TestIsRateLimited_WrappedError(t *testing.T) {
	inner := &RateLimitedError{SessionID: "s1", Limit: 10, Window: time.Minute}
	wrapped := fmt.Errorf("pipeline error: %w", inner)
	if !IsRateLimited(wrapped) {
		t.Error("wrapped RateLimitedError should be detected")
	}
}

func TestIsRateLimited_OtherError(t *testing.T) {
	if IsRateLimited(fmt.Errorf("some other error")) {
		t.Error("non-rate-limit error should return false")
	}
}

func TestRateLimitedError_Message(t *testing.T) {
	err := &RateLimitedError{
		SessionID:  "abc",
		Limit:      10,
		Window:     time.Minute,
		RetryAfter: 30 * time.Second,
	}
	msg := err.Error()
	if msg == "" {
		t.Error("error message should not be empty")
	}
}

func TestAllow_Concurrent(t *testing.T) {
	limiter := New(100, time.Minute)
	var wg sync.WaitGroup
	errors := make([]error, 200)

	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			errors[idx] = limiter.Allow("concurrent-session")
		}(i)
	}
	wg.Wait()

	allowed := 0
	blocked := 0
	for _, err := range errors {
		if err == nil {
			allowed++
		} else {
			blocked++
		}
	}

	if allowed != 100 {
		t.Errorf("expected exactly 100 allowed requests, got %d", allowed)
	}
	if blocked != 100 {
		t.Errorf("expected exactly 100 blocked requests, got %d", blocked)
	}
}
