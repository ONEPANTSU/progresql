package logger

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"go.uber.org/zap"
)

func TestInit_DebugLevel(t *testing.T) {
	l, err := Init("debug", "production")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
	// Check that debug level is enabled
	if !l.Core().Enabled(zap.DebugLevel) {
		t.Error("expected debug level to be enabled")
	}
}

func TestInit_InvalidLevel(t *testing.T) {
	_, err := Init("invalid-level", "production")
	if err == nil {
		t.Fatal("expected error for invalid level")
	}
}

func TestGet_BeforeInit(t *testing.T) {
	// Reset global for this test
	old := global
	global = nil
	defer func() { global = old }()

	l := Get()
	if l == nil {
		t.Fatal("Get() should return non-nil even before Init")
	}
}

func TestInit_ProductionJSON(t *testing.T) {
	// Redirect stderr to capture JSON output
	r, w, _ := os.Pipe()
	oldStderr := os.Stderr
	os.Stderr = w

	l, err := Init("info", "production")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}

	l.Info("test message", zap.String("key", "value"), zap.Int("count", 42))
	_ = l.Sync()
	w.Close()
	os.Stderr = oldStderr

	buf := make([]byte, 4096)
	n, _ := r.Read(buf)
	output := string(buf[:n])

	// Production mode outputs JSON
	var logEntry map[string]interface{}
	// Find the JSON line
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if err := json.Unmarshal([]byte(line), &logEntry); err == nil {
			break
		}
	}

	if logEntry == nil {
		t.Fatalf("no valid JSON log entry found in output: %s", output)
	}

	if logEntry["msg"] != "test message" {
		t.Errorf("expected msg='test message', got %v", logEntry["msg"])
	}
	if logEntry["key"] != "value" {
		t.Errorf("expected key='value', got %v", logEntry["key"])
	}
	if logEntry["count"] != float64(42) {
		t.Errorf("expected count=42, got %v", logEntry["count"])
	}
}

func TestInit_DevelopmentMode(t *testing.T) {
	l, err := Init("debug", "development")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
	// Development logger should allow debug
	if !l.Core().Enabled(zap.DebugLevel) {
		t.Error("expected debug level to be enabled in development mode")
	}
}

func TestGet_AfterInit(t *testing.T) {
	l, err := Init("info", "production")
	if err != nil {
		t.Fatalf("Init failed: %v", err)
	}
	got := Get()
	if got == nil {
		t.Fatal("Get() should return non-nil after Init")
	}
	_ = l
}

func TestSync(t *testing.T) {
	// Sync before Init should not panic.
	old := global
	global = nil
	Sync()
	global = old

	// Sync after Init should not panic.
	_, err := Init("info", "production")
	if err != nil {
		t.Fatalf("Init: %v", err)
	}
	Sync() // should not panic
}

func TestInit_WithVersion(t *testing.T) {
	l, err := Init("info", "production", "1.2.3")
	if err != nil {
		t.Fatalf("Init with version: %v", err)
	}
	if l == nil {
		t.Fatal("expected non-nil logger")
	}
}
