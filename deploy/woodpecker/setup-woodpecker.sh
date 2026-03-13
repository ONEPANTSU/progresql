#!/bin/bash
set -euo pipefail

# ============================================================
# Woodpecker CI — Setup Script
# Запускать на сервере (root@81.200.157.194)
# ============================================================

echo "==> 1. Создаём директорию..."
mkdir -p /opt/progresql/woodpecker
cd /opt/progresql/woodpecker

echo "==> 2. Копируем docker-compose..."
# Файл уже должен быть скопирован deploy-backend пайплайном
# или вручную: scp deploy/woodpecker/docker-compose.woodpecker.yml root@81.200.157.194:/opt/progresql/woodpecker/

echo "==> 3. Генерируем agent secret..."
AGENT_SECRET=$(openssl rand -hex 32)
echo "    Agent secret: ${AGENT_SECRET}"

echo "==> 4. Создаём .env.woodpecker..."
echo "    ⚠️  Нужно вписать GitHub OAuth credentials!"
cat > .env.woodpecker << EOF
# GitHub OAuth App credentials
# Создай на https://github.com/settings/developers
# Homepage URL: https://ci.progresql.com
# Callback URL: https://ci.progresql.com/authorize
WOODPECKER_GITHUB_CLIENT=ВСТАВЬ_CLIENT_ID
WOODPECKER_GITHUB_SECRET=ВСТАВЬ_CLIENT_SECRET

# Agent secret
WOODPECKER_AGENT_SECRET=${AGENT_SECRET}
EOF

echo "==> 5. Настраиваем nginx для ci.progresql.com..."
cat > /etc/nginx/sites-available/woodpecker << 'NGINX'
server {
    listen 80;
    server_name ci.progresql.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ci.progresql.com;

    ssl_certificate     /etc/letsencrypt/live/progresql.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/progresql.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;

        # WebSocket support (для live логов)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/woodpecker /etc/nginx/sites-enabled/woodpecker
nginx -t && systemctl reload nginx

echo ""
echo "==> ✅ Nginx настроен для ci.progresql.com"
echo ""
echo "==> 6. Следующие шаги:"
echo "    1. Создай GitHub OAuth App: https://github.com/settings/developers"
echo "       - Homepage URL: https://ci.progresql.com"
echo "       - Authorization callback URL: https://ci.progresql.com/authorize"
echo "    2. Впиши Client ID и Client Secret в /opt/progresql/woodpecker/.env.woodpecker"
echo "    3. Получи SSL для ci.progresql.com:"
echo "       certbot certonly --nginx -d ci.progresql.com"
echo "       (или используй wildcard *.progresql.com если есть)"
echo "    4. Запусти Woodpecker:"
echo "       cd /opt/progresql/woodpecker"
echo "       docker compose -f docker-compose.woodpecker.yml up -d"
echo "    5. Открой https://ci.progresql.com — залогинься через GitHub"
echo "    6. Активируй репо progresql в UI"
