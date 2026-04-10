package websocket

import "encoding/json"

// Message type constants for WebSocket protocol routing.
const (
	TypeAgentRequest  = "agent.request"
	TypeAgentCancel   = "agent.cancel"
	TypeToolResult    = "tool.result"
	TypeToolCall      = "tool.call"
	TypeAgentStream   = "agent.stream"
	TypeAgentResponse = "agent.response"
	TypeAgentError    = "agent.error"

	TypeAutocompleteRequest  = "autocomplete.request"
	TypeAutocompleteResponse = "autocomplete.response"

	// Quota and billing notification types.
	TypeQuotaWarning   = "quota.warning"
	TypeQuotaExhausted = "quota.exhausted"
	TypeModelFallback  = "model.fallback"
	TypeBalanceLow     = "balance.low"
)

// Envelope is the common wrapper for all WebSocket messages.
// The Type field is used for routing/dispatching.
type Envelope struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id,omitempty"`
	CallID    string          `json:"call_id,omitempty"`
	Payload   json.RawMessage `json:"payload"`
}

// --- Client -> Backend ---

// AgentRequestPayload is sent by the client to request an agent action.
type AgentRequestPayload struct {
	Action      string               `json:"action"`
	UserMessage string               `json:"user_message,omitempty"`
	Model       string               `json:"model,omitempty"` // per-request model override from client
	Context     *AgentRequestContext  `json:"context,omitempty"`
}

// AgentRequestContext provides optional context for an agent request.
type AgentRequestContext struct {
	SelectedSQL      string  `json:"selected_sql,omitempty"`
	ActiveTable      string  `json:"active_table,omitempty"`
	UserDescriptions string  `json:"user_descriptions,omitempty"`
	SafeMode         *bool   `json:"safe_mode,omitempty"`     // deprecated, kept for backward compat
	SecurityMode     *string `json:"security_mode,omitempty"` // "safe", "data", "execute"
	Language         string  `json:"language,omitempty"`       // "ru" or "en"
	ConnectionID     string  `json:"connection_id,omitempty"`  // which saved connection to use
	Database         string  `json:"database,omitempty"`       // selected database name
}

// ToolResultPayload is the client's response to a tool.call.
type ToolResultPayload struct {
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// AutocompleteRequestPayload is sent by the client to request SQL autocomplete suggestions.
type AutocompleteRequestPayload struct {
	SQL           string `json:"sql"`
	CursorPos     int    `json:"cursor_position"`
	SchemaContext string `json:"schema_context"`
	Model         string `json:"model,omitempty"` // optional: override autocomplete model (must be budget tier)
}

// AutocompleteResponsePayload carries the autocomplete suggestion back to the client.
type AutocompleteResponsePayload struct {
	Completion string `json:"completion"`
}

// --- Backend -> Client ---

// ToolCallPayload requests the client to execute a tool.
type ToolCallPayload struct {
	ToolName  string          `json:"tool_name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// AgentStreamPayload carries a streaming delta chunk from the LLM.
type AgentStreamPayload struct {
	Delta string `json:"delta"`
}

// AgentResponsePayload is the final response from the agent.
type AgentResponsePayload struct {
	Action       string             `json:"action"`
	Result       AgentResult        `json:"result"`
	ToolCallsLog []ToolCallLogEntry `json:"tool_calls_log,omitempty"`
	ModelUsed    string             `json:"model_used,omitempty"`
	TokensUsed   int                `json:"tokens_used,omitempty"`

	// Cost/quota info (populated when quota system is active).
	ModelTier    string  `json:"model_tier,omitempty"`
	CostUSD      float64 `json:"cost_usd,omitempty"`
	InputTokens  int     `json:"input_tokens,omitempty"`
	OutputTokens int     `json:"output_tokens,omitempty"`
}

// AgentResult holds the outcome of an agent action.
type AgentResult struct {
	SQL             string          `json:"sql,omitempty"`
	Explanation     string          `json:"explanation,omitempty"`
	Candidates      []string        `json:"candidates,omitempty"`
	QueryResult     json.RawMessage `json:"query_result,omitempty"`
	Visualization   *Visualization  `json:"visualization,omitempty"`
	ValidationError string          `json:"validation_error,omitempty"`
	SecurityBlocked bool            `json:"security_blocked,omitempty"`
}

// Chart type constants for visualization responses.
const (
	ChartTypeBar    = "bar"
	ChartTypeLine   = "line"
	ChartTypePie    = "pie"
	ChartTypeArea   = "area"
	ChartTypeMetric = "metric"
	ChartTypeTable  = "table"
)

// Visualization describes a chart or data visualization returned by the agent.
type Visualization struct {
	ChartType string                   `json:"chart_type"`
	Title     string                   `json:"title"`
	Data      []map[string]interface{} `json:"data"`
	XLabel    string                   `json:"x_label,omitempty"`
	YLabel    string                   `json:"y_label,omitempty"`
	SQL       string                   `json:"sql,omitempty"`
}

// ToolCallLogEntry records a single tool invocation for audit purposes.
type ToolCallLogEntry struct {
	CallID   string `json:"call_id"`
	ToolName string `json:"tool_name"`
	Success  bool   `json:"success"`
}

// AgentErrorPayload communicates an error to the client.
type AgentErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error code constants.
const (
	ErrCodeToolTimeout    = "tool_timeout"
	ErrCodeLLMError       = "llm_error"
	ErrCodeInvalidRequest = "invalid_request"
	ErrCodeSQLBlocked     = "sql_blocked"
	ErrCodeRateLimited    = "rate_limited"
	ErrCodeDBNotConnected = "db_not_connected"
	ErrCodeCancelled      = "cancelled"
	ErrCodeQuotaExhausted = "quota_exhausted"
)

// QuotaWarningPayload notifies the client that a quota/balance is running low or exhausted.
type QuotaWarningPayload struct {
	BalanceUSD float64 `json:"balance_usd"`
	Message    string  `json:"message"`
}

// ModelFallbackPayload notifies the client that the model was switched.
type ModelFallbackPayload struct {
	FromModel string `json:"from_model"`
	ToModel   string `json:"to_model"`
	Reason    string `json:"reason"`
}

// BalanceLowPayload notifies the client that the balance is running low.
type BalanceLowPayload struct {
	Balance  float64 `json:"balance"`
	Currency string  `json:"currency"` // "USD"
}

// ParseEnvelope unmarshals raw JSON into an Envelope.
func ParseEnvelope(data []byte) (*Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, err
	}
	return &env, nil
}

// NewEnvelope creates an Envelope with the given type and marshals the payload.
func NewEnvelope(msgType string, payload any) (*Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return &Envelope{
		Type:    msgType,
		Payload: raw,
	}, nil
}

// NewEnvelopeWithID creates an Envelope with type, request/call ID, and payload.
func NewEnvelopeWithID(msgType, requestID, callID string, payload any) (*Envelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return &Envelope{
		Type:      msgType,
		RequestID: requestID,
		CallID:    callID,
		Payload:   raw,
	}, nil
}

// DecodePayload unmarshals the Envelope's Payload into the given target.
func (e *Envelope) DecodePayload(target any) error {
	return json.Unmarshal(e.Payload, target)
}

// Marshal serializes the Envelope to JSON bytes.
func (e *Envelope) Marshal() ([]byte, error) {
	return json.Marshal(e)
}
