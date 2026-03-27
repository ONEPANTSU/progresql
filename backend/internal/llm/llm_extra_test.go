/*
* Created on Mar 27, 2026
* Test file for client.go / stream.go / retry.go (extra coverage)
* File path: internal/llm/llm_extra_test.go
*
* Author: Abhijeet Pratap Singh - Senior Software Engineer
* Copyright (c) 2026 Aurigo
*/

package llm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// fastRetryCfg returns a RetryConfig suitable for unit tests — tiny delays so
// tests finish quickly while still exercising the retry loop.
func fastRetryCfg(maxRetries int) RetryConfig {
	return RetryConfig{
		MaxRetries:     maxRetries,
		BaseDelay:      5 * time.Millisecond,
		MaxDelay:       20 * time.Millisecond,
		RequestTimeout: 5 * time.Second,
	}
}

// newObservedLogger returns a zap.Logger whose output is captured in the
// returned *observer.ObservedLogs, useful for asserting log output.
func newObservedLogger() (*zap.Logger, *observer.ObservedLogs) {
	core, logs := observer.New(zapcore.DebugLevel)
	return zap.New(core), logs
}

// ---------------------------------------------------------------------------
// WithLogger option
// ---------------------------------------------------------------------------

// TestWithLogger verifies that the WithLogger option replaces the nop logger
// on the client and that the logger is actually used during a request.
func TestWithLogger(t *testing.T) {
	logger, logs := newObservedLogger()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"id1","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{}}`)
	}))
	defer srv.Close()

	client := NewClient("key", WithBaseURL(srv.URL), WithLogger(logger))

	if client.logger != logger {
		t.Fatal("WithLogger did not set the logger on the client")
	}

	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hello"}},
	})
	if err != nil {
		t.Fatalf("ChatCompletion: %v", err)
	}

	// The logger should have recorded at least one debug entry from ChatCompletion.
	if logs.Len() == 0 {
		t.Error("expected at least one log entry from the observed logger, got zero")
	}
}

// ---------------------------------------------------------------------------
// doRequest error paths
// ---------------------------------------------------------------------------

// errReader is an io.ReadCloser that always returns an error on Read so we can
// simulate a mid-body read failure.
type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }
func (e errReader) Close() error             { return nil }

// mockTransport lets us inject arbitrary http.Response values (including ones
// with broken bodies) without starting an httptest.Server.
type mockTransport struct {
	fn func(*http.Request) (*http.Response, error)
}

func (m *mockTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return m.fn(r)
}

// TestDoRequest_BodyReadError exercises the io.ReadAll failure branch inside
// doRequest (line: "llm: read response: ...").
func TestDoRequest_BodyReadError(t *testing.T) {
	readErr := errors.New("simulated read error")

	transport := &mockTransport{fn: func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       errReader{err: readErr},
		}, nil
	}}

	client := NewClient("key",
		WithBaseURL("http://fake-host"),
		WithHTTPClient(&http.Client{Transport: transport}),
		WithRetryConfig(fastRetryCfg(0)),
	)

	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "test"}},
	})

	if err == nil {
		t.Fatal("expected error from body read failure, got nil")
	}
	if !strings.Contains(err.Error(), "read response") {
		t.Errorf("expected 'read response' in error, got: %v", err)
	}
}

