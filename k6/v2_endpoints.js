import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL   = __ENV.BASE_URL      || 'https://progresql.com';
const TEST_EMAIL = __ENV.TEST_EMAIL     || '';
const TEST_PASS  = __ENV.TEST_PASSWORD  || '';

// ─── Custom metrics ──────────────────────────────────────────────────────────

const errorRate        = new Rate('errors');
const pricesDuration   = new Trend('v2_prices_duration', true);
const balanceDuration  = new Trend('v2_balance_duration', true);
const historyDuration  = new Trend('v2_balance_history_duration', true);
const usageDuration    = new Trend('v2_usage_duration', true);
const quotaDuration    = new Trend('v2_quota_duration', true);
const invoiceDuration  = new Trend('v2_create_invoice_duration', true);

// ─── Scenarios ───────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // Smoke — quick sanity check
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      exec: 'v2Flow',
      tags: { scenario: 'smoke' },
    },
    // Load — sustained normal traffic
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 10 },
        { duration: '30s', target: 30 },
        { duration: '1m',  target: 30 },
        { duration: '30s', target: 0 },
      ],
      startTime: '35s',
      exec: 'v2Flow',
      tags: { scenario: 'load' },
    },
    // Spike — sudden burst
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 60 },
        { duration: '30s', target: 60 },
        { duration: '10s', target: 0 },
      ],
      startTime: '4m10s',
      exec: 'v2Flow',
      tags: { scenario: 'spike' },
    },
  },
  thresholds: {
    http_req_duration:           ['p(95)<2000', 'p(99)<5000'],
    errors:                      ['rate<0.10'],
    v2_prices_duration:          ['p(95)<500'],
    v2_balance_duration:         ['p(95)<500'],
    v2_balance_history_duration: ['p(95)<500'],
    v2_usage_duration:           ['p(95)<500'],
    v2_quota_duration:           ['p(95)<500'],
    v2_create_invoice_duration:  ['p(95)<2000'],
  },
};

// ─── Setup — authenticate once, share token across VUs ──────────────────────

export function setup() {
  if (!TEST_EMAIL || !TEST_PASS) {
    console.error(
      'TEST_EMAIL and TEST_PASSWORD env vars are required.\n' +
      'Usage: k6 run -e TEST_EMAIL=user@example.com -e TEST_PASSWORD=secret v2_endpoints.js'
    );
    return { token: null };
  }

  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const ok = check(res, {
    'setup: login status 200': (r) => r.status === 200,
  });

  if (!ok) {
    console.error(`Login failed: status=${res.status} body=${res.body}`);
    return { token: null };
  }

  try {
    const token = JSON.parse(res.body).token;
    console.log('Setup complete — JWT obtained');
    return { token };
  } catch (e) {
    console.error(`Failed to parse login response: ${e}`);
    return { token: null };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
}

function timedGet(url, token, metricTrend, tag) {
  const start = Date.now();
  const res = http.get(url, { ...authHeaders(token), tags: { name: tag } });
  metricTrend.add(Date.now() - start);
  return res;
}

// ─── Main test flow ──────────────────────────────────────────────────────────

export function v2Flow(data) {
  if (!data.token) {
    console.error('No token — skipping iteration (check TEST_EMAIL / TEST_PASSWORD)');
    errorRate.add(true);
    return;
  }

  const token = data.token;

  // ── GET /api/v2/payment/prices ──────────────────────────────────────────
  group('v2 Payment Prices', () => {
    const res = timedGet(
      `${BASE_URL}/api/v2/payment/prices`,
      token,
      pricesDuration,
      'v2_prices',
    );
    const ok = check(res, {
      'prices status 200': (r) => r.status === 200,
      'prices body is array or object': (r) => {
        try { const b = JSON.parse(r.body); return b !== null; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // ── GET /api/v2/balance ─────────────────────────────────────────────────
  group('v2 Balance', () => {
    const res = timedGet(
      `${BASE_URL}/api/v2/balance`,
      token,
      balanceDuration,
      'v2_balance',
    );
    const ok = check(res, {
      'balance status 200': (r) => r.status === 200,
      'balance body is JSON': (r) => {
        try { JSON.parse(r.body); return true; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // ── GET /api/v2/balance/history ─────────────────────────────────────────
  group('v2 Balance History', () => {
    const res = timedGet(
      `${BASE_URL}/api/v2/balance/history?limit=10&offset=0`,
      token,
      historyDuration,
      'v2_balance_history',
    );
    const ok = check(res, {
      'history status 200': (r) => r.status === 200,
      'history body is JSON': (r) => {
        try { JSON.parse(r.body); return true; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // ── GET /api/v2/usage ───────────────────────────────────────────────────
  group('v2 Usage', () => {
    const res = timedGet(
      `${BASE_URL}/api/v2/usage`,
      token,
      usageDuration,
      'v2_usage',
    );
    const ok = check(res, {
      'usage status 200': (r) => r.status === 200,
      'usage body is JSON': (r) => {
        try { JSON.parse(r.body); return true; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // ── GET /api/v2/quota ───────────────────────────────────────────────────
  group('v2 Quota', () => {
    const res = timedGet(
      `${BASE_URL}/api/v2/quota`,
      token,
      quotaDuration,
      'v2_quota',
    );
    const ok = check(res, {
      'quota status 200': (r) => r.status === 200,
      'quota body is JSON': (r) => {
        try { JSON.parse(r.body); return true; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  // ── POST /api/v2/payments/create-invoice ────────────────────────────────
  group('v2 Create Invoice', () => {
    const start = Date.now();
    const payload = JSON.stringify({
      amount: 100,
      currency: 'RUB',
      payment_method: 'card',
      plan: 'pro',
      payment_type: 'subscription',
    });

    const res = http.post(
      `${BASE_URL}/api/v2/payments/create-invoice`,
      payload,
      { ...authHeaders(token), tags: { name: 'v2_create_invoice' } },
    );
    invoiceDuration.add(Date.now() - start);

    const ok = check(res, {
      'invoice status 200 or 400': (r) => r.status === 200 || r.status === 400,
      'invoice body is JSON': (r) => {
        try { JSON.parse(r.body); return true; }
        catch (_) { return false; }
      },
    });
    errorRate.add(!ok);
  });

  sleep(Math.random() * 2 + 1);
}
