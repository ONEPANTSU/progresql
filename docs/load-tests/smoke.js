import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * Smoke Test — ProgreSQL API
 *
 * Purpose : Verify all key endpoints are reachable and return expected status
 *           codes under minimal load (1 virtual user, 30 seconds).
 *
 * Run     : k6 run smoke.js
 */

export const options = {
  vus: 1,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],       // less than 1 % of requests may fail
    http_req_duration: ['p(95)<3000'],    // 95th percentile under 3 s
  },
};

const BASE_URL = 'https://progresql.com';

const HEADERS_JSON = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Helper — obtain an anonymous JWT from /api/v1/auth/token
// ---------------------------------------------------------------------------
function getToken() {
  const res = http.post(`${BASE_URL}/api/v1/auth/token`, '{}', {
    headers: HEADERS_JSON,
  });

  check(res, {
    'auth/token: status is 200': (r) => r.status === 200,
    'auth/token: body contains token': (r) => {
      try {
        return r.json('token') !== undefined;
      } catch (_) {
        return false;
      }
    },
  });

  if (res.status === 200) {
    try {
      return res.json('token');
    } catch (_) {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default function — executed once per VU iteration
// ---------------------------------------------------------------------------
export default function () {
  // 1. Health check
  const healthRes = http.get(`${BASE_URL}/api/v1/health`);
  check(healthRes, {
    'health: status is 200': (r) => r.status === 200,
  });

  sleep(0.5);

  // 2. Obtain anonymous JWT
  const token = getToken();

  sleep(0.5);

  // 3. Register a new user (unique email per iteration to avoid conflicts)
  const email = `smoke_user_${Date.now()}@example.com`;
  const registerPayload = JSON.stringify({
    email,
    password: 'SmokeTest@1234',
    name: 'Smoke User',
  });

  const registerRes = http.post(`${BASE_URL}/api/v1/auth/register`, registerPayload, {
    headers: HEADERS_JSON,
  });
  check(registerRes, {
    'register: status is 200 or 201': (r) => r.status === 200 || r.status === 201,
  });

  sleep(0.5);

  // 4. Login with the same credentials
  const loginPayload = JSON.stringify({
    email,
    password: 'SmokeTest@1234',
  });

  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, loginPayload, {
    headers: HEADERS_JSON,
  });
  check(loginRes, {
    'login: status is 200': (r) => r.status === 200,
  });

  sleep(0.5);

  // 5. Create an agent session (requires JWT from step 2)
  if (token) {
    const sessionPayload = JSON.stringify({});
    const sessionRes = http.post(`${BASE_URL}/api/v1/sessions`, sessionPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    check(sessionRes, {
      'sessions: status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    });
  }

  sleep(0.5);

  // 6. Metrics
  const metricsRes = http.get(`${BASE_URL}/api/v1/metrics`);
  check(metricsRes, {
    'metrics: status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
