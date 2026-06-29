#!/bin/bash
# setup-github.sh — Rivift OS の GitHub リポジトリ + GitHub Pages をセットアップ
# macOS 上で動作。GitHub CLI (gh) が無ければ Web 手順を表示
set -e

echo "=== Rivift OS GitHub セットアップ ==="
echo ""

# Check gh CLI
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    echo "GitHub CLI (gh) が利用可能です。自動セットアップします。"
    echo ""

    read -p "GitHub リポジトリ名 [rivift-os]: " REPO_NAME
    REPO_NAME="${REPO_NAME:-rivift-os}"

    read -p "リポジトリの説明 [Rivift OS - Electron based desktop environment]: " REPO_DESC
    REPO_DESC="${REPO_DESC:-Rivift OS - Electron based desktop environment}"

    echo ""
    echo "リポジトリを作成しています..."
    gh repo create "$REPO_NAME" --public --description "$REPO_DESC" --source=. --remote=origin --push 2>&1 || {
        echo "既存のリポジトリにプッシュします..."
        git remote add origin "https://github.com/$(gh api user | jq -r .login)/${REPO_NAME}.git" 2>/dev/null || true
        git push -u origin main 2>&1 || echo "push 完了"
    }

    OWNER=$(gh api user | jq -r .login)
    echo ""
    echo "GitHub Pages を有効化しています..."
    gh api "repos/${OWNER}/${REPO_NAME}/pages" -X POST \
        --input <(echo '{"source":{"branch":"main","path":"/docs"}}') 2>/dev/null || {
        echo "Web から設定してください: https://github.com/${OWNER}/${REPO_NAME}/settings/pages"
        echo "  Source → Deploy from branch → main → /docs → Save"
    }

    echo ""
    echo "=== セットアップ完了 ==="
    echo "  リポジトリ: https://github.com/${OWNER}/${REPO_NAME}"
    echo "  Pages URL:  https://${OWNER}.github.io/${REPO_NAME}"
    echo ""
    echo "  RIVIFT_UPDATE_URL の値:"
    echo "    export RIVIFT_UPDATE_URL=gh:${OWNER}/${REPO_NAME}"
    echo ""

else
    echo "GitHub CLI (gh) がインストールされていません。"
    echo "Web から手動でセットアップします。"
    echo ""
    echo "【手順】"
    echo "  1. https://github.com にアクセスしてアカウント作成（またはログイン）"
    echo ""
    echo "  2. 新しいリポジトリを作成:"
    echo "     https://github.com/new"
    echo "     - Repository name: rivift-os"
    echo "     - Public にする"
    echo "     - Create repository をクリック"
    echo ""
    echo "  3. できたらこのプロジェクトをプッシュ:"
    echo "     cd \"$(dirname "$0")/..\""
    echo "     git init"
    echo "     git add ."
    echo '     git commit -m "Initial commit"'
    echo "     git remote add origin https://github.com/あなたのユーザー名/rivift-os.git"
    echo "     git push -u origin main"
    echo ""
    echo "  4. GitHub Pages を有効化:"
    echo "     https://github.com/あなたのユーザー名/rivift-os/settings/pages"
    echo "     Source → Deploy from branch → main → /docs → Save"
    echo ""
    echo "  5. 以上！ RIVIFT_UPDATE_URL には以下を設定:"
    echo "     export RIVIFT_UPDATE_URL=gh:あなたのユーザー名/rivift-os"
    echo ""
fi
