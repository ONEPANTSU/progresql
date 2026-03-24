package rest

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/onepantsu/progressql/backend/internal/auth"
	"go.uber.org/zap"
)

// requestIDKey is an unexported type for the request-id context key.
type requestIDKey struct{}

// RequestIDFromContext extracts the request ID from the context.
// Returns empty string if not present.
func RequestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// LoggingMiddleware logs each HTTP request with method, path, status, duration_ms,
// request_id, and user_id (when available from JWT claims).
// It generates a UUID per request, stores it in context, and adds it
// to the X-Request-ID response header.
func LoggingMiddleware(log *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Generate or reuse request ID.
			reqID := r.Header.Get("X-Request-ID")
			if reqID == "" {
				reqID = uuid.New().String()
			}

			// Store in context and set response header.
			ctx := context.WithValue(r.Context(), requestIDKey{}, reqID)
			r = r.WithContext(ctx)
			w.Header().Set("X-Request-ID", reqID)

			// Wrap writer to capture status code.
			rec := &loggingRecorder{ResponseWriter: w, statusCode: http.StatusOK}
			next.ServeHTTP(rec, r)

			duration := time.Since(start)

			fields := []zap.Field{
				zap.String("request_id", reqID),
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", rec.statusCode),
				zap.Int64("duration_ms", duration.Milliseconds()),
			}

			// Add user_id if JWT claims are present in context.
			if claims := auth.ClaimsFromContext(r.Context()); claims != nil && claims.UserID != "" {
				fields = append(fields, zap.String("user_id", claims.UserID))
			}

			// Skip noisy health/metrics endpoints at info level.
			path := r.URL.Path
			if path == "/api/v1/health" || path == "/metrics" || path == "/api/v1/metrics" {
				log.Debug("http request", fields...)
			} else {
				log.Info("http request", fields...)
			}
		})
	}
}

// loggingRecorder wraps http.ResponseWriter to capture the status code for logging.
type loggingRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *loggingRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}
