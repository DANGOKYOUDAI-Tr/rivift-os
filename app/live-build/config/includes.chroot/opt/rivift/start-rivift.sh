#!/bin/bash
set -e
cd /opt/rivift/app
# アップデートサーバー（未設定の場合は自動検出を試みる）
if [ -z "$RIVIFT_UPDATE_URL" ]; then
    # GitHub Pages が有効なら自動検出（gh:owner/repo 形式）
    if [ -f /opt/rivift/.update-source ]; then
        export RIVIFT_UPDATE_URL=$(cat /opt/rivift/.update-source)
    fi
fi
exec npx electron .
