package rest

import (
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/onepantsu/progressql/backend/internal/metrics"
)

// uuidPattern matches UUID-like segments in URL paths to normalize them.
var uuidPattern = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// normalizePath replaces UUIDs in the path with :id to avoid cardinality explosion.
func normalizePath(path string) string {
	return uuidPattern.ReplaceAllString(path, ":id")
}

// statusRecorder wraps http.ResponseWriter to capture the status code.
type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

// MetricsMiddleware records Prometheus HTTP metrics for every request.
func MetricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		path := normalizePath(r.URL.Path)

		rec := &statusRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(rec, r)

		duration := time.Since(start).Seconds()
		statusCode := strconv.Itoa(rec.statusCode)

		metrics.HTTPRequestsTotal.WithLabelValues(r.Method, path, statusCode).Inc()
		metrics.HTTPRequestDuration.WithLabelValues(r.Method, path).Observe(duration)
	})
}
