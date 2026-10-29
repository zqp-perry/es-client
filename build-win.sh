#!/bin/bash
# 在 macOS 上交叉打包 Windows 便携版(zip,解压即用,无需安装):
#   bash build-win.sh              → 分享模式(不含内置连接,默认)
#   KEEP_CONN=1 bash build-win.sh  → 保留内置连接(慎用:包含集群账号密码)
# 说明:文件名用 ASCII(ESClient),避免 Windows 解压中文文件名出现乱码;
#       窗口/任务栏内仍显示「ES客户端」。需要正式安装器(NSIS exe)请用 GitHub Actions 构建。
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -p "require('./package.json').version")
EVER=$(node -p "require('./node_modules/electron/package.json').version")
CACHE="build/cache/electron-${EVER}-win-x64"
ZIP="build/cache/electron-v${EVER}-win32-x64.zip"

mkdir -p build/cache
if [ ! -d "$CACHE" ]; then
  if [ ! -f "$ZIP" ]; then
    echo "下载 Windows 版 Electron(${EVER},x64)…"
    curl -fL -o "$ZIP" "https://npmmirror.com/mirrors/electron/${EVER}/electron-v${EVER}-win32-x64.zip"
  fi
  rm -rf "$CACHE"
  mkdir -p "$CACHE"
  # mac 用 unzip;Windows runner(Git Bash)无 unzip,用 python zipfile
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$ZIP" -d "$CACHE"
  else
    PY=$(command -v python3 || command -v python)
    "$PY" -m zipfile -e "$ZIP" "$CACHE/"
  fi
fi

OUT="dist/ESClient-win-x64"
rm -rf "$OUT"
mkdir -p dist
cp -R "$CACHE" "$OUT"

# 替换应用代码
rm -f "$OUT/resources/default_app.asar"
APPDIR="$OUT/resources/app"
mkdir -p "$APPDIR"
cp -R main.js preload.js renderer package.json default-connection.json "$APPDIR/"

# 分享模式:移除内置连接(不含任何账号密码)
if [ "${SHARE:-0}" = "1" ] || [ "${KEEP_CONN:-0}" != "1" ]; then
  rm -f "$APPDIR/default-connection.json"
  echo "🔒 分享模式:已移除内置连接,包内不含任何账号密码(KEEP_CONN=1 可保留)"
fi

# 改名 + 写入图标与版本信息
mv "$OUT/electron.exe" "$OUT/ESClient.exe"
if [ -f build/icon.ico ] && [ -d node_modules/resedit ]; then
  node build/patch-exe-icon.js "$OUT/ESClient.exe" || echo "⚠️ exe 图标替换失败,使用默认图标"
else
  echo "⚠️ 缺少 build/icon.ico 或 resedit,exe 使用默认图标"
fi

PKG="dist/ESClient-v${VERSION}-win-x64-portable.zip"
rm -f "$PKG"
if command -v zip >/dev/null 2>&1; then
  (cd dist && zip -qr9 "$(basename "$PKG")" "$(basename "$OUT")")
else
  PY=$(command -v python3 || command -v python)
  (cd dist && "$PY" -m zipfile -c "$(basename "$PKG")" "$(basename "$OUT")")
fi
rm -rf "$OUT"

echo "✅ Windows 便携版已生成:$(cd dist && pwd)/$(basename "$PKG")"
ls -lh "$PKG" | awk '{print "   大小:" $5}'
echo "   使用方式:Windows 上解压后直接运行 ESClient.exe"
