package balance

import (
	"encoding/json"
	"net/http"
	"strconv"

	"go.uber.org/zap"

	"github.com/onepantsu/progressql/backend/internal/auth"
)

// Handler provides HTTP handlers for balance-related API endpoints.
type Handler struct {
	service *Service
	logger  *zap.Logger
}

// NewHandler creates a new balance Handler.
func NewHandler(service *Service, logger *zap.Logger) *Handler {
	return &Handler{
		service: service,
		logger:  logger,
	}
}

// balanceResponse is the JSON shape for GET /api/v2/balance.
type balanceResponse struct {
	Balance  float64 `json:"balance"`
	Currency string  `json:"currency"`
}

// historyResponse is the JSON shape for GET /api/v2/balance/history.
type historyResponse struct {
	Transactions []Transaction `json:"transactions"`
	Total        int           `json:"total"`
	Limit        int           `json:"limit"`
	Offset       int           `json:"offset"`
}

// errorResp is a generic error envelope.
type errorResp struct {
	Error string `json:"error"`
}

// GetBalanceHandler returns the current balance for the authenticated user.
//
// @Summary      Get user balance
// @Description  Returns the current balance and currency for the authenticated user.
// @Tags         balance
// @Produce      json
// @Security     BearerAuth
// @Success      200  {object}  balanceResponse
// @Failure      401  {object}  errorResp
// @Failure      500  {object}  errorResp
// @Router       /api/v2/balance [get]
func (h *Handler) GetBalanceHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(errorResp{Error: "missing authentication"})
		return
	}

	balance, err := h.service.GetBalance(r.Context(), userID)
	if err != nil {
		h.logger.Error("failed to get balance",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(errorResp{Error: "failed to get balance"})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(balanceResponse{
		Balance:  balance,
		Currency: "RUB",
	})
}

// GetHistoryHandler returns balance transaction history for the authenticated user.
// Supports pagination via query parameters: limit (default 20, max 100) and offset (default 0).
//
// @Summary      Get balance transaction history
// @Description  Returns paginated balance transaction history for the authenticated user.
// @Tags         balance
// @Produce      json
// @Security     BearerAuth
// @Param        limit   query     int  false  "Number of transactions per page (default 20, max 100)"
// @Param        offset  query     int  false  "Offset for pagination (default 0)"
// @Success      200     {object}  historyResponse
// @Failure      401     {object}  errorResp
// @Failure      500     {object}  errorResp
// @Router       /api/v2/balance/history [get]
func (h *Handler) GetHistoryHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(errorResp{Error: "missing authentication"})
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

	transactions, total, err := h.service.GetHistory(r.Context(), userID, limit, offset)
	if err != nil {
		h.logger.Error("failed to get balance history",
			zap.String("user_id", userID), zap.Error(err))
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(errorResp{Error: "failed to get balance history"})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(historyResponse{
		Transactions: transactions,
		Total:        total,
		Limit:        limit,
		Offset:       offset,
	})
}
