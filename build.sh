#!/bin/bash
# 打包为 Mac .app:复制 Electron.app,替换应用代码与图标,改写 Info.plist,放到桌面。
# 环境变量:
#   SHARE=1        分享模式:移除内置连接(default-connection.json),安装包不含任何账号密码
#   ARCH=universal 出通用包(Apple Silicon + Intel);默认 arm64
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="ES客户端"
OUT="dist/${APP_NAME}.app"
ARCH="${ARCH:-arm64}"

# 选择 Electron 底座
SRC_APP="node_modules/electron/dist/Electron.app"   # 本机 npm 安装的(arm64)
if [ "$ARCH" = "universal" ]; then
  VER=$(node -p "require('./node_modules/electron/package.json').version")
  CACHE_DIR="build/cache"
  UAPP="$CACHE_DIR/Electron-universal.app"
  if [ ! -d "$UAPP" ]; then
    ZIP="electron-v${VER}-darwin-universal.zip"
    mkdir -p "$CACHE_DIR"
    echo "下载 Universal 版 Electron($VER)…"
    curl -fL -o "$CACHE_DIR/$ZIP" "https://npmmirror.com/mirrors/electron/${VER}/${ZIP}"
    unzip -q "$CACHE_DIR/$ZIP" -d "$CACHE_DIR/universal-tmp"
    mv "$CACHE_DIR/universal-tmp/Electron.app" "$UAPP"
    rm -rf "$CACHE_DIR/universal-tmp"
  fi
  SRC_APP="$UAPP"
fi

if [ ! -d "$SRC_APP" ]; then
  echo "❌ 未找到 Electron 二进制($SRC_APP),先执行: npm install"
  exit 1
fi

rm -rf "$OUT"
mkdir -p dist
cp -R "$SRC_APP" "$OUT"

APP_CONTENTS="$OUT/Contents"
# 替换应用代码
rm -f "$APP_CONTENTS/Resources/default_app.asar"
rm -rf "$APP_CONTENTS/Resources/app"
mkdir -p "$APP_CONTENTS/Resources/app"
cp -R main.js preload.js renderer package.json default-connection.json "$APP_CONTENTS/Resources/app/"

# 图标(存在则替换)
if [ -f build/icon.icns ]; then
  cp build/icon.icns "$APP_CONTENTS/Resources/electron.icns"
fi

# 改写 Info.plist
PLIST="$APP_CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName ${APP_NAME}" "$PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ${APP_NAME}" "$PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.zqp.esclient" "$PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 1.0.0" "$PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 1.0.0" "$PLIST" >/dev/null

# 分享模式:移除内置连接(不含任何账号密码,使用者自行配置)
if [ "${SHARE:-0}" = "1" ]; then
  rm -f "$APP_CONTENTS/Resources/app/default-connection.json"
  echo "🔒 分享模式:已移除内置连接,包内不含任何账号密码"
fi

xattr -cr "$OUT" 2>/dev/null || true

echo "✅ 已生成 $OUT($ARCH)"
# 放到桌面(移动,不留副本)
TARGET="$HOME/Desktop/${APP_NAME}.app"
rm -rf "$TARGET"
mv "$OUT" "$TARGET"
echo "✅ 已放到桌面: $TARGET"