// TestDoRequest_JSONUnmarshalError exercises the json.Unmarshal failure branch
// inside doRequest (line: "llm: unmarshal response: ...").
func TestDoRequest_JSONUnmarshalError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Valid HTTP 200 but body is not a valid ChatResponse JSON.
		w.Write([]byte(`this is not json`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(0)),
	)

	_, err := client.ChatCompletion(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "test"}},
	})

	if err == nil {
		t.Fatal("expected unmarshal error, got nil")
	}
	if !strings.Contains(err.Error(), "unmarshal response") {
		t.Errorf("expected 'unmarshal response' in error, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// callbackError.Unwrap
// ---------------------------------------------------------------------------

// TestCallbackError_Unwrap verifies that the private callbackError type
// properly implements Unwrap so errors.Is/As work through the wrapper.
func TestCallbackError_Unwrap(t *testing.T) {
	sentinel := errors.New("sentinel")
	ce := &callbackError{err: sentinel}

	if ce.Unwrap() != sentinel {
		t.Errorf("Unwrap() = %v, want %v", ce.Unwrap(), sentinel)
	}

	if !errors.Is(ce, sentinel) {
		t.Error("errors.Is should find the wrapped sentinel through callbackError")
	}

	if ce.Error() != sentinel.Error() {
		t.Errorf("Error() = %q, want %q", ce.Error(), sentinel.Error())
	}
}

// ---------------------------------------------------------------------------
// Streaming retry after 429
// ---------------------------------------------------------------------------

// TestChatCompletionStream_Retry429ThenSuccess verifies that a 429 during a
// stream attempt triggers a retry and ultimately succeeds.
func TestChatCompletionStream_Retry429ThenSuccess(t *testing.T) {
	var attempts int32

	sseBody := sseResponse(
		`{"id":"chatcmpl-r","model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			// First attempt: 429 rate-limit response
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":{"message":"rate limited"}}`))
			return
		}
		// Second attempt: successful SSE stream
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(3)),
	)

	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err != nil {
		t.Fatalf("expected success after retry, got: %v", err)
	}
	if resp.Choices[0].Message.Content != "ok" {
		t.Errorf("content = %q, want 'ok'", resp.Choices[0].Message.Content)
	}
	if n := atomic.LoadInt32(&attempts); n != 2 {
		t.Errorf("attempts = %d, want 2", n)
	}
}

// TestChatCompletionStream_Retry500Exhausted verifies that exhausting all
// retries on 5xx during streaming surfaces a "max retries exceeded" error.
func TestChatCompletionStream_Retry500Exhausted(t *testing.T) {
	var attempts int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"server down"}}`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(2)),
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error after retries exhausted, got nil")
	}
	if !strings.Contains(err.Error(), "max retries") {
		t.Errorf("expected 'max retries' in error, got: %v", err)
	}
	// 1 initial + 2 retries = 3 total attempts
	if n := atomic.LoadInt32(&attempts); n != 3 {
		t.Errorf("attempts = %d, want 3", n)
	}
}

// TestChatCompletionStream_NoRetryOn400 confirms non-retryable 4xx responses
// are returned immediately without retrying.
func TestChatCompletionStream_NoRetryOn400(t *testing.T) {
	var attempts int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"bad input"}}`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(3)),
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error for 400, got nil")
	}
	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != 400 {
		t.Errorf("status = %d, want 400", apiErr.StatusCode)
	}
	if n := atomic.LoadInt32(&attempts); n != 1 {
		t.Errorf("attempts = %d, want 1 (no retry on 400)", n)
	}
}

// TestChatCompletionStream_ContextCanceledDuringRetry verifies that a context
// cancellation fires during the backoff wait and stops further retry attempts.
func TestChatCompletionStream_ContextCanceledDuringRetry(t *testing.T) {
	var attempts int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	// Context deadline shorter than the retry delay so it fires mid-backoff.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     10,
			BaseDelay:      500 * time.Millisecond,
			MaxDelay:       2 * time.Second,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletionStream(ctx, ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error from context cancellation, got nil")
	}
	// Should have stopped well before exhausting 10 retries.
	if n := atomic.LoadInt32(&attempts); n > 3 {
		t.Errorf("attempts = %d, expected <= 3 (context should have cancelled)", n)
	}
}

// ---------------------------------------------------------------------------
// Network error during streaming (connection dropped mid-stream)
// ---------------------------------------------------------------------------

// TestChatCompletionStream_NetworkError tests the path where the HTTP Do call
// itself fails (e.g. connection refused / DNS failure).
func TestChatCompletionStream_NetworkError(t *testing.T) {
	// Point client at a port nothing is listening on.
	client := NewClient("key",
		WithBaseURL("http://127.0.0.1:1"), // port 1 is always refused
		WithRetryConfig(fastRetryCfg(0)),
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "test",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected network error, got nil")
	}
	if !strings.Contains(err.Error(), "send request") {
		t.Errorf("expected 'send request' in error, got: %v", err)
	}
}

