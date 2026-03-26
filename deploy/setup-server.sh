#!/usr/bin/env bash
# setup-server.sh
# Run once on a fresh Ubuntu server to bootstrap the ProgreSQL production environment.
# Usage: bash setup-server.sh
# Expected to be executed as root on 81.200.157.194

set -euo pipefail

DOMAIN="progresql.com"
APP_DIR="/opt/progresql"
DOWNLOADS_DIR="${APP_DIR}/downloads"
BACKEND_PORT="8080"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
echo ">>> Updating system packages..."
apt-get update -y
apt-get upgrade -y
apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    nginx \
    certbot \
    python3-certbot-nginx \
    ufw \
    logrotate

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
    echo ">>> Installing Docker..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc

    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "${VERSION_CODENAME}") stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
else
    echo ">>> Docker already installed, skipping."
fi

# ---------------------------------------------------------------------------
# 3. Directory structure
# ---------------------------------------------------------------------------
echo ">>> Creating application directories..."
mkdir -p "${APP_DIR}"
mkdir -p "${DOWNLOADS_DIR}"
mkdir -p "${APP_DIR}/data"       # persistent backend data volume
mkdir -p /var/www/progresql/payment
mkdir -p /var/www/progresql/legal

# ---------------------------------------------------------------------------
# 4. Production docker-compose (backend only, no test postgres)
# ---------------------------------------------------------------------------
echo ">>> Writing production docker-compose.yml..."
cat > "${APP_DIR}/docker-compose.yml" << 'COMPOSE'
services:
  backend:
    image: progresql-backend:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - .env
    volumes:
      - ./data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "5"
COMPOSE

# ---------------------------------------------------------------------------
# 5. .env template (fill in real values before first start)
# ---------------------------------------------------------------------------
if [ ! -f "${APP_DIR}/.env" ]; then
    echo ">>> Writing .env template..."
    cat > "${APP_DIR}/.env" << 'ENVFILE'
# ProgreSQL backend environment — fill in all values before starting
PROGRESSQL_SERVER_PORT=8080
PROGRESSQL_ENVIRONMENT=production
PROGRESSQL_LOG_LEVEL=info

# JWT — generate with: openssl rand -hex 32
PROGRESSQL_JWT_SECRET=CHANGE_ME

# OpenRouter LLM
PROGRESSQL_OPENROUTER_API_KEY=
PROGRESSQL_HTTP_MODEL=qwen/qwen3-coder

# SMTP (email verification)
PROGRESSQL_SMTP_HOST=smtp.yandex.ru
PROGRESSQL_SMTP_PORT=465
PROGRESSQL_SMTP_USER=
PROGRESSQL_SMTP_PASSWORD=
PROGRESSQL_SMTP_FROM=progresql.noreply@yandex.ru

# Platega.io payment gateway
PROGRESSQL_PLATEGA_MERCHANT_ID=
PROGRESSQL_PLATEGA_API_KEY=
PROGRESSQL_PLATEGA_SECRET=
ENVFILE
    echo ">>> .env template written to ${APP_DIR}/.env — edit it before starting the backend."
else
    echo ">>> .env already exists, skipping template creation."
fi

# ---------------------------------------------------------------------------
# 6. Firewall
# ---------------------------------------------------------------------------
echo ">>> Configuring UFW firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ---------------------------------------------------------------------------
# 7. nginx — initial HTTP config (needed for certbot HTTP-01 challenge)
# ---------------------------------------------------------------------------
echo ">>> Writing initial nginx config (HTTP only, for certbot)..."
cat > /etc/nginx/sites-available/progresql << NGINXHTTP
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    # Certbot ACME challenge
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Temporary redirect while cert is being provisioned
    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINXHTTP

mkdir -p /var/www/certbot
ln -sf /etc/nginx/sites-available/progresql /etc/nginx/sites-enabled/progresql
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable --now nginx
systemctl reload nginx

# ---------------------------------------------------------------------------
# 8. SSL certificate via certbot
# ---------------------------------------------------------------------------
echo ">>> Obtaining SSL certificate for ${DOMAIN}..."
certbot certonly \
    --nginx \
    --non-interactive \
    --agree-tos \
    --email "admin@${DOMAIN}" \
    -d "${DOMAIN}" \
    -d "www.${DOMAIN}" || {
        echo "WARNING: certbot failed — ensure DNS A records for ${DOMAIN} and www.${DOMAIN} point to this server before re-running certbot."
        echo "Re-run manually: certbot certonly --nginx -d ${DOMAIN} -d www.${DOMAIN}"
    }

# Auto-renewal cron (certbot installs a systemd timer; ensure it is active)
systemctl enable --now certbot.timer 2>/dev/null || true

# ---------------------------------------------------------------------------
# 9. nginx — full HTTPS config from repo (deploy/nginx/progresql.conf)
# ---------------------------------------------------------------------------
echo ">>> Installing nginx config from deploy/nginx/progresql.conf..."
if [ -f "deploy/nginx/progresql.conf" ]; then
    cp deploy/nginx/progresql.conf /etc/nginx/sites-available/progresql
else
    echo "WARNING: deploy/nginx/progresql.conf not found — nginx config not updated."
    echo "Copy it manually after setup: cp deploy/nginx/progresql.conf /etc/nginx/sites-available/progresql"
fi

nginx -t && systemctl reload nginx

# ---------------------------------------------------------------------------
# 10. Start the backend (if .env is already populated)
# ---------------------------------------------------------------------------
echo ">>> Checking if .env is populated..."
if grep -q "CHANGE_ME" "${APP_DIR}/.env" 2>/dev/null; then
    echo ""
    echo "============================================================"
    echo "  IMPORTANT: Edit ${APP_DIR}/.env before starting."
    echo "  Once done, run:"
    echo "    cd ${APP_DIR} && docker compose up -d"
    echo "============================================================"
else
    echo ">>> Starting backend container..."
    cd "${APP_DIR}"
    docker compose pull 2>/dev/null || true
    docker compose up -d
    echo ">>> Backend started. Check logs with: docker compose -f ${APP_DIR}/docker-compose.yml logs -f"
fi

echo ""
echo ">>> Setup complete."
echo "    App directory : ${APP_DIR}"
echo "    Downloads dir : ${DOWNLOADS_DIR}"
echo "    nginx config  : /etc/nginx/sites-available/progresql"
echo "    SSL certs     : /etc/letsencrypt/live/${DOMAIN}/"
