package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"go.uber.org/zap"
)

// StreamCallback is called for each delta chunk received from the SSE stream.
// Return a non-nil error to abort streaming.
type StreamCallback func(chunk StreamChunk) error

// callbackError wraps an error returned by a StreamCallback.
type callbackError struct{ err error }

func (e *callbackError) Error() string { return e.err.Error() }
func (e *callbackError) Unwrap() error { return e.err }

func isCallbackError(err error) bool {
	var ce *callbackError
	return errors.As(err, &ce)
}

// ChatCompletionStream sends a streaming chat completion request.
// It parses the SSE stream and calls onChunk for each delta chunk.
// The final aggregated ChatResponse is returned after the stream completes.
func (c *Client) ChatCompletionStream(ctx context.Context, req ChatRequest, onChunk StreamCallback) (*ChatResponse, error) {
	req.Stream = true

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("llm: marshal request: %w", err)
	}

	c.logger.Debug("sending streaming chat completion",
		zap.String("model", req.Model),
		zap.Int("messages", len(req.Messages)),
	)

	var lastErr error
	for attempt := 0; attempt <= c.retryCfg.MaxRetries; attempt++ {
		if attempt > 0 {
			delay := backoff(attempt-1, c.retryCfg)
			c.logger.Debug("retrying streaming request",
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
			)
			select {
			case <-ctx.Done():
				return nil, fmt.Errorf("llm: %w", ctx.Err())
			case <-time.After(delay):
			}
		}

		resp, err := c.doStreamRequest(ctx, body, onChunk)
		if err == nil {
			return resp, nil
		}

		// Callback errors are client-side aborts — don't retry
		if isCallbackError(err) {
			return nil, err
		}

		if apiErr, ok := IsAPIError(err); ok && !isRetryableStatus(apiErr.StatusCode) {
			return nil, err
		}

		if ctx.Err() != nil {
			return nil, fmt.Errorf("llm: %w", ctx.Err())
		}

		lastErr = err
		c.logger.Debug("retryable streaming error",
			zap.Int("attempt", attempt),
			zap.Error(err),
		)
	}

	return nil, fmt.Errorf("llm: max retries (%d) exceeded: %w", c.retryCfg.MaxRetries, lastErr)
}

// doStreamRequest performs a single streaming HTTP request.
func (c *Client) doStreamRequest(ctx context.Context, body []byte, onChunk StreamCallback) (*ChatResponse, error) {
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

	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		buf.ReadFrom(resp.Body)
		return nil, &APIError{
			StatusCode: resp.StatusCode,
			Body:       buf.String(),
		}
	}

	return c.parseSSEStream(resp.Body, onChunk)
}

// parseSSEStream reads an SSE stream and calls onChunk for each data event.
// It aggregates content and tool_calls across chunks and returns a final ChatResponse.
func (c *Client) parseSSEStream(r io.Reader, onChunk StreamCallback) (*ChatResponse, error) {
	scanner := bufio.NewScanner(r)

	var (
		contentBuilder strings.Builder
		allToolCalls   []ToolCall
		model          string
		responseID     string
		finishReason   string
		usage          *Usage
	)

	// toolCallAccumulator maps tool call index to accumulated arguments
	toolCallArgs := make(map[int]*strings.Builder)
	toolCallMeta := make(map[int]ToolCall) // stores id, type, function.name

	for scanner.Scan() {
		line := scanner.Text()

		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}

		// SSE format: "data: {...}" or "data: [DONE]"
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")

		// Handle [DONE] marker
		if data == "[DONE]" {
			break
		}

		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			c.logger.Debug("skipping unparseable SSE chunk", zap.String("data", data), zap.Error(err))
			continue
		}

		// Capture metadata from first chunk
		if responseID == "" && chunk.ID != "" {
			responseID = chunk.ID
		}
		if model == "" && chunk.Model != "" {
			model = chunk.Model
		}

		// Capture usage if present (usually in the last chunk)
		if chunk.Usage != nil {
			usage = chunk.Usage
		}

		// Accumulate content and tool calls from choices
		for _, choice := range chunk.Choices {
			if choice.Delta.Content != "" {
				contentBuilder.WriteString(choice.Delta.Content)
			}

			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finishReason = *choice.FinishReason
			}

			// Accumulate tool calls by index
			for _, tc := range choice.Delta.ToolCalls {
				idx := tc.Index
				if _, exists := toolCallArgs[idx]; !exists {
					toolCallArgs[idx] = &strings.Builder{}
					toolCallMeta[idx] = ToolCall{
						ID:   tc.ID,
						Type: tc.Type,
						Function: FunctionCall{
							Name: tc.Function.Name,
						},
					}
				} else {
					// Update metadata if provided in subsequent chunks
					if tc.ID != "" {
						meta := toolCallMeta[idx]
						meta.ID = tc.ID
						toolCallMeta[idx] = meta
					}
					if tc.Type != "" {
						meta := toolCallMeta[idx]
						meta.Type = tc.Type
						toolCallMeta[idx] = meta
					}
					if tc.Function.Name != "" {
						meta := toolCallMeta[idx]
						meta.Function.Name = tc.Function.Name
						toolCallMeta[idx] = meta
					}
				}
				toolCallArgs[idx].WriteString(tc.Function.Arguments)
			}
		}

		// Call user's callback
		if onChunk != nil {
			if err := onChunk(chunk); err != nil {
				return nil, &callbackError{err: err}
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("llm: read SSE stream: %w", err)
	}

	// Build aggregated tool calls
	for idx := 0; idx < len(toolCallArgs); idx++ {
		args, ok := toolCallArgs[idx]
		if !ok {
			continue
		}
		meta := toolCallMeta[idx]
		meta.Function.Arguments = args.String()
		allToolCalls = append(allToolCalls, meta)
	}

	// Build aggregated response
	aggregated := &ChatResponse{
		ID:    responseID,
		Model: model,
		Choices: []Choice{{
			Index: 0,
			Message: Message{
				Role:      "assistant",
				Content:   contentBuilder.String(),
				ToolCalls: allToolCalls,
			},
			FinishReason: finishReason,
		}},
	}

	if usage != nil {
		aggregated.Usage = *usage
	}

	c.logger.Debug("streaming complete",
		zap.String("model", model),
		zap.Int("content_length", contentBuilder.Len()),
		zap.Int("tool_calls", len(allToolCalls)),
	)

	return aggregated, nil
}
