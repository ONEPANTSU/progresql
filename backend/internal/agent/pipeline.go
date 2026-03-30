package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/balance"
	"github.com/onepantsu/progressql/backend/internal/llm"
	"github.com/onepantsu/progressql/backend/internal/metrics"
	"github.com/onepantsu/progressql/backend/internal/models"
	"github.com/onepantsu/progressql/backend/internal/quota"
	"github.com/onepantsu/progressql/backend/internal/ratelimit"
	"github.com/onepantsu/progressql/backend/internal/security"
	"github.com/onepantsu/progressql/backend/internal/subscription"
	"github.com/onepantsu/progressql/backend/internal/tools"
	"github.com/onepantsu/progressql/backend/internal/websocket"
)

// Valid action names for agent.request.
const (
	ActionGenerateSQL   = "generate_sql"
	ActionImproveSQL    = "improve_sql"
	ActionExplainSQL    = "explain_sql"
	ActionAnalyzeSchema = "analyze_schema"
)

// Step is a single unit of work in a pipeline.
type Step interface {
	// Name returns a human-readable name for logging.
	Name() string
	// Execute runs the step, reading from and writing to the PipelineContext.
	// It returns an error if the step fails.
	Execute(ctx context.Context, pctx *PipelineContext) error
}

// PipelineContext carries data between pipeline steps.
type PipelineContext struct {
	// Request fields (set at start).
	RequestID        string
	Action           string
	UserMessage      string
	SelectedSQL      string
	ActiveTable      string
	UserDescriptions string
	Model            string
	SecurityMode     string // "safe", "data", or "execute". Default: "safe".
	Language         string // User's UI language: "ru" or "en".

	// ConversationHistory holds previous user/assistant messages for multi-turn context.
	ConversationHistory []llm.Message

	// UserID is the authenticated user's ID from JWT claims.
	UserID string

	// Accumulated state between steps.
	Messages         []llm.Message
	ToolCallsLog     []websocket.ToolCallLogEntry
	TokensUsed       int
	PromptTokens     int
	CompletionTokens int
	ModelUsed        string
	SkipRemaining    bool // When true, pipeline skips all subsequent steps.

	// Quota tracking (populated when quota system is active).
	QuotaResult *quota.QuotaCheckResult // result of pre-check
	CostRUB     float64                 // accumulated cost in RUB

	// Result fields (set by final step or intermediate steps).
	Result websocket.AgentResult

	// Infrastructure (available to all steps).
	Session        *websocket.Session
	ToolDispatcher *websocket.ToolDispatcher
	LLMClient      *llm.Client
	ToolRegistry   *tools.Registry
	Logger         *zap.Logger

	// Arbitrary key-value store for step-to-step communication.
	mu     sync.RWMutex
	values map[string]any
}

// NewPipelineContext creates a PipelineContext with initialized internal state.
func NewPipelineContext() *PipelineContext {
	return &PipelineContext{
		values: make(map[string]any),
	}
}

// Set stores a value in the pipeline context.
func (pc *PipelineContext) Set(key string, value any) {
	pc.mu.Lock()
	if pc.values == nil {
		pc.values = make(map[string]any)
	}
	pc.values[key] = value
	pc.mu.Unlock()
}

// Get retrieves a value from the pipeline context.
func (pc *PipelineContext) Get(key string) (any, bool) {
	pc.mu.RLock()
	v, ok := pc.values[key]
	pc.mu.RUnlock()
	return v, ok
}

// AddToolCallLog records a tool invocation in the audit log.
func (pc *PipelineContext) AddToolCallLog(callID, toolName string, success bool) {
	pc.ToolCallsLog = append(pc.ToolCallsLog, websocket.ToolCallLogEntry{
		CallID:   callID,
		ToolName: toolName,
		Success:  success,
	})
}

// AddTokens increments the total token count.
func (pc *PipelineContext) AddTokens(n int) {
	pc.TokensUsed += n
}

// AddTokensDetailed increments prompt, completion, and total token counts.
func (pc *PipelineContext) AddTokensDetailed(usage llm.Usage) {
	pc.PromptTokens += usage.PromptTokens
	pc.CompletionTokens += usage.CompletionTokens
	pc.TokensUsed += usage.TotalTokens
}

// MessagesWithHistory returns a message slice with a SecurityMode system prompt and
// ConversationHistory prepended before the given messages.
// This enables multi-turn context and consistent security policy for all LLM calls.
func (pc *PipelineContext) MessagesWithHistory(msgs ...llm.Message) []llm.Message {
	lang := pc.Language
	if lang == "" {
		lang = "en"
	}
	mode := pc.SecurityMode
	if mode == "" {
		mode = SecurityModeSafe
	}
	systemPrompt := SafeModeSystemPrompt(mode, lang)
	extra := 1 + len(pc.ConversationHistory) // system prompt + history
	result := make([]llm.Message, 0, extra+len(msgs))
	result = append(result, llm.Message{Role: "system", Content: systemPrompt})
	result = append(result, pc.ConversationHistory...)
	result = append(result, msgs...)
	return result
}

