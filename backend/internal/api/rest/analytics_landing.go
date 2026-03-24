package rest

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// landingEventRequest represents an analytics event from the landing page.
type landingEventRequest struct {
	Event         string `json:"event"`
	Page          string `json:"page"`
	Referrer      string `json:"referrer"`
	UTMSource     string `json:"utm_source"`
	UTMMedium     string `json:"utm_medium"`
	UTMCampaign   string `json:"utm_campaign"`
	ButtonID      string `json:"button_id"`
	ScrollPercent *int   `json:"scroll_percent"`
	VideoAction   string `json:"video_action"`
	ScreenWidth   *int   `json:"screen_width"`
	UserAgent     string `json:"user_agent"`
	SessionID     string `json:"session_id"`
}

// landingRateLimiter provides simple in-memory per-IP rate limiting.
type landingRateLimiter struct {
	mu      sync.Mutex
	counts  map[string]*ipCounter
	limit   int
	window  time.Duration
	lastGC  time.Time
}

type ipCounter struct {
	count    int
	windowStart time.Time
}

func newLandingRateLimiter(limit int, window time.Duration) *landingRateLimiter {
	return &landingRateLimiter{
		counts: make(map[string]*ipCounter),
		limit:  limit,
		window: window,
		lastGC: time.Now(),
	}
}

// allow returns true if the IP has not exceeded the rate limit.
func (rl *landingRateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	// Garbage-collect stale entries every 5 minutes.
	if now.Sub(rl.lastGC) > 5*time.Minute {
		for k, v := range rl.counts {
			if now.Sub(v.windowStart) > rl.window {
				delete(rl.counts, k)
			}
		}
		rl.lastGC = now
	}

	entry, ok := rl.counts[ip]
	if !ok || now.Sub(entry.windowStart) > rl.window {
		rl.counts[ip] = &ipCounter{count: 1, windowStart: now}
		return true
	}

	entry.count++
	return entry.count <= rl.limit
}

// knownSessions tracks unique session IDs to increment LandingUniqueSessions only once.
var knownSessions = struct {
	mu   sync.Mutex
	seen map[string]struct{}
}{seen: make(map[string]struct{})}

// validEvents is the set of allowed event types.
var validEvents = map[string]bool{
	"page_view":    true,
	"button_click": true,
	"scroll_depth": true,
	"video_play":   true,
}

// extractReferrerDomain extracts the hostname from a referrer URL.
func extractReferrerDomain(ref string) string {
	if ref == "" {
		return "direct"
	}
	u, err := url.Parse(ref)
	if err != nil || u.Host == "" {
		return "unknown"
	}
	return u.Host
}

// extractCountry extracts a country/language hint from the Accept-Language header.
func extractCountry(header string) string {
	if header == "" {
		return "unknown"
	}
	// Accept-Language: en-US,en;q=0.9,ru;q=0.8
	// Take the first language tag.
	parts := strings.SplitN(header, ",", 2)
	tag := strings.TrimSpace(parts[0])
	// Extract region if present (e.g., en-US -> US).
	if idx := strings.IndexByte(tag, '-'); idx != -1 {
		return strings.ToUpper(tag[idx+1:])
	}
	// Fallback to language code.
	if idx := strings.IndexByte(tag, ';'); idx != -1 {
		tag = tag[:idx]
	}
	return strings.ToLower(strings.TrimSpace(tag))
}

// clientIP extracts the client IP from X-Forwarded-For or RemoteAddr.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	if xri := r.Header.Get("X-Real-Ip"); xri != "" {
		return strings.TrimSpace(xri)
	}
	// RemoteAddr is host:port.
	host := r.RemoteAddr
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}
	return host
}

// hashIP produces a SHA-256 hash of the IP for privacy-safe storage.
func hashIP(ip string) string {
	h := sha256.Sum256([]byte(ip))
	return fmt.Sprintf("%x", h)
}

// analyticsLandingEventHandler returns a handler for POST /api/v1/analytics/event.
func analyticsLandingEventHandler(db *pgxpool.Pool) http.HandlerFunc {
	rl := newLandingRateLimiter(100, time.Minute)

	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)

		// Rate limit check.
		if !rl.allow(ip) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		var req landingEventRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Validate event type.
		if !validEvents[req.Event] {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		// Fill user_agent from header if not provided in body.
		if req.UserAgent == "" {
			req.UserAgent = r.Header.Get("User-Agent")
		}

		country := extractCountry(r.Header.Get("Accept-Language"))
		referrerDomain := extractReferrerDomain(req.Referrer)
		ipHash := hashIP(ip)

		// Track unique sessions.
		if req.SessionID != "" {
			knownSessions.mu.Lock()
			if _, exists := knownSessions.seen[req.SessionID]; !exists {
				knownSessions.seen[req.SessionID] = struct{}{}
				metrics.LandingUniqueSessions.Inc()
			}
			knownSessions.mu.Unlock()
		}

		// Increment Prometheus metrics based on event type.
		switch req.Event {
		case "page_view":
			metrics.LandingPageViews.WithLabelValues(referrerDomain, req.UTMSource, country).Inc()
		case "button_click":
			buttonID := req.ButtonID
			if buttonID == "" {
				buttonID = "unknown"
			}
			metrics.LandingButtonClicks.WithLabelValues(buttonID).Inc()
			// Track download clicks by platform.
			switch buttonID {
			case "download-mac":
				metrics.LandingDownloads.WithLabelValues("mac").Inc()
			case "download-windows":
				metrics.LandingDownloads.WithLabelValues("windows").Inc()
			case "download-linux":
				metrics.LandingDownloads.WithLabelValues("linux").Inc()
			}
		case "scroll_depth":
			pct := 0
			if req.ScrollPercent != nil {
				pct = *req.ScrollPercent
			}
			metrics.LandingScrollDepth.WithLabelValues(strconv.Itoa(pct)).Inc()
		case "video_play":
			action := req.VideoAction
			if action == "" {
				action = "play"
			}
			metrics.LandingVideoEvents.WithLabelValues(action).Inc()
		}

		// Store in PostgreSQL (async — fire and forget to keep latency low).
		if db != nil {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()

				var scrollPct *int
				if req.ScrollPercent != nil {
					scrollPct = req.ScrollPercent
				}
				var screenW *int
				if req.ScreenWidth != nil {
					screenW = req.ScreenWidth
				}

				_, _ = db.Exec(ctx, `
					INSERT INTO landing_events
						(event_type, session_id, referrer, referrer_domain, utm_source, utm_medium, utm_campaign,
						 country, button_id, scroll_percent, video_action, screen_width, user_agent, ip_hash)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
					req.Event, req.SessionID, req.Referrer, referrerDomain, req.UTMSource, req.UTMMedium, req.UTMCampaign,
					country, req.ButtonID, scrollPct, req.VideoAction, screenW, req.UserAgent, ipHash,
				)
			}()
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
