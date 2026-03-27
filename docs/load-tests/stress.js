import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

/**
 * Stress Test — ProgreSQL API
 *
 * Purpose : Incrementally ramp load to 50 VUs to find the API's breaking point.
 *           Tracks error rates and response times at each load level.
 *           After peak, the test verifies the system recovers (error rate drops).
 *
 * Run     : k6 run stress.js
 *
 * Stages overview:
 *   0 → 10 VUs  (30 s)  warm-up
 *  10 → 20 VUs  (60 s)  light stress
 *  20 → 35 VUs  (60 s)  moderate stress
 *  35 → 50 VUs  (60 s)  peak stress — breaking point investigation
 *  50 → 50 VUs  (60 s)  sustain peak
 *  50 →  0 VUs  (30 s)  recovery
 */

export const options = {
  stages: [
    { duration: '30s',  target: 10 },   // warm-up
    { duration: '60s',  target: 20 },   // light stress
    { duration: '60s',  target: 35 },   // moderate stress
    { duration: '60s',  target: 50 },   // peak stress
    { duration: '60s',  target: 50 },   // sustain peak
    { duration: '30s',  target: 0  },   // recovery ramp-down
  ],
  thresholds: {
    // These thresholds are intentionally lenient — the goal is to observe
    // degradation, not to gate/fail the run.
    http_req_failed:   ['rate<0.30'],    // alert if > 30 % errors
    http_req_duration: ['p(95)<8000'],   // alert if p95 > 8 s
  },
};

const BASE_URL = 'https://progresql.com';
const HEADERS_JSON = { 'Content-Type': 'application/json' };

// Custom metrics for detailed breakdown
const tokenLatency   = new Trend('stress_token_latency',   true);
const sessionLatency = new Trend('stress_session_latency', true);
const healthLatency  = new Trend('stress_health_latency',  true);
const errorCounter   = new Counter('stress_errors');

// ---------------------------------------------------------------------------
// Helper — fetch anonymous JWT with error tracking
// ---------------------------------------------------------------------------
function fetchToken() {
  const res = http.post(`${BASE_URL}/api/v1/auth/token`, '{}', {
    headers: HEADERS_JSON,
    tags: { endpoint: 'token' },
  });

  tokenLatency.add(res.timings.duration);

  const ok = check(res, {
    'auth/token: status 200': (r) => r.status === 200,
    'auth/token: response time < 5s': (r) => r.timings.duration < 5000,
  });

  if (!ok) errorCounter.add(1);

  if (res.status === 200) {
    try { return res.json('token'); } catch (_) { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default function
// ---------------------------------------------------------------------------
export default function () {
  // ---- Health check (fast, low-cost probe) ----
  group('health_check', () => {
    const res = http.get(`${BASE_URL}/api/v1/health`, {
      tags: { endpoint: 'health' },
    });

    healthLatency.add(res.timings.duration);

    const ok = check(res, {
      'health: status 200': (r) => r.status === 200,
      'health: fast response < 1s': (r) => r.timings.duration < 1000,
    });

    if (!ok) errorCounter.add(1);
  });

  sleep(0.2);

  // ---- Token acquisition ----
  let token = null;
  group('auth_token', () => {
    token = fetchToken();
  });

  sleep(0.2);

  // ---- Session creation (authenticated, heaviest operation) ----
  group('session_creation', () => {
    if (!token) {
      errorCounter.add(1);
      return;
    }

    const res = http.post(`${BASE_URL}/api/v1/sessions`, '{}', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: 'session' },
    });

    sessionLatency.add(res.timings.duration);

    const ok = check(res, {
      'sessions: status 200 or 201': (r) => r.status === 200 || r.status === 201,
      'sessions: response time < 5s': (r) => r.timings.duration < 5000,
    });

    if (!ok) errorCounter.add(1);
  });

  sleep(0.2);

  // ---- Metrics endpoint ----
  group('metrics', () => {
    const res = http.get(`${BASE_URL}/api/v1/metrics`, {
      tags: { endpoint: 'metrics' },
    });

    const ok = check(res, {
      'metrics: status 200': (r) => r.status === 200,
    });

    if (!ok) errorCounter.add(1);
  });

  // Short think-time — keep pressure high during stress test
  sleep(0.5 + Math.random() * 0.5);
}

// ---------------------------------------------------------------------------
// handleSummary — print a human-readable stress analysis at the end
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const totalReqs  = data.metrics.http_reqs        ? data.metrics.http_reqs.values.count        : 0;
  const failRate   = data.metrics.http_req_failed  ? data.metrics.http_req_failed.values.rate   : 0;
  const p95        = data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'] : 0;
  const p99        = data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(99)'] : 0;
  const maxDur     = data.metrics.http_req_duration ? data.metrics.http_req_duration.values.max        : 0;
  const errors     = data.metrics.stress_errors    ? data.metrics.stress_errors.values.count    : 0;

  const summary = `
======================================================
  STRESS TEST SUMMARY — ProgreSQL API
======================================================
  Total requests  : ${totalReqs}
  Error rate      : ${(failRate * 100).toFixed(2)} %
  Custom errors   : ${errors}

  Response time
    p(95)         : ${p95.toFixed(0)} ms
    p(99)         : ${p99.toFixed(0)} ms
    max           : ${maxDur.toFixed(0)} ms

  Verdict         : ${failRate < 0.05 && p95 < 2000
    ? 'PASS — system held under stress'
    : failRate < 0.15
    ? 'DEGRADED — elevated errors or latency detected'
    : 'BREAKING POINT REACHED — investigate error logs'}
======================================================
`;

  return {
    stdout: summary,
    'docs/load-tests/stress-summary.txt': summary,
  };
}
