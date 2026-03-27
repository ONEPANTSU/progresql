import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * Load Test — ProgreSQL API
 *
 * Purpose : Simulate a typical concurrent user workload (10 VUs, 2 minutes).
 *           Validates the primary user flow: obtain token → create session.
 *           SLO: p95 response time < 2 s.
 *
 * Run     : k6 run load.js
 */

export const options = {
  stages: [
    { duration: '20s', target: 10 },   // ramp up to 10 VUs
    { duration: '80s', target: 10 },   // hold at 10 VUs for ~1 min 20 s
    { duration: '20s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed:   ['rate<0.02'],          // < 2 % error rate
    http_req_duration: ['p(95)<2000'],         // SLO: p95 < 2 s
    'http_req_duration{endpoint:token}':    ['p(95)<1000'],
    'http_req_duration{endpoint:session}':  ['p(95)<2000'],
    'http_req_duration{endpoint:health}':   ['p(95)<500'],
  },
};

const BASE_URL = 'https://progresql.com';
const HEADERS_JSON = { 'Content-Type': 'application/json' };

// Custom metrics
const sessionCreationTime = new Trend('session_creation_time', true);
const tokenFetchTime      = new Trend('token_fetch_time', true);
const authSuccessRate     = new Rate('auth_success_rate');

// ---------------------------------------------------------------------------
// Helper — fetch anonymous JWT
// ---------------------------------------------------------------------------
function fetchToken() {
  const res = http.post(`${BASE_URL}/api/v1/auth/token`, '{}', {
    headers: HEADERS_JSON,
    tags: { endpoint: 'token' },
  });

  tokenFetchTime.add(res.timings.duration);

  const ok = check(res, {
    'auth/token: status 200':     (r) => r.status === 200,
    'auth/token: token present':  (r) => {
      try { return Boolean(r.json('token')); } catch (_) { return false; }
    },
  });

  authSuccessRate.add(ok);

  if (ok) {
    try { return res.json('token'); } catch (_) { return null; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default function
// ---------------------------------------------------------------------------
export default function () {
  // ---- Group 1: Health check ----
  group('health_check', () => {
    const res = http.get(`${BASE_URL}/api/v1/health`, {
      tags: { endpoint: 'health' },
    });
    check(res, { 'health: status 200': (r) => r.status === 200 });
  });

  sleep(0.5);

  // ---- Group 2: Auth flow — token ----
  let token = null;
  group('auth_token', () => {
    token = fetchToken();
  });

  sleep(0.5);

  // ---- Group 3: Session creation ----
  group('session_creation', () => {
    if (!token) {
      console.warn('Skipping session creation: no JWT available');
      return;
    }

    const res = http.post(`${BASE_URL}/api/v1/sessions`, '{}', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      tags: { endpoint: 'session' },
    });

    sessionCreationTime.add(res.timings.duration);

    check(res, {
      'sessions: status 200 or 201': (r) => r.status === 200 || r.status === 201,
    });
  });

  sleep(0.5);

  // ---- Group 4: Metrics ----
  group('metrics', () => {
    const res = http.get(`${BASE_URL}/api/v1/metrics`, {
      tags: { endpoint: 'metrics' },
    });
    check(res, { 'metrics: status 200': (r) => r.status === 200 });
  });

  // Simulate realistic think-time between user actions (1–3 s)
  sleep(1 + Math.random() * 2);
}
