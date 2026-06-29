#!/bin/bash
# build-update.sh — Rivift OS アップデート用zip + latest.json を生成
#
# 使い方:
#   ./build-update.sh <new_version> [--github username/repo]
#
# 例:
#   ./build-update.sh 0.2.0
#   ./build-update.sh 0.2.0 --github yourname/rivift-os
#
# 出力:
#   dist/update/rivift-os-<version>.zip
#   dist/update/latest.json
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$PROJECT_ROOT/app"
# docs/update に出力 → GitHub Pages が自動公開
DIST_DIR="$PROJECT_ROOT/docs/update"
VERSION="${1:-}"
GITHUB_REPO=""

if [ -z "$VERSION" ]; then
    echo "Usage: $0 <new_version> [--github owner/repo]"
    echo "Current version: $(node -e "console.log(require('$APP_DIR/package.json').version)")"
    exit 1
fi

if [ "$2" = "--github" ] && [ -n "$3" ]; then
    GITHUB_REPO="$3"
fi

echo "=== Rivift OS Update Builder ==="
echo "Version: $VERSION"
echo "App dir: $APP_DIR"
[ -n "$GITHUB_REPO" ] && echo "GitHub:  $GITHUB_REPO"

mkdir -p "$DIST_DIR"

ZIP_FILE="$DIST_DIR/rivift-os-${VERSION}.zip"
TEMP_DIR=$(mktemp -d)
trap "rm -rf '$TEMP_DIR'" EXIT

echo "--- Copying app files (excl. node_modules, .git, DS_Store) ---"
rsync -a --exclude='node_modules' --exclude='.git' --exclude='.DS_Store' \
    --exclude='dist' --exclude='*.log' --exclude='__pycache__' \
    "$APP_DIR/" "$TEMP_DIR/app/"

# Update version in package.json
echo "--- Setting version $VERSION in package.json ---"
node -e "
const p = require('$TEMP_DIR/app/package.json');
p.version = '$VERSION';
require('fs').writeFileSync('$TEMP_DIR/app/package.json', JSON.stringify(p, null, 2) + '\n');
"

# Also update backend/package.json
if [ -f "$TEMP_DIR/app/backend/package.json" ]; then
    node -e "
    const p = require('$TEMP_DIR/app/backend/package.json');
    p.version = '$VERSION';
    require('fs').writeFileSync('$TEMP_DIR/app/backend/package.json', JSON.stringify(p, null, 2) + '\n');
    "
fi

echo "--- Creating zip ---"
cd "$TEMP_DIR"
zip -r "$ZIP_FILE" app/ -x "*/node_modules/*" "*.git*" "*.DS_Store" > /dev/null
cd "$PROJECT_ROOT"

ZIP_SIZE=$(stat -f%z "$ZIP_FILE" 2>/dev/null || stat -c%s "$ZIP_FILE" 2>/dev/null || echo "0")
SHA256=$(shasum -a 256 "$ZIP_FILE" | cut -d' ' -f1)

echo "--- Generating latest.json ---"

if [ -n "$GITHUB_REPO" ]; then
    DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/rivift-os-${VERSION}.zip"
else
    DOWNLOAD_URL="./rivift-os-${VERSION}.zip"
fi

cat > "$DIST_DIR/latest.json" << JSON
{
  "version": "${VERSION}",
  "download_url": "${DOWNLOAD_URL}",
  "sha256": "${SHA256}",
  "size": ${ZIP_SIZE},
  "changelog": "## Rivift OS v${VERSION}\n\n- 更新内容をここに書いてください\n",
  "required_version": "0.1.0"
}
JSON

echo ""
echo "=== 完了 ==="
echo "  ZIP:     $ZIP_FILE ($(echo "scale=1; $ZIP_SIZE/1048576" | bc) MB)"
echo "  SHA256:  $SHA256"
echo "  JSON:    $DIST_DIR/latest.json"
echo ""
echo "GitHub にアップロードする手順:"
echo "  1. GitHub でリリースを作成 (v${VERSION})"
echo "  2. $ZIP_FILE をアップロード"
echo "  3. dist/update/latest.json を gh-pages ブランチ等に配置"
echo "  4. 環境変数 RIVIFT_UPDATE_URL を設定:"
echo ""
if [ -n "$GITHUB_REPO" ]; then
    echo "     export RIVIFT_UPDATE_URL=gh:${GITHUB_REPO}"
else
    echo "     export RIVIFT_UPDATE_URL=https://your-update-server.example.com"
fi
echo ""