// DispatchTool is a convenience method that dispatches a tool call and logs the result.
func (pc *PipelineContext) DispatchTool(toolName string, arguments json.RawMessage) (*websocket.ToolCallResult, error) {
	result, err := pc.ToolDispatcher.Dispatch(pc.RequestID, toolName, arguments)
	if err != nil {
		if te, ok := err.(*websocket.ToolTimeoutError); ok {
			pc.AddToolCallLog(te.CallID, toolName, false)
			metrics.AgentToolCallsTotal.WithLabelValues(toolName, "timeout").Inc()
		} else {
			metrics.AgentToolCallsTotal.WithLabelValues(toolName, "error").Inc()
		}
		return nil, err
	}
	pc.AddToolCallLog(result.CallID, toolName, result.Success)
	if result.Success {
		metrics.AgentToolCallsTotal.WithLabelValues(toolName, "success").Inc()
	} else {
		metrics.AgentToolCallsTotal.WithLabelValues(toolName, "error").Inc()
	}
	return result, nil
}

// Pipeline orchestrates a sequence of steps for a given action.
type Pipeline struct {
	actions            map[string][]Step
	llm                *llm.Client
	registry           *tools.Registry
	logger             *zap.Logger
	rateLimiter        *ratelimit.Limiter
	metrics            *metrics.Collector
	db                 *pgxpool.Pool
	quotaService       *quota.Service
	balanceService     *balance.Service
	defaultModel       string
	toolCallTimeout    time.Duration
	toolCallMaxRetries int
	mu                 sync.RWMutex
	modelsSvc          *models.Service
}

// NewPipeline creates a new Pipeline with the given dependencies.
// defaultModel is the fallback LLM model used when a session has no model set.
func NewPipeline(llmClient *llm.Client, registry *tools.Registry, logger *zap.Logger, defaultModel string) *Pipeline {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Pipeline{
		actions:            make(map[string][]Step),
		llm:                llmClient,
		registry:           registry,
		logger:             logger,
		defaultModel:       defaultModel,
		toolCallTimeout:    websocket.DefaultToolCallTimeout,
		toolCallMaxRetries: 1,
	}
}

// SetRateLimiter configures a rate limiter for the pipeline.
// When set, each agent.request is checked against the limiter before execution.
func (p *Pipeline) SetRateLimiter(limiter *ratelimit.Limiter) {
	p.rateLimiter = limiter
}

// SetToolCallTimeout configures the timeout and max retries for tool calls.
func (p *Pipeline) SetToolCallTimeout(timeout time.Duration, maxRetries int) {
	p.toolCallTimeout = timeout
	p.toolCallMaxRetries = maxRetries
}

// SetDB configures the database pool for recording token usage.
func (p *Pipeline) SetDB(db *pgxpool.Pool) {
	p.db = db
}

// SetMetrics configures a metrics collector for the pipeline.
// When set, each agent.request records request count, tokens, errors, and duration.
func (p *Pipeline) SetMetrics(m *metrics.Collector) {
	p.metrics = m
}

// SetQuotaService configures the quota service for token quota checking and deduction.
func (p *Pipeline) SetQuotaService(svc *quota.Service) {
	p.quotaService = svc
}

// SetBalanceService configures the balance service for balance-related operations.
func (p *Pipeline) SetBalanceService(svc *balance.Service) {
	p.balanceService = svc
}

// SetModelsService configures the database-driven model catalog service.
func (p *Pipeline) SetModelsService(svc *models.Service) {
	p.modelsSvc = svc
}

// RegisterAction maps an action name to a sequence of steps.
func (p *Pipeline) RegisterAction(action string, steps ...Step) {
	p.mu.Lock()
	p.actions[action] = steps
	p.mu.Unlock()
}

// resolveSecurityMode extracts the security mode from the request context.
// Priority: SecurityMode field > SafeMode bool (backward compat) > default "safe".
func resolveSecurityMode(reqCtx *websocket.AgentRequestContext) string {
	if reqCtx == nil {
		return SecurityModeSafe
	}

	// New field takes priority.
	if reqCtx.SecurityMode != nil {
		mode := *reqCtx.SecurityMode
		switch mode {
		case SecurityModeSafe, SecurityModeData, SecurityModeExecute:
			return mode
		default:
			return SecurityModeSafe
		}
	}

	// Backward compatibility: map old bool SafeMode to new SecurityMode.
	if reqCtx.SafeMode != nil {
		if *reqCtx.SafeMode {
			return SecurityModeSafe
		}
		return SecurityModeExecute
	}

	return SecurityModeSafe
}

