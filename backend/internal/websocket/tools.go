package websocket

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

const (
	// DefaultToolCallTimeout is the default maximum time to wait for a tool.result response.
	DefaultToolCallTimeout = 15 * time.Second
)

// ToolDispatcher sends tool.call messages and awaits tool.result responses.
type ToolDispatcher struct {
	session    *Session
	timeout    time.Duration
	maxRetries int
	logger     *zap.Logger
}

// NewToolDispatcher creates a ToolDispatcher bound to the given session.
// Uses DefaultToolCallTimeout and 1 retry by default.
func NewToolDispatcher(session *Session) *ToolDispatcher {
	return &ToolDispatcher{
		session:    session,
		timeout:    DefaultToolCallTimeout,
		maxRetries: 1,
		logger:     zap.NewNop(),
	}
}

// WithTimeout sets the timeout for tool calls.
func (d *ToolDispatcher) WithTimeout(t time.Duration) *ToolDispatcher {
	d.timeout = t
	return d
}

// WithMaxRetries sets the number of automatic retries on timeout (0 = no retry).
func (d *ToolDispatcher) WithMaxRetries(n int) *ToolDispatcher {
	d.maxRetries = n
	return d
}

// WithLogger sets the logger for timeout/retry logging.
func (d *ToolDispatcher) WithLogger(l *zap.Logger) *ToolDispatcher {
	if l != nil {
		d.logger = l
	}
	return d
}

// ToolCallResult holds the outcome of a dispatched tool call.
type ToolCallResult struct {
	CallID  string
	Success bool
	Data    json.RawMessage
	Error   string
}

// Dispatch sends a tool.call to the client and waits for the corresponding tool.result.
// It retries automatically on timeout up to maxRetries times.
// The requestID is propagated on the envelope for tracing.
func (d *ToolDispatcher) Dispatch(requestID, toolName string, arguments json.RawMessage) (*ToolCallResult, error) {
	var lastErr error

	for attempt := 0; attempt <= d.maxRetries; attempt++ {
		if attempt > 0 {
			d.logger.Warn("retrying tool.call after timeout",
				zap.String("tool_name", toolName),
				zap.Int("attempt", attempt+1),
				zap.Int("max_attempts", d.maxRetries+1),
				zap.Duration("timeout", d.timeout),
			)
		}

		result, err := d.dispatchOnce(requestID, toolName, arguments)
		if err == nil {
			return result, nil
		}

		if !IsToolTimeout(err) {
			// Non-timeout errors are not retryable.
			return nil, err
		}

		d.logger.Warn("tool.call timed out",
			zap.String("tool_name", toolName),
			zap.Int("attempt", attempt+1),
			zap.Duration("timeout", d.timeout),
		)
		lastErr = err
	}

	return nil, lastErr
}

// dispatchOnce sends a single tool.call and waits for the result with timeout.
func (d *ToolDispatcher) dispatchOnce(requestID, toolName string, arguments json.RawMessage) (*ToolCallResult, error) {
	callID := uuid.New().String()

	payload := ToolCallPayload{
		ToolName:  toolName,
		Arguments: arguments,
	}

	env, err := NewEnvelopeWithID(TypeToolCall, requestID, callID, payload)
	if err != nil {
		return nil, fmt.Errorf("marshal tool.call: %w", err)
	}

	// Register waiter before sending to avoid race where result arrives before registration.
	ch := d.session.RegisterToolWaiter(callID)
	defer d.session.UnregisterToolWaiter(callID)

	if err := d.session.SendEnvelope(env); err != nil {
		return nil, fmt.Errorf("send tool.call: %w", err)
	}

	timer := time.NewTimer(d.timeout)
	defer timer.Stop()

	select {
	case result, ok := <-ch:
		if !ok {
			// Channel closed — session shut down.
			return nil, fmt.Errorf("session closed while waiting for tool.result")
		}
		var resultPayload ToolResultPayload
		if err := result.DecodePayload(&resultPayload); err != nil {
			return nil, fmt.Errorf("decode tool.result payload: %w", err)
		}
		return &ToolCallResult{
			CallID:  callID,
			Success: resultPayload.Success,
			Data:    resultPayload.Data,
			Error:   resultPayload.Error,
		}, nil

	case <-timer.C:
		return nil, &ToolTimeoutError{CallID: callID, ToolName: toolName, Timeout: d.timeout}

	case <-d.session.done:
		return nil, fmt.Errorf("session closed while waiting for tool.result")
	}
}

// ToolTimeoutError is returned when a tool.result is not received within the timeout.
type ToolTimeoutError struct {
	CallID   string
	ToolName string
	Timeout  time.Duration
}

func (e *ToolTimeoutError) Error() string {
	return fmt.Sprintf("tool.call %s (%s) timed out after %s", e.CallID, e.ToolName, e.Timeout)
}

// IsToolTimeout checks whether an error is a ToolTimeoutError (supports wrapped errors).
func IsToolTimeout(err error) bool {
	var te *ToolTimeoutError
	return errors.As(err, &te)
}
