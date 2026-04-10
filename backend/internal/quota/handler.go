package quota

import (
	"encoding/json"
	"net/http"
	"strconv"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/config"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"github.com/onepantsu/progressql/backend/internal/exchange"
	"github.com/onepantsu/progressql/backend/internal/models"
	"github.com/onepantsu/progressql/backend/internal/subscription"
)

// Handler provides HTTP handlers for billing-related API endpoints.
type Handler struct {
	service   *Service
	logger    *zap.Logger
	modelsSvc *models.Service
	rateSvc   *exchange.RateService
}

// NewHandler creates a new quota Handler.
func NewHandler(service *Service, logger *zap.Logger, modelsSvc *models.Service, rateSvc *exchange.RateService) *Handler {
	return &Handler{
		service:   service,
		logger:    logger,
		modelsSvc: modelsSvc,
		rateSvc:   rateSvc,
	}
}

type errorResp struct {
	Error string `json:"error"`
}

// usageResponse is the JSON shape for GET /api/v2/usage.
type usageResponse struct {
	BalanceUSD         float64 `json:"balance_usd"`
	BalanceRUB         float64 `json:"balance_rub"`
	Plan               string  `json:"plan"`
	CreditsIncludedUSD float64 `json:"credits_included_usd"`
	CreditsUsedUSD     float64 `json:"credits_used_usd"`
	CreditsRemainingUSD float64 `json:"credits_remaining_usd"`
	PeriodStart        string  `json:"period_start"`
	PeriodEnd          string  `json:"period_end"`
	RequestsTotal      int     `json:"requests_total"`
	TokensTotal        int64   `json:"tokens_total"`
	CostUSDTotal       float64 `json:"cost_usd_total"`
	AvgCostPerReqUSD   float64 `json:"avg_cost_per_request_usd"`
}

// quotaResponse is the JSON shape for GET /api/v2/quota.
type quotaResponse struct {
	Plan                string   `json:"plan"`
	AllowedModelTiers   []string `json:"allowed_model_tiers"`
	AutocompleteEnabled bool     `json:"autocomplete_enabled"`
	BalanceMarkupPct    int      `json:"balance_markup_pct"`
	MaxRequestsPerMin   int      `json:"max_requests_per_min"`
	MaxTokensPerRequest int      `json:"max_tokens_per_request"`
	MonthlyCreditsUSD   float64  `json:"monthly_credits_usd"`
	DailyCreditsUSD     float64  `json:"daily_credits_usd"`
	CreditsRollover     bool     `json:"credits_rollover"`
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

// topupOption describes a single top-up option.
type topupOption struct {
	AmountRUB  float64 `json:"amount_rub"`
	CreditsUSD float64 `json:"credits_usd"`
}

// topupOptionsResponse is the JSON shape for GET /api/v2/billing/topup-options.
type topupOptionsResponse struct {
	MarkupPct int           `json:"markup_pct"`
	UsdToRub  float64       `json:"usd_to_rub"`
	Options   []topupOption `json:"options"`
}

// GetUsageHandler returns current billing usage for the authenticated user.
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

	creditsRemaining := usage.CreditsIncludedUSD - usage.CreditsUsedUSD
	if creditsRemaining < 0 {
		creditsRemaining = 0
	}

	var avgCost float64
	if usage.RequestsTotal > 0 {
		avgCost = usage.CostUSDTotal / float64(usage.RequestsTotal)
	}

	rate := h.rateSvc.GetUSDToRUB()

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(usageResponse{
		BalanceUSD:          usage.BalanceUSD,
		BalanceRUB:          usage.BalanceUSD * rate,
		Plan:                usage.Plan,
		CreditsIncludedUSD:  usage.CreditsIncludedUSD,
		CreditsUsedUSD:      usage.CreditsUsedUSD,
		CreditsRemainingUSD: creditsRemaining,
		PeriodStart:         usage.PeriodStart.Format("2006-01-02T15:04:05Z"),
		PeriodEnd:           usage.PeriodEnd.Format("2006-01-02T15:04:05Z"),
		RequestsTotal:       usage.RequestsTotal,
		TokensTotal:         usage.TokensTotal,
		CostUSDTotal:        usage.CostUSDTotal,
		AvgCostPerReqUSD:    avgCost,
	})
}

