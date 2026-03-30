package models

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.uber.org/zap"
)

// Model represents a row from the model_catalog table.
type Model struct {
	ID              string  `json:"id"`
	DisplayName     string  `json:"name"`
	Provider        string  `json:"provider"`
	Tier            string  `json:"tier"`
	InputPricePerM  float64 `json:"input_price_per_m"`
	OutputPricePerM float64 `json:"output_price_per_m"`
	IsActive        bool    `json:"is_active"`
	SortOrder       int     `json:"sort_order"`
}

// Service provides cached access to the model catalog.
type Service struct {
	db       *pgxpool.Pool
	logger   *zap.Logger
	mu       sync.RWMutex
	models   []Model
	lastLoad time.Time
	cacheTTL time.Duration
}

// NewService creates a new models Service.
func NewService(db *pgxpool.Pool, logger *zap.Logger) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	return &Service{
		db:       db,
		logger:   logger,
		cacheTTL: 5 * time.Minute,
	}
}

// All returns all active models, loading from DB if cache is stale.
// Returns nil, error if DB is unavailable.
func (s *Service) All(ctx context.Context) ([]Model, error) {
	if s.db == nil {
		return nil, fmt.Errorf("models: database pool is nil")
	}

	s.mu.RLock()
	if s.models != nil && time.Since(s.lastLoad) < s.cacheTTL {
		m := s.models
		s.mu.RUnlock()
		return m, nil
	}
	s.mu.RUnlock()
	return s.reload(ctx)
}

func (s *Service) reload(ctx context.Context) ([]Model, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Double-check after acquiring write lock.
	if s.models != nil && time.Since(s.lastLoad) < s.cacheTTL {
		return s.models, nil
	}

	if s.db == nil {
		return nil, fmt.Errorf("models: database pool is nil")
	}

	rows, err := s.db.Query(ctx,
		`SELECT id, display_name, provider, tier, input_price_per_m, output_price_per_m, is_active, sort_order
		 FROM model_catalog
		 WHERE is_active = TRUE
		 ORDER BY sort_order`)
	if err != nil {
		return nil, fmt.Errorf("models: query: %w", err)
	}
	defer rows.Close()

	var models []Model
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ID, &m.DisplayName, &m.Provider, &m.Tier, &m.InputPricePerM, &m.OutputPricePerM, &m.IsActive, &m.SortOrder); err != nil {
			return nil, fmt.Errorf("models: scan: %w", err)
		}
		models = append(models, m)
	}

	s.models = models
	s.lastLoad = time.Now()
	s.logger.Info("model catalog loaded from DB", zap.Int("count", len(models)))
	return models, nil
}

// FindByID returns a model by exact ID match or fuzzy match for aliased OpenRouter IDs.
func (s *Service) FindByID(ctx context.Context, modelID string) *Model {
	models, err := s.All(ctx)
	if err != nil {
		return nil
	}

	// Exact match.
	for i := range models {
		if models[i].ID == modelID {
			return &models[i]
		}
	}

	// Fuzzy match for aliased OpenRouter IDs.
	// OpenRouter may return versioned IDs like "anthropic/claude-4-sonnet-20250522"
	// for our catalog entry "anthropic/claude-sonnet-4". We normalize both sides
	// by extracting word tokens (ignoring date suffixes and provider prefixes)
	// and checking if all catalog tokens appear in the aliased ID.
	queryNorm := normalizeModelID(modelID)
	for i := range models {
		catalogNorm := normalizeModelID(models[i].ID)
		if fuzzyTokenMatch(catalogNorm, queryNorm) {
			return &models[i]
		}
	}

	return nil
}

// GetTier returns the tier ("budget" or "premium") for the given model ID.
// Returns "budget" if model is not found.
func (s *Service) GetTier(ctx context.Context, modelID string) string {
	m := s.FindByID(ctx, modelID)
	if m != nil {
		return m.Tier
	}
	return "budget"
}

// GetDisplayName returns the display name for the given model ID.
func (s *Service) GetDisplayName(ctx context.Context, modelID string) string {
	m := s.FindByID(ctx, modelID)
	if m != nil {
		return m.DisplayName
	}
	// Fallback: take part after last slash.
	parts := strings.Split(modelID, "/")
	return parts[len(parts)-1]
}

// CalcCostUSD calculates the estimated cost in USD for the given model and token counts.
func (s *Service) CalcCostUSD(ctx context.Context, modelID string, inputTokens, outputTokens int) float64 {
	m := s.FindByID(ctx, modelID)
	if m == nil {
		return 0
	}
	inputCost := float64(inputTokens) * m.InputPricePerM / 1_000_000.0
	outputCost := float64(outputTokens) * m.OutputPricePerM / 1_000_000.0
	return inputCost + outputCost
}

// CalcCostUSDTotal calculates cost using average of input/output price when detailed split is unavailable.
func (s *Service) CalcCostUSDTotal(ctx context.Context, modelID string, totalTokens int) float64 {
	m := s.FindByID(ctx, modelID)
	if m == nil {
		return 0
	}
	avgPricePerToken := (m.InputPricePerM + m.OutputPricePerM) / 2.0 / 1_000_000.0
	return avgPricePerToken * float64(totalTokens)
}

// Invalidate clears the cache, forcing a reload on next access.
func (s *Service) Invalidate() {
	s.mu.Lock()
	s.models = nil
	s.mu.Unlock()
}

// normalizeModelID strips provider prefix and date suffixes, returning lowercase tokens.
// "anthropic/claude-4-sonnet-20250522" -> ["claude", "4", "sonnet"]
// "anthropic/claude-sonnet-4"          -> ["claude", "sonnet", "4"]
func normalizeModelID(id string) []string {
	// Strip provider prefix.
	if idx := strings.LastIndex(id, "/"); idx >= 0 {
		id = id[idx+1:]
	}
	id = strings.ToLower(id)

	parts := strings.FieldsFunc(id, func(r rune) bool { return r == '-' || r == '_' || r == '.' })

	// Remove date-like suffixes (8+ digit tokens like "20250522").
	var tokens []string
	for _, p := range parts {
		if len(p) >= 8 && isAllDigits(p) {
			continue
		}
		tokens = append(tokens, p)
	}
	return tokens
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

// fuzzyTokenMatch returns true if all tokens from catalog appear in query tokens.
// E.g., catalog=["claude","sonnet","4"] matches query=["claude","4","sonnet"].
func fuzzyTokenMatch(catalog, query []string) bool {
	if len(catalog) == 0 {
		return false
	}
	qSet := make(map[string]bool, len(query))
	for _, t := range query {
		qSet[t] = true
	}
	for _, t := range catalog {
		if !qSet[t] {
			return false
		}
	}
	return true
}
