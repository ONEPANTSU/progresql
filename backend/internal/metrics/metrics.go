package metrics

import (
	"encoding/json"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Collector aggregates metrics for agent pipeline requests.
// All methods are safe for concurrent use.
type Collector struct {
	totalRequests atomic.Int64
	totalTokens   atomic.Int64
	totalErrors   atomic.Int64

	mu        sync.Mutex
	durations []float64 // milliseconds
	startTime time.Time
}

// New creates a new Collector.
func New() *Collector {
	return &Collector{
		durations: make([]float64, 0, 1024),
		startTime: time.Now(),
	}
}

// RecordRequest increments the total request counter.
func (c *Collector) RecordRequest() {
	c.totalRequests.Add(1)
}

// RecordTokens adds to the total token counter.
func (c *Collector) RecordTokens(n int) {
	c.totalTokens.Add(int64(n))
}

// RecordError increments the total error counter.
func (c *Collector) RecordError() {
	c.totalErrors.Add(1)
}

// RecordDuration records a request duration in milliseconds.
func (c *Collector) RecordDuration(ms float64) {
	c.mu.Lock()
	c.durations = append(c.durations, ms)
	c.mu.Unlock()
}

// Snapshot holds a point-in-time view of all metrics.
type Snapshot struct {
	TotalRequests int64            `json:"total_requests"`
	TotalTokens   int64            `json:"total_tokens"`
	TotalErrors   int64            `json:"total_errors"`
	Duration      DurationSnapshot `json:"request_duration_ms"`
	UptimeSeconds float64          `json:"uptime_seconds"`
}

// DurationSnapshot holds histogram-like stats for request durations.
type DurationSnapshot struct {
	Count int     `json:"count"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Avg   float64 `json:"avg"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
}

// Snapshot returns a point-in-time view of all collected metrics.
func (c *Collector) Snapshot() Snapshot {
	c.mu.Lock()
	durs := make([]float64, len(c.durations))
	copy(durs, c.durations)
	c.mu.Unlock()

	snap := Snapshot{
		TotalRequests: c.totalRequests.Load(),
		TotalTokens:   c.totalTokens.Load(),
		TotalErrors:   c.totalErrors.Load(),
		UptimeSeconds: time.Since(c.startTime).Seconds(),
	}

	if len(durs) > 0 {
		sortFloat64s(durs)
		snap.Duration = DurationSnapshot{
			Count: len(durs),
			Min:   durs[0],
			Max:   durs[len(durs)-1],
			Avg:   avg(durs),
			P50:   percentile(durs, 50),
			P95:   percentile(durs, 95),
			P99:   percentile(durs, 99),
		}
	}

	return snap
}

// Handler returns an http.HandlerFunc that serves the metrics as JSON.
func (c *Collector) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(c.Snapshot())
	}
}

// --- helpers ---

func avg(sorted []float64) float64 {
	var sum float64
	for _, v := range sorted {
		sum += v
	}
	return math.Round(sum/float64(len(sorted))*100) / 100
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := p / 100 * float64(len(sorted)-1)
	lower := int(math.Floor(idx))
	upper := int(math.Ceil(idx))
	if lower == upper || upper >= len(sorted) {
		return sorted[lower]
	}
	frac := idx - float64(lower)
	return sorted[lower]*(1-frac) + sorted[upper]*frac
}

// sortFloat64s sorts a slice of float64 in ascending order using insertion sort
// (good enough for typical metrics sizes; avoids sort package import for simplicity).
func sortFloat64s(a []float64) {
	for i := 1; i < len(a); i++ {
		key := a[i]
		j := i - 1
		for j >= 0 && a[j] > key {
			a[j+1] = a[j]
			j--
		}
		a[j+1] = key
	}
}
