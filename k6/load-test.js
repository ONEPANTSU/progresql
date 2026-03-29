import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'https://progresql.com';
const WS_URL = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');

// ─── Custom metrics ──────────────────────────────────────────────────────────

const errorRate = new Rate('errors');
const loginDuration = new Trend('login_duration', true);
const profileDuration = new Trend('profile_duration', true);
const wsDuration = new Trend('ws_connect_duration', true);
const healthDuration = new Trend('health_duration', true);
const aiResponseDuration = new Trend('ai_response_duration', true);
const aiStreamFirstChunk = new Trend('ai_stream_first_chunk', true);
const wsMessages = new Counter('ws_messages_received');

// ─── Scenarios ───────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    // 1. Smoke test — baseline sanity check
    smoke: {
      executor: 'constant-vus',
      vus: 3,
      duration: '30s',
      startTime: '0s',
      exec: 'httpFlow',
      tags: { scenario: 'smoke' },
    },
    // 2. Load test — normal expected load
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      startTime: '35s',
      exec: 'httpFlow',
      tags: { scenario: 'load' },
    },
    // 3. Spike test — sudden burst
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      startTime: '4m10s',
      exec: 'httpFlow',
      tags: { scenario: 'spike' },
    },
    // 4. AI/WebSocket load — concurrent AI chat sessions
    aiLoad: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 5 },
        { duration: '1m', target: 5 },
        { duration: '20s', target: 15 },
        { duration: '1m', target: 15 },
        { duration: '20s', target: 0 },
      ],
      startTime: '10s',
      exec: 'aiFlow',
      tags: { scenario: 'ai_load' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    errors: ['rate<0.15'],
    health_duration: ['p(95)<500'],
    login_duration: ['p(95)<3000'],
    profile_duration: ['p(95)<1000'],
    ai_response_duration: ['p(95)<30000'],
    ai_stream_first_chunk: ['p(95)<5000'],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function registerUser(id) {
  const email = `k6_load_${id}_${Date.now()}@test.local`;
  const payload = JSON.stringify({
    email: email,
    password: 'K6Test123!',
    name: `K6 User ${id}`,
  });

  const res = http.post(`${BASE_URL}/api/v1/auth/register`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'register' },
  });

  if (res.status === 201 || res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      return { token: body.token, email: email };
    } catch (e) {
      return null;
    }
  }
  return null;
}

function loginUser(email) {
  const start = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: email, password: 'K6Test123!' }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'login' } }
  );
  loginDuration.add(Date.now() - start);

  if (res.status === 200) {
    try {
      return JSON.parse(res.body).token;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function authHeaders(token) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  };
}

// AI prompts for realistic load
const AI_PROMPTS = [
  { action: 'chat', message: 'Покажи все таблицы в базе данных' },
  { action: 'chat', message: 'Сколько записей в таблице users?' },
  { action: 'chat', message: 'Напиши SQL запрос для получения топ-10 пользователей по дате регистрации' },
  { action: 'chat', message: 'Объясни что делает SELECT COUNT(*) FROM users GROUP BY plan' },
  { action: 'chat', message: 'Создай запрос для поиска пользователей с истекшей подпиской' },
  { action: 'autocomplete', sql: 'SELECT u.email, u.name FROM us' },
  { action: 'autocomplete', sql: 'SELECT * FROM users WHERE pla' },
  { action: 'autocomplete', sql: 'INSERT INTO ' },
];

// ─── HTTP test flow ─────────────────────────────────────────────────────────

