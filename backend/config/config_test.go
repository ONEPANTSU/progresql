package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfig_Defaults(t *testing.T) {
	cfg, err := LoadConfig("/nonexistent")
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.ServerPort != "8080" {
		t.Errorf("expected ServerPort=8080, got %s", cfg.ServerPort)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected LogLevel=info, got %s", cfg.LogLevel)
	}
	if cfg.Version != "0.1.0" {
		t.Errorf("expected Version=0.1.0, got %s", cfg.Version)
	}
}

func TestLoadConfig_FromYAML(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `server_port: "9090"
jwt_secret: "test-secret"
openrouter_api_key: "sk-test-123"
log_level: "debug"
version: "1.0.0"
`
	err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yamlContent), 0644)
	if err != nil {
		t.Fatalf("failed to write config.yaml: %v", err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.ServerPort != "9090" {
		t.Errorf("expected ServerPort=9090, got %s", cfg.ServerPort)
	}
	if cfg.JWTSecret != "test-secret" {
		t.Errorf("expected JWTSecret=test-secret, got %s", cfg.JWTSecret)
	}
	if cfg.OpenRouterAPIKey != "sk-test-123" {
		t.Errorf("expected OpenRouterAPIKey=sk-test-123, got %s", cfg.OpenRouterAPIKey)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("expected LogLevel=debug, got %s", cfg.LogLevel)
	}
}

func TestLoadConfig_DefaultModels(t *testing.T) {
	cfg, err := LoadConfig("/nonexistent")
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if len(cfg.AvailableModels) == 0 {
		t.Fatal("expected default models to be populated, got empty")
	}

	// Check that the default model list includes at least the main model.
	found := false
	for _, m := range cfg.AvailableModels {
		if m.ID == "qwen/qwen3-coder" {
			found = true
			if m.Name != "Qwen 3 Coder" {
				t.Errorf("expected Name='Qwen 3 Coder', got %q", m.Name)
			}
			if m.Provider != "openrouter" {
				t.Errorf("expected Provider='openrouter', got %q", m.Provider)
			}
		}
	}
	if !found {
		t.Error("expected qwen/qwen3-coder in default models")
	}
}

func TestLoadConfig_ModelsFromYAML(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `
available_models:
  - id: "custom/model-1"
    name: "Custom Model"
    provider: "custom"
  - id: "custom/model-2"
    name: "Custom Model 2"
    provider: "custom"
`
	err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yamlContent), 0644)
	if err != nil {
		t.Fatalf("failed to write config.yaml: %v", err)
	}

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if len(cfg.AvailableModels) != 2 {
		t.Fatalf("expected 2 models from YAML, got %d", len(cfg.AvailableModels))
	}
	if cfg.AvailableModels[0].ID != "custom/model-1" {
		t.Errorf("expected first model ID='custom/model-1', got %q", cfg.AvailableModels[0].ID)
	}
	if cfg.AvailableModels[1].Name != "Custom Model 2" {
		t.Errorf("expected second model Name='Custom Model 2', got %q", cfg.AvailableModels[1].Name)
	}
}

func TestLoadConfig_EnvOverridesYAML(t *testing.T) {
	dir := t.TempDir()
	yamlContent := `server_port: "9090"
log_level: "debug"
`
	err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(yamlContent), 0644)
	if err != nil {
		t.Fatalf("failed to write config.yaml: %v", err)
	}

	t.Setenv("PROGRESSQL_SERVER_PORT", "3000")
	t.Setenv("PROGRESSQL_LOG_LEVEL", "warn")

	cfg, err := LoadConfig(dir)
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}

	if cfg.ServerPort != "3000" {
		t.Errorf("expected env override ServerPort=3000, got %s", cfg.ServerPort)
	}
	if cfg.LogLevel != "warn" {
		t.Errorf("expected env override LogLevel=warn, got %s", cfg.LogLevel)
	}
}
