#!/bin/bash
# build-deb.sh — rivift-shell の .deb パッケージをビルドするスクリプト
#
# 使い方:
#   cd packaging/
#   ./build-deb.sh
#
# 出力: packaging/rivift-shell_0.1.0_amd64.deb
#
# やっていること:
#   1. debian/opt/rivift/app/ に、本物のappフォルダ(main.js, backend/, renderer/)
#      をコピーする(node_modulesは含めない。postinstでnpm installする方針)
#   2. dpkg-deb --build で .deb にまとめる
#
# 前提: dpkg-deb コマンドが使えること(Debian/Ubuntu系には標準で入っている)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBIAN_ROOT="$SCRIPT_DIR/debian"
APP_SRC="$SCRIPT_DIR/../app"
APP_DEST="$DEBIAN_ROOT/opt/rivift/app"

echo "[build-deb] アプリのファイルをコピーしています..."
rm -rf "$APP_DEST"
mkdir -p "$APP_DEST"

# node_modules や .git, ログファイル等は除外してコピーする
# (rsyncが無い環境でも動くよう、cp + find --exclude相当の処理にしている)
cp -a "$APP_SRC"/. "$APP_DEST"/
find "$APP_DEST" -type d -name 'node_modules' -prune -exec rm -rf {} +
find "$APP_DEST" -type d -name '.git' -prune -exec rm -rf {} +
find "$APP_DEST" -type f -name '*.log' -delete
find "$APP_DEST" -type f -name '.DS_Store' -delete
# 開発・検証中にできる派生ファイル(index_phase1only.html等)も除外する
find "$APP_DEST/renderer" -type f -name 'index_*.html' ! -name 'index.html' -delete 2>/dev/null || true

echo "[build-deb] 権限を設定しています..."
chmod 0755 "$DEBIAN_ROOT/DEBIAN/postinst"
chmod 0755 "$DEBIAN_ROOT/DEBIAN/postrm"

echo "[build-deb] .deb パッケージをビルドしています..."
dpkg-deb --build --root-owner-group "$DEBIAN_ROOT" "$SCRIPT_DIR/rivift-shell_0.1.0_amd64.deb"

echo "[build-deb] 完了: $SCRIPT_DIR/rivift-shell_0.1.0_amd64.deb"
echo ""
echo "インストールするには:"
echo "  sudo dpkg -i rivift-shell_0.1.0_amd64.deb"
echo "  sudo apt-get install -f   # 依存関係が足りない場合"
