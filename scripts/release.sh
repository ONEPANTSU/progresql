#!/bin/bash
set -euo pipefail

# ============================================================
# ProgreSQL — Local macOS Release Script
# Билдит macOS DMG на маке и загружает в GitHub Release.
# Windows EXE билдится на сервере через Woodpecker CI.
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
    --icon "ProgreSQL.app" 170 180 \
    --app-drop-link 490 180 \
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

# --- GitHub Release first (without tag) ---
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

echo "==> ✅ DMG uploaded! Waiting for GitHub to process..."
sleep 5

# --- Push tag AFTER release+DMG are ready ---
# gh release create already created the tag, just fetch it locally
git fetch origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true

echo ""
echo "==> ✅ Release ready! CI will deploy DMG to server."
echo "    https://github.com/ONEPANTSU/progresql/releases/tag/${TAG}"
