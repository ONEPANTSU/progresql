package exchange

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
)

const (
	cbrURL         = "https://www.cbr-xml-daily.ru/daily_json.js"
	fallbackRate   = 90.0
	cacheDuration  = 1 * time.Hour
	requestTimeout = 10 * time.Second
)

// cbrResponse represents the relevant part of the CBR JSON response.
type cbrResponse struct {
	Valute struct {
		USD struct {
			Value float64 `json:"Value"`
		} `json:"USD"`
	} `json:"Valute"`
}

// RateService provides a cached, thread-safe USD/RUB exchange rate
// fetched from the CBR public API.
type RateService struct {
	mu        sync.RWMutex
	rate      float64
	updatedAt time.Time
	logger    *zap.Logger
	stopCh    chan struct{}
}

// NewRateService creates a new RateService, fetches the initial rate,
// and starts a background goroutine that refreshes the rate every hour.
func NewRateService(logger *zap.Logger) *RateService {
	if logger == nil {
		logger = zap.NewNop()
	}

	s := &RateService{
		rate:   fallbackRate,
		logger: logger,
		stopCh: make(chan struct{}),
	}

	// Fetch initial rate synchronously (best-effort).
	s.refresh()

	// Start background refresh.
	go s.backgroundRefresh()

	return s
}

// GetUSDToRUB returns the current cached USD to RUB exchange rate.
// If the cache is stale or was never populated, returns the fallback rate.
func (s *RateService) GetUSDToRUB() float64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.rate
}

// Stop terminates the background refresh goroutine.
func (s *RateService) Stop() {
	close(s.stopCh)
}

func (s *RateService) backgroundRefresh() {
	ticker := time.NewTicker(cacheDuration)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.refresh()
		case <-s.stopCh:
			return
		}
	}
}

func (s *RateService) refresh() {
	rate, err := fetchRate()
	if err != nil {
		s.logger.Warn("failed to fetch USD/RUB rate from CBR, using cached/fallback",
			zap.Error(err))
		return
	}

	s.mu.Lock()
	s.rate = rate
	s.updatedAt = time.Now()
	s.mu.Unlock()

	s.logger.Info("USD/RUB rate updated", zap.Float64("rate", rate))
}

func fetchRate() (float64, error) {
	client := &http.Client{Timeout: requestTimeout}

	resp, err := client.Get(cbrURL)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var data cbrResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, err
	}

	rate := data.Valute.USD.Value
	if rate <= 0 {
		return 0, err
	}

	return rate, nil
}