// TestChatCompletionStream_MidStreamDisconnect simulates a server that closes
// the connection after sending partial SSE data, exercising the scanner path
// that ends without [DONE].  The stream should complete without error (partial
// content is returned).
func TestChatCompletionStream_MidStreamDisconnect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		// Send one valid chunk then close abruptly (no [DONE]).
		fmt.Fprint(w, "data: {\"id\":\"x\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n")
		// Hijack and close to cut the connection without a clean TCP FIN.
		hj, ok := w.(http.Hijacker)
		if !ok {
			// Fallback: just return; the scanner will still EOF gracefully.
			return
		}
		conn, _, _ := hj.Hijack()
		conn.Close()
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(0)),
	)

	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	// A graceful EOF after partial data is acceptable — either no error or
	// a read-stream error.  What matters is we don't panic and the partial
	// content is preserved when there is no error.
	if err == nil {
		if resp.Choices[0].Message.Content != "partial" {
			t.Errorf("content = %q, want 'partial'", resp.Choices[0].Message.Content)
		}
	}
	// If err != nil it should mention the stream read.
	if err != nil && !strings.Contains(err.Error(), "read SSE stream") {
		t.Errorf("unexpected error: %v", err)
	}
}

// ---------------------------------------------------------------------------
// SSE parser edge cases
// ---------------------------------------------------------------------------

// TestParseSSEStream_BadJSONChunk verifies that a malformed JSON data line is
// silently skipped (logged at debug level) and parsing continues.
func TestParseSSEStream_BadJSONChunk(t *testing.T) {
	raw := "" +
		"data: NOT_JSON\n\n" +
		"data: {\"id\":\"ok\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: [DONE]\n\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(raw))
	}))
	defer srv.Close()

	var callbackCalled int
	client := NewClient("key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, func(chunk StreamChunk) error {
		callbackCalled++
		return nil
	})

	if err != nil {
		t.Fatalf("expected no error for bad JSON chunk, got: %v", err)
	}
	// Only the valid chunk should have triggered the callback.
	if callbackCalled != 1 {
		t.Errorf("callback called %d times, want 1", callbackCalled)
	}
	if resp.Choices[0].Message.Content != "hello" {
		t.Errorf("content = %q, want 'hello'", resp.Choices[0].Message.Content)
	}
}

// TestParseSSEStream_NonDataLines verifies that lines that are not "data: ..."
// (e.g. "event: ...", blank lines) are ignored.
func TestParseSSEStream_NonDataLines(t *testing.T) {
	raw := "" +
		"event: message\n" +
		"retry: 3000\n" +
		"\n" +
		"data: {\"id\":\"id2\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: [DONE]\n\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(raw))
	}))
	defer srv.Close()

	client := NewClient("key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Choices[0].Message.Content != "x" {
		t.Errorf("content = %q, want 'x'", resp.Choices[0].Message.Content)
	}
}

// TestParseSSEStream_ScannerError injects a reader that returns an error
// mid-stream to hit the scanner.Err() path.
func TestParseSSEStream_ScannerError(t *testing.T) {
	scanErr := errors.New("injected scanner error")

	// errorAfterReader streams valid bytes then returns an error on the next
	// Read call so bufio.Scanner.Err() returns a non-nil value.
	type errorAfterReader struct {
		data []byte
		pos  int
		done bool
	}
	r := &errorAfterReader{
		data: []byte("data: {\"id\":\"e\",\"model\":\"m\",\"choices\":[]}\n\n"),
	}
	readFn := func(p []byte) (int, error) {
		if r.done {
			return 0, scanErr
		}
		n := copy(p, r.data[r.pos:])
		r.pos += n
		if r.pos >= len(r.data) {
			r.done = true
		}
		return n, nil
	}

	client := NewClient("key")
	reader := readerFunc(readFn)
	_, err := client.parseSSEStream(reader, nil)

	if err == nil {
		t.Fatal("expected scanner error, got nil")
	}
	if !strings.Contains(err.Error(), "read SSE stream") {
		t.Errorf("expected 'read SSE stream' in error, got: %v", err)
	}
	if !errors.Is(err, scanErr) {
		t.Errorf("expected wrapped scanErr, got: %v", err)
	}
}

