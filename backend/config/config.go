package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

// DefaultAutocompleteModelID is the default model used for inline code completions.
const DefaultAutocompleteModelID = "openai/gpt-4o-mini"

// ModelInfo describes an available LLM model.
type ModelInfo struct {
	ID              string  `json:"id"                        mapstructure:"id"`
	Name            string  `json:"name"                      mapstructure:"name"`
	Provider        string  `json:"provider"                  mapstructure:"provider"`
	Tier            string  `json:"tier"                      mapstructure:"tier"`                           // "budget" or "premium"
	InputPricePerM  float64 `json:"input_price_per_m"         mapstructure:"input_price_per_m"`              // USD per 1M tokens
	OutputPricePerM float64 `json:"output_price_per_m"        mapstructure:"output_price_per_m"`             // USD per 1M tokens
	IsDefault       bool    `json:"is_default,omitempty"       mapstructure:"is_default"`
}

// Config holds all application configuration.
type Config struct {
	ServerPort         string      `mapstructure:"server_port"`
	JWTSecret          string      `mapstructure:"jwt_secret"`
	OpenRouterAPIKey   string      `mapstructure:"openrouter_api_key"`
	HTTPBaseURL        string      `mapstructure:"http_base_url"`
	HTTPModel          string      `mapstructure:"http_model"`
	LogLevel           string      `mapstructure:"log_level"`
	Environment        string      `mapstructure:"environment"`
	Version            string      `mapstructure:"version"`
	RateLimitPerMin    int         `mapstructure:"rate_limit_per_min"`
	ToolCallTimeoutSec int         `mapstructure:"tool_call_timeout"`
	AvailableModels    []ModelInfo `mapstructure:"available_models"`

	// PostgreSQL connection string.
	DatabaseURL string `mapstructure:"database_url"`

	// SMTP settings for email verification.
	SMTPHost     string `mapstructure:"smtp_host"`
	SMTPPort     int    `mapstructure:"smtp_port"`
	SMTPUser     string `mapstructure:"smtp_user"`
	SMTPPassword string `mapstructure:"smtp_password"`
	SMTPFrom     string `mapstructure:"smtp_from"`

	// Platega.io payment gateway settings.
	PlategaMerchantID string `mapstructure:"platega_merchant_id"`
	PlategaAPIKey     string `mapstructure:"platega_api_key"`
	PlategaSecret     string `mapstructure:"platega_secret"`

	// Admin user IDs (comma-separated in env var PROGRESSQL_ADMIN_USER_IDS).
	AdminUserIDs []string `mapstructure:"admin_user_ids"`
}

// LoadConfig reads configuration from config.yaml and environment variables.
// Environment variables take precedence over config file values.
// Env vars are prefixed with PROGRESSQL_ (e.g. PROGRESSQL_SERVER_PORT).
func LoadConfig(configPath ...string) (*Config, error) {
	v := viper.New()

	// Defaults
	v.SetDefault("server_port", "8080")
	v.SetDefault("jwt_secret", "change-me-in-production")
	v.SetDefault("openrouter_api_key", "")
	v.SetDefault("http_base_url", "https://openrouter.ai/api/v1")
	v.SetDefault("http_model", "qwen/qwen3-coder")
	v.SetDefault("log_level", "info")
	v.SetDefault("environment", "production")
	v.SetDefault("version", "0.1.0")
	v.SetDefault("rate_limit_per_min", 10)
	v.SetDefault("tool_call_timeout", 15)
	v.SetDefault("database_url", "postgres://progressql:progressql@postgres:5432/progressql?sslmode=disable")
	v.SetDefault("smtp_host", "smtp.yandex.ru")
	v.SetDefault("smtp_port", 465)
	v.SetDefault("smtp_user", "")
	v.SetDefault("smtp_password", "")
	v.SetDefault("smtp_from", "progresql.noreply@yandex.ru")
	v.SetDefault("platega_merchant_id", "")
	v.SetDefault("platega_api_key", "")
	v.SetDefault("platega_secret", "")

	// Config file
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	if len(configPath) > 0 && configPath[0] != "" {
		v.AddConfigPath(configPath[0])
	}
	v.AddConfigPath(".")
	v.AddConfigPath("./backend")

	// Environment variables with PROGRESSQL_ prefix
	v.SetEnvPrefix("PROGRESSQL")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// Read config file (optional — env vars and defaults still work)
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshalling config: %w", err)
	}

	// If no models configured via YAML, use sensible defaults.
	if len(cfg.AvailableModels) == 0 {
		cfg.AvailableModels = DefaultModels()
	}

	return &cfg, nil
}

// DefaultModels returns the built-in list of available LLM models.
func DefaultModels() []ModelInfo {
	return []ModelInfo{
		// --- Budget tier ---
		{ID: "qwen/qwen3-coder", Name: "Qwen 3 Coder", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.20, OutputPricePerM: 0.60},
		{ID: "openai/gpt-4o-mini", Name: "GPT-4o Mini", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.15, OutputPricePerM: 0.60},
		{ID: "google/gemini-2.0-flash-001", Name: "Gemini 2.0 Flash", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.10, OutputPricePerM: 0.40},
		{ID: "deepseek/deepseek-chat-v3-0324", Name: "DeepSeek V3 0324", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.20, OutputPricePerM: 0.60},
		{ID: "qwen/qwen3-vl-32b-instruct", Name: "Qwen 3 VL 32B", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.20, OutputPricePerM: 0.60},
		{ID: "openai/gpt-oss-120b", Name: "GPT-OSS 120B", Provider: "openrouter", Tier: "budget", InputPricePerM: 0.20, OutputPricePerM: 0.60},

		// --- Premium tier ---
		{ID: "openai/gpt-4.1", Name: "GPT-4.1", Provider: "openrouter", Tier: "premium", InputPricePerM: 2.00, OutputPricePerM: 8.00},
		{ID: "openai/o4-mini", Name: "o4 Mini", Provider: "openrouter", Tier: "premium", InputPricePerM: 1.10, OutputPricePerM: 4.40},
		{ID: "anthropic/claude-sonnet-4", Name: "Claude Sonnet 4", Provider: "openrouter", Tier: "premium", InputPricePerM: 3.00, OutputPricePerM: 15.00},
		{ID: "anthropic/claude-opus-4", Name: "Claude Opus 4", Provider: "openrouter", Tier: "premium", InputPricePerM: 15.00, OutputPricePerM: 75.00},
		{ID: "google/gemini-2.5-pro-preview", Name: "Gemini 2.5 Pro", Provider: "openrouter", Tier: "premium", InputPricePerM: 1.25, OutputPricePerM: 10.00},
		{ID: "deepseek/deepseek-r1", Name: "DeepSeek R1", Provider: "openrouter", Tier: "premium", InputPricePerM: 0.55, OutputPricePerM: 2.19},
		{ID: "qwen/qwen3-235b-a22b", Name: "Qwen 3 235B", Provider: "openrouter", Tier: "premium", InputPricePerM: 0.20, OutputPricePerM: 1.20},
	}
}