// HandleMessage processes an incoming agent.request or autocomplete.request envelope.
// It runs the registered step chain and sends agent.response or agent.error.
func (p *Pipeline) HandleMessage(session *websocket.Session, env *websocket.Envelope) {
	// Intercept autocomplete requests before the standard agent pipeline.
	if env.Type == websocket.TypeAutocompleteRequest {
		go p.handleAutocomplete(session, env)
		return
	}

	if env.Type != websocket.TypeAgentRequest {
		return
	}

	startTime := time.Now()

	if p.metrics != nil {
		p.metrics.RecordRequest()
	}

	var payload websocket.AgentRequestPayload
	if err := env.DecodePayload(&payload); err != nil {
		p.sendError(session, env.RequestID, websocket.ErrCodeInvalidRequest, "invalid request payload")
		p.emitAuditLog(session, env.RequestID, "", startTime, 0, "", 0, nil, fmt.Errorf("invalid request payload"))
		p.recordMetricsEnd(startTime, 0, true)
		metrics.AgentRequestsTotal.WithLabelValues("unknown", "error").Inc()
		metrics.AgentRequestDuration.WithLabelValues("unknown").Observe(time.Since(startTime).Seconds())
		return
	}

	requestID := env.RequestID
	if requestID == "" {
		requestID = uuid.New().String()
	}

	userID := session.UserID()

	// Check rate limit before processing.
	if p.rateLimiter != nil {
		if err := p.rateLimiter.Allow(session.SessionID()); err != nil {
			p.sendError(session, requestID, websocket.ErrCodeRateLimited, err.Error())
			p.emitAuditLog(session, requestID, payload.Action, startTime, 0, "", 0, nil, err)
			p.recordMetricsEnd(startTime, 0, true)
			metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "error").Inc()
			metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(time.Since(startTime).Seconds())
			return
		}
	}

	p.logger.Info("pipeline started",
		zap.String("request_id", requestID),
		zap.String("action", payload.Action),
		zap.String("user_id", userID),
	)

	p.mu.RLock()
	steps, ok := p.actions[payload.Action]
	p.mu.RUnlock()

	if !ok {
		errMsg := fmt.Sprintf("unknown action: %s", payload.Action)
		p.sendError(session, requestID, websocket.ErrCodeInvalidRequest, errMsg)
		p.emitAuditLog(session, requestID, payload.Action, startTime, 0, "", 0, nil, fmt.Errorf("%s", errMsg))
		p.recordMetricsEnd(startTime, 0, true)
		metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "error").Inc()
		metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(time.Since(startTime).Seconds())
		return
	}

	// Load conversation history from session for multi-turn context.
	historyMsgs := session.GetHistory()
	convHistory := make([]llm.Message, len(historyMsgs))
	for i, hm := range historyMsgs {
		convHistory[i] = llm.Message{Role: hm.Role, Content: hm.Content}
	}

	// Build pipeline context.
	// Model priority: per-request model > session-level model > pipeline default model.
	model := payload.Model
	if model == "" {
		model = session.Model()
	}
	if model == "" {
		model = p.defaultModel
	}

	pctx := &PipelineContext{
		RequestID:           requestID,
		Action:              payload.Action,
		UserMessage:         payload.UserMessage,
		ConversationHistory: convHistory,
		Model:               model,
		UserID:              userID,
		Session:             session,
		ToolDispatcher:      websocket.NewToolDispatcher(session).WithTimeout(p.toolCallTimeout).WithMaxRetries(p.toolCallMaxRetries).WithLogger(p.logger),
		LLMClient:           p.llm,
		ToolRegistry:        p.registry,
		Logger:              p.logger.With(zap.String("request_id", requestID), zap.String("action", payload.Action), zap.String("user_id", userID)),
		values:              make(map[string]any),
	}

	if payload.Context != nil {
		pctx.SelectedSQL = payload.Context.SelectedSQL
		pctx.ActiveTable = payload.Context.ActiveTable
		pctx.UserDescriptions = payload.Context.UserDescriptions
		pctx.Language = payload.Context.Language
	}
	pctx.SecurityMode = resolveSecurityMode(payload.Context)
	if pctx.Language == "" {
		pctx.Language = "en"
	}

	// --- Quota pre-check (only when quota service is configured and user is authenticated) ---
	if p.quotaService != nil && userID != "" {
		originalModel := model
		quotaBlocked := p.checkQuotaBeforePipeline(session, pctx, requestID, originalModel)
		if quotaBlocked {
			// Quota exhausted with no fallback available. Response already sent.
			p.recordMetricsEnd(startTime, 0, true)
			metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "error").Inc()
			metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(time.Since(startTime).Seconds())
			return
		}
	}

	// Execute steps sequentially with cancellable context.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Register cancel so agent.cancel messages can stop this pipeline.
	session.RegisterCancel(requestID, cancel)
	defer session.UnregisterCancel(requestID)

	cancelled := false
	for i, step := range steps {
		// Check for cancellation before each step.
		if ctx.Err() != nil {
			cancelled = true
			break
		}

		pctx.Logger.Info("step started",
			zap.Int("step", i+1),
			zap.Int("total_steps", len(steps)),
			zap.String("step_name", step.Name()),
		)

		if err := step.Execute(ctx, pctx); err != nil {
			// Check if the error is due to context cancellation.
			if ctx.Err() != nil {
				cancelled = true
				break
			}

			// Database not connected: send a friendly agent.response instead of agent.error.
			if IsDatabaseNotConnected(err) {
				pctx.Logger.Warn("database not connected, sending friendly response",
					zap.String("step_name", step.Name()),
					zap.Error(err),
				)
				p.handleDBNotConnected(ctx, pctx)
				break
			}

			pctx.Logger.Error("step failed",
				zap.String("step_name", step.Name()),
				zap.Error(err),
			)

			code := errorCode(err)
			p.sendError(session, requestID, code, err.Error())
			p.emitAuditLog(session, requestID, payload.Action, startTime, len(pctx.ToolCallsLog), pctx.ModelUsed, pctx.TokensUsed, pctx.ToolCallsLog, err)
			p.recordMetricsEnd(startTime, pctx.TokensUsed, true)
			duration := time.Since(startTime)
			metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "error").Inc()
			metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(duration.Seconds())
			p.recordPrometheusTokens(pctx)
			return
		}

		pctx.Logger.Info("step completed", zap.String("step_name", step.Name()))

		if pctx.SkipRemaining {
			pctx.Logger.Info("skipping remaining steps", zap.String("triggered_by", step.Name()))
			break
		}
	}

	// Handle cancellation: send agent.error with "cancelled" code.
	if cancelled {
		pctx.Logger.Info("pipeline cancelled by client")
		p.sendError(session, requestID, websocket.ErrCodeCancelled, "cancelled")
		p.emitAuditLog(session, requestID, payload.Action, startTime, len(pctx.ToolCallsLog), pctx.ModelUsed, pctx.TokensUsed, pctx.ToolCallsLog, fmt.Errorf("cancelled by client"))
		p.recordMetricsEnd(startTime, pctx.TokensUsed, false)
		duration := time.Since(startTime)
		metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "cancelled").Inc()
		metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(duration.Seconds())
		p.recordPrometheusTokens(pctx)
		return
	}

	// Send final agent.response.
	resp := websocket.AgentResponsePayload{
		Action:       payload.Action,
		Result:       pctx.Result,
		ToolCallsLog: pctx.ToolCallsLog,
		ModelUsed:    pctx.ModelUsed,
		TokensUsed:   pctx.TokensUsed,
		ModelTier:    getModelTier(pctx.ModelUsed),
		CostRUB:      pctx.CostRUB,
		InputTokens:  pctx.PromptTokens,
		OutputTokens: pctx.CompletionTokens,
	}

	respEnv, err := websocket.NewEnvelopeWithID(websocket.TypeAgentResponse, requestID, "", resp)
	if err != nil {
		p.logger.Error("failed to marshal agent.response", zap.Error(err))
		return
	}

	if err := session.SendEnvelope(respEnv); err != nil {
		p.logger.Error("failed to send agent.response", zap.Error(err))
	}

	// Record conversation history for multi-turn context.
	if payload.UserMessage != "" {
		session.AddHistory("user", payload.UserMessage)
	}
	// Build a concise assistant summary for history.
	assistantMsg := buildAssistantHistoryMessage(pctx)
	if assistantMsg != "" {
		session.AddHistory("assistant", assistantMsg)
	}

	p.emitAuditLog(session, requestID, payload.Action, startTime, len(pctx.ToolCallsLog), pctx.ModelUsed, pctx.TokensUsed, pctx.ToolCallsLog, nil)
	p.recordMetricsEnd(startTime, pctx.TokensUsed, false)
	p.recordTokenUsage(pctx)

	// --- Quota deduction (after successful pipeline) ---
	p.deductQuotaAfterPipeline(session, pctx, requestID)

	// Prometheus: record success metrics.
	duration := time.Since(startTime)
	metrics.AgentRequestsTotal.WithLabelValues(payload.Action, "success").Inc()
	metrics.AgentRequestDuration.WithLabelValues(payload.Action).Observe(duration.Seconds())
	p.recordPrometheusTokens(pctx)
}

