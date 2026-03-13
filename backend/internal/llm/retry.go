package llm

import (
	"math"
	"math/rand"
	"time"
)

const (
	defaultMaxRetries  = 3
	defaultBaseDelay   = 1 * time.Second
	defaultMaxDelay    = 10 * time.Second
	defaultRequestTimeout = 30 * time.Second
)

// RetryConfig controls retry behavior for LLM requests.
type RetryConfig struct {
	MaxRetries     int
	BaseDelay      time.Duration
	MaxDelay       time.Duration
	RequestTimeout time.Duration
}

// DefaultRetryConfig returns the default retry configuration.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxRetries:     defaultMaxRetries,
		BaseDelay:      defaultBaseDelay,
		MaxDelay:       defaultMaxDelay,
		RequestTimeout: defaultRequestTimeout,
	}
}

// WithRetryConfig sets the retry configuration for the client.
func WithRetryConfig(cfg RetryConfig) Option {
	return func(c *Client) { c.retryCfg = cfg }
}

// WithMaxRetries sets the maximum number of retries (convenience option).
func WithMaxRetries(n int) Option {
	return func(c *Client) { c.retryCfg.MaxRetries = n }
}

// isRetryableStatus returns true if the HTTP status code is retryable.
func isRetryableStatus(statusCode int) bool {
	return statusCode == 429 || statusCode >= 500
}

// backoff calculates the delay for the given attempt using exponential backoff with jitter.
// attempt is 0-indexed.
func backoff(attempt int, cfg RetryConfig) time.Duration {
	delay := float64(cfg.BaseDelay) * math.Pow(2, float64(attempt))
	if delay > float64(cfg.MaxDelay) {
		delay = float64(cfg.MaxDelay)
	}
	// Add jitter: random value in [0, delay)
	jitter := rand.Float64() * delay
	return time.Duration(jitter)
}
