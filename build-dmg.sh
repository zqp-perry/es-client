#!/bin/bash
# 生成 DMG 安装包(用于分享给同事):
#   bash build-dmg.sh                 → arm64 分享包(默认,不含内置连接)
#   KEEP_CONN=1 bash build-dmg.sh     → 保留内置连接(慎用:包含集群账号密码)
#   ARCH=universal bash build-dmg.sh  → 通用包(Intel + Apple Silicon)
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="ES客户端"
VERSION=$(node -p "require('./package.json').version")
ARCH="${ARCH:-arm64}"
SHARE=1
if [ "${KEEP_CONN:-0}" = "1" ]; then SHARE=0; fi

# 先构建 .app(会放到桌面)
SHARE=$SHARE ARCH=$ARCH bash build.sh

# 组装 DMG 暂存目录
STAGING="build/dmg-staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$HOME/Desktop/${APP_NAME}.app" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

ARCH_NOTE="芯片 Mac"
[ "$ARCH" = "universal" ] && ARCH_NOTE="Apple Silicon 和 Intel 芯片 Mac"
cat > "$STAGING/安装说明.txt" <<EOF
ES 客户端 v${VERSION} 安装说明
================================

1. 把「${APP_NAME}.app」拖到旁边的 Applications 文件夹(或任意想放的位置);
2. 首次打开若提示「无法验证开发者」(应用未做 Apple 签名公证,属正常现象),任选其一:
   · 右键点击 App →「打开」→ 再点「打开」;
   · 系统设置 → 隐私与安全性 → 点「仍要打开」;
   · 或在终端执行:xattr -cr /Applications/${APP_NAME}.app
3. 打开后在「连接管理 → + 新增连接」里填入你的 Elasticsearch 地址和账号即可使用;
4. 共用集群建议开启「安全防护」:索引白名单 + 屏蔽危险操作(删除/关闭索引)。

适用系统:macOS(${ARCH_NOTE})
EOF

DMG="dist/ESClient-v${VERSION}-macos-${ARCH}.dmg"
rm -f "$DMG"
hdiutil create -volname "${APP_NAME}" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGING"

echo ""
echo "✅ 安装包已生成:$(cd dist && pwd)/$(basename "$DMG")"
ls -lh "$DMG" | awk '{echo "   大小:" $5}'
echo "   分享方式:直接把这个 .dmg 文件发给同事(IM / 网盘 / 内部文件服务器均可)"
open dist 2>/dev/null || true
