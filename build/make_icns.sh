#!/bin/bash
# 由 build/icon.png 生成 build/icon.icns(需要 macOS 自带 sips / iconutil)
set -euo pipefail
cd "$(dirname "$0")/.."

ICONSET=build/icon.iconset
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512; do
  sips -z $size $size build/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
for size in 32 64 128 256 512 1024; do
  half=$((size / 2))
  sips -z $size $size build/icon.png --out "$ICONSET/icon_${half}x${half}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns
rm -rf "$ICONSET"
echo "build/icon.icns 生成完成"
