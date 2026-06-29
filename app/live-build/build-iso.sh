#!/bin/bash
# build-iso.sh — Rivift OS ブータブルISOビルド（Dockerコンテナ内で実行）
set -e

RIVIFT_VERSION="${RIVIFT_VERSION:-0.1.0}"
DEBIAN_SUITE="${DEBIAN_SUITE:-bookworm}"
ARCH="amd64"
OUTPUT_DIR="${OUTPUT_DIR:-/output}"
BUILD_DIR="/build"
SRC_DIR="/src"

echo "=== Rivift OS ISO Builder ==="
echo "Version: $RIVIFT_VERSION | Debian: $DEBIAN_SUITE | Arch: $ARCH"

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Copy live-build config from source
echo "--- Configuring live-build ---"
mkdir -p "$BUILD_DIR/config"
cp -a "$SRC_DIR/app/live-build/config/." "$BUILD_DIR/config/"

# Copy app source into includes.chroot
echo "--- Copying app source ---"
mkdir -p "$BUILD_DIR/config/includes.chroot/opt/rivift"
cp -a "$SRC_DIR/app/." "$BUILD_DIR/config/includes.chroot/opt/rivift/app"

# Clean up node_modules etc from the included source
find "$BUILD_DIR/config/includes.chroot/opt/rivift/app" \
    -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/config/includes.chroot/opt/rivift/app" \
    -type d -name .git -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/config/includes.chroot/opt/rivift" \
    -name '.DS_Store' -delete 2>/dev/null || true

# Run lb config
echo "--- Running lb config ---"
lb config \
    --distribution "$DEBIAN_SUITE" \
    --archive-areas "main contrib non-free non-free-firmware" \
    --bootappend-live "boot=live components username=rivift locales=ja_JP.UTF-8 keyboard-layouts=jp" \
    --iso-application "Rivift OS" \
    --iso-preparer "Rivift OS Builder" \
    --iso-publisher "Rivift OS" \
    --iso-volume "Rivift OS ${RIVIFT_VERSION}" \
    --image-name "rivift-os-${RIVIFT_VERSION}" \
    --linux-packages "linux-image-amd64" \
    --linux-flavours "amd64"

# Build ISO
echo "--- Building ISO (this will take a while) ---"
lb build 2>&1 | tee "$OUTPUT_DIR/build.log"

# Copy result
echo "--- Collecting result ---"
ISO_FILE=""
if [ -f "$BUILD_DIR/rivift-os-${RIVIFT_VERSION}-hybrid.iso" ]; then
    ISO_FILE="$BUILD_DIR/rivift-os-${RIVIFT_VERSION}-hybrid.iso"
elif ls "$BUILD_DIR"/*.iso 2>/dev/null | head -1; then
    ISO_FILE=$(ls "$BUILD_DIR"/*.iso 2>/dev/null | head -1)
fi

if [ -n "$ISO_FILE" ]; then
    cp "$ISO_FILE" "$OUTPUT_DIR/"
    echo "=== SUCCESS ==="
    echo "ISO: $OUTPUT_DIR/$(basename "$ISO_FILE")"
    ls -lh "$ISO_FILE"
else
    echo "=== FAILED ==="
    echo "ISO was not generated. Check $OUTPUT_DIR/build.log"
    ls -la "$BUILD_DIR/"
    exit 1
fi
