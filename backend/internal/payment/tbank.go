package payment

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const tbankBaseURL = "https://securepay.tinkoff.ru/v2/"

// TBankClient is an HTTP client for the T-Bank (Tinkoff) e-acquiring API.
type TBankClient struct {
	terminalKey string
	password    string
	httpClient  *http.Client
	baseURL     string
}

// NewTBankClient creates a new T-Bank API client.
func NewTBankClient(terminalKey, password string) *TBankClient {
	return &TBankClient{
		terminalKey: terminalKey,
		password:    password,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		baseURL: tbankBaseURL,
	}
}

// TBankInitRequest holds parameters for creating a payment.
type TBankInitRequest struct {
	Amount          int64  // in kopecks
	OrderId         string // unique order ID
	Description     string // shown on payment form
	CustomerKey     string // buyer ID (for future recurring)
	NotificationURL string // webhook URL
	SuccessURL      string // redirect after success
	FailURL         string // redirect after failure
	Language        string // "ru" or "en"
	PayType         string // "O" for one-stage
}

// TBankInitResponse is the response from Init.
type TBankInitResponse struct {
	Success     bool   `json:"Success"`
	ErrorCode   string `json:"ErrorCode"`
	Message     string `json:"Message"`
	TerminalKey string `json:"TerminalKey"`
	Status      string `json:"Status"`
	PaymentId   string `json:"PaymentId"`
	OrderId     string `json:"OrderId"`
	Amount      int64  `json:"Amount"`
	PaymentURL  string `json:"PaymentURL"`
}

// TBankGetStateResponse is the response from GetState.
type TBankGetStateResponse struct {
	Success     bool   `json:"Success"`
	ErrorCode   string `json:"ErrorCode"`
	Message     string `json:"Message"`
	TerminalKey string `json:"TerminalKey"`
	Status      string `json:"Status"`
	PaymentId   string `json:"PaymentId"`
	OrderId     string `json:"OrderId"`
	Amount      int64  `json:"Amount"`
}

// TBankCancelResponse is the response from Cancel.
type TBankCancelResponse struct {
	Success   bool   `json:"Success"`
	ErrorCode string `json:"ErrorCode"`
	Message   string `json:"Message"`
	Status    string `json:"Status"`
	PaymentId string `json:"PaymentId"`
	Amount    int64  `json:"Amount"`
}

// GenerateToken creates the Token for T-Bank API requests.
// Algorithm: collect all root-level string params, add Password, sort by key,
// concatenate values, SHA-256 hash, return lowercase hex.
func (c *TBankClient) GenerateToken(params map[string]string) string {
	// Add password to params for hashing (do not mutate the original map).
	merged := make(map[string]string, len(params)+1)
	for k, v := range params {
		if k == "Token" {
			continue
		}
		merged[k] = v
	}
	merged["Password"] = c.password

	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var sb strings.Builder
	for _, k := range keys {
		sb.WriteString(merged[k])
	}

	hash := sha256.Sum256([]byte(sb.String()))
	return hex.EncodeToString(hash[:])
}

// VerifyNotificationToken verifies a webhook signature from T-Bank.
func (c *TBankClient) VerifyNotificationToken(params map[string]string, receivedToken string) bool {
	expected := c.GenerateToken(params)
	return expected == receivedToken
}