// checkQuotaBeforePipeline runs a pre-check against the quota system before executing pipeline steps.
// Returns true if the request is blocked (quota exhausted with no fallback).
func (p *Pipeline) checkQuotaBeforePipeline(session *websocket.Session, pctx *PipelineContext, requestID, originalModel string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	modelTier := getModelTier(originalModel)

	quotaResult, err := p.quotaService.CheckQuota(ctx, pctx.UserID, modelTier, 0)
	if err != nil {
		// Quota check failed — log and allow the request to proceed (fail-open).
		p.logger.Warn("quota pre-check failed, allowing request",
			zap.String("user_id", pctx.UserID),
			zap.Error(err),
		)
		return false
	}

	pctx.QuotaResult = quotaResult

	if !quotaResult.Allowed && quotaResult.FallbackModelID == "" {
		// Quota exhausted, no fallback possible.
		p.sendQuotaExhausted(session, requestID, modelTier, quotaResult)
		return true
	}

	if quotaResult.FallbackModelID != "" {
		// Switch to fallback model.
		pctx.Model = quotaResult.FallbackModelID
		p.sendModelFallback(session, requestID, originalModel, quotaResult.FallbackModelID, "quota_exhausted")
	}

	return false
}

// deductQuotaAfterPipeline deducts tokens from the quota system after a successful pipeline run
// and sends quota/balance warning notifications if thresholds are crossed.
func (p *Pipeline) deductQuotaAfterPipeline(session *websocket.Session, pctx *PipelineContext, requestID string) {
	if p.quotaService == nil || pctx.UserID == "" || pctx.TokensUsed == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	modelUsed := pctx.ModelUsed
	if modelUsed == "" {
		modelUsed = pctx.Model
	}
	modelTier := p.getModelTierFromDB(modelUsed)

	// Most pipeline steps only call AddTokens (total), not AddTokensDetailed
	// (prompt+completion). If detailed counts are missing, split total as
	// approximate 25% input / 75% output so DeductTokens receives non-zero values.
	inputTokens := pctx.PromptTokens
	outputTokens := pctx.CompletionTokens
	if inputTokens == 0 && outputTokens == 0 && pctx.TokensUsed > 0 {
		inputTokens = pctx.TokensUsed / 4
		outputTokens = pctx.TokensUsed - inputTokens
	}

	if err := p.quotaService.DeductTokens(ctx, pctx.UserID, modelUsed, modelTier, inputTokens, outputTokens); err != nil {
		p.logger.Error("quota token deduction failed",
			zap.String("user_id", pctx.UserID),
			zap.Error(err),
		)
		// Non-fatal: the request already succeeded.
		return
	}

	// Check for quota/balance warning thresholds.
	p.sendQuotaWarnings(session, pctx, requestID)
}

