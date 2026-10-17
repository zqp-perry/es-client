'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let mainWindow = null;

// ---------------------------------------------------------------------------
// 配置存储:~/Library/Application Support/ES客户端/config.json
// ---------------------------------------------------------------------------
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaultConfig() {
  // 预置连接放在独立的 default-connection.json(打分享安装包时会移除,避免泄露账号密码)
  let connections = [];
  try {
    connections = require('./default-connection.json') || [];
  } catch (e) {
    connections = [];
  }
  return {
    connections,
    activeId: connections.length ? connections[0].id : null
  };
}

function normalizeConn(c) {
  c.whitelistEnabled = !!c.whitelistEnabled;
  c.whitelist = Array.isArray(c.whitelist)
    ? c.whitelist.map((s) => String(s).trim()).filter(Boolean)
    : [];
  // 老配置迁移:acm-dev(共用集群)默认开启危险操作屏蔽
  if (c.blockDanger === undefined) c.blockDanger = c.id === 'acm-dev';
  else c.blockDanger = !!c.blockDanger;
  return c;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.connections)) throw new Error('配置格式错误');
    cfg.connections.forEach(normalizeConn);
    return cfg;
  } catch (e) {
    const cfg = defaultConfig();
    saveConfig(cfg);
    return cfg;
  }
}

function saveConfig(cfg) {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, configPath());
  return cfg;
}

