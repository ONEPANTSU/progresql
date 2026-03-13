package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/tools"
)

const (
	defaultBaseURL = "https://openrouter.ai/api/v1"
	defaultTimeout = 30 * time.Second
)

// Client communicates with the OpenRouter API (OpenAI-compatible format).
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	logger     *zap.Logger
	retryCfg   RetryConfig
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL overrides the default OpenRouter base URL.
func WithBaseURL(url string) Option {
	return func(c *Client) { c.baseURL = url }
}

// WithHTTPClient sets a custom http.Client (useful for testing).
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) { c.httpClient = hc }
}

// WithLogger sets the logger for the client.
func WithLogger(l *zap.Logger) Option {
	return func(c *Client) { c.logger = l }
}

// NewClient creates a new OpenRouter API client.
func NewClient(apiKey string, opts ...Option) *Client {
	c := &Client{
		apiKey:  apiKey,
		baseURL: defaultBaseURL,
		httpClient: &http.Client{
			Timeout: defaultTimeout,
		},
		logger:   zap.NewNop(),
		retryCfg: DefaultRetryConfig(),
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// ChatCompletion sends a chat completion request and returns the parsed response.
// It retries on 429 (rate limit) and 5xx errors with exponential backoff and jitter.
// Each individual attempt is bounded by the configured RequestTimeout.
func (c *Client) ChatCompletion(ctx context.Context, req ChatRequest) (*ChatResponse, error) {
	req.Stream = false

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("llm: marshal request: %w", err)
	}

	c.logger.Debug("sending chat completion",
		zap.String("model", req.Model),
		zap.Int("messages", len(req.Messages)),
		zap.Int("tools", len(req.Tools)),
	)

	var lastErr error
	for attempt := 0; attempt <= c.retryCfg.MaxRetries; attempt++ {
		if attempt > 0 {
			delay := backoff(attempt-1, c.retryCfg)
			c.logger.Debug("retrying chat completion",
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
			)
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("llm: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		resp, err := c.doRequest(ctx, body)
		if err == nil {
			return resp, nil
		}

		// Non-retryable API error (4xx except 429) — return immediately
		if apiErr, ok := IsAPIError(err); ok && !isRetryableStatus(apiErr.StatusCode) {
			return nil, err
		}

		// Context canceled/deadline — don't retry
		if ctx.Err() != nil {
			return nil, fmt.Errorf("llm: %w", ctx.Err())
		}

		lastErr = err
		c.logger.Debug("retryable error",
			zap.Int("attempt", attempt),
			zap.Error(err),
		)
	}

	return nil, fmt.Errorf("llm: max retries (%d) exceeded: %w", c.retryCfg.MaxRetries, lastErr)
}

// doRequest performs a single HTTP request with per-request timeout.
func (c *Client) doRequest(ctx context.Context, body []byte) (*ChatResponse, error) {
	reqCtx, cancel := context.WithTimeout(ctx, c.retryCfg.RequestTimeout)
	defer cancel()

	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("llm: create request: %w", err)
	}
	c.setHeaders(httpReq)

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("llm: send request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("llm: read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, &APIError{
			StatusCode: resp.StatusCode,
			Body:       string(respBody),
		}
	}

	var chatResp ChatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return nil, fmt.Errorf("llm: unmarshal response: %w", err)
	}

	c.logger.Debug("chat completion received",
		zap.String("model", chatResp.Model),
		zap.Int("prompt_tokens", chatResp.Usage.PromptTokens),
		zap.Int("completion_tokens", chatResp.Usage.CompletionTokens),
	)

	return &chatResp, nil
}

// ToolsFromRegistry converts tools.ToolDefinition entries to the OpenAI function calling format.
func ToolsFromRegistry(defs []tools.ToolDefinition) []ToolDefinition {
	out := make([]ToolDefinition, len(defs))
	for i, d := range defs {
		out[i] = ToolDefinition{
			Type: "function",
			Function: FunctionSchema{
				Name:        d.Name,
				Description: d.Description,
				Parameters:  d.Parameters,
			},
		}
	}
	return out
}

func (c *Client) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
}

// APIError is returned when the API responds with a non-200 status code.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("llm: API error %d: %s", e.StatusCode, e.Body)
}

// IsAPIError checks whether err is an *APIError and returns it.
func IsAPIError(err error) (*APIError, bool) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr, true
	}
	return nil, false
}
