// 用 resedit(纯 JS)把图标与版本信息写进 Windows exe,无需 wine
// 用法: node build/patch-exe-icon.js <path-to-exe>
'use strict';
const fs = require('fs');
const ResEdit = require('resedit');

const exePath = process.argv[2];
if (!exePath || !fs.existsSync(exePath)) {
  console.error('用法: node build/patch-exe-icon.js <exe>');
  process.exit(1);
}

const exe = fs.readFileSync(exePath);
const ne = ResEdit.NtExecutable.from(exe);
const rsrc = ResEdit.NtExecutableResource.from(ne);
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync('build/icon.ico'));

// 替换图标组(资源 ID 1,语言 1033)
const entries = [...rsrc.entries];
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(entries, 1, 1033, iconFile.icons.map((i) => i.data));
rsrc.entries = entries;

// 版本信息:任务栏/详情页显示中文名而非 Electron
try {
  const viList = ResEdit.Resource.VersionInfo.fromEntries(rsrc.entries);
  if (viList.length) {
    const vi = viList[0];
    vi.setFileVersion(1, 0, 0, 0);
    vi.setProductVersion(1, 0, 0, 0);
    let langInfo = null;
    try { const ls = vi.getAvailableLanguages(); langInfo = ls && ls[0]; } catch (e) { /* 忽略 */ }
    if (!langInfo) langInfo = { lang: 1033, codepage: 1200 };
    vi.setStringValues(langInfo, {
      ProductName: 'ES客户端',
      FileDescription: 'ES客户端 - Elasticsearch 桌面工具',
      OriginalFilename: 'ESClient.exe',
      InternalName: 'ESClient',
      FileVersion: '1.0.0',
      ProductVersion: '1.0.0',
      LegalCopyright: 'MIT License'
    });
    vi.outputToResourceEntries(rsrc.entries);
  }
} catch (e) {
  console.warn('版本信息写入跳过:', e.message);
}

rsrc.outputResource(ne);
fs.writeFileSync(exePath, Buffer.from(ne.generate()));
console.log('✅ exe 图标与版本信息已写入');