// GetQuotaHandler returns the billing configuration for the authenticated user's plan.
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
		`SELECT CASE WHEN COALESCE(plan,'free') NOT IN ('free','trial')
		              AND plan_expires_at IS NOT NULL
		              AND plan_expires_at < NOW()
		         THEN 'free' ELSE COALESCE(plan,'free') END
		 FROM users WHERE id = $1`, userID).Scan(&planStr)
	if err != nil {
		h.logger.Error("failed to get user plan",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(errorResp{Error: "failed to get plan info"})
		return
	}

	plan := subscription.NormalizePlan(subscription.Plan(planStr))
	pl := subscription.LimitsForPlan(plan)

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(quotaResponse{
		Plan:                string(plan),
		AllowedModelTiers:   pl.AllowedModelTiers,
		AutocompleteEnabled: pl.AutocompleteEnabled,
		BalanceMarkupPct:    pl.BalanceMarkupPct,
		MaxRequestsPerMin:   pl.MaxRequestsPerMin,
		MaxTokensPerRequest: pl.MaxTokensPerRequest,
		MonthlyCreditsUSD:   pl.MonthlyCreditsUSD,
		DailyCreditsUSD:     pl.DailyCreditsUSD,
		CreditsRollover:     pl.CreditsRollover,
	})
}

// GetUsageHistoryHandler returns paginated token usage history with aggregate stats.
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

// GetModelPricingHandler returns model pricing information.
func (h *Handler) GetModelPricingHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	var pricingModels []modelPricingInfo

	if h.modelsSvc != nil {
		allModels, err := h.modelsSvc.All(r.Context())
		if err == nil && len(allModels) > 0 {
			for _, m := range allModels {
				pricingModels = append(pricingModels, modelPricingInfo{
					ID:              m.ID,
					Name:            m.DisplayName,
					Tier:            m.Tier,
					InputPricePerM:  m.InputPricePerM,
					OutputPricePerM: m.OutputPricePerM,
				})
			}
		}
	}

	if len(pricingModels) == 0 {
		for _, m := range config.DefaultModels() {
			pricingModels = append(pricingModels, modelPricingInfo{
				ID:              m.ID,
				Name:            m.Name,
				Tier:            m.Tier,
				InputPricePerM:  m.InputPricePerM,
				OutputPricePerM: m.OutputPricePerM,
			})
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(modelPricingResponse{
		Models:   pricingModels,
		UsdToRub: h.rateSvc.GetUSDToRUB(),
	})
}

// GetTopUpOptionsHandler returns available top-up options with credits after markup.
func (h *Handler) GetTopUpOptionsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	markupPct := 30 // default for Free

	userID := auth.UserIDFromContext(r.Context())
	if userID != "" {
		var planStr string
		err := h.service.db.QueryRow(r.Context(),
			`SELECT CASE WHEN COALESCE(plan,'free') NOT IN ('free','trial')
			              AND plan_expires_at IS NOT NULL
			              AND plan_expires_at < NOW()
			         THEN 'free' ELSE COALESCE(plan,'free') END
			 FROM users WHERE id = $1`, userID).Scan(&planStr)
		if err == nil {
			plan := subscription.NormalizePlan(subscription.Plan(planStr))
			markupPct = subscription.LimitsForPlan(plan).BalanceMarkupPct
		}
	}

	rate := h.rateSvc.GetUSDToRUB()
	amounts := []float64{300, 900, 2700, 4500, 9000}

	var options []topupOption
	for _, rub := range amounts {
		credits := rub / rate / (1.0 + float64(markupPct)/100.0)
		options = append(options, topupOption{
			AmountRUB:  rub,
			CreditsUSD: float64(int(credits*100)) / 100, // round to 2 decimals
		})
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(topupOptionsResponse{
		MarkupPct: markupPct,
		UsdToRub:  rate,
		Options:   options,
	})
}
