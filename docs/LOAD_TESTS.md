# ProgreSQL — Load Test Results

## Test Configuration

**Tool:** k6 v0.55+
**Target:** `https://progresql.com`
**Date:** 2026-03-29
**Script:** `k6/load-test.js`

### Scenarios

| Scenario | Type | VUs | Duration | Purpose |
|----------|------|-----|----------|---------|
| Smoke | Constant 3 VU | 3 | 30s | Baseline sanity check |
| Load | Ramp 0→20→50→0 | 50 max | 3m30s | Normal expected load |
| Spike | Ramp 0→100→0 | 100 max | 50s | Sudden traffic burst |
| AI Load | Ramp 0→5→15→0 | 15 max | 3m | Concurrent AI/WebSocket sessions |

### Thresholds

| Metric | Threshold | Result |
|--------|-----------|--------|
| `http_req_duration` p95 | < 2000ms | **561ms** PASS |
| `http_req_duration` p99 | < 5000ms | PASS |
| `errors` rate | < 15% | **2.18%** PASS |
| `health_duration` p95 | < 500ms | **414ms** PASS |
| `login_duration` p95 | < 3000ms | **726ms** PASS |
| `profile_duration` p95 | < 1000ms | **515ms** PASS |
| `ai_response_duration` p95 | < 30000ms | **1.65s** PASS |

## HTTP Results

| Metric | Value |
|--------|-------|
| Total requests | 23,962 |
| Throughput | **79 req/s** |
| HTTP failures | **0.00%** |
| p50 latency | 135ms |
| p90 latency | 399ms |
| p95 latency | **561ms** |
| Max latency | 1.61s |

### Endpoint Breakdown

| Endpoint | p95 Latency |
|----------|-------------|
| Health check | 414ms |
| Login | 726ms |
| Profile | 515ms |
| Register | ~200ms |
| Models | ~100ms |
| Legal | ~100ms |

## AI/WebSocket Results

| Metric | Value |
|--------|-------|
| AI sessions | 329 |
| AI session rate | 1.08/s |
| WS connect p95 | 831ms |
| AI response median | 824ms |
| AI response p95 | **1.65s** |
| AI response max | 30s (timeout) |
| WS messages received | 327 |
| Error rate | 2.18% |

## Capacity Estimation

| Metric | Value |
|--------|-------|
| Peak concurrent HTTP users | **100 VU** — stable, 0% failures |
| HTTP throughput | **~80 req/s** sustained |
| Peak concurrent AI sessions | **15** — stable |
| AI response time (p95) | **< 2s** |

### Real-World Capacity

In production, users don't send requests continuously. With average think time of 10-30 seconds between actions:

| Scenario | Estimated Capacity |
|----------|-------------------|
| Concurrent active users (HTTP) | **300-500** |
| Concurrent AI chat users | **50-100** |
| Hourly active users | **500-1000** |
| Daily active users | **2000-5000** |

### Bottlenecks Identified

1. **LLM API latency** — AI responses depend on OpenRouter API speed (800ms median)
2. **Health check at load** — p95 approaches 500ms threshold during spike
3. **No connection pooling** — Backend uses single DB connection (adequate for current load)

## How to Run

```bash
# Full test (smoke + load + spike + AI)
k6 run k6/load-test.js

# Custom base URL
k6 run -e BASE_URL=http://localhost:8080 k6/load-test.js
```

**After testing**, clean up test users:
```sql
DELETE FROM users WHERE email LIKE 'k6_load_%@test.local';
```
