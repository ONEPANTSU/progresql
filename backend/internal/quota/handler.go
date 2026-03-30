package quota

import (
	"encoding/json"
	"net/http"
	"strconv"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/subscription"
)

// Handler provides HTTP handlers for quota-related API endpoints.
type Handler struct {
	service *Service
	logger  *zap.Logger
}

// NewHandler creates a new quota Handler.
func NewHandler(service *Service, logger *zap.Logger) *Handler {
	return &Handler{
		service: service,
		logger:  logger,
	}
}

type errorResp struct {
	Error string `json:"error"`
}

// usageResponse is the JSON shape for GET /api/v2/usage.
type usageResponse struct {
	BudgetTokensUsed   int64   `json:"budget_tokens_used"`
	BudgetTokensLimit  int64   `json:"budget_tokens_limit"`
	PremiumTokensUsed  int64   `json:"premium_tokens_used"`
	PremiumTokensLimit int64   `json:"premium_tokens_limit"`
	PeriodStart        string  `json:"period_start"`
	PeriodEnd          string  `json:"period_end"`
	PeriodType         string  `json:"period_type"`
	Balance            float64 `json:"balance"`
	BalanceEnabled     bool    `json:"balance_enabled"`
	Plan               string  `json:"plan"`
}

// quotaResponse is the JSON shape for GET /api/v2/quota.
type quotaResponse struct {
	Plan                string `json:"plan"`
	BudgetTokensLimit   int64  `json:"budget_tokens_limit"`
	PremiumTokensLimit  int64  `json:"premium_tokens_limit"`
	PeriodType          string `json:"period_type"`
	AutocompleteEnabled bool   `json:"autocomplete_enabled"`
	BalanceMarkupPct    int    `json:"balance_markup_pct"`
	BalanceEnabled      bool   `json:"balance_enabled"`
	MaxRequestsPerMin   int    `json:"max_requests_per_min"`
	MaxTokensPerRequest int    `json:"max_tokens_per_request"`
}

// usageHistoryResponse is the JSON shape for GET /api/v2/usage/history.
type usageHistoryResponse struct {
	Records []UsageRecord `json:"records"`
	Stats   *UsageStats   `json:"stats"`
	Total   int           `json:"total"`
	Limit   int           `json:"limit"`
	Offset  int           `json:"offset"`
}

// modelPricingInfo describes pricing for a single model.
type modelPricingInfo struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Tier            string  `json:"tier"`
	InputPricePerM  float64 `json:"input_price_per_m"`
	OutputPricePerM float64 `json:"output_price_per_m"`
}

// modelPricingResponse is the JSON shape for GET /api/v2/models/pricing.
type modelPricingResponse struct {
	Models   []modelPricingInfo `json:"models"`
	UsdToRub float64            `json:"usd_to_rub"`
}

// GetUsageHandler returns current token usage for the authenticated user.
//
// @Summary      Get current usage
// @Description  Returns current token usage, limits, and balance for the authenticated user.
// @Tags         quota
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  usageResponse
// @Failure      401  {object}  errorResp
// @Failure      500  {object}  errorResp
// @Router       /api/v2/usage [get]
func (h *Handler) GetUsageHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(errorResp{Error: "missing authentication"})
		return
	}

	usage, err := h.service.GetUsage(r.Context(), userID)
	if err != nil {
		h.logger.Error("failed to get usage",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(errorResp{Error: "failed to get usage"})
		return
	}

	// Get plan name for response.
	var planStr string
	err = h.service.db.QueryRow(r.Context(),
		`SELECT COALESCE(plan, 'free') FROM users WHERE id = $1`, userID).Scan(&planStr)
	if err != nil {
		planStr = "free"
	}

	plan := subscription.Plan(planStr)
	quotaLimits := subscription.QuotaLimitsForPlan(plan)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(usageResponse{
		BudgetTokensUsed:   usage.BudgetTokensUsed,
		BudgetTokensLimit:  usage.BudgetTokensLimit,
		PremiumTokensUsed:  usage.PremiumTokensUsed,
		PremiumTokensLimit: usage.PremiumTokensLimit,
		PeriodStart:        usage.PeriodStart.Format("2006-01-02T15:04:05Z"),
		PeriodEnd:          usage.PeriodEnd.Format("2006-01-02T15:04:05Z"),
		PeriodType:         quotaLimits.PeriodType,
		Balance:            usage.Balance,
		BalanceEnabled:     quotaLimits.BalanceEnabled,
		Plan:               planStr,
	})
}