// readerFunc adapts a function to the io.Reader interface.
type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// ---------------------------------------------------------------------------
// Tool call accumulation edge cases
// ---------------------------------------------------------------------------

// TestChatCompletionStream_ToolCallMetaUpdate verifies that subsequent chunks
// can update the ID, Type and function name of an already-seen tool call index.
func TestChatCompletionStream_ToolCallMetaUpdate(t *testing.T) {
	// First chunk creates the tool call entry with empty id/type.
	// Second chunk fills in the real id and type.
	sseBody := sseResponse(
		// Initial chunk: name set, id/type empty
		`{"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"do_thing","arguments":""}}]}}]}`,
		// Follow-up: id and type update, plus partial args
		`{"id":"c","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_99","type":"function","function":{"name":"","arguments":"{}"}}]}}]}`,
		// Finish
		`{"id":"c","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	tc := resp.Choices[0].Message.ToolCalls
	if len(tc) != 1 {
		t.Fatalf("tool_calls len = %d, want 1", len(tc))
	}
	if tc[0].ID != "call_99" {
		t.Errorf("id = %q, want 'call_99'", tc[0].ID)
	}
	if tc[0].Type != "function" {
		t.Errorf("type = %q, want 'function'", tc[0].Type)
	}
	if tc[0].Function.Name != "do_thing" {
		t.Errorf("name = %q, want 'do_thing'", tc[0].Function.Name)
	}
	if tc[0].Function.Arguments != "{}" {
		t.Errorf("args = %q, want '{}'", tc[0].Function.Arguments)
	}
}

// ---------------------------------------------------------------------------
// Callback abort propagated without retry
// ---------------------------------------------------------------------------

// TestChatCompletionStream_CallbackAbortNoRetry confirms that when a callback
// returns an error during streaming, the error is wrapped in callbackError and
// returned immediately without any retry attempt.
func TestChatCompletionStream_CallbackAbortNoRetry(t *testing.T) {
	var attempts int32

	sseBody := sseResponse(
		`{"id":"ab","model":"m","choices":[{"index":0,"delta":{"content":"first"},"finish_reason":null}]}`,
		`{"id":"ab","model":"m","choices":[{"index":0,"delta":{"content":"second"},"finish_reason":"stop"}]}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	abortErr := errors.New("client abort")

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(3)), // retries enabled, but callback abort must not retry
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, func(chunk StreamChunk) error {
		return abortErr
	})

	if err == nil {
		t.Fatal("expected error from callback abort, got nil")
	}
	if !errors.Is(err, abortErr) {
		t.Errorf("expected wrapped abortErr, got: %v", err)
	}
	// Must NOT retry on callback error.
	if n := atomic.LoadInt32(&attempts); n != 1 {
		t.Errorf("attempts = %d, want 1 (no retry for callback abort)", n)
	}
}

// ---------------------------------------------------------------------------
// doStreamRequest network error path
// ---------------------------------------------------------------------------

