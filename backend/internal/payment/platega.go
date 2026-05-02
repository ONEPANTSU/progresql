package payment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const plategaBaseURL = "https://app.platega.io"

// PlategaClient is an HTTP client for the Platega.io payment API.
type PlategaClient struct {
	merchantID string
	apiKey     string
	httpClient *http.Client
}

// NewPlategaClient creates a new Platega.io API client.
func NewPlategaClient(merchantID, apiKey string) *PlategaClient {
	return &PlategaClient{
		merchantID: merchantID,
		apiKey:     apiKey,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// PlategaPaymentDetails holds amount and currency for a Platega transaction.
type PlategaPaymentDetails struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// PlategaTransactionRequest is the payload sent to Platega to create a transaction.
type PlategaTransactionRequest struct {
	PaymentMethod  int                    `json:"paymentMethod"`
	PaymentDetails PlategaPaymentDetails  `json:"paymentDetails"`
	Description    string                 `json:"description"`
	Return         string                 `json:"return"`
	FailedURL      string                 `json:"failedUrl"`
	Payload        string                 `json:"payload"`
}

// PlategaTransactionResponse is the response returned by Platega after transaction creation.
type PlategaTransactionResponse struct {
	TransactionID string `json:"transactionId"`
	Redirect      string `json:"redirect"`
	Status        string `json:"status"`
}

// CreateInvoice creates a payment transaction via the Platega.io API.
// paymentMethod: 2=SBP, 3=ERIP, 11=Card, 12=International, 13=Crypto.
// If paymentMethod is 0, defaults to 11 (Card).
func (c *PlategaClient) CreateInvoice(amount float64, currency, orderID, email, successURL, failURL string, paymentMethod int) (*PlategaTransactionResponse, error) {
	if paymentMethod == 0 {
		paymentMethod = 11
	}
	if successURL == "" {
		successURL = "https://progresql.com"
	}
	if failURL == "" {
		failURL = "https://progresql.com"
	}

	reqBody := PlategaTransactionRequest{
		PaymentMethod: paymentMethod,
		PaymentDetails: PlategaPaymentDetails{
			Amount:   amount,
			Currency: currency,
		},
		Description: fmt.Sprintf("ProgreSQL Pro — %s", email),
		Return:      successURL,
		FailedURL:   failURL,
		Payload:     orderID,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshalling Platega request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, plategaBaseURL+"/transaction/process", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-MerchantId", c.merchantID)
	req.Header.Set("X-Secret", c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sending request to Platega: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("platega returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var result PlategaTransactionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding Platega response: %w", err)
	}

	return &result, nil
}
