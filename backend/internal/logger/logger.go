package logger

import (
	"fmt"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var global *zap.Logger

// Init initializes the global logger based on log level and environment.
// If env is "development", uses a human-readable console encoder.
// Otherwise, uses JSON encoder suitable for production.
func Init(level string, env string) (*zap.Logger, error) {
	lvl, err := zapcore.ParseLevel(level)
	if err != nil {
		return nil, fmt.Errorf("parsing log level %q: %w", level, err)
	}

	var cfg zap.Config
	if env == "development" {
		cfg = zap.NewDevelopmentConfig()
	} else {
		cfg = zap.NewProductionConfig()
	}
	cfg.Level = zap.NewAtomicLevelAt(lvl)

	logger, err := cfg.Build()
	if err != nil {
		return nil, fmt.Errorf("building logger: %w", err)
	}

	global = logger
	return logger, nil
}

// Get returns the global logger. If Init has not been called, returns a no-op logger.
func Get() *zap.Logger {
	if global == nil {
		return zap.NewNop()
	}
	return global
}

// Sync flushes any buffered log entries. Should be called before program exit.
func Sync() {
	if global != nil {
		_ = global.Sync()
	}
}