// TestDoStreamRequest_NetworkError confirms that a transport-level failure
// during a streaming request surfaces as "send request" error.
func TestDoStreamRequest_NetworkError(t *testing.T) {
	netErr := &net.OpError{Op: "dial", Err: errors.New("connection refused")}
	transport := &mockTransport{fn: func(r *http.Request) (*http.Response, error) {
		return nil, netErr
	}}

	client := NewClient("key",
		WithBaseURL("http://fake"),
		WithHTTPClient(&http.Client{Transport: transport}),
		WithRetryConfig(fastRetryCfg(0)),
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error from network failure, got nil")
	}
	if !strings.Contains(err.Error(), "send request") {
		t.Errorf("expected 'send request' in error, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Usage captured from streaming last chunk
// ---------------------------------------------------------------------------

// TestChatCompletionStream_UsageFromLastChunk verifies that usage data present
// in the last SSE chunk is captured in the aggregated response.
func TestChatCompletionStream_UsageFromLastChunk(t *testing.T) {
	sseBody := sseResponse(
		`{"id":"u","model":"m","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}`,
		`{"id":"u","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}`,
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(sseBody))
	}))
	defer srv.Close()

	client := NewClient("key", WithBaseURL(srv.URL))
	resp, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err != nil {
		t.Fatalf("ChatCompletionStream: %v", err)
	}
	if resp.Usage.PromptTokens != 7 {
		t.Errorf("prompt_tokens = %d, want 7", resp.Usage.PromptTokens)
	}
	if resp.Usage.CompletionTokens != 3 {
		t.Errorf("completion_tokens = %d, want 3", resp.Usage.CompletionTokens)
	}
	if resp.Usage.TotalTokens != 10 {
		t.Errorf("total_tokens = %d, want 10", resp.Usage.TotalTokens)
	}
}

// ---------------------------------------------------------------------------
// isCallbackError helper
// ---------------------------------------------------------------------------

// TestIsCallbackError confirms the helper correctly identifies callbackErrors
// and ignores plain errors.
func TestIsCallbackError(t *testing.T) {
	ce := &callbackError{err: errors.New("inner")}
	if !isCallbackError(ce) {
		t.Error("isCallbackError should return true for *callbackError")
	}

	plain := errors.New("plain")
	if isCallbackError(plain) {
		t.Error("isCallbackError should return false for a plain error")
	}
}

// ---------------------------------------------------------------------------
// ChatCompletion context canceled after first attempt (covers the
// ctx.Err() != nil branch in ChatCompletion)
// ---------------------------------------------------------------------------

// TestChatCompletion_ContextCanceledAfterAttempt exercises the branch where the
// context is canceled between a retryable error response and the next backoff
// wait, specifically the ctx.Err() check inside the retry loop body.
func TestChatCompletion_ContextCanceledAfterAttempt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			// Cancel context just before responding with a retryable error.
			cancel()
		}
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"err"}}`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     5,
			BaseDelay:      0,
			MaxDelay:       0,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletion(ctx, ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	})

	if err == nil {
		t.Fatal("expected context error, got nil")
	}
}

// TestChatCompletionStream_ContextCanceledAfterAttempt mirrors the above for
// the streaming path.
func TestChatCompletionStream_ContextCanceledAfterAttempt(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	var attempts int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&attempts, 1)
		if n == 1 {
			cancel()
		}
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"message":"err"}}`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(RetryConfig{
			MaxRetries:     5,
			BaseDelay:      0,
			MaxDelay:       0,
			RequestTimeout: 5 * time.Second,
		}),
	)

	_, err := client.ChatCompletionStream(ctx, ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected context error, got nil")
	}
}

// ---------------------------------------------------------------------------
// io.ReadAll body error for streaming (buf.ReadFrom silently ignores errors,
// so we target the doRequest path only; here we add an extra sanity check that
// the APIError body is populated from the error response).
// ---------------------------------------------------------------------------

// TestChatCompletionStream_APIError403 confirms that a non-retryable 4xx error
// is immediately returned from the stream path with the correct status code.
func TestChatCompletionStream_APIError403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":{"message":"forbidden"}}`))
	}))
	defer srv.Close()

	client := NewClient("key",
		WithBaseURL(srv.URL),
		WithRetryConfig(fastRetryCfg(3)),
	)

	_, err := client.ChatCompletionStream(context.Background(), ChatRequest{
		Model:    "m",
		Messages: []Message{{Role: "user", Content: "hi"}},
	}, nil)

	if err == nil {
		t.Fatal("expected error for 403, got nil")
	}
	apiErr, ok := IsAPIError(err)
	if !ok {
		t.Fatalf("expected APIError, got %T: %v", err, err)
	}
	if apiErr.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", apiErr.StatusCode)
	}
}

// ---------------------------------------------------------------------------
// Ensure io import is used (errReader needs io.Reader and io.Closer)
// ---------------------------------------------------------------------------
var _ io.ReadCloser = errReader{}
