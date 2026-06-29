#!/bin/bash
# run-docker.sh — Rivift OS ISO を Docker でビルドするスクリプト
# macOS / Linux どちらでも動作
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/output"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Rivift OS ISO Builder (Docker) ===${NC}"

# Check Docker
if ! command -v docker &>/dev/null; then
    echo -e "${RED}[ERROR] Docker がインストールされていません${NC}"
    echo "  macOS: https://docs.docker.com/desktop/setup/install/mac-install/"
    echo "  または OrbStack: https://orbstack.dev"
    exit 1
fi

# Check Docker is running
if ! docker info &>/dev/null; then
    echo -e "${RED}[ERROR] Docker デーモンが動作していません${NC}"
    echo "  Docker Desktop を起動してください"
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Build the Docker image (if not already cached)
echo -e "${YELLOW}[1/4] Docker イメージをビルドしています...${NC}"
docker build -t rivift-iso-builder "$SCRIPT_DIR"

# Run the build
echo -e "${YELLOW}[2/4] ISO ビルドを開始します（20〜40分かかります）...${NC}"
echo -e "${YELLOW}      進捗は build.log に出力されます${NC}"

docker run --rm \
    --name rivift-build \
    -v "$PROJECT_ROOT:/src" \
    -v "$OUTPUT_DIR:/output" \
    rivift-iso-builder

# Check result
echo -e "${YELLOW}[3/4] 結果を確認しています...${NC}"
if ls "$OUTPUT_DIR"/*.iso 2>/dev/null | head -1; then
    ISO_FILE=$(ls "$OUTPUT_DIR"/*.iso 2>/dev/null | head -1)
    SIZE=$(du -h "$ISO_FILE" 2>/dev/null | cut -f1)
    echo -e "${GREEN}=== ビルド成功！ ===${NC}"
    echo -e "  ISO: ${GREEN}$ISO_FILE${NC}"
    echo -e "  サイズ: $SIZE"
    echo ""
    echo -e "${YELLOW}[4/4] USB に書き込むには:${NC}"
    echo -e "  1. USB を挿入し、デバイス名を確認:"
    echo -e "     ${GREEN}diskutil list${NC}"
    echo -e "  2. 書き込み (/dev/diskX は正しいデバイスに置き換え):"
    echo -e "     ${GREEN}sudo dd if=$ISO_FILE of=/dev/diskX bs=4m status=progress${NC}"
    echo -e "  3. 取り出し:"
    echo -e "     ${GREEN}diskutil eject /dev/diskX${NC}"
    echo ""
    echo -e "  ${YELLOW}⚠ 注意: dd はデバイスを完全に上書きします。"
    echo -e "  必ず正しいデバイスかを確認してから実行してください。${NC}"
else
    echo -e "${RED}=== ビルド失敗 ===${NC}"
    echo -e "${RED}  $OUTPUT_DIR/build.log を確認してください${NC}"
    exit 1
fi