// Init creates a payment and returns PaymentId + PaymentURL.
func (c *TBankClient) Init(ctx context.Context, req TBankInitRequest) (*TBankInitResponse, error) {
	// String params for token generation.
	tokenParams := map[string]string{
		"TerminalKey": c.terminalKey,
		"Amount":      strconv.FormatInt(req.Amount, 10),
		"OrderId":     req.OrderId,
		"Description": req.Description,
		"PayType":     req.PayType,
	}
	if req.CustomerKey != "" {
		tokenParams["CustomerKey"] = req.CustomerKey
	}
	if req.NotificationURL != "" {
		tokenParams["NotificationURL"] = req.NotificationURL
	}
	if req.SuccessURL != "" {
		tokenParams["SuccessURL"] = req.SuccessURL
	}
	if req.FailURL != "" {
		tokenParams["FailURL"] = req.FailURL
	}
	if req.Language != "" {
		tokenParams["Language"] = req.Language
	}

	token := c.GenerateToken(tokenParams)

	// Build the actual request body with proper types (Amount as number).
	reqBody := map[string]interface{}{
		"TerminalKey": c.terminalKey,
		"Amount":      req.Amount,
		"OrderId":     req.OrderId,
		"Description": req.Description,
		"PayType":     req.PayType,
		"Token":       token,
	}
	if req.CustomerKey != "" {
		reqBody["CustomerKey"] = req.CustomerKey
	}
	if req.NotificationURL != "" {
		reqBody["NotificationURL"] = req.NotificationURL
	}
	if req.SuccessURL != "" {
		reqBody["SuccessURL"] = req.SuccessURL
	}
	if req.FailURL != "" {
		reqBody["FailURL"] = req.FailURL
	}
	if req.Language != "" {
		reqBody["Language"] = req.Language
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshalling TBank Init request: %w", err)
	}

	slog.Info("TBank Init request", "order_id", req.OrderId, "amount", req.Amount)

	var result TBankInitResponse
	if err := c.doRequest(ctx, "Init", body, &result); err != nil {
		return nil, err
	}

	if !result.Success {
		slog.Warn("TBank Init failed",
			"order_id", req.OrderId,
			"error_code", result.ErrorCode,
			"message", result.Message,
		)
		return &result, fmt.Errorf("TBank Init error %s: %s", result.ErrorCode, result.Message)
	}

	slog.Info("TBank Init success", "order_id", result.OrderId, "payment_id", result.PaymentId)
	return &result, nil
}

// GetState checks payment status.
func (c *TBankClient) GetState(ctx context.Context, paymentID string) (*TBankGetStateResponse, error) {
	params := map[string]string{
		"TerminalKey": c.terminalKey,
		"PaymentId":   paymentID,
	}
	params["Token"] = c.GenerateToken(params)

	body, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshalling TBank GetState request: %w", err)
	}

	slog.Info("TBank GetState request", "payment_id", paymentID)

	var result TBankGetStateResponse
	if err := c.doRequest(ctx, "GetState", body, &result); err != nil {
		return nil, err
	}

	if !result.Success {
		slog.Warn("TBank GetState failed",
			"payment_id", paymentID,
			"error_code", result.ErrorCode,
			"message", result.Message,
		)
		return &result, fmt.Errorf("TBank GetState error %s: %s", result.ErrorCode, result.Message)
	}

	slog.Info("TBank GetState success", "payment_id", result.PaymentId, "status", result.Status)
	return &result, nil
}

// Cancel cancels or refunds a payment. If amount is 0, the full amount is cancelled.
func (c *TBankClient) Cancel(ctx context.Context, paymentID string, amount int64) (*TBankCancelResponse, error) {
	params := map[string]string{
		"TerminalKey": c.terminalKey,
		"PaymentId":   paymentID,
	}
	if amount > 0 {
		params["Amount"] = strconv.FormatInt(amount, 10)
	}
	params["Token"] = c.GenerateToken(params)

	body, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshalling TBank Cancel request: %w", err)
	}

	slog.Info("TBank Cancel request", "payment_id", paymentID, "amount", amount)

	var result TBankCancelResponse
	if err := c.doRequest(ctx, "Cancel", body, &result); err != nil {
		return nil, err
	}

	if !result.Success {
		slog.Warn("TBank Cancel failed",
			"payment_id", paymentID,
			"error_code", result.ErrorCode,
			"message", result.Message,
		)
		return &result, fmt.Errorf("TBank Cancel error %s: %s", result.ErrorCode, result.Message)
	}

	slog.Info("TBank Cancel success", "payment_id", result.PaymentId, "status", result.Status)
	return &result, nil
}

// doRequest sends a POST request to a T-Bank API endpoint and decodes the JSON response.
func (c *TBankClient) doRequest(ctx context.Context, endpoint string, body []byte, result interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("creating TBank %s request: %w", endpoint, err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("sending request to TBank %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("TBank %s returned status %d: %s", endpoint, resp.StatusCode, string(respBody))
	}

	if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
		return fmt.Errorf("decoding TBank %s response: %w", endpoint, err)
	}

	return nil
}
