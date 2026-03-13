# ProgreSQL — Makefile
# ============================================================

VERSION := $(shell node -p 'require("./frontend/package.json").version')

# --- Development ---

.PHONY: dev
dev: ## Run frontend in dev mode
	cd frontend && npm run dev

.PHONY: dev-backend
dev-backend: ## Run backend locally
	cd backend && go run ./cmd/server

.PHONY: install
install: ## Install frontend dependencies
	cd frontend && npm ci

# --- Build ---

.PHONY: build-mac
build-mac: ## Build macOS DMG
	cd frontend && CSC_IDENTITY_AUTO_DISCOVERY=false npx nextron build --mac

.PHONY: build-win
build-win: ## Build Windows EXE (requires Wine or run on server)
	cd frontend && npx nextron build --win

.PHONY: build-backend
build-backend: ## Build backend Docker image
	docker buildx build --file deploy/Dockerfile.backend --tag progresql-backend:latest --load .

# --- Release (tags trigger Woodpecker CI) ---

.PHONY: release-mac
release-mac: ## Build macOS DMG + upload to GitHub Release → triggers Woodpecker
	bash scripts/release.sh

.PHONY: release-backend
release-backend: ## Tag and push backend release
	git tag -a "backend-v$(VERSION)" -m "Backend release $(VERSION)"
	git push origin "backend-v$(VERSION)"
	@echo "Tagged backend-v$(VERSION) — Woodpecker deploys backend"

.PHONY: release-landing
release-landing: ## Tag and push landing release
	git tag -a "landing-v$(VERSION)" -m "Landing release $(VERSION)"
	git push origin "landing-v$(VERSION)"
	@echo "Tagged landing-v$(VERSION) — Woodpecker deploys static"

.PHONY: release-all
release-all: release-backend release-landing release-mac ## Release everything

# --- Docker ---

.PHONY: up
up: ## Start local docker-compose (backend + postgres)
	docker compose -f deploy/docker-compose.dev.yml up -d

.PHONY: down
down: ## Stop local docker-compose
	docker compose -f deploy/docker-compose.dev.yml down

.PHONY: logs
logs: ## Show backend logs
	docker compose -f deploy/docker-compose.dev.yml logs -f backend

# --- Tests ---

.PHONY: test-backend
test-backend: ## Run Go tests
	cd backend && go test ./...

.PHONY: test-frontend
test-frontend: ## Run frontend tests
	cd frontend && npm test

.PHONY: test
test: test-backend test-frontend ## Run all tests

# --- Cleanup ---

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf frontend/dist
	rm -f server

# --- Version ---

.PHONY: bump-patch
bump-patch: ## Bump patch version (1.0.5 → 1.0.6)
	cd frontend && npm version patch --no-git-tag-version
	@echo "Version: $$(node -p 'require(\"./frontend/package.json\").version')"

.PHONY: bump-minor
bump-minor: ## Bump minor version (1.0.5 → 1.1.0)
	cd frontend && npm version minor --no-git-tag-version
	@echo "Version: $$(node -p 'require(\"./frontend/package.json\").version')"

# --- Help ---

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
