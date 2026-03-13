package rest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/onepantsu/progressql/backend/config"
)

func TestHealthHandler(t *testing.T) {
	version := "1.2.3-test"
	handler := healthHandler(version)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", ct)
	}

	var resp healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", resp.Status)
	}
	if resp.Version != version {
		t.Errorf("expected version %q, got %q", version, resp.Version)
	}
}

func TestHealthHandlerDefaultVersion(t *testing.T) {
	handler := healthHandler("0.1.0")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	var resp healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.Version != "0.1.0" {
		t.Errorf("expected version '0.1.0', got %q", resp.Version)
	}
}

func TestModelsHandler(t *testing.T) {
	models := []config.ModelInfo{
		{ID: "test/model-a", Name: "Model A", Provider: "test"},
		{ID: "test/model-b", Name: "Model B", Provider: "test"},
	}
	handler := modelsHandler(models, "test/model-a")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/models", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", ct)
	}

	var resp modelsListResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(resp.Models) != 2 {
		t.Fatalf("expected 2 models, got %d", len(resp.Models))
	}

	if resp.Models[0].ID != "test/model-a" {
		t.Errorf("expected first model ID='test/model-a', got %q", resp.Models[0].ID)
	}
	if !resp.Models[0].IsDefault {
		t.Error("expected first model to be marked as default")
	}
	if resp.Models[1].IsDefault {
		t.Error("expected second model NOT to be default")
	}
}

func TestModelsHandler_EmptyList(t *testing.T) {
	handler := modelsHandler(nil, "")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/models", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var resp modelsListResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if resp.Models == nil {
		t.Error("expected empty slice, got nil")
	}
	if len(resp.Models) != 0 {
		t.Errorf("expected 0 models, got %d", len(resp.Models))
	}
}

func TestModelsHandler_NoDefaultMatch(t *testing.T) {
	models := []config.ModelInfo{
		{ID: "test/model-a", Name: "Model A", Provider: "test"},
	}
	handler := modelsHandler(models, "nonexistent/model")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/models", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	var resp modelsListResponse
	json.NewDecoder(rec.Body).Decode(&resp)

	for _, m := range resp.Models {
		if m.IsDefault {
			t.Errorf("expected no model to be default, but %q is", m.ID)
		}
	}
}
