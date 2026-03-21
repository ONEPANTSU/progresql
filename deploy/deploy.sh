#!/usr/bin/env bash
# deploy.sh
# Run from the developer's Mac to build, ship, and restart the ProgreSQL backend.
# Usage: ./deploy/deploy.sh [--skip-build]

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SERVER="root@81.200.157.194"
APP_DIR="/opt/progresql"
IMAGE_NAME="progresql-backend"
IMAGE_TAG="latest"
TAR_FILE="/tmp/${IMAGE_NAME}.tar"
DOCKERFILE="deploy/Dockerfile.backend"
PLATFORM="linux/amd64"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
step() { echo ""; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# Ensure we run from the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# 1. Build Docker image for linux/amd64
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD}" = false ]; then
    step "Building Docker image ${IMAGE_NAME}:${IMAGE_TAG} for ${PLATFORM}..."
    [ -f "${DOCKERFILE}" ] || die "Dockerfile not found at ${DOCKERFILE}"

    docker buildx build \
        --platform "${PLATFORM}" \
        --file "${DOCKERFILE}" \
        --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
        --load \
        .

    step "Image built successfully."
else
    step "Skipping build (--skip-build flag set)."
    docker image inspect "${IMAGE_NAME}:${IMAGE_TAG}" &>/dev/null \
        || die "Image ${IMAGE_NAME}:${IMAGE_TAG} not found locally. Run without --skip-build first."
fi

# ---------------------------------------------------------------------------
# 2. Save image to tar
# ---------------------------------------------------------------------------
step "Saving image to ${TAR_FILE}..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" -o "${TAR_FILE}"
TAR_SIZE=$(du -sh "${TAR_FILE}" | cut -f1)
echo "    Archive size: ${TAR_SIZE}"

# ---------------------------------------------------------------------------
# 3. Copy tar to server
# ---------------------------------------------------------------------------
step "Copying image to ${SERVER}:${APP_DIR}/..."
# Ensure destination directory exists
ssh "${SERVER}" "mkdir -p ${APP_DIR}"
scp -C "${TAR_FILE}" "${SERVER}:${APP_DIR}/${IMAGE_NAME}.tar"

# ---------------------------------------------------------------------------
# 4. Deploy static files (payment + legal pages) and nginx config
# ---------------------------------------------------------------------------
step "Deploying static files and nginx config..."
ssh "${SERVER}" "mkdir -p /var/www/progresql/payment /var/www/progresql/legal"
scp static/payment/success.html static/payment/fail.html static/payment/favicon.png "${SERVER}:/var/www/progresql/payment/"
scp static/legal/*.html "${SERVER}:/var/www/progresql/legal/"
scp deploy/nginx/progresql.conf "${SERVER}:/etc/nginx/sites-available/progresql"
ssh "${SERVER}" "ln -sf /etc/nginx/sites-available/progresql /etc/nginx/sites-enabled/progresql && nginx -t && systemctl reload nginx"

# ---------------------------------------------------------------------------
# 5. Load image and restart container on server
# ---------------------------------------------------------------------------
step "Loading image and restarting container on server..."
ssh "${SERVER}" bash -s << REMOTE
set -euo pipefail

echo "  >> Loading image..."
docker load -i "${APP_DIR}/${IMAGE_NAME}.tar"

echo "  >> Removing old tar..."
rm -f "${APP_DIR}/${IMAGE_NAME}.tar"

echo "  >> Restarting backend service..."
cd "${APP_DIR}"

# Graceful rolling restart: bring up new container before removing old one
docker compose up -d --no-build --remove-orphans

echo "  >> Waiting for health check..."
RETRIES=20
until docker compose ps --format '{{.Health}}' | grep -q "healthy" || [ \$RETRIES -eq 0 ]; do
    RETRIES=\$((RETRIES - 1))
    sleep 3
done

if [ \$RETRIES -eq 0 ]; then
    echo "  >> WARNING: Container did not become healthy within timeout."
    echo "  >> Last 30 log lines:"
    docker compose logs --tail=30
    exit 1
fi

echo "  >> Backend is healthy."
docker compose ps
REMOTE

# ---------------------------------------------------------------------------
# 6. Cleanup local tar
# ---------------------------------------------------------------------------
step "Cleaning up local tar file..."
rm -f "${TAR_FILE}"

step "Deployment complete."
echo "    Server  : ${SERVER}"
echo "    Image   : ${IMAGE_NAME}:${IMAGE_TAG}"
echo "    App dir : ${APP_DIR}"
echo ""
echo "    Tail logs  : ssh ${SERVER} 'docker compose -f ${APP_DIR}/docker-compose.yml logs -f'"
echo "    Check status: ssh ${SERVER} 'docker compose -f ${APP_DIR}/docker-compose.yml ps'"
