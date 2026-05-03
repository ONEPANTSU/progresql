#!/bin/bash
set -euo pipefail

# ============================================================
# ProgreSQL — Client Release Script
#
# 1. Билдит macOS DMG локально (с кастомным фоном)
# 2. Создаёт GitHub Release и загружает DMG
# 3. Тригерит GitHub Actions для сборки Windows EXE + Linux AppImage
# 4. Ждёт завершения всех билдов
# ============================================================

cd "$(dirname "$0")/.."

# --- Version ---
VERSION=$(node -p 'require("./frontend/package.json").version')
TAG="client-v${VERSION}"
echo "==> Releasing ProgreSQL Client ${VERSION} (tag: ${TAG})"

# --- Check clean working tree ---
if [ -n "$(git status --porcelain frontend/)" ]; then
  echo "ERROR: frontend/ has uncommitted changes. Commit first."
  exit 1
fi

# --- Build macOS ---
cd frontend

echo "==> Installing dependencies..."
npm ci --silent

echo "==> Building Next.js + Electron (macOS)..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx nextron build --mac 2>&1 | tail -20

echo "==> Build output:"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || true

# --- macOS DMG with custom background ---
echo "==> Creating DMG with custom background..."
rm -f dist/ProgreSQL-${VERSION}-arm64.dmg

if command -v create-dmg &>/dev/null; then
  create-dmg \
    --volname "ProgreSQL ${VERSION}" \
    --background "public/assets/dmg/background.png" \
    --window-pos 200 120 \
    --window-size 660 400 \
    --icon-size 100 \
    --icon "ProgreSQL.app" 170 190 \
    --app-drop-link 490 190 \
    --no-internet-enable \
    "dist/ProgreSQL-${VERSION}-arm64.dmg" \
    "dist/mac-arm64/ProgreSQL.app" || true
else
  echo "WARNING: create-dmg not found. Install with: brew install create-dmg"
fi

# --- Verify ---
DMG="dist/ProgreSQL-${VERSION}-arm64.dmg"
ZIP=$(ls dist/*-mac.zip 2>/dev/null | head -1)

echo ""
echo "==> Artifacts:"
[ -f "$DMG" ] && echo "  ✅ DMG: $(du -h "$DMG" | cut -f1)" || echo "  ❌ DMG not found"
[ -n "$ZIP" ] && echo "  ✅ ZIP: $(du -h "$ZIP" | cut -f1)" || echo "  ⚠️  ZIP not found"

if [ ! -f "$DMG" ]; then
  echo "ERROR: DMG not created. Aborting."
  exit 1
fi

cd ..

# --- GitHub Release ---
echo ""
echo "==> Creating GitHub Release with DMG..."
UPLOAD_FILES=""
[ -f "frontend/$DMG" ] && UPLOAD_FILES="$UPLOAD_FILES frontend/$DMG"
[ -n "$ZIP" ] && UPLOAD_FILES="$UPLOAD_FILES frontend/$ZIP"

gh release create "${TAG}" \
  --title "ProgreSQL ${VERSION}" \
  --generate-notes \
  --target main \
  $UPLOAD_FILES \
  2>/dev/null || {
    echo "Release exists, uploading assets..."
    gh release upload "${TAG}" $UPLOAD_FILES --clobber
  }

echo "==> ✅ DMG uploaded!"

# --- Fetch tag locally ---
git fetch origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true

# --- Trigger GitHub Actions for Windows + Linux ---
echo ""
echo "==> Triggering GitHub Actions for Windows + Linux builds..."
gh workflow run build-desktop.yml --field tag="${TAG}"
sleep 3

# Find the run that was just triggered
RUN_ID=$(gh run list --workflow=build-desktop.yml --limit 1 --json databaseId --jq '.[0].databaseId')
echo "==> Actions run: https://github.com/ONEPANTSU/progresql/actions/runs/${RUN_ID}"

# --- Wait for builds ---
echo "==> Waiting for Windows + Linux builds..."
while true; do
  STATUS=$(gh run view "$RUN_ID" --json status --jq '.status')
  if [ "$STATUS" = "completed" ]; then
    CONCLUSION=$(gh run view "$RUN_ID" --json conclusion --jq '.conclusion')
    if [ "$CONCLUSION" = "success" ]; then
      echo "==> ✅ All builds completed successfully!"
    else
      echo "==> ❌ Build failed: ${CONCLUSION}"
      echo "    Check: https://github.com/ONEPANTSU/progresql/actions/runs/${RUN_ID}"
      exit 1
    fi
    break
  fi
  printf "."
  sleep 15
done

# --- Update download symlinks on server ---
echo ""
echo "==> Updating download links on progresql.com..."
DOWNLOAD_DIR="/opt/progresql/downloads"
GITHUB_DL="https://github.com/ONEPANTSU/progresql/releases/download/${TAG}"
DOWNLOAD_HOST="${PROGRESSQL_DOWNLOAD_HOST:-147.45.198.0}"
# After server reinstall / key rotation, drop stale host keys so SSH does not abort.
ssh-keygen -R "${DOWNLOAD_HOST}" 2>/dev/null || true
ssh-keyscan -H "${DOWNLOAD_HOST}" >> ~/.ssh/known_hosts 2>/dev/null || true
ssh -i ~/.ssh/progresql_server root@${DOWNLOAD_HOST} "cd ${DOWNLOAD_DIR} && \
  curl -sL '${GITHUB_DL}/ProgreSQL-${VERSION}-arm64.dmg' -o ProgreSQL-${VERSION}-arm64.dmg && \
  curl -sL '${GITHUB_DL}/ProgreSQL.Setup.${VERSION}.exe' -o ProgreSQL.Setup.${VERSION}.exe && \
  curl -sL '${GITHUB_DL}/ProgreSQL-${VERSION}.AppImage' -o ProgreSQL-${VERSION}.AppImage && \
  ln -sf ProgreSQL-${VERSION}-arm64.dmg ProgreSQL-latest.dmg && \
  ln -sf ProgreSQL.Setup.${VERSION}.exe ProgreSQL-latest.exe && \
  ln -sf ProgreSQL-${VERSION}.AppImage ProgreSQL-latest.AppImage && \
  echo 'Symlinks updated:' && ls -lh ProgreSQL-latest*"
echo "==> ✅ Download links updated!"

# --- Final summary ---
echo ""
echo "==> Release v${VERSION} complete!"
gh release view "${TAG}" --json assets --jq '.assets[] | "  \(.name) (\(.size / 1048576 | floor)MB)"'
echo ""
echo "    https://github.com/ONEPANTSU/progresql/releases/tag/${TAG}"
