#!/bin/bash
# 由 build/icon.png 生成 build/icon.ico(Windows exe 图标用)
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=build/ico-tmp
rm -rf "$TMP"
mkdir -p "$TMP"
for size in 16 24 32 48 64 128 256; do
  sips -z $size $size build/icon.png --out "$TMP/$size.png" >/dev/null
done
python3 build/pack_ico.py build/icon.ico "$TMP"/{16,24,32,48,64,128,256}.png
rm -rf "$TMP"
