# ES客户端

跨平台(macOS / Windows)Elasticsearch 桌面工具。像数据库客户端一样按字段查数据,不用手写 DSL;同时保留 Kibana Dev Tools 风格的原生 DSL / REST 控制台。零运行时依赖、离线可用,所有请求经本机主进程直连你的 ES。

![平台](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 功能

- **连接管理**:多连接,支持 Basic 认证 / ApiKey / 无认证,自签名 https 可忽略证书;可通过 `default-connection.json` 预置连接(参见 `default-connection.example.json`)。
- **概览**:集群健康、版本、节点数、索引数、文档总数、存储大小、节点列表。
- **数据浏览(核心)**:选索引(≈选表)→ 字段下拉选条件(等于 / 不等于 / 包含 / 短语 / 前缀 / 通配符 / 大于小于 / 区间 / 为空 / 为真为假,操作符按字段类型自动适配)→ 表格展示、排序、翻页、列配置(表头 ✕ 快速隐藏列);点行查看 / 编辑 / 删除文档,可新增文档;全字段快速搜索;可展开查看自动生成的 DSL;字段列表 = 完整 mapping + 文档采样补全。
- **索引管理**:列表(健康 / 状态 / 文档数 / 大小)、查看 mapping / settings、新建 / 打开 / 关闭 / 删除索引(删除需输入索引名确认)。
- **DSL 查询**:常用模板(match / term / range / bool / 聚合 / 排序分页)、格式化、表格 / JSON 双视图;数据浏览的条件可一键带入继续改。
- **控制台**:Kibana Dev Tools 风格——一个编辑器多个请求,光标处 ⌘/Ctrl+回车执行;支持 # 注释、格式化、历史;可调 bulk、reindex、_sql 等任意 API。
- **安全防护(连接级,共用集群推荐)**:
  - **索引白名单**:仅白名单内索引**可见、可读、可写**;白名单外界面不显示,直接请求(含 `_all`、`_cat` 列表、bulk)在主进程被拦截或改写,控制台也无法绕过;
  - **屏蔽危险操作**:删除索引 / 关闭索引 / `_delete_by_query` 一律拦截(即使白名单内)。

适配 ES 6.x / 7.x / 8.x。

## 安装

到 [Releases](../../releases) 下载对应平台安装包:

- **macOS**:`ES客户端-v*-*-arm64.dmg`(Apple Silicon)或 universal 版(Intel Mac);打开后拖入 Applications。未签名应用首次打开:右键 → 打开。
- **Windows**:`ESClient-Setup-v*-x64.exe` 安装版,或 `ESClient-v*-win-x64-portable.zip` 便携版(解压直接运行 `ESClient.exe`)。

## 使用

1. 打开应用,在「连接管理 → + 新增连接」填入 ES 地址与账号(支持 http / https);
2. 顶部下拉切换连接;「数据浏览」按字段查数据,「控制台」写原生 DSL;
3. 共用集群请开启「安全防护」(连接编辑页)。

连接配置(含密码,明文)保存在本机:
macOS `~/Library/Application Support/ES客户端/config.json`,Windows `%APPDATA%\ES客户端\config.json`。请勿在公共电脑保存敏感密码。

## 开发

```bash
npm install        # Electron 二进制走 npmmirror 镜像(见 .npmrc)
npm start          # 运行
npm run icon       # 重新生成图标(需 python3;mac 另需 sips)
npm run build      # 打 mac .app 放到桌面
npm run dmg        # 打 mac DMG 分享包(默认不含任何预置连接/密码)
npm run win        # 在 mac 上交叉打包 Windows 便携版 zip
```

Windows 正式安装器(NSIS)由 GitHub Actions 构建(见下)。

## 发布(GitHub Actions)

`.github/workflows/release.yml`:推 tag 自动构建并发布 Release——

```bash
git tag v1.0.0 && git push origin v1.0.0
```

产物:macOS DMG(arm64)+ Windows NSIS 安装器与便携 zip。也可在 Actions 页手动触发(workflow_dispatch),产物在 Artifacts 下载。

## License

[MIT](./LICENSE)