// ---------------------------------------------------------------------------
// ES 请求(Node http/https,绕开浏览器 CORS;支持 Basic / ApiKey 认证)
// ---------------------------------------------------------------------------
function esRequest(conn, method, reqPath, body) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(conn.url);
    } catch (e) {
      resolve({ ok: false, error: '地址格式错误: ' + conn.url });
      return;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      resolve({ ok: false, error: '仅支持 http / https 地址' });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    const hasBody = body != null && String(body).trim() !== '';
    if (hasBody) headers['Content-Type'] = 'application/json';

    let auth = null;
    if (conn.apiKey && String(conn.apiKey).trim()) {
      auth = 'ApiKey ' + String(conn.apiKey).trim();
    } else if (conn.username) {
      auth = 'Basic ' + Buffer.from(conn.username + ':' + (conn.password || '')).toString('base64');
    }
    if (auth) headers['Authorization'] = auth;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: String(reqPath || '/').startsWith('/') ? String(reqPath) : '/' + reqPath,
      method: String(method || 'GET').toUpperCase(),
      headers,
      timeout: Number(conn.timeout) > 0 ? Number(conn.timeout) : 30000
    };
    if (u.protocol === 'https:' && conn.ignoreTLS) {
      opts.agent = new https.Agent({ rejectUnauthorized: false });
    }

    const t0 = Date.now();
    const req = mod.request(opts, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (d) => {
        len += d.length;
        if (len <= 100 * 1024 * 1024) chunks.push(d);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          /* 非 JSON 响应按文本返回 */
        }
        resolve({ ok: res.statusCode < 400, status: res.statusCode, body: parsed, tookMs: Date.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时(可尝试在连接设置中调大超时时间)')));
    req.on('error', (e) => resolve({ ok: false, error: e.message, tookMs: Date.now() - t0 }));
    if (hasBody) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 安全防护:索引白名单 + 危险操作屏蔽(在主进程统一拦截,控制台也无法绕过)
// ---------------------------------------------------------------------------
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 根级(面向 _all)的数据接口:白名单模式下必须显式指定白名单内索引
const ROOT_DATA_ENDPOINTS = ['_search', '_msearch', '_count', '_mget', '_search_template', '_msearch_template'];

function pathIndices(path) {
  const seg = String(path || '').split('?')[0].split('/')[1];
  if (!seg) return null;
  let dec;
  try { dec = decodeURIComponent(seg); } catch (e) { dec = seg; }
  if (!dec) return null;
  if (dec === '_all' || dec === '*') return [dec];
  if (dec.startsWith('_')) return null; // 集群级 API,不针对具体索引
  return dec.split(',').map((s) => s.trim()).filter(Boolean);
}

function wlEnabled(conn) {
  return !!(conn.whitelistEnabled && Array.isArray(conn.whitelist) && conn.whitelist.filter((s) => String(s).trim()).length);
}

function wlMatch(target, patterns) {
  // _all / 通配目标无法收敛到白名单,按不匹配处理
  if (target === '_all' || /[*?]/.test(target)) return false;
  return patterns.some((pat) => new RegExp('^' + pat.split('*').map(escapeRe).join('.*') + '$').test(target));
}

function checkGuard(conn, method, path, body) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').split('?')[0];
  const targets = pathIndices(p) || [];
  const patterns = wlEnabled(conn) ? conn.whitelist.map((s) => String(s).trim()).filter(Boolean) : null;

  if (conn.blockDanger) {
    if (m === 'DELETE' && targets.length && !/(\/_doc\/|\/_update\/)/.test(p)) {
      return '已拦截:删除索引属于危险操作(本连接开启了「屏蔽危险操作」)';
    }
    if (m === 'POST' && /\/_close$/.test(p)) return '已拦截:关闭索引属于危险操作(本连接开启了「屏蔽危险操作」)';
    if (m === 'POST' && /\/_delete_by_query$/.test(p)) return '已拦截:按查询删除文档(_delete_by_query)属于危险操作(本连接开启了「屏蔽危险操作」)';
  }

  if (patterns) {
    // 严格白名单:白名单外的索引不可见、不可读、不可写
    if (p === '/_bulk') {
      const lines = String(body || '').split('\n').filter((l) => l.trim());
      const bad = [];
      for (let i = 0; i < lines.length; i += 2) { // 偶数行为 action 元数据行
        try {
          const meta = JSON.parse(lines[i]);
          const act = meta[Object.keys(meta)[0]] || {};
          const idx = act._index || act.index;
          if (idx && !wlMatch(idx, patterns) && !bad.includes(idx)) bad.push(idx);
        } catch (e) { /* 容忍解析失败的行 */ }
      }
      if (bad.length) return '已拦截:_bulk 涉及白名单外的索引: ' + bad.join(', ');
    } else if (targets.length) {
      const bad = targets.filter((t) => !wlMatch(t, patterns));
      if (bad.length) return '已拦截:索引不在白名单内(' + bad.join(', ') + ')。白名单外的索引不可见、不可读、不可写。白名单规则: ' + patterns.join(' , ');
    } else if (ROOT_DATA_ENDPOINTS.includes(p.slice(1))) {
      return '已拦截:白名单模式下不允许对 _all 发起 ' + p + ' 请求,请指定白名单内的索引';
    }
  }
  return null;
}

/* 白名单启用时,把 _cat 类索引列表请求改写为只查白名单模式:
   索引列表里根本不出现其他索引(连控制台 GET /_cat/indices 也只返回白名单内的) */
function rewriteCatPath(conn, path) {
  const patterns = wlEnabled(conn) ? conn.whitelist.map((s) => String(s).trim()).filter(Boolean) : null;
  if (!patterns) return path;
  const raw = String(path || '');
  const qi = raw.indexOf('?');
  const pathname = (qi >= 0 ? raw.slice(0, qi) : raw).replace(/\/+$/, '');
  const query = qi >= 0 ? raw.slice(qi) : '';
  const CATS = ['/_cat/indices', '/_cat/shards', '/_cat/aliases', '/_cat/segments', '/_cat/recovery'];
  const pat = patterns.map((x) => encodeURIComponent(x).replace(/%2A/gi, '*')).join(',');
  for (const c of CATS) {
    if (pathname === c || pathname.startsWith(c + '/')) {
      return c + '/' + pat + query;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('cfg:get', () => loadConfig());
ipcMain.handle('cfg:save', (_e, cfg) => saveConfig(cfg));
ipcMain.handle('es:req', (_e, p) => {
  const cfg = loadConfig();
  const conn = (p && p.conn) || cfg.connections.find((c) => c.id === (p && p.connId));
  if (!conn) return { ok: false, error: '未找到连接,请先在「连接管理」中配置' };
  const finalPath = rewriteCatPath(conn, p && p.path);
  const guardErr = checkGuard(conn, p && p.method, finalPath, p && p.body);
  if (guardErr) return { ok: false, blocked: true, status: 0, error: guardErr };
  return esRequest(conn, p && p.method, finalPath, p && p.body);
});
ipcMain.handle('app:info', () => ({
  electron: process.versions.electron,
  node: process.versions.node,
  configPath: configPath()
}));

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    // mac 用沉浸式红绿灯标题栏;Windows 用系统原生标题栏
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 18 } } : {}),
    backgroundColor: '#0b101d',
    title: 'ES 客户端',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 冒烟测试模式:加载完成后收集渲染进程错误并退出
  if (process.env.SMOKE) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        const r = await mainWindow.webContents.executeJavaScript(
          'JSON.stringify({errs: (window.__smokeErrors||[]), nav: document.querySelectorAll("#nav .nav-item").length, title: document.title})'
        );
        console.log('SMOKE_RESULT ' + r);
        const parsed = JSON.parse(r);
        app.exit(parsed.errs.length === 0 && parsed.nav >= 5 ? 0 : 1);
      } catch (e) {
        console.log('SMOKE_RESULT error ' + e.message);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