export function httpFlow() {
  // Health check
  group('Health', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/health`, { tags: { name: 'health' } });
    healthDuration.add(Date.now() - start);
    const ok = check(res, {
      'health status 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // Models endpoint (public)
  group('Models', () => {
    const res = http.get(`${BASE_URL}/api/v1/models`, { tags: { name: 'models' } });
    const ok = check(res, {
      'models status 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);
  });

  // Register + Auth flow
  group('Auth Flow', () => {
    const creds = registerUser(__VU);
    if (!creds) {
      errorRate.add(true);
      return;
    }

    // Profile
    const start = Date.now();
    const profileRes = http.get(
      `${BASE_URL}/api/v1/auth/profile`,
      { ...authHeaders(creds.token), tags: { name: 'profile' } }
    );
    profileDuration.add(Date.now() - start);
    const ok = check(profileRes, {
      'profile status 200': (r) => r.status === 200,
    });
    errorRate.add(!ok);

    // Login with same creds
    const token = loginUser(creds.email);
    check(token, {
      'login returns token': (t) => t !== null && t.length > 20,
    });

    // Payment price (authenticated)
    if (token) {
      const priceRes = http.get(
        `${BASE_URL}/api/v1/payment/price`,
        { ...authHeaders(token), tags: { name: 'payment_price' } }
      );
      check(priceRes, {
        'price status 200': (r) => r.status === 200,
      });
    }

    // Create session (for WebSocket)
    if (token) {
      const sessionRes = http.post(
        `${BASE_URL}/api/v1/sessions`,
        '{}',
        { ...authHeaders(token), tags: { name: 'create_session' } }
      );
      check(sessionRes, {
        'session created': (r) => r.status === 201 || r.status === 200,
      });
    }
  });

  // Legal docs (public)
  group('Legal', () => {
    const res = http.get(`${BASE_URL}/api/v1/legal/privacy`, { tags: { name: 'legal' } });
    check(res, {
      'legal status 200': (r) => r.status === 200,
    });
  });

  sleep(Math.random() * 2 + 1);
}

// ─── AI/WebSocket test flow ─────────────────────────────────────────────────

export function aiFlow() {
  const creds = registerUser(__VU + 20000);
  if (!creds) {
    errorRate.add(true);
    return;
  }

  // Create session
  const sessionRes = http.post(
    `${BASE_URL}/api/v1/sessions`,
    '{}',
    { ...authHeaders(creds.token), tags: { name: 'ai_create_session' } }
  );

  if (sessionRes.status !== 201 && sessionRes.status !== 200) {
    errorRate.add(true);
    return;
  }

  let sessionId;
  try {
    sessionId = JSON.parse(sessionRes.body).session_id;
  } catch (e) {
    errorRate.add(true);
    return;
  }

  if (!sessionId) {
    errorRate.add(true);
    return;
  }

  // Connect WebSocket and send AI request
  const prompt = AI_PROMPTS[Math.floor(Math.random() * AI_PROMPTS.length)];
  const wsStart = Date.now();

  const res = ws.connect(
    `${WS_URL}/ws/${sessionId}?token=${creds.token}`,
    {},
    function (socket) {
      wsDuration.add(Date.now() - wsStart);

      let firstChunkReceived = false;
      let gotResponse = false;
      const requestId = `k6-${__VU}-${Date.now()}`;

      socket.on('open', () => {
        if (prompt.action === 'autocomplete') {
          // Autocomplete request
          socket.send(JSON.stringify({
            type: 'autocomplete.request',
            request_id: requestId,
            payload: {
              sql: prompt.sql,
              cursor_position: prompt.sql.length,
              schema_context: '',
            },
          }));
        } else {
          // Agent chat request
          socket.send(JSON.stringify({
            type: 'agent.request',
            request_id: requestId,
            payload: {
              action: 'chat',
              user_message: prompt.message,
              context: {
                security_mode: 'safe',
                language: 'ru',
              },
            },
          }));
        }
      });

      socket.on('message', (msg) => {
        wsMessages.add(1);
        try {
          const env = JSON.parse(msg);

          // Track first stream chunk latency
          if (env.type === 'agent.stream' && !firstChunkReceived) {
            firstChunkReceived = true;
            aiStreamFirstChunk.add(Date.now() - wsStart);
          }

          // Final response
          if (env.type === 'agent.response' || env.type === 'autocomplete.response') {
            gotResponse = true;
            aiResponseDuration.add(Date.now() - wsStart);
            errorRate.add(false);
            socket.close();
          }

          // Error
          if (env.type === 'agent.error') {
            aiResponseDuration.add(Date.now() - wsStart);
            errorRate.add(true);
            socket.close();
          }

          // Tool call — respond with mock result
          if (env.type === 'tool.call') {
            socket.send(JSON.stringify({
              type: 'tool.result',
              request_id: env.request_id,
              call_id: env.call_id,
              payload: {
                success: true,
                data: { rows: [], columns: [] },
              },
            }));
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      // Timeout — close after 30s if no response
      socket.setTimeout(() => {
        if (!gotResponse) {
          aiResponseDuration.add(30000);
          errorRate.add(true);
        }
        socket.close();
      }, 30000);
    }
  );

  check(res, {
    'ws status 101': (r) => r && r.status === 101,
  });

  sleep(Math.random() * 3 + 2);
}
