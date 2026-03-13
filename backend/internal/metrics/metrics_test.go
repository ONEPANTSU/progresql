package metrics

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestNew(t *testing.T) {
	c := New()
	if c == nil {
		t.Fatal("expected non-nil collector")
	}
	snap := c.Snapshot()
	if snap.TotalRequests != 0 || snap.TotalTokens != 0 || snap.TotalErrors != 0 {
		t.Fatalf("expected zero counters, got %+v", snap)
	}
	if snap.Duration.Count != 0 {
		t.Fatalf("expected zero duration count, got %d", snap.Duration.Count)
	}
	if snap.UptimeSeconds <= 0 {
		t.Fatal("expected positive uptime")
	}
}

func TestRecordRequest(t *testing.T) {
	c := New()
	c.RecordRequest()
	c.RecordRequest()
	c.RecordRequest()
	snap := c.Snapshot()
	if snap.TotalRequests != 3 {
		t.Fatalf("expected 3, got %d", snap.TotalRequests)
	}
}

func TestRecordTokens(t *testing.T) {
	c := New()
	c.RecordTokens(100)
	c.RecordTokens(250)
	snap := c.Snapshot()
	if snap.TotalTokens != 350 {
		t.Fatalf("expected 350, got %d", snap.TotalTokens)
	}
}

func TestRecordError(t *testing.T) {
	c := New()
	c.RecordError()
	c.RecordError()
	snap := c.Snapshot()
	if snap.TotalErrors != 2 {
		t.Fatalf("expected 2, got %d", snap.TotalErrors)
	}
}

func TestRecordDuration(t *testing.T) {
	c := New()
	c.RecordDuration(100)
	c.RecordDuration(200)
	c.RecordDuration(300)
	snap := c.Snapshot()
	if snap.Duration.Count != 3 {
		t.Fatalf("expected 3, got %d", snap.Duration.Count)
	}
	if snap.Duration.Min != 100 {
		t.Fatalf("expected min=100, got %f", snap.Duration.Min)
	}
	if snap.Duration.Max != 300 {
		t.Fatalf("expected max=300, got %f", snap.Duration.Max)
	}
	if snap.Duration.Avg != 200 {
		t.Fatalf("expected avg=200, got %f", snap.Duration.Avg)
	}
	if snap.Duration.P50 != 200 {
		t.Fatalf("expected p50=200, got %f", snap.Duration.P50)
	}
}

func TestDurationPercentiles(t *testing.T) {
	c := New()
	// Add 100 durations: 1, 2, 3, ..., 100
	for i := 1; i <= 100; i++ {
		c.RecordDuration(float64(i))
	}
	snap := c.Snapshot()
	if snap.Duration.Count != 100 {
		t.Fatalf("expected 100, got %d", snap.Duration.Count)
	}
	if snap.Duration.Min != 1 {
		t.Fatalf("expected min=1, got %f", snap.Duration.Min)
	}
	if snap.Duration.Max != 100 {
		t.Fatalf("expected max=100, got %f", snap.Duration.Max)
	}
	// P95 should be around 95
	if math.Abs(snap.Duration.P95-95.04) > 0.5 {
		t.Fatalf("expected p95 ~95, got %f", snap.Duration.P95)
	}
	// P99 should be around 99
	if math.Abs(snap.Duration.P99-99.02) > 0.5 {
		t.Fatalf("expected p99 ~99, got %f", snap.Duration.P99)
	}
}

func TestHandler(t *testing.T) {
	c := New()
	c.RecordRequest()
	c.RecordTokens(42)
	c.RecordError()
	c.RecordDuration(150.5)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	w := httptest.NewRecorder()
	c.Handler()(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected application/json, got %s", ct)
	}

	var snap Snapshot
	if err := json.NewDecoder(w.Body).Decode(&snap); err != nil {
		t.Fatalf("failed to decode JSON: %v", err)
	}
	if snap.TotalRequests != 1 {
		t.Fatalf("expected 1 request, got %d", snap.TotalRequests)
	}
	if snap.TotalTokens != 42 {
		t.Fatalf("expected 42 tokens, got %d", snap.TotalTokens)
	}
	if snap.TotalErrors != 1 {
		t.Fatalf("expected 1 error, got %d", snap.TotalErrors)
	}
	if snap.Duration.Count != 1 {
		t.Fatalf("expected 1 duration, got %d", snap.Duration.Count)
	}
	if snap.UptimeSeconds <= 0 {
		t.Fatal("expected positive uptime")
	}
}

func TestConcurrentAccess(t *testing.T) {
	c := New()
	const goroutines = 100
	var wg sync.WaitGroup
	wg.Add(goroutines * 3)

	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			c.RecordRequest()
		}()
		go func() {
			defer wg.Done()
			c.RecordTokens(10)
		}()
		go func(v float64) {
			defer wg.Done()
			c.RecordDuration(v)
		}(float64(i))
	}
	wg.Wait()

	snap := c.Snapshot()
	if snap.TotalRequests != goroutines {
		t.Fatalf("expected %d requests, got %d", goroutines, snap.TotalRequests)
	}
	if snap.TotalTokens != goroutines*10 {
		t.Fatalf("expected %d tokens, got %d", goroutines*10, snap.TotalTokens)
	}
	if snap.Duration.Count != goroutines {
		t.Fatalf("expected %d durations, got %d", goroutines, snap.Duration.Count)
	}
}

func TestSortFloat64s(t *testing.T) {
	input := []float64{5, 3, 1, 4, 2}
	sortFloat64s(input)
	expected := []float64{1, 2, 3, 4, 5}
	for i, v := range input {
		if v != expected[i] {
			t.Fatalf("index %d: expected %f, got %f", i, expected[i], v)
		}
	}
}

func TestPercentileSingleValue(t *testing.T) {
	c := New()
	c.RecordDuration(42)
	snap := c.Snapshot()
	if snap.Duration.P50 != 42 || snap.Duration.P95 != 42 || snap.Duration.P99 != 42 {
		t.Fatalf("expected all percentiles=42 for single value, got p50=%f p95=%f p99=%f",
			snap.Duration.P50, snap.Duration.P95, snap.Duration.P99)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	c := New()
	c.RecordDuration(10)
	snap1 := c.Snapshot()

	// Add more data after taking snapshot
	c.RecordDuration(20)
	c.RecordRequest()
	snap2 := c.Snapshot()

	if snap1.Duration.Count != 1 {
		t.Fatalf("snap1 should have 1 duration, got %d", snap1.Duration.Count)
	}
	if snap2.Duration.Count != 2 {
		t.Fatalf("snap2 should have 2 durations, got %d", snap2.Duration.Count)
	}
	if snap1.TotalRequests != 0 {
		t.Fatalf("snap1 should have 0 requests, got %d", snap1.TotalRequests)
	}
	if snap2.TotalRequests != 1 {
		t.Fatalf("snap2 should have 1 request, got %d", snap2.TotalRequests)
	}
}