// GetQuotaHandler returns the quota configuration for the authenticated user's plan.
//
// @Summary      Get quota limits
// @Description  Returns quota limits and plan configuration for the authenticated user.
// @Tags         quota
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  quotaResponse
// @Failure      401  {object}  errorResp
// @Failure      500  {object}  errorResp
// @Router       /api/v2/quota [get]
func (h *Handler) GetQuotaHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(errorResp{Error: "missing authentication"})
		return
	}

	var planStr string
	err := h.service.db.QueryRow(r.Context(),
		`SELECT COALESCE(plan, 'free') FROM users WHERE id = $1`, userID).Scan(&planStr)
	if err != nil {
		h.logger.Error("failed to get user plan",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(errorResp{Error: "failed to get plan info"})
		return
	}

	plan := subscription.Plan(planStr)
	ql := subscription.QuotaLimitsForPlan(plan)
	pl := subscription.LimitsForPlan(plan)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(quotaResponse{
		Plan:                planStr,
		BudgetTokensLimit:   ql.BudgetTokensLimit,
		PremiumTokensLimit:  ql.PremiumTokensLimit,
		PeriodType:          ql.PeriodType,
		AutocompleteEnabled: ql.AutocompleteEnabled,
		BalanceMarkupPct:    ql.BalanceMarkupPct,
		BalanceEnabled:      ql.BalanceEnabled,
		MaxRequestsPerMin:   pl.MaxRequestsPerMin,
		MaxTokensPerRequest: pl.MaxTokensPerRequest,
	})
}

// GetUsageHistoryHandler returns paginated token usage history with aggregate stats.
//
// @Summary      Get token usage history
// @Description  Returns paginated token usage history and aggregate statistics for the authenticated user.
// @Tags         quota
// @Produce      json
// @Security     BearerAuth
// @Param        limit   query     int  false  "Number of records per page (default 20, max 100)"
// @Param        offset  query     int  false  "Offset for pagination (default 0)"
// @Success      200     {object}  usageHistoryResponse
// @Failure      401     {object}  errorResp
// @Failure      500     {object}  errorResp
// @Router       /api/v2/usage/history [get]
func (h *Handler) GetUsageHistoryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(errorResp{Error: "missing authentication"})
		return
	}

	limit := 20
	offset := 0

	if v := r.URL.Query().Get("limit"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed >= 0 {
			offset = parsed
		}
	}

	records, stats, total, err := h.service.GetUsageHistory(r.Context(), userID, limit, offset)
	if err != nil {
		h.logger.Error("failed to get usage history",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(errorResp{Error: "failed to get usage history"})
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(usageHistoryResponse{
		Records: records,
		Stats:   stats,
		Total:   total,
		Limit:   limit,
		Offset:  offset,
	})
}

// GetModelPricingHandler returns model pricing information. No authentication required.
//
// @Summary      Get model pricing
// @Description  Returns pricing information for all available models.
// @Tags         quota
// @Produce      json
// @Success      200  {object}  modelPricingResponse
// @Router       /api/v2/models/pricing [get]
func (h *Handler) GetModelPricingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	models := config.DefaultModels()
	pricing := make([]modelPricingInfo, 0, len(models))
	for _, m := range models {
		pricing = append(pricing, modelPricingInfo{
			ID:              m.ID,
			Name:            m.Name,
			Tier:            m.Tier,
			InputPricePerM:  m.InputPricePerM,
			OutputPricePerM: m.OutputPricePerM,
		})
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(modelPricingResponse{
		Models:   pricing,
		UsdToRub: UsdToRUB,
	})
}
