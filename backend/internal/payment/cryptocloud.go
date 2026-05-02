package payment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const cryptoCloudBaseURL = "https://api.cryptocloud.plus/v2"

// CryptoCloudClient is an HTTP client for the CryptoCloud payment API.
type CryptoCloudClient struct {
	apiKey     string
	shopID     string
	httpClient *http.Client
}

// NewCryptoCloudClient creates a new CryptoCloud API client.
func NewCryptoCloudClient(apiKey, shopID string) *CryptoCloudClient {
	return &CryptoCloudClient{
		apiKey: apiKey,
		shopID: shopID,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// CreateInvoiceRequest is the payload sent to CryptoCloud to create an invoice.
type CreateInvoiceRequest struct {
	Amount   float64 `json:"amount"`
	ShopID   string  `json:"shop_id"`
	Currency string  `json:"currency"`
	OrderID  string  `json:"order_id"`
	Email    string  `json:"email,omitempty"`
}

// CreateInvoiceResponse is the response returned by CryptoCloud after invoice creation.
type CreateInvoiceResponse struct {
	Status string `json:"status"`
	Result struct {
		UUID    string `json:"uuid"`
		Link    string `json:"link"`
		OrderID string `json:"order_id"`
	} `json:"result"`
}

// CreateInvoice creates a payment invoice via the CryptoCloud API.
func (c *CryptoCloudClient) CreateInvoice(amount float64, currency, orderID, email string) (*CreateInvoiceResponse, error) {
	reqBody := CreateInvoiceRequest{
		Amount:   amount,
		ShopID:   c.shopID,
		Currency: currency,
		OrderID:  orderID,
		Email:    email,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshalling invoice request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, cryptoCloudBaseURL+"/invoice/create", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Token "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("sending request to CryptoCloud: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("CryptoCloud returned status %d", resp.StatusCode)
	}

	var result CreateInvoiceResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding CryptoCloud response: %w", err)
	}

	return &result, nil
}
