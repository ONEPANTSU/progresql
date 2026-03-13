package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

// ModelInfo describes an available LLM model.
type ModelInfo struct {
	ID       string `json:"id"        mapstructure:"id"`
	Name     string `json:"name"      mapstructure:"name"`
	Provider string `json:"provider"  mapstructure:"provider"`
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

	// CryptoCloud payment gateway settings.
	CryptoCloudAPIKey string `mapstructure:"cryptocloud_api_key"`
	CryptoCloudShopID string `mapstructure:"cryptocloud_shop_id"`
	CryptoCloudSecret string `mapstructure:"cryptocloud_secret"`

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
	v.SetDefault("cryptocloud_api_key", "")
	v.SetDefault("cryptocloud_shop_id", "")
	v.SetDefault("cryptocloud_secret", "")

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
		{ID: "qwen/qwen3-coder", Name: "Qwen 3 Coder", Provider: "openrouter"},
		{ID: "openai/gpt-oss-120b", Name: "GPT-OSS 120B", Provider: "openrouter"},
		{ID: "qwen/qwen3-vl-32b-instruct", Name: "Qwen 3 VL 32B", Provider: "openrouter"},
	}
}