// sendQuotaWarnings checks usage after deduction and sends warning notifications
// when remaining quota or balance drops below threshold.
func (p *Pipeline) sendQuotaWarnings(session *websocket.Session, pctx *PipelineContext, requestID string) {
	if p.quotaService == nil || pctx.UserID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	usage, err := p.quotaService.GetUsage(ctx, pctx.UserID)
	if err != nil {
		p.logger.Debug("failed to fetch usage for quota warning check", zap.Error(err))
		return
	}

	// Check budget quota warning (< 20% remaining).
	if usage.BudgetTokensLimit > 0 {
		remaining := usage.BudgetTokensLimit - usage.BudgetTokensUsed
		if remaining > 0 && remaining < usage.BudgetTokensLimit/5 {
			env, err := websocket.NewEnvelopeWithID(websocket.TypeQuotaWarning, requestID, "", websocket.QuotaWarningPayload{
				QuotaType:       "budget",
				UsedTokens:      usage.BudgetTokensUsed,
				LimitTokens:     usage.BudgetTokensLimit,
				RemainingTokens: remaining,
			})
			if err == nil {
				_ = session.SendEnvelope(env)
			}
		}
	}

	// Check premium quota warning (< 20% remaining).
	if usage.PremiumTokensLimit > 0 {
		remaining := usage.PremiumTokensLimit - usage.PremiumTokensUsed
		if remaining > 0 && remaining < usage.PremiumTokensLimit/5 {
			env, err := websocket.NewEnvelopeWithID(websocket.TypeQuotaWarning, requestID, "", websocket.QuotaWarningPayload{
				QuotaType:       "premium",
				UsedTokens:      usage.PremiumTokensUsed,
				LimitTokens:     usage.PremiumTokensLimit,
				RemainingTokens: remaining,
			})
			if err == nil {
				_ = session.SendEnvelope(env)
			}
		}
	}

	// Check balance warning (< 100 RUB).
	if usage.Balance > 0 && usage.Balance < 100 {
		env, err := websocket.NewEnvelopeWithID(websocket.TypeBalanceLow, requestID, "", websocket.BalanceLowPayload{
			Balance:  usage.Balance,
			Currency: "RUB",
		})
		if err == nil {
			_ = session.SendEnvelope(env)
		}
	}
}

// sendQuotaExhausted sends a quota.exhausted message to the client.
func (p *Pipeline) sendQuotaExhausted(session *websocket.Session, requestID, modelTier string, result *quota.QuotaCheckResult) {
	var used, limit int64
	if modelTier == "premium" {
		limit = result.RemainingPremium // already 0
		used = limit                    // fully used
	} else {
		limit = result.RemainingBudget
		used = limit
	}

	env, err := websocket.NewEnvelopeWithID(websocket.TypeQuotaExhausted, requestID, "", websocket.QuotaWarningPayload{
		QuotaType:       modelTier,
		UsedTokens:      used,
		LimitTokens:     limit,
		RemainingTokens: 0,
	})
	if err != nil {
		p.logger.Error("failed to marshal quota.exhausted", zap.Error(err))
		return
	}
	_ = session.SendEnvelope(env)

	// Also send a standard agent.error so the client knows the request was not processed.
	p.sendError(session, requestID, websocket.ErrCodeQuotaExhausted, result.Reason)
}

// sendModelFallback sends a model.fallback notification to the client.
func (p *Pipeline) sendModelFallback(session *websocket.Session, requestID, fromModel, toModel, reason string) {
	env, err := websocket.NewEnvelopeWithID(websocket.TypeModelFallback, requestID, "", websocket.ModelFallbackPayload{
		FromModel: fromModel,
		ToModel:   toModel,
		Reason:    reason,
	})
	if err != nil {
		p.logger.Error("failed to marshal model.fallback", zap.Error(err))
		return
	}
	_ = session.SendEnvelope(env)
}

// getModelTier returns the tier ("budget" or "premium") for the given model ID.
// Handles OpenRouter model ID aliasing (e.g. "anthropic/claude-4-opus-20250522"
// returned by the API vs "anthropic/claude-opus-4" in our config).
// Returns "budget" as default if the model is not found.
func getModelTier(modelID string) string {
	for _, m := range config.DefaultModels() {
		if m.ID == modelID {
			return m.Tier
		}
	}
	// Fuzzy match: OpenRouter may return versioned model IDs
	// (e.g. "anthropic/claude-4-opus-20250522" for "anthropic/claude-opus-4").
	// Extract provider prefix and check if any config model name is a substring.
	for _, m := range config.DefaultModels() {
		// Match if either the config ID is contained in the response model ID,
		// or vice versa (after removing date suffixes).
		if strings.Contains(modelID, strings.TrimPrefix(m.ID, "anthropic/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "openai/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "google/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "deepseek/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "qwen/")) {
			return m.Tier
		}
	}
	return "budget"
}

