# ProgreSQL — Development & Release Guide

## Development Approach

**BDD/TDD** — Write tests before implementing new features:
1. Write failing tests (unit for backend/frontend, E2E for user-facing)
2. Implement to make tests pass
3. Tests run as part of deploy pipelines

## Local Development

### Prerequisites

- Go 1.25+
- Node.js 20+
- PostgreSQL 16 (or Docker)
- k6 (for load testing)

### Backend

```bash
cd backend
go mod download
go test ./... -count=1    # Run tests
go run ./cmd/server       # Start server on :8080
```

**Environment variables** (see `config/config.go` for all options):
```
PROGRESSQL_DATABASE_URL=postgres://user:pass@localhost:5432/progressql?sslmode=disable
PROGRESSQL_JWT_SECRET=your-secret
PROGRESSQL_OPENROUTER_API_KEY=sk-or-...
```

### Frontend

```bash
cd frontend
npm ci
npx jest --ci            # Run tests (479 tests)
npx nextron dev          # Start Electron dev mode
```

### Docker (dev)

```bash
docker compose -f deploy/docker-compose.dev.yml up -d
```

Starts: PostgreSQL (:5434), test PostgreSQL (:5433), backend (:8080).

## Testing

### Backend Tests

```bash
cd backend && go test ./... -count=1
```

Runs Go unit tests. Also runs via `golangci-lint` in CI.

### Frontend Tests

```bash
cd frontend && npx jest --ci --passWithNoTests
```

479 Jest tests covering: AuthProvider, ChatPanel, AgentContext, SQLBlock, ChartBlock, hooks, services, storage.

### E2E Tests

```bash
cd frontend && npx playwright test
```

56 Playwright E2E tests: auth errors, SQL editor, chat tabs, settings, accessibility.

### Load Tests

```bash
k6 run k6/load-test.js
```

Scenarios: smoke (3 VU, 30s), load (0→50 VU, 3.5min), spike (0→100 VU, 50s), AI/WebSocket (0→15 VU, 3min).

## Release Flow

### 1. Version Bump

```bash
cd frontend
npm version patch    # 1.0.69 → 1.0.70
```

### 2. Commit & Push

```bash
git add -A
git commit -m "release: client v1.0.70, backend v1.0.70"
git push
```

### 3. Tag & Deploy Backend

```bash
git tag backend-v1.0.70
git push origin backend-v1.0.70
```

This triggers `.github/workflows/deploy-backend.yml`:
- Go lint + tests → Docker build → SCP to server → `docker compose up -d`

**Or deploy manually:**
```bash
./deploy/deploy.sh
```

### 4. Build macOS DMG

**Always use `create-dmg`** (electron-builder DMG broken on ARM Mac):

```bash
cd frontend
npx nextron build --mac
create-dmg \
  --volname "ProgreSQL" \
  --background build/mac/dmg-background.png \
  --window-size 540 380 \
  --icon-size 80 \
  --icon "ProgreSQL.app" 130 200 \
  --app-drop-link 410 200 \
  --hide-extension "ProgreSQL.app" \
  "dist/ProgreSQL-1.0.70.dmg" \
  "dist/mac-arm64/ProgreSQL.app"
```

Upload to GitHub Release:
```bash
gh release create client-v1.0.70 dist/ProgreSQL-1.0.70.dmg --title "ProgreSQL v1.0.70"
```

### 5. Build Windows & Linux

```bash
gh workflow run build-desktop.yml -f tag=client-v1.0.70
```

This triggers GitHub Actions:
- Jest tests → Build Windows .exe (NSIS) → Build Linux .AppImage → Upload to release

### 6. Deploy Installers to Server

Triggered automatically after `build-desktop.yml` completes, or manually:
```bash
gh workflow run deploy-client.yml -f tag=client-v1.0.70
```

Downloads DMG/EXE/AppImage from GitHub Release → uploads to `/opt/progresql/downloads/` → creates symlinks.

### 7. Deploy Landing Page (if changed)

```bash
git tag landing-v1.0.70
git push origin landing-v1.0.70
```

## CI/CD Pipelines

| Trigger | Workflow | What It Does |
|---------|----------|-------------|
| Tag `backend-v*` | `deploy-backend.yml` | Go lint → tests → Docker → deploy to server |
| Manual (tag input) | `build-desktop.yml` | Jest → Build Win .exe + Linux .AppImage → GitHub Release |
| After `build-desktop` | `deploy-client.yml` | Download assets → upload to server → symlink |
| Tag `landing-v*` | `deploy-landing.yml` | Deploy static pages → reload nginx |

## SSH Access

```bash
# Server (deploy, monitoring, DB)
ssh -i ~/.ssh/progresql_server root@progresql.com

# GitHub push (via progresql_deploy key)
GIT_SSH_COMMAND="ssh -i ~/.ssh/progresql_deploy" git push
```

## Server Directory Structure

```
/opt/progresql/
├── docker-compose.yml
├── .env                 # All secrets
├── downloads/           # DMG, EXE, AppImage installers
└── monitoring/          # Grafana provisioning, Prometheus config

/var/www/progresql/
├── landing/             # Landing page
├── legal/               # Legal pages
└── payment/             # Payment result pages
```
