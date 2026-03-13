package ratelimit

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Limiter tracks request counts per session within a sliding window.
type Limiter struct {
	maxRequests int
	window      time.Duration

	mu       sync.Mutex
	sessions map[string][]time.Time
}

// New creates a Limiter that allows maxRequests per window duration per session.
func New(maxRequests int, window time.Duration) *Limiter {
	return &Limiter{
		maxRequests: maxRequests,
		window:      window,
		sessions:    make(map[string][]time.Time),
	}
}

// Allow checks whether a request from the given sessionID is allowed.
// If allowed, it records the request and returns nil.
// If rate-limited, it returns a *RateLimitedError.
func (l *Limiter) Allow(sessionID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-l.window)

	// Prune expired timestamps.
	timestamps := l.sessions[sessionID]
	start := 0
	for start < len(timestamps) && timestamps[start].Before(cutoff) {
		start++
	}
	timestamps = timestamps[start:]

	if len(timestamps) >= l.maxRequests {
		retryAfter := timestamps[0].Add(l.window).Sub(now)
		l.sessions[sessionID] = timestamps
		return &RateLimitedError{
			SessionID:  sessionID,
			Limit:      l.maxRequests,
			Window:     l.window,
			RetryAfter: retryAfter,
		}
	}

	l.sessions[sessionID] = append(timestamps, now)
	return nil
}

// Cleanup removes expired entries for all sessions. Call periodically to prevent memory leaks.
func (l *Limiter) Cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := time.Now().Add(-l.window)
	for sid, timestamps := range l.sessions {
		start := 0
		for start < len(timestamps) && timestamps[start].Before(cutoff) {
			start++
		}
		if start == len(timestamps) {
			delete(l.sessions, sid)
		} else {
			l.sessions[sid] = timestamps[start:]
		}
	}
}

// RateLimitedError is returned when a session exceeds the rate limit.
type RateLimitedError struct {
	SessionID  string
	Limit      int
	Window     time.Duration
	RetryAfter time.Duration
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("rate limited: session %s exceeded %d requests per %s (retry after %s)",
		e.SessionID, e.Limit, e.Window, e.RetryAfter.Truncate(time.Second))
}

// IsRateLimited checks whether err is a *RateLimitedError (supports wrapped errors).
func IsRateLimited(err error) bool {
	var rle *RateLimitedError
	return errors.As(err, &rle)
}
