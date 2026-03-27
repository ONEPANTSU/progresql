# ProgreSQL API — k6 Load Tests

This directory contains [k6](https://k6.io) load test scripts targeting the ProgreSQL production API at `https://progresql.com`.

---

## Prerequisites

Install k6 (choose one):

```bash
# macOS (Homebrew)
brew install k6

# Linux (apt)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
     --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
     | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Docker (no install needed)
docker pull grafana/k6
```

---

## Test files

| File | VUs | Duration | Purpose |
|------|-----|----------|---------|
| `smoke.js` | 1 | 30 s | Verify all endpoints return correct status codes |
| `load.js` | 10 | ~2 min | Typical user flow, SLO p95 < 2 s |
| `stress.js` | 0 → 50 | ~5 min | Find the breaking point under increasing load |

---

## Running the tests

### Smoke test

```bash
k6 run docs/load-tests/smoke.js
```

Expected result: all checks pass, zero HTTP errors.

---

### Load test

```bash
k6 run docs/load-tests/load.js
```

Expected result: p95 response time below 2 000 ms, error rate below 2 %.

To write results to a JSON file for later analysis:

```bash
k6 run --out json=load-results.json docs/load-tests/load.js
```

---

### Stress test

```bash
k6 run docs/load-tests/stress.js
```

The test ramps from 10 VUs to 50 VUs across several stages. A plain-text
summary (`stress-summary.txt`) is written to `docs/load-tests/` after the run.

Observe the **Verdict** line in the summary to identify whether the API held
up, degraded, or reached a breaking point.

---

## Running with Docker (no local install)

```bash
# From the repository root
docker run --rm -i grafana/k6 run - < docs/load-tests/smoke.js
docker run --rm -i grafana/k6 run - < docs/load-tests/load.js
docker run --rm -i grafana/k6 run - < docs/load-tests/stress.js
```

---

## Key endpoints under test

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/v1/auth/token` | — | Obtain anonymous JWT (empty body) |
| `POST` | `/api/v1/auth/register` | — | Register a new user |
| `POST` | `/api/v1/auth/login` | — | Login with email + password |
| `GET`  | `/api/v1/health` | — | Health probe |
| `POST` | `/api/v1/sessions` | Bearer JWT | Create agent session |
| `GET`  | `/api/v1/metrics` | — | Application metrics |

---

## Thresholds

| Test | Metric | Threshold |
|------|--------|-----------|
| smoke | `http_req_failed` | < 1 % |
| smoke | `http_req_duration p(95)` | < 3 000 ms |
| load  | `http_req_failed` | < 2 % |
| load  | `http_req_duration p(95)` | < 2 000 ms |
| stress | `http_req_failed` | < 30 % (alerting only) |
| stress | `http_req_duration p(95)` | < 8 000 ms (alerting only) |

---

## Notes

- The smoke test generates a unique email address per iteration to avoid
  registration conflicts.
- All tests use a short `sleep()` between requests to simulate realistic
  think-time and avoid hammering the API without pause.
- The stress test intentionally uses loose thresholds — its purpose is
  observation, not gating. Investigate `stress-summary.txt` after the run.
- Do **not** run load or stress tests against a staging environment that
  shares infrastructure with production.