// getModelTierFromDB returns the tier using the database-driven model service.
// Falls back to the config-based getModelTier if the service is not available.
func (p *Pipeline) getModelTierFromDB(modelID string) string {
	if p.modelsSvc != nil {
		return p.modelsSvc.GetTier(context.Background(), modelID)
	}
	return getModelTier(modelID)
}

// recordPrometheusTokens emits Prometheus LLM token counters from the pipeline context.
func (p *Pipeline) recordPrometheusTokens(pctx *PipelineContext) {
	model := pctx.ModelUsed
	if model == "" {
		model = pctx.Model
	}
	if pctx.PromptTokens > 0 {
		metrics.LLMTokensTotal.WithLabelValues(model, "prompt").Add(float64(pctx.PromptTokens))
	}
	if pctx.CompletionTokens > 0 {
		metrics.LLMTokensTotal.WithLabelValues(model, "completion").Add(float64(pctx.CompletionTokens))
	}
}

// handleAutocomplete processes an autocomplete.request envelope.
// It sends the SQL context to the LLM for a short completion suggestion and responds
// with an autocomplete.response envelope. Errors are silently logged; no error envelope
// is sent to the client for autocomplete failures.
func (p *Pipeline) handleAutocomplete(session *websocket.Session, env *websocket.Envelope) {
	var payload websocket.AutocompleteRequestPayload
	if err := env.DecodePayload(&payload); err != nil {
		return // silently ignore malformed requests
	}

	if payload.SQL == "" {
		return
	}

	// --- Autocomplete gating: check if the user's plan allows autocomplete ---
	userID := session.UserID()
	if p.quotaService != nil && userID != "" {
		allowed := p.isAutocompleteAllowed(userID)
		if !allowed {
			// Plan does not include autocomplete. Send empty response.
			return
		}
	}

	// Split SQL at cursor position.
	cursorPos := payload.CursorPos
	if cursorPos > len(payload.SQL) {
		cursorPos = len(payload.SQL)
	}
	sqlBefore := payload.SQL[:cursorPos]
	sqlAfter := ""
	if cursorPos < len(payload.SQL) {
		sqlAfter = payload.SQL[cursorPos:]
	}

	// Build prompt.
	schemaSection := ""
	if payload.SchemaContext != "" {
		schemaSection = fmt.Sprintf("DATABASE SCHEMA (this is the COMPLETE list of all tables and columns — NOTHING else exists):\n%s\n\n", payload.SchemaContext)
	}

	systemPrompt := "You are a PostgreSQL SQL autocomplete engine.\n\n" +
		"STRICT RULES:\n" +
		"- Return ONLY the NEW text that should be INSERTED after the cursor position. NEVER repeat any text that already exists before [CURSOR].\n" +
		"- For example, if SQL before cursor is 'SELECT ', return '* FROM table_name' — NOT 'SELECT * FROM table_name'.\n" +
		"- No markdown, no code blocks, no explanation, no backticks, no comments.\n" +
		"- Keep completions short: 1-3 lines maximum.\n" +
		"- Stop at a natural SQL boundary: semicolon, closing parenthesis, or end of clause.\n" +
		"- ONLY use table and column names from the DATABASE SCHEMA provided below.\n" +
		"- NEVER invent, guess, or hallucinate table or column names that are not in the schema.\n" +
		"- If you are unsure which column to suggest, return EMPTY response rather than guessing.\n" +
		"- Use schema-qualified names (e.g. shop.orders) when tables are not in the public schema.\n" +
		"- Match the style of the existing query (aliases, casing, formatting).\n" +
		"- If the cursor is after SELECT, suggest only columns that exist in the tables referenced in FROM/JOIN.\n" +
		"- If the cursor is after FROM/JOIN, suggest a real table from the schema.\n" +
		"- If the cursor is after WHERE/AND/OR, suggest conditions using real columns from referenced tables.\n" +
		"- If the cursor is after a dot (alias.col), resolve the alias to the table and suggest its real columns.\n"

	afterPart := ""
	if strings.TrimSpace(sqlAfter) != "" {
		afterPart = fmt.Sprintf("\nSQL after cursor: %s", sqlAfter)
	}
	userPrompt := fmt.Sprintf("%sSQL before cursor: %s%s", schemaSection, sqlBefore, afterPart)

	// Use client-provided autocomplete model if it is a valid budget-tier model.
	model := config.DefaultAutocompleteModelID
	if payload.Model != "" && getModelTier(payload.Model) == "budget" {
		model = payload.Model
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	maxTokens := 150
	req := llm.ChatRequest{
		Model: model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		MaxTokens: &maxTokens,
	}

	resp, err := p.llm.ChatCompletion(ctx, req)
	if err != nil {
		p.logger.Debug("autocomplete LLM failed", zap.Error(err))
		return
	}

	if len(resp.Choices) == 0 {
		return
	}

	completion := strings.TrimSpace(resp.Choices[0].Message.Content)
	// Remove any markdown code blocks or cursor markers the LLM might add despite instructions.
	completion = strings.TrimPrefix(completion, "```sql")
	completion = strings.TrimPrefix(completion, "```")
	completion = strings.TrimSuffix(completion, "```")
	completion = strings.ReplaceAll(completion, "[CURSOR]", "")
	completion = strings.TrimSpace(completion)

	if completion == "" {
		return
	}

	// Strip duplicated prefix: if LLM repeats the text before cursor, remove it.
	// Compare case-insensitively since SQL keywords can vary in casing.
	beforeLower := strings.ToLower(strings.TrimSpace(sqlBefore))
	completionLower := strings.ToLower(completion)
	if beforeLower != "" && strings.HasPrefix(completionLower, beforeLower) {
		completion = strings.TrimSpace(completion[len(beforeLower):])
	} else {
		// Check partial overlap: find the longest suffix of sqlBefore that is a prefix of completion.
		trimmedBefore := strings.TrimSpace(sqlBefore)
		for i := 1; i < len(trimmedBefore) && i < len(completion); i++ {
			suffix := strings.ToLower(trimmedBefore[len(trimmedBefore)-i:])
			prefix := strings.ToLower(completion[:i])
			if suffix == prefix {
				// Check if the full word matches (avoid partial word matches).
				if i == len(trimmedBefore) || i >= len(completion) ||
					completion[i] == ' ' || completion[i] == '\n' || completion[i] == '(' ||
					trimmedBefore[len(trimmedBefore)-i-1] == ' ' || trimmedBefore[len(trimmedBefore)-i-1] == '\n' {
					completion = strings.TrimSpace(completion[i:])
				}
			}
		}
	}

	if completion == "" {
		return
	}

	// Send response.
	respEnv, err := websocket.NewEnvelopeWithID(websocket.TypeAutocompleteResponse, env.RequestID, "", websocket.AutocompleteResponsePayload{
		Completion: completion,
	})
	if err != nil {
		p.logger.Error("failed to marshal autocomplete.response", zap.Error(err))
		return
	}

	if err := session.SendEnvelope(respEnv); err != nil {
		p.logger.Error("failed to send autocomplete.response", zap.Error(err))
	}
}

// isAutocompleteAllowed checks if the user's plan permits autocomplete requests.
func (p *Pipeline) isAutocompleteAllowed(userID string) bool {
	if p.quotaService == nil {
		return true // no quota system — allow by default
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Fetch user plan to check autocomplete access.
	var planStr string
	if p.db != nil {
		err := p.db.QueryRow(ctx,
			`SELECT COALESCE(plan, 'free') FROM users WHERE id = $1`, userID).Scan(&planStr)
		if err != nil {
			p.logger.Debug("failed to fetch user plan for autocomplete check", zap.Error(err))
			return true // fail-open
		}
	} else {
		return true // no DB — allow
	}

	plan := subscription.Plan(planStr)
	quotaLimits := subscription.QuotaLimitsForPlan(plan)
	return quotaLimits.AutocompleteEnabled
}

// handleDBNotConnected streams a friendly LLM response telling the user to connect a database.
// The LLM naturally responds in the user's language. Falls back to a static message if LLM fails.
func (p *Pipeline) handleDBNotConnected(ctx context.Context, pctx *PipelineContext) {
	model := pctx.Model

	prompt := "You are a PostgreSQL database assistant. The user sent a message that requires a database connection, " +
		"but no database is currently connected.\n\n" +
		"Tell the user briefly and friendly that they need to connect to a database first " +
		"to work with SQL queries and schema inspection. " +
		"Suggest using the connection panel on the left side of the interface.\n\n" +
		"IMPORTANT: Always respond in the same language as the user's message. " +
		"If the user writes in Russian, respond in Russian. If in English, respond in English.\n\n" +
		"User message: " + pctx.UserMessage

	req := llm.ChatRequest{
		Model: model,
		Messages: []llm.Message{
			{Role: "user", Content: prompt},
		},
	}

	resp, err := pctx.StreamLLM(ctx, req)
	if err != nil {
		// Fallback: static bilingual message if LLM is unavailable.
		pctx.Logger.Warn("LLM unavailable for db-not-connected response, using fallback", zap.Error(err))
		pctx.Result.Explanation = "Для работы с SQL-запросами необходимо подключение к базе данных. " +
			"Используйте панель подключения слева.\n\n" +
			"Please connect to a database first to work with SQL queries. " +
			"Use the connection panel on the left."
		return
	}

	if len(resp.Choices) > 0 && resp.Choices[0].Message.Content != "" {
		pctx.Result.Explanation = resp.Choices[0].Message.Content
	} else {
		pctx.Result.Explanation = "Для работы с SQL-запросами необходимо подключение к базе данных. " +
			"Используйте панель подключения слева.\n\n" +
			"Please connect to a database first to work with SQL queries. " +
			"Use the connection panel on the left."
	}
}

// emitAuditLog writes a single structured audit log entry for each agent.request.
// Fields: timestamp, session_id, request_id, user_id, action, tool_calls, model, tokens, duration_ms, error.
func (p *Pipeline) emitAuditLog(session *websocket.Session, requestID, action string, startTime time.Time, toolCallCount int, model string, tokens int, toolCalls []websocket.ToolCallLogEntry, pipelineErr error) {
	durationMs := time.Since(startTime).Milliseconds()

	sessionID := ""
	userID := ""
	if session != nil {
		sessionID = session.SessionID()
		userID = session.UserID()
	}

	// Build tool call names for compact audit.
	toolNames := make([]string, len(toolCalls))
	for i, tc := range toolCalls {
		toolNames[i] = tc.ToolName
	}

	fields := []zap.Field{
		zap.String("audit", "agent_request"),
		zap.String("session_id", sessionID),
		zap.String("request_id", requestID),
		zap.String("user_id", userID),
		zap.String("action", action),
		zap.Int("tool_calls", toolCallCount),
		zap.Strings("tool_names", toolNames),
		zap.String("model", model),
		zap.Int("tokens", tokens),
		zap.Int64("duration_ms", durationMs),
	}

	if pipelineErr != nil {
		fields = append(fields, zap.String("error", pipelineErr.Error()))
		p.logger.Error("agent request completed with error", fields...)
	} else {
		p.logger.Info("agent request completed", fields...)
	}
}

// sendError sends an agent.error envelope to the client.
func (p *Pipeline) sendError(session *websocket.Session, requestID, code, message string) {
	payload := websocket.AgentErrorPayload{Code: code, Message: message}
	env, err := websocket.NewEnvelopeWithID(websocket.TypeAgentError, requestID, "", payload)
	if err != nil {
		p.logger.Error("failed to marshal agent.error", zap.Error(err))
		return
	}
	_ = session.SendEnvelope(env)
}

// recordMetricsEnd records duration, tokens and error state to the metrics collector.
func (p *Pipeline) recordMetricsEnd(startTime time.Time, tokens int, isError bool) {
	if p.metrics == nil {
		return
	}
	p.metrics.RecordDuration(float64(time.Since(startTime).Milliseconds()))
	if tokens > 0 {
		p.metrics.RecordTokens(tokens)
	}
	if isError {
		p.metrics.RecordError()
	}
}

// buildAssistantHistoryMessage creates a concise summary of the agent's response
// to store in conversation history. Includes SQL and/or explanation.
func buildAssistantHistoryMessage(pctx *PipelineContext) string {
	var parts []string
	if pctx.Result.Explanation != "" {
		parts = append(parts, pctx.Result.Explanation)
	}
	if pctx.Result.SQL != "" {
		parts = append(parts, "Generated SQL: "+pctx.Result.SQL)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, "\n\n")
}

// calcCostUSD estimates the cost in USD for the given model and total tokens.
// Uses config.DefaultModels() prices with fuzzy matching for aliased OpenRouter IDs.
// Approximates using average of input/output price when detailed breakdown is unavailable.
func calcCostUSD(modelID string, totalTokens int) float64 {
	m := findModelFuzzy(modelID)
	if m == nil {
		return 0
	}
	// Average of input and output price per token as approximation
	avgPricePerToken := (m.InputPricePerM + m.OutputPricePerM) / 2.0 / 1_000_000.0
	return avgPricePerToken * float64(totalTokens)
}

// findModelFuzzy finds a model from config by exact match or fuzzy substring matching.
func findModelFuzzy(modelID string) *config.ModelInfo {
	// Exact match first
	for _, m := range config.DefaultModels() {
		if m.ID == modelID {
			return &m
		}
	}
	// Fuzzy match for aliased OpenRouter IDs
	for _, m := range config.DefaultModels() {
		if strings.Contains(modelID, strings.TrimPrefix(m.ID, "anthropic/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "openai/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "google/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "deepseek/")) ||
			strings.Contains(modelID, strings.TrimPrefix(m.ID, "qwen/")) {
			return &m
		}
	}
	return nil
}
// calcCostUSDFromDB estimates cost using the database-driven model service.
// Falls back to the config-based calcCostUSD if the service is not available.
func (p *Pipeline) calcCostUSDFromDB(modelID string, totalTokens int) float64 {
	if p.modelsSvc != nil {
		return p.modelsSvc.CalcCostUSDTotal(context.Background(), modelID, totalTokens)
	}
	return calcCostUSD(modelID, totalTokens)
}


// recordTokenUsage inserts a row into the token_usage table after a successful pipeline run.
// Skips silently if DB is nil, user_id is empty, or no tokens were used.
func (p *Pipeline) recordTokenUsage(pctx *PipelineContext) {
	if p.db == nil || pctx.UserID == "" || pctx.TokensUsed == 0 {
		return
	}

	costUSD := p.calcCostUSDFromDB(pctx.ModelUsed, pctx.TokensUsed)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// If detailed counts are missing, approximate from total
	promptTokens := pctx.PromptTokens
	completionTokens := pctx.CompletionTokens
	if promptTokens == 0 && completionTokens == 0 && pctx.TokensUsed > 0 {
		promptTokens = pctx.TokensUsed / 4
		completionTokens = pctx.TokensUsed - promptTokens
	}

	_, err := p.db.Exec(ctx,
		`INSERT INTO token_usage (id, user_id, session_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, action)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
		pctx.UserID,
		pctx.Session.SessionID(),
		pctx.ModelUsed,
		promptTokens,
		completionTokens,
		pctx.TokensUsed,
		costUSD,
		pctx.Action,
	)
	if err != nil {
		p.logger.Error("failed to record token usage",
			zap.String("user_id", pctx.UserID),
			zap.Error(err),
		)
	}
}

// errorCode determines the appropriate error code from an error.
func errorCode(err error) string {
	if websocket.IsToolTimeout(err) {
		return websocket.ErrCodeToolTimeout
	}
	if _, ok := llm.IsAPIError(err); ok {
		return websocket.ErrCodeLLMError
	}
	if security.IsSQLBlocked(err) {
		return websocket.ErrCodeSQLBlocked
	}
	if ratelimit.IsRateLimited(err) {
		return websocket.ErrCodeRateLimited
	}
	return websocket.ErrCodeInvalidRequest
}
