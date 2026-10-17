'use strict';
/* =========================================================================
 * ES 客户端 渲染进程
 * 视图:概览 / 索引 / 数据浏览(类数据库工具) / DSL 查询 / 控制台 / 连接管理
 * ========================================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('zh-CN'));
const fmtBytes = (n) => {
  if (n == null) return '—';
  n = Number(n);
  if (isNaN(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
};
const trunc = (s, n = 120) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const LS = {
  get(k, d) { try { const v = localStorage.getItem('esclient:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('esclient:' + k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }
};

window.__smokeErrors = [];
window.addEventListener('error', (e) => window.__smokeErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__smokeErrors.push(String(e.reason && e.reason.message || e.reason)));

/* 平台适配:Windows 无红绿灯沉浸标题栏、快捷键提示用 Ctrl */
const IS_MAC = /Mac/i.test(navigator.platform);
const CMD = IS_MAC ? '⌘' : 'Ctrl';
if (!IS_MAC) document.body.classList.add('win');

/* ---------------------------- 全局状态 ---------------------------- */
const state = {
  cfg: null,
  connId: null,
  connected: false,
  cluster: null,            // {cluster_name, version}
  view: 'overview',
  indices: [],              // _cat/indices 结果
  browse: {
    index: '', fields: [],  // [{path,type}] 来自 mapping
    quick: '', filters: [{ field: '', op: 'match', value: '' }],
    docFields: [],           // 文档中存在但 mapping 未定义的字段(从数据采样补充)
    sortField: '', sortOrder: 'asc',
    page: 1, size: 25,
    cols: null,             // 当前可见列(path 数组)
    lastHits: [], lastTotal: 0, lastTook: 0
  },
  mappingCache: {}          // connId|index -> {fields}
};

/* ---------------------------- API 封装 ---------------------------- */
async function apiReq(method, path, body, connOverride) {
  const payload = { connId: state.connId, method, path, body };
  if (connOverride) { delete payload.connId; payload.conn = connOverride; }
  return window.api.request(payload);
}
function errText(r) {
  if (!r) return '未知错误';
  if (r.blocked) return '⛔ ' + r.error;
  if (r.error) return r.error;
  const b = r.body;
  if (b && typeof b === 'object' && b.error) {
    const e = b.error;
    let msg = e.reason ? e.type + ': ' + e.reason : typeof e === 'string' ? e : JSON.stringify(e);
    if (e.caused_by && e.caused_by.reason) msg += '\n← ' + e.caused_by.reason;
    if (e.root_cause && e.root_cause[0] && e.root_cause[0].reason && e.root_cause[0].reason !== e.reason)
      msg += '\n← ' + e.root_cause[0].reason;
    return msg + (r.status ? ' [HTTP ' + r.status + ']' : '');
  }
  if (typeof b === 'string' && b.length < 400) return b || '请求失败';
  return '请求失败' + (r.status ? ' [HTTP ' + r.status + ']' : '');
}
async function es(method, path, body) {
  const r = await apiReq(method, path, body);
  if (!r.ok) throw new Error(errText(r));
  return r.body;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已复制到剪贴板'); }
  catch (e) { toast('复制失败: ' + e.message, 'err'); }
}

/* ---------------------------- 通用 UI ---------------------------- */
function toast(msg, type = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'err' ? 'err' : type === 'warn' ? 'warn' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}
function openModal(html, { wide = false } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const mask = $('.modal-mask', root);
  const close = () => { root.innerHTML = ''; };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  $$('.modal-close', root).forEach((b) => b.addEventListener('click', close));
  return { root, close, modal: $('.modal', root) };
}
function confirmModal({ title, bodyHTML, okText = '确定', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    const { root, close, modal } = openModal(`
      <div class="modal-head">${esc(title)}<button class="modal-close">✕</button></div>
      <div class="modal-body">
        <div style="line-height:1.7">${bodyHTML}</div>
        ${requireText != null ? `<div style="margin-top:14px"><label class="fld">请输入 <b class="mono">${esc(requireText)}</b> 以确认:<input class="input" id="cfmInput" style="margin-top:5px;width:100%"></label></div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn" id="cfmNo">取消</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cfmYes" ${requireText != null ? 'disabled' : ''}>${esc(okText)}</button></div>`);
    let ok = false;
    const done = (v) => { ok = v; close(); resolve(v); };
    $('#cfmNo', modal).addEventListener('click', () => done(false));
    $('#cfmYes', modal).addEventListener('click', () => done(true));
    if (requireText != null) {
      $('#cfmInput', modal).addEventListener('input', (e) => { $('#cfmYes', modal).disabled = e.target.value !== requireText; });
      $('#cfmInput', modal).focus();
    }
    maskCloseGuard(root, () => resolve(false));
  });
}
function maskCloseGuard(root, cb) {
  // 关闭弹窗(点 X / 遮罩)视为取消
  const obs = new MutationObserver(() => { if (!root.innerHTML) { obs.disconnect(); cb(); } });
  obs.observe(root, { childList: true });
}
function highlightJSON(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return json.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = 'json-num';
      if (m.startsWith('"')) cls = /:\s*$/.test(m) ? 'json-key' : 'json-str';
      else if (m === 'true' || m === 'false') cls = 'json-bool';
      else if (m === 'null') cls = 'json-null';
      return `<span class="${cls}">${esc(m)}</span>`;
    }
  );
}
function loadingHTML() { return '<div class="loading-block">加载中…</div>'; }
function unconnectedHTML() {
  return `<div class="empty" style="padding-top:120px">
    <div style="font-size:40px;margin-bottom:10px">🔌</div>
    <div style="margin-bottom:16px">尚未连接 Elasticsearch</div>
    <button class="btn primary" data-act="goto-connections">去连接管理</button>
  </div>`;
}
function bindGotoConnections(scope) {
  $$('[data-act="goto-connections"]', scope).forEach((b) =>
    b.addEventListener('click', () => switchView('connections')));
}

/* ---------------------------- 连接 ---------------------------- */
function conn() { return state.cfg && state.cfg.connections.find((c) => c.id === state.connId); }
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function wlPatterns() {
  const c = conn();
  if (!c || !c.whitelistEnabled) return null;
  const pats = (c.whitelist || []).map((s) => s.trim()).filter(Boolean);
  return pats.length ? pats : null;
}
/* 白名单启用时,界面(索引列表/下拉)只显示白名单内的索引 */
function allowedIndices(list) {
  const pats = wlPatterns();
  if (!pats) return list;
  return list.filter((i) => {
    const n = i.index;
    return !/[*?]/.test(n) && pats.some((pat) => new RegExp('^' + pat.split('*').map(escapeRe).join('.*') + '$').test(n));
  });
}
function dangerBlocked() { const c = conn(); return !!(c && c.blockDanger); }

function renderConnSelect() {
  const sel = $('#connSelect');
  sel.innerHTML = state.cfg.connections.map((c) => `<option value="${esc(c.id)}" ${c.id === state.connId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}
function setConnStatus(cls, text, title) {
  $('#connDot').className = 'dot ' + cls;
  $('#connInfo').textContent = text;
  if (title) $('#connInfo').title = title;
}
async function connect(id, { silent = false } = {}) {
  state.connId = id;
  state.cfg.activeId = id;
  renderConnSelect();
  setConnStatus('off', '连接中…');
  const r = await apiReq('GET', '/', null);
  if (r.ok) {
    state.connected = true;
    state.cluster = { cluster_name: r.body.cluster_name, version: r.body.version };
    setConnStatus('on', `${r.body.cluster_name} · v${r.body.version && r.body.version.number}`);
    if (!silent) toast(`已连接:${r.body.cluster_name}(ES ${r.body.version.number})`);
  } else {
    state.connected = false;
    state.cluster = null;
    setConnStatus('err', '连接失败', errText(r));
    if (!silent) toast('连接失败:' + errText(r), 'err', 8000);
  }
  state.indices = [];
  state.mappingCache = {};
  render(state.view); // 重新渲染当前视图
}

/* ---------------------------- 索引列表 ---------------------------- */
async function loadIndices(force = false) {
  if (state.indices.length && !force) return state.indices;
  const list = await es('GET', '/_cat/indices?format=json&h=health,status,index,pri,rep,docs.count,store.size&s=index');
  state.indices = Array.isArray(list) ? list : [];
  return state.indices;
}
function openIndices() { return state.indices.filter((i) => (i.status || 'open') === 'open'); }

/* ---------------------------- mapping 解析 ---------------------------- */
function flattenMappingProps(props, prefix, out, depth) {
  for (const [name, def] of Object.entries(props || {})) {
    const path = prefix ? prefix + '.' + name : name;
    if (def.properties && depth < 6) {
      out.push({ path, type: 'object' });
      flattenMappingProps(def.properties, path, out, depth + 1);
    } else if (def.type) {
      out.push({ path, type: def.type });
    } else {
      out.push({ path, type: 'object' });
    }
    if (def.fields) {
      for (const [sub, sdef] of Object.entries(def.fields)) out.push({ path: path + '.' + sub, type: sdef.type || 'keyword', sub: true });
    }
  }
}
async function loadFields(index) {
  const key = state.connId + '|' + index;
  if (state.mappingCache[key]) return state.mappingCache[key];
  const body = await es('GET', `/${encodeURIComponent(index)}/_mapping`);
  const m = body && body[index] && body[index].mappings;
  const props = (m && m.properties) || (m && m.doc && m.doc.properties) || {};
  const fields = [];
  flattenMappingProps(props, '', fields, 0);
  state.mappingCache[key] = fields;
  return fields;
}
/* mapping 字段 + 文档采样字段的合集(保证字段列表完整) */
function allBrowseFields() {
  const b = state.browse;
  const seen = new Set(b.fields.map((f) => f.path));
  return b.fields.concat((b.docFields || []).filter((f) => !seen.has(f.path)));
}

/* ---------------------------- 字段类型 → 操作符 ---------------------------- */
const NUM_TYPES = ['long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float', 'unsigned_long'];
function kindOf(type) {
  if (type === 'keyword' || type === 'text') return 'text';
  if (NUM_TYPES.includes(type)) return 'num';
  if (type === 'date') return 'date';
  if (type === 'boolean') return 'bool';
  if (type === 'ip') return 'ip';
  return 'other';
}
const OPS = [
  { code: 'eq', label: '等于', kinds: 'all' },
  { code: 'neq', label: '不等于', kinds: 'all' },
  { code: 'match', label: '包含(分词)', kinds: ['text'] },
  { code: 'phrase', label: '包含整个短语', kinds: ['text'] },
  { code: 'prefix', label: '前缀匹配 xx…', kinds: ['text'] },
  { code: 'wildcard', label: '通配符 * ?', kinds: ['text'] },
  { code: 'gt', label: '大于 >', kinds: ['num', 'date', 'ip'] },
  { code: 'gte', label: '大于等于 ≥', kinds: ['num', 'date', 'ip'] },
  { code: 'lt', label: '小于 <', kinds: ['num', 'date', 'ip'] },
  { code: 'lte', label: '小于等于 ≤', kinds: ['num', 'date', 'ip'] },
  { code: 'between', label: '区间(填两个值)', kinds: ['num', 'date'] },
  { code: 'is_true', label: '为 true', kinds: ['bool'], noVal: true },
  { code: 'is_false', label: '为 false', kinds: ['bool'], noVal: true },
  { code: 'exists', label: '字段有值', kinds: 'all', noVal: true },
  { code: 'not_exists', label: '字段为空', kinds: 'all', noVal: true },
];
function opsFor(fieldType) {
  const k = kindOf(fieldType);
  return OPS.filter((o) => o.kinds === 'all' || o.kinds.includes(k) || (k === 'other' && ['eq', 'neq', 'match', 'exists', 'not_exists'].includes(o.code)));
}
function coerceVal(fieldType, v) {
  const k = kindOf(fieldType);
  if (k === 'num' && v !== '') {
    const n = Number(v);
    if (isNaN(n)) throw new Error(`字段类型为数字,但填写的值「${v}」不是数字`);
    return n;
  }
  return v;
}

/* ---------------------------- 简单查询 → DSL ---------------------------- */
function buildQueryFromFilters(filters, quick) {
  const must = [];
  const mustNot = [];
  for (const f of filters) {
    const field = (f.field || '').trim();
    const op = f.op;
    const val = (f.value || '').trim();
    const val2 = (f.value2 || '').trim();
    if (!field) continue;
    if (!op) continue;
    if (!OPS.find((o) => o.code === op).noVal && !val && op !== 'between') continue;
    if (op === 'between' && !val && !val2) continue;
    switch (op) {
      case 'eq': must.push({ term: { [field]: coerceVal(f.type, val) } }); break;
      case 'neq': mustNot.push({ term: { [field]: coerceVal(f.type, val) } }); break;
      case 'match': must.push({ match: { [field]: val } }); break;
      case 'phrase': must.push({ match_phrase: { [field]: val } }); break;
      case 'prefix': must.push({ prefix: { [field]: val } }); break;
      case 'wildcard': must.push({ wildcard: { [field]: { value: val } } }); break;
      case 'gt': case 'gte': case 'lt': case 'lte':
        must.push({ range: { [field]: { [op]: coerceVal(f.type, val) } } }); break;
      case 'between':
        must.push({ range: { [field]: { gte: coerceVal(f.type, val), lte: coerceVal(f.type, val2) } } }); break;
      case 'is_true': must.push({ term: { [field]: true } }); break;
      case 'is_false': must.push({ term: { [field]: false } }); break;
      case 'exists': must.push({ exists: { field } }); break;
      case 'not_exists': mustNot.push({ exists: { field } }); break;
    }
  }
  if (quick && quick.trim()) {
    must.push({ simple_query_string: { query: quick.trim(), fields: ['*'], lenient: true } });
  }
  if (!must.length && !mustNot.length) return { match_all: {} };
  const bool = {};
  if (must.length) bool.must = must;
  if (mustNot.length) bool.must_not = mustNot;
  return { bool };
}

/* ---------------------------- 文档拍平 ---------------------------- */
function flattenDoc(obj, prefix, out, depth) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? prefix + '.' + k : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < 4) {
      flattenDoc(v, path, out, depth + 1);
    } else {
      out[path] = v;
    }
  }
}
function displayVal(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const s = v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v);
    return trunc(s);
  }
  if (typeof v === 'object') return trunc(JSON.stringify(v));
  if (typeof v === 'boolean') return String(v);
  return trunc(String(v));
}

/* =========================================================================
 * 视图注册表
 * ========================================================================= */
const views = {};

/* ---------------------------- 概览 ---------------------------- */
views.overview = {
  title: '集群概览',
  async render(el) {
    if (!state.connected) { el.innerHTML = unconnectedHTML(); bindGotoConnections(el); return; }
    el.innerHTML = loadingHTML();
    const [rootR, healthR, statsR, nodesR] = await Promise.allSettled([
      apiReq('GET', '/'),
      apiReq('GET', '/_cluster/health'),
      apiReq('GET', '/_cluster/stats'),
      apiReq('GET', '/_cat/nodes?format=json&h=name,ip,role,master,heap.percent,ram.percent,cpu')
    ]);
    const root = rootR.status === 'fulfilled' && rootR.value.ok ? rootR.value.body : {};
    const health = healthR.status === 'fulfilled' && healthR.value.ok ? healthR.value.body : {};
    const stats = statsR.status === 'fulfilled' && statsR.value.ok ? statsR.value.body : null;
    const nodes = nodesR.status === 'fulfilled' && nodesR.value.ok && Array.isArray(nodesR.value.body) ? nodesR.value.body : [];
    const ver = (root.version || {}).number || '—';
    const st = health.status || 'unknown';
    const stBadge = { green: 'green', yellow: 'yellow', red: 'red' }[st] || 'gray';
    const idx = stats && stats.indices ? stats.indices : {};
    const nd = stats && stats.nodes ? stats.nodes : {};
    el.innerHTML = `
      <div class="section-title">集群概览
        <button class="btn sm" id="ovRefresh">刷新</button>
        ${stats ? '' : '<span class="hint">(_cluster/stats 不可用,部分指标缺失)</span>'}
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="k">集群状态</div><div class="v"><span class="badge ${stBadge}" style="font-size:14px">${esc(st)}</span></div></div>
        <div class="stat-card"><div class="k">集群名称</div><div class="v">${esc(root.cluster_name || health.cluster_name || '—')}</div></div>
        <div class="stat-card"><div class="k">Elasticsearch 版本</div><div class="v">${esc(ver)}</div></div>
        <div class="stat-card"><div class="k">节点数</div><div class="v">${fmtNum(nd.count ? nd.count.total : nodes.length)}</div></div>
        <div class="stat-card"><div class="k">索引数</div><div class="v">${fmtNum(idx.count)}</div></div>
        <div class="stat-card"><div class="k">文档总数</div><div class="v">${fmtNum(idx.docs ? idx.docs.count : null)}</div></div>
        <div class="stat-card"><div class="k">已删除文档</div><div class="v">${fmtNum(idx.docs ? idx.docs.deleted : null)}</div></div>
        <div class="stat-card"><div class="k">存储大小</div><div class="v">${fmtBytes(idx.store ? idx.store.size_in_bytes : null)}</div></div>
        <div class="stat-card"><div class="k">分片(已分配/总数)</div><div class="v">${fmtNum(nd.shards ? nd.shards.total_count : null)}<span class="dim"> / </span>${fmtNum((health.active_shards || 0) + (health.unassigned_shards || 0))}</div></div>
        <div class="stat-card"><div class="k">未分配分片</div><div class="v">${fmtNum(health.unassigned_shards)}</div></div>
      </div>
      <div class="section-title" style="font-size:13px">节点列表</div>
      <div class="table-wrap">
        <table class="tbl"><thead><tr>
          <th>名称</th><th>IP</th><th>角色</th><th>主节点</th><th>堆内存</th><th>内存</th><th>CPU</th>
        </tr></thead><tbody>
          ${nodes.length ? nodes.map((n) => `<tr>
            <td class="mono">${esc(n.name)}</td><td class="mono dim">${esc(n.ip)}</td>
            <td class="dim">${esc((n.role || '').replace(/,/g, ' · '))}</td>
            <td>${n.master === '*' ? '<span class="badge yellow">master</span>' : ''}</td>
            <td class="num">${esc(n['heap.percent'] ?? '—')}%</td>
            <td class="num">${esc(n['ram.percent'] ?? '—')}%</td>
            <td class="num">${esc(n.cpu ?? '—')}%</td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty">无节点数据</td></tr>'}
        </tbody></table>
      </div>`;
    $('#ovRefresh', el).addEventListener('click', () => this.render(el));
  }
};

/* ---------------------------- 索引管理 ---------------------------- */
views.indices = {
  title: '索引管理',
  async render(el) {
    if (!state.connected) { el.innerHTML = unconnectedHTML(); bindGotoConnections(el); return; }
    el.innerHTML = loadingHTML();
    try { await loadIndices(true); } catch (e) { toast('加载索引失败:' + e.message, 'err'); el.innerHTML = '<div class="empty">加载失败</div>'; return; }
    el.innerHTML = `
      <div class="toolbar">
        <input class="input" id="idxFilter" placeholder="按名称过滤…" style="width:240px">
        <span class="hint">共 ${state.indices.length} 个索引${wlPatterns() ? ',白名单内 ' + allowedIndices(state.indices).length + ' 个' : ''}</span>
        ${dangerBlocked() ? '<span class="badge red" title="删除/关闭索引等危险操作已在主进程拦截">🛡 危险操作已屏蔽</span>' : ''}
        <div class="spacer"></div>
        <button class="btn" id="idxRefresh">刷新</button>
        <button class="btn primary" id="idxNew">新建索引</button>
      </div>
      <div class="table-wrap" style="max-height:calc(100vh - 190px)">
        <table class="tbl"><thead><tr>
          <th>索引名称</th><th>健康</th><th>状态</th><th>文档数</th><th>存储大小</th><th>主分片</th><th>副本</th><th style="width:280px">操作</th>
        </tr></thead><tbody id="idxBody"></tbody></table>
      </div>`;
    const renderRows = () => {
      const kw = $('#idxFilter', el).value.trim().toLowerCase();
      const list = allowedIndices(state.indices).filter((i) => !kw || String(i.index).toLowerCase().includes(kw));
      $('#idxBody', el).innerHTML = list.length ? list.map((i) => {
        const hb = { green: 'green', yellow: 'yellow', red: 'red' }[i.health] || 'gray';
        const closed = i.status === 'close';
        return `<tr data-idx="${esc(i.index)}">
          <td class="mono" style="user-select:text">${esc(i.index)}</td>
          <td><span class="badge ${hb}">${esc(i.health || '—')}</span></td>
          <td>${closed ? '<span class="badge gray">closed</span>' : '<span class="badge blue">open</span>'}</td>
          <td class="num">${fmtNum(i['docs.count'])}</td>
          <td class="num">${esc(i['store.size'] || '—')}</td>
          <td class="num">${esc(i.pri ?? '—')}</td>
          <td class="num">${esc(i.rep ?? '—')}</td>
          <td>
            <button class="btn sm" data-act="mapping">结构</button>
            <button class="btn sm" data-act="settings">设置</button>
            <button class="btn sm" data-act="browse">查数据</button>
            <button class="btn sm" data-act="toggle" ${dangerBlocked() ? 'disabled title="本连接已屏蔽危险操作(可在连接管理中调整)"' : ''}>${closed ? '打开' : '关闭'}</button>
            <button class="btn sm danger" data-act="del" ${dangerBlocked() ? 'disabled title="本连接已屏蔽危险操作(可在连接管理中调整)"' : ''}>删除</button>
          </td></tr>`;
      }).join('') : '<tr><td colspan="8" class="empty">无匹配索引</td></tr>';
    };
    renderRows();
    $('#idxFilter', el).addEventListener('input', renderRows);
    $('#idxRefresh', el).addEventListener('click', () => this.render(el));
    $('#idxNew', el).addEventListener('click', () => this.createIndex(el));

    $('#idxBody', el).addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const idx = btn.closest('tr').dataset.idx;
      const act = btn.dataset.act;
      if ((act === 'del' || act === 'toggle') && dangerBlocked()) {
        toast('⛔ 本连接已屏蔽危险操作(删除/关闭索引),可在「连接管理」中调整', 'warn');
        return;
      }
      try {
        if (act === 'mapping' || act === 'settings') {
          const path = act === 'mapping' ? 'mapping' : 'settings';
          const body = await es('GET', `/${encodeURIComponent(idx)}/_${path}`);
          openModal(`
            <div class="modal-head"><span class="mono">${esc(idx)} — _${path}</span><button class="modal-close">✕</button></div>
            <div class="modal-body"><pre class="json">${highlightJSON(body)}</pre></div>
            <div class="modal-foot"><button class="btn" id="cpJson">复制 JSON</button></div>`, { wide: true });
          $('#cpJson').addEventListener('click', () => copyText(JSON.stringify(body, null, 2)));
        } else if (act === 'browse') {
          state.browse.index = idx;
          state.browse.page = 1;
          switchView('browse');
        } else if (act === 'toggle') {
          const closed = state.indices.find((i) => i.index === idx && i.status === 'close');
          const closing = !closed;
          if (closing) {
            const ok = await confirmModal({ title: `关闭索引 ${idx}`, body: '关闭后索引不可读写,确认关闭?', okText: '关闭', danger: true });
            if (!ok) return;
            await es('POST', `/${encodeURIComponent(idx)}/_close`);
          } else {
            await es('POST', `/${encodeURIComponent(idx)}/_open`);
          }
          toast(closing ? '已关闭' : '已打开');
          this.render(el);
        } else if (act === 'del') {
          const ok = await confirmModal({
            title: `删除索引 ${idx}`,
            body: `<span style="color:var(--red)">将永久删除该索引及全部数据,不可恢复!</span>`,
            okText: '删除', danger: true, requireText: idx
          });
          if (!ok) return;
          await es('DELETE', `/${encodeURIComponent(idx)}`);
          toast('索引已删除:' + idx);
          this.render(el);
        }
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  },
  createIndex(el) {
    const { root, close, modal } = openModal(`
      <div class="modal-head">新建索引<button class="modal-close">✕</button></div>
      <div class="modal-body"><div class="form-grid">
        <label class="fld full">索引名称<input class="input" id="niName" placeholder="如 order_info_2026"></label>
        <label class="fld">主分片数<input class="input" id="niShards" type="number" value="1" min="1"></label>
        <label class="fld">副本数<input class="input" id="niReplicas" type="number" value="1" min="0"></label>
      </div></div>
      <div class="modal-foot"><button class="btn" id="niCancel">取消</button><button class="btn primary" id="niOk">创建</button></div>`);
    $('#niCancel', modal).addEventListener('click', close);
    maskCloseGuard(root, () => {});
    $('#niOk', modal).addEventListener('click', async () => {
      const name = $('#niName', modal).value.trim();
      if (!name) { toast('请填写索引名称', 'warn'); return; }
      try {
        await es('PUT', `/${encodeURIComponent(name)}`, {
          settings: { number_of_shards: Number($('#niShards', modal).value) || 1, number_of_replicas: Number($('#niReplicas', modal).value) || 0 }
        });
        toast('索引已创建:' + name);
        close();
        this.render(el);
      } catch (e) { toast(e.message, 'err'); }
    });
  }
};

/* ---------------------------- 数据浏览(类数据库工具) ---------------------------- */
views.browse = {
  title: '数据浏览',
  async render(el) {
    if (!state.connected) { el.innerHTML = unconnectedHTML(); bindGotoConnections(el); return; }
    el.innerHTML = loadingHTML();
    try { await loadIndices(); } catch (e) { toast('加载索引列表失败:' + e.message, 'err'); }
    const opens = allowedIndices(openIndices());
    if (!state.browse.index || !opens.find((i) => i.index === state.browse.index)) {
      const last = LS.get('lastIndex:' + state.connId, '');
      state.browse.index = opens.find((i) => i.index === last) ? last : (opens[0] && opens[0].index) || '';
    }
    const b = state.browse;
    el.innerHTML = `
      <div class="toolbar">
        <select class="select" id="brIndex" style="max-width:320px">
          ${opens.map((i) => `<option value="${esc(i.index)}" ${i.index === b.index ? 'selected' : ''}>${esc(i.index)}(${fmtNum(i['docs.count'])} 条)</option>`).join('')}
        </select>
        ${wlPatterns() ? '<span class="badge yellow" title="本连接启用了索引白名单,仅显示白名单内索引">🔒 白名单已启用</span>' : ''}
        <input class="input" id="brQuick" placeholder="🔍 全字段快速搜索(关键词,无需写 DSL)" style="width:280px" value="${esc(b.quick)}">
        <div class="spacer"></div>
        <button class="btn" id="brToDsl" title="把当前索引与条件带到「DSL 查询」页继续编辑">在 DSL 中打开</button>
        <button class="btn" id="brCols">列显示</button>
        <button class="btn" id="brRefresh">刷新</button>
        <button class="btn primary" id="brNewDoc">+ 新增文档</button>
      </div>
      <div class="fieldset" id="brFilters">
        <div class="legend">条件筛选(按字段,不用写 DSL,多条件为 AND 关系)</div>
        <div id="brFilterRows"></div>
        <button class="btn sm ghost" id="brAddFilter">+ 添加条件</button>
        <button class="btn sm ghost" id="brClearFilter" style="margin-left:6px">清空条件</button>
        <details style="margin-top:10px"><summary class="hint" style="cursor:pointer">查看生成的查询 DSL</summary><pre class="json" id="brDslPreview" style="margin-top:8px"></pre></details>
      </div>
      <div class="toolbar" style="margin-bottom:10px">
        <span class="dim">排序:</span>
        <select class="select" id="brSortField" style="max-width:220px"></select>
        <select class="select" id="brSortOrder" style="width:90px">
          <option value="asc" ${b.sortOrder === 'asc' ? 'selected' : ''}>升序 ↑</option>
          <option value="desc" ${b.sortOrder === 'desc' ? 'selected' : ''}>降序 ↓</option>
        </select>
        <div class="spacer"></div>
        <span class="dim">每页</span>
        <select class="select" id="brSize" style="width:76px">
          ${[10, 25, 50, 100].map((n) => `<option value="${n}" ${b.size === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap" style="max-height:calc(100vh - 420px);min-height:160px" id="brTableWrap">${loadingHTML()}</div>
      <div class="pager" id="brPager"></div>`;

    $('#brIndex', el).addEventListener('change', async (e) => {
      b.index = e.target.value; b.page = 1; b.cols = null; b.filters = [{ field: '', op: 'match', value: '' }];
      LS.set('lastIndex:' + state.connId, b.index);
      await this.reload(el);
    });
    $('#brQuick', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { b.quick = e.target.value; b.page = 1; this.fetchData(el); } });
    $('#brRefresh', el).addEventListener('click', () => this.fetchData(el));
    $('#brToDsl', el).addEventListener('click', () => {
      this.harvestFilters(el);
      let body;
      try { body = this.buildBody(); } catch (e) { toast(e.message, 'err'); return; }
      LS.set('queryState', { index: b.index, size: b.size, body: JSON.stringify(body, null, 2) });
      switchView('query');
    });
    $('#brAddFilter', el).addEventListener('click', () => { this.harvestFilters(el); b.filters.push({ field: '', op: 'eq', value: '' }); this.renderFilterRows(el); });
    $('#brClearFilter', el).addEventListener('click', () => { b.filters = [{ field: '', op: 'eq', value: '' }]; b.quick = $('#brQuick', el).value = ''; b.page = 1; this.renderFilterRows(el); this.fetchData(el); });
    $('#brNewDoc', el).addEventListener('click', () => this.openDocDrawer(null, el));
    $('#brCols', el).addEventListener('click', () => this.columnPicker(el));
    $('#brSortOrder', el).addEventListener('change', (e) => { b.sortOrder = e.target.value; b.page = 1; this.fetchData(el); });
    $('#brSize', el).addEventListener('change', (e) => { b.size = Number(e.target.value); b.page = 1; this.fetchData(el); });
    $('#brTableWrap', el).addEventListener('click', (e) => {
      const colX = e.target.closest('.col-x');
      if (colX) {
        e.stopPropagation();
        const col = colX.dataset.col;
        const cur = this.visibleCols() || [];
        b.cols = cur.filter((p) => p !== col);
        LS.set('cols:' + state.connId + '|' + b.index, b.cols);
        this.renderTable(el);
        toast(`已隐藏列「${col}」,可在「列显示」中恢复`, 'info', 2600);
        return;
      }
      const idTd = e.target.closest('td[data-copy]');
      if (idTd) { e.stopPropagation(); copyText(idTd.dataset.copy); return; }
      const tr = e.target.closest('tr[data-i]');
      if (tr) this.openDocDrawer(Number(tr.dataset.i), el);
    });
    await this.reload(el);
  },

  async reload(el) {
    const b = state.browse;
    if (!b.index) { $('#brTableWrap', el).innerHTML = '<div class="empty">没有可查询的开放索引</div>'; return; }
    b.docFields = [];
    try {
      b.fields = await loadFields(b.index);
    } catch (e) {
      b.fields = [];
    }
    this.renderFilterRows(el);
    const sf = $('#brSortField', el);
    sf.innerHTML = `<option value="">(默认 _doc 顺序)</option>` +
      allBrowseFields().filter((f) => f.type !== 'object').map((f) => `<option value="${esc(f.path)}" ${f.path === b.sortField ? 'selected' : ''}>${esc(f.path)} <span class="faint">(${esc(f.type)})</span></option>`).join('');
    sf.onchange = (e) => { b.sortField = e.target.value; b.page = 1; this.fetchData(el); };
    await this.fetchData(el);
  },

  renderFilterRows(el) {
    const b = state.browse;
    const fields = allBrowseFields();
    const wrap = $('#brFilterRows', el);
    if (!fields.length) {
      wrap.innerHTML = `<div class="hint" style="margin-bottom:8px">未取到字段映射,可直接在字段框手输名称,或用上方快速搜索</div>`;
    }
    wrap.innerHTML = b.filters.map((f, i) => {
      const fieldOpts = ['<option value=""></option>'].concat(
        fields.map((fd) => `<option value="${esc(fd.path)}" ${fd.path === f.field ? 'selected' : ''}>${esc(fd.path)} <span class="faint">(${esc(fd.type)})</span></option>`)
      ).join('');
      const ops = opsFor(f.type || '');
      const opOpts = ops.map((o) => `<option value="${o.code}" ${o.code === f.op ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
      const cur = OPS.find((o) => o.code === f.op);
      const noVal = cur && cur.noVal;
      const isBetween = f.op === 'between';
      return `<div class="filter-row" data-i="${i}">
        <select class="select br-f-field" style="min-width:200px;max-width:260px;flex:none">${fieldOpts}</select>
        <select class="select br-f-op" style="width:150px;flex:none">${opOpts}</select>
        ${noVal ? '<span class="faint" style="flex:1"></span>' :
          isBetween ? `<input class="input br-f-val" placeholder="起(含)" style="width:110px" value="${esc(f.value)}"><span class="dim">~</span><input class="input br-f-val2" placeholder="止(含)" style="width:110px" value="${esc(f.value2)}"><span style="flex:1"></span>` :
          `<input class="input br-f-val" placeholder="值" style="width:180px" value="${esc(f.value)}"><span style="flex:1"></span>`}
        <button class="btn sm danger br-f-del" title="删除此条件">✕</button>
      </div>`;
    }).join('');
    $$('.br-f-del', wrap).forEach((btn) => btn.addEventListener('click', () => {
      this.harvestFilters(el);
      const i = Number(btn.closest('.filter-row').dataset.i);
      state.browse.filters.splice(i, 1);
      if (!state.browse.filters.length) state.browse.filters.push({ field: '', op: 'eq', value: '' });
      this.renderFilterRows(el);
    }));
    $$('.br-f-field', wrap).forEach((sel) => sel.addEventListener('change', () => {
      this.harvestFilters(el);
      const i = Number(sel.closest('.filter-row').dataset.i);
      const f = state.browse.filters[i];
      const fd = allBrowseFields().find((x) => x.path === f.field);
      f.type = fd ? fd.type : '';
      const ops = opsFor(f.type);
      if (!ops.find((o) => o.code === f.op)) f.op = ops[0].code;
      this.renderFilterRows(el);
    }));
    $$('.br-f-op', wrap).forEach((sel) => sel.addEventListener('change', () => {
      this.harvestFilters(el);
      this.renderFilterRows(el);
    }));
    $$('.br-f-val, .br-f-val2', wrap).forEach((inp) => inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { this.harvestFilters(el); state.browse.page = 1; this.fetchData(el); }
    }));
  },

  harvestFilters(el) {
    const b = state.browse;
    b.filters = $$('.filter-row', $('#brFilterRows', el)).map((row) => {
      const fieldSel = $('.br-f-field', row);
      return {
        field: fieldSel ? fieldSel.value : '',
        op: $('.br-f-op', row) ? $('.br-f-op', row).value : 'eq',
        value: $('.br-f-val', row) ? $('.br-f-val', row).value : '',
        value2: $('.br-f-val2', row) ? $('.br-f-val2', row).value : '',
        type: (allBrowseFields().find((x) => x.path === (fieldSel && fieldSel.value)) || {}).type || ''
      };
    });
    b.quick = $('#brQuick', el) ? $('#brQuick', el).value : '';
  },

  buildBody() {
    const b = state.browse;
    const query = buildQueryFromFilters(b.filters, b.quick);
    const body = { query, from: (b.page - 1) * b.size, size: b.size, track_total_hits: true };
    if (b.sortField) body.sort = [{ [b.sortField]: { order: b.sortOrder } }];
    return body;
  },

  visibleCols() {
    const b = state.browse;
    const all = allBrowseFields().filter((f) => f.type !== 'object');
    // 默认展示全部真实字段;多字段子项(.keyword/.py 等不在 _source 中)默认隐藏
    const base = all.filter((f) => !f.sub).map((f) => f.path);
    if (!base.length) return all.map((f) => f.path).length ? all.map((f) => f.path) : null;
    if (b.cols) return all.map((f) => f.path).filter((p) => b.cols.includes(p));
    return base;
  },

  async fetchData(el) {
    const b = state.browse;
    const wrap = $('#brTableWrap', el);
    if (!b.index) return;
    this.harvestFilters(el);
    let body;
    try { body = this.buildBody(); } catch (e) { toast(e.message, 'err'); return; }
    const dslEl = $('#brDslPreview', el);
    if (dslEl) dslEl.innerHTML = highlightJSON(body.query);
    if ((b.page - 1) * b.size + b.size > 10000) {
      toast('翻页过深:from + size 超过 ES max_result_window(10000),建议改用搜索条件缩小范围', 'warn', 6000);
      b.page = Math.max(1, Math.ceil(10000 / b.size) - 1);
      body.from = (b.page - 1) * b.size;
    }
    wrap.innerHTML = loadingHTML();
    const t0 = Date.now();
    const r = await apiReq('POST', `/${encodeURIComponent(b.index)}/_search`, body);
    if (!r.ok) { wrap.innerHTML = `<div class="empty" style="color:var(--red);white-space:pre-wrap;user-select:text">${esc(errText(r))}</div>`; return; }
    const hits = (r.body.hits && r.body.hits.hits) || [];
    b.lastHits = hits;
    b.lastTotal = r.body.hits ? (typeof r.body.hits.total === 'object' ? r.body.hits.total.value : r.body.hits.total) : 0;
    b.lastTook = r.body.took;
    // 从当前页数据采样 mapping 未覆盖的字段(如 dynamic:false 的索引),补进字段列表
    const known = new Set(b.fields.map((f) => f.path));
    const extra = [];
    for (const h of hits.slice(0, 50)) {
      const flat = {};
      flattenDoc(h._source, '', flat, 0);
      for (const k of Object.keys(flat)) {
        if (!known.has(k) && !extra.some((e) => e.path === k)) {
          const v = flat[k];
          const t = typeof v === 'number' ? 'long' : typeof v === 'boolean' ? 'boolean' : '(文档)';
          extra.push({ path: k, type: t });
        }
      }
    }
    const prevDoc = new Set((b.docFields || []).map((f) => f.path));
    b.docFields = b.docFields.concat(extra.filter((e) => !prevDoc.has(e.path)));
    if (extra.length) {
      // 新发现的字段补进筛选下拉与排序下拉
      this.renderFilterRows(el);
      const sf = $('#brSortField', el);
      if (sf) {
        for (const e of extra) {
          if (![...sf.options].some((o) => o.value === e.path)) {
            const o = document.createElement('option');
            o.value = e.path;
            o.innerHTML = `${esc(e.path)} <span class="faint">(${esc(e.type)})</span>`;
            sf.appendChild(o);
          }
        }
      }
    }
    this.renderTable(el);
    void t0;
  },

  renderTable(el) {
    const b = state.browse;
    const wrap = $('#brTableWrap', el);
    const hits = b.lastHits;
    // 计算列:优先 mapping 的可见列;无 mapping 时按数据采样
    let cols = this.visibleCols();
    if (!cols) {
      const keySet = new Map();
      for (const h of hits.slice(0, 50)) {
        const flat = {};
        flattenDoc(h._source, '', flat, 0);
        for (const k of Object.keys(flat)) if (!keySet.has(k)) keySet.set(k, 1);
      }
      cols = [...keySet.keys()].slice(0, 24);
    }
    const docFlat = hits.map((h) => {
      const flat = {};
      flattenDoc(h._source, '', flat, 0);
      return flat;
    });
    wrap.innerHTML = hits.length ? `<table class="tbl"><thead><tr>
        <th style="min-width:120px">_id</th>
        ${cols.map((c) => `<th title="${esc(c)}" class="ellipsis">${esc(c)}<span class="col-x" data-col="${esc(c)}" title="隐藏此列(可在「列显示」中恢复)">✕</span></th>`).join('')}
      </tr></thead><tbody>
      ${hits.map((h, i) => `<tr class="clickable" data-i="${i}" title="点击查看 / 编辑文档">
        <td class="mono dim" data-copy="${esc(h._id)}" title="点击复制 ID" style="cursor:copy">${esc(trunc(h._id, 22))}</td>
        ${cols.map((c) => {
          const v = displayVal(docFlat[i][c]);
          return `<td class="ellipsis" title="${esc(v == null ? '' : v)}">${v == null ? '<span class="faint">null</span>' : esc(v)}</td>`;
        }).join('')}
      </tr>`).join('')}
      </tbody></table>` : `<div class="empty">没有符合条件的数据</div>`;
    // 分页
    const pages = Math.max(1, Math.ceil(b.lastTotal / b.size));
    $('#brPager', el).innerHTML = `
      <span>共 <span class="num">${fmtNum(b.lastTotal)}</span> 条 · 耗时 <span class="num">${b.lastTook}</span> ms</span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn sm" id="pgPrev" ${b.page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      <span>第 <input class="input num" id="pgJump" value="${b.page}" style="width:52px;text-align:center;padding:2px 6px"> / ${pages} 页</span>
      <button class="btn sm" id="pgNext" ${b.page >= pages ? 'disabled' : ''}>下一页 ›</button>`;
    $('#pgPrev', el).addEventListener('click', () => { if (b.page > 1) { b.page--; this.fetchData(el); } });
    $('#pgNext', el).addEventListener('click', () => { if (b.page < pages) { b.page++; this.fetchData(el); } });
    $('#pgJump', el).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = Math.min(pages, Math.max(1, Number(e.target.value) || 1));
        if (p !== b.page) { b.page = p; this.fetchData(el); }
      }
    });
  },

  columnPicker(el) {
    const b = state.browse;
    const fields = allBrowseFields().filter((f) => f.type !== 'object');
    const all = fields.map((f) => f.path);
    if (!all.length) { toast('当前索引没有可配置的字段映射', 'warn'); return; }
    const cur = b.cols || all;
    const { root, close, modal } = openModal(`
      <div class="modal-head">列显示(${esc(b.index)},共 ${all.length} 列)<button class="modal-close">✕</button></div>
      <div class="modal-body">
        <input class="input" id="cpSearch" placeholder="搜索字段…" style="width:100%;margin-bottom:10px">
        <div id="cpList" style="max-height:380px;overflow:auto"></div>
      </div>
      <div class="modal-foot">
        <button class="btn sm" id="cpAll">全选</button>
        <button class="btn sm" id="cpNone">全不选</button>
        <div style="flex:1"></div>
        <button class="btn" id="cpCancel">取消</button><button class="btn primary" id="cpOk">保存</button>
      </div>`);
    const renderList = (kw) => {
      $('#cpList', modal).innerHTML = all
        .filter((p) => !kw || p.toLowerCase().includes(kw))
        .map((p) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 2px;cursor:pointer">
          <input type="checkbox" value="${esc(p)}" ${cur.includes(p) ? 'checked' : ''}>
          <span class="mono" style="font-size:12px">${esc(p)}</span>
          <span class="faint" style="font-size:11px">${esc((fields.find((f) => f.path === p) || {}).type)}</span>
        </label>`).join('');
    };
    renderList('');
    $('#cpSearch', modal).addEventListener('input', (e) => renderList(e.target.value.trim().toLowerCase()));
    $('#cpAll', modal).addEventListener('click', () => { $$('input[type=checkbox]', $('#cpList', modal)).forEach((c) => (c.checked = true)); });
    $('#cpNone', modal).addEventListener('click', () => { $$('input[type=checkbox]', $('#cpList', modal)).forEach((c) => (c.checked = false)); });
    $('#cpCancel', modal).addEventListener('click', close);
    maskCloseGuard(root, () => {});
    $('#cpOk', modal).addEventListener('click', () => {
      b.cols = $$('input[type=checkbox]:checked', $('#cpList', modal)).map((c) => c.value);
      LS.set('cols:' + state.connId + '|' + b.index, b.cols);
      close();
      this.renderTable(el);
    });
  },

  openDocDrawer(i, el) {
    const b = state.browse;
    const hit = i == null ? null : b.lastHits[i];
    const root = $('#drawerRoot');
    const srcStr = hit ? JSON.stringify(hit._source, null, 2) : '{\n  \n}';
    root.innerHTML = `
      <div class="drawer-mask"></div>
      <div class="drawer">
        <div class="drawer-head">
          <span class="title">${hit ? '文档详情' : '新增文档 — ' + esc(b.index)}</span>
          <button class="modal-close">✕</button>
        </div>
        <div class="drawer-body">
          ${hit ? `<div class="doc-meta">
            <span class="badge blue mono">_index: ${esc(hit._index)}</span>
            <span class="badge teal mono">_id: ${esc(hit._id)}</span>
            ${hit._score != null ? `<span class="badge gray mono">_score: ${esc(hit._score)}</span>` : ''}
          </div>
          <div id="dwView"><pre class="json">${highlightJSON(hit._source)}</pre></div>
          <div id="dwEdit" style="display:none">
            <textarea class="textarea" id="dwSrc" style="min-height:320px">${esc(srcStr)}</textarea>
            <div class="hint" style="margin-top:6px">直接编辑 _source 的 JSON,保存时走 _update 部分更新</div>
          </div>` :
          `<textarea class="textarea" id="dwSrc" style="min-height:320px">${esc(srcStr)}</textarea>
           <div class="hint" style="margin-top:6px">输入 _source 的 JSON,自动生成文档 ID</div>`}
        </div>
        <div class="drawer-foot">
          ${hit ? `<button class="btn" id="dwEditBtn">编辑</button>
          <button class="btn" id="dwCopy">复制 JSON</button>
          <div style="flex:1"></div>
          <button class="btn danger" id="dwDel">删除文档</button>` : ''}
          ${hit ? '' : '<div style="flex:1"></div>'}
          <button class="btn primary" id="dwSave">${hit ? '保存修改' : '创建文档'}</button>
        </div>
      </div>`;
    const closeDrawer = () => { root.innerHTML = ''; };
    $('.drawer-mask', root).addEventListener('mousedown', closeDrawer);
    $('.drawer-head .modal-close', root).addEventListener('click', closeDrawer);
    const refresh = () => this.fetchData(el);
    if (hit) {
      $('#dwEditBtn', root).addEventListener('click', () => {
        const v = $('#dwView', root), e = $('#dwEdit', root);
        const editing = e.style.display === 'none';
        e.style.display = editing ? 'block' : 'none';
        v.style.display = editing ? 'none' : 'block';
        $('#dwEditBtn', root).textContent = editing ? '取消编辑' : '编辑';
      });
      $('#dwCopy', root).addEventListener('click', () => copyText(JSON.stringify(hit._source, null, 2)));
      $('#dwDel', root).addEventListener('click', async () => {
        const ok = await confirmModal({
          title: '删除文档',
          body: `确定删除文档 <b class="mono">${esc(hit._id)}</b>(索引 ${esc(hit._index)})?`,
          okText: '删除', danger: true
        });
        if (!ok) return;
        try {
          const r = await apiReq('DELETE', `/${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}`);
          if (!r.ok) throw new Error(errText(r));
          toast('文档已删除');
          closeDrawer();
          refresh();
        } catch (e) { toast(e.message, 'err'); }
      });
    }
    $('#dwSave', root).addEventListener('click', async () => {
      let src;
      try { src = JSON.parse($('#dwSrc', root).value); } catch (e) { toast('JSON 格式错误:' + e.message, 'err'); return; }
      try {
        let r;
        if (hit) {
          r = await apiReq('POST', `/${encodeURIComponent(hit._index)}/_update/${encodeURIComponent(hit._id)}`, { doc: src });
        } else {
          r = await apiReq('POST', `/${encodeURIComponent(b.index)}/_doc`, src);
        }
        if (!r.ok) throw new Error(errText(r));
        toast(hit ? '已保存(结果刷新中)' : '文档已创建');
        closeDrawer();
        refresh();
      } catch (e) { toast(e.message, 'err'); }
    });
  }
};

/* ---------------------------- DSL 查询 ---------------------------- */
const QUERY_TEMPLATES = [
  { name: '全量 match_all', body: { query: { match_all: {} } } },
  { name: '关键词 match', body: { query: { match: { 字段名: '关键词' } } } },
  { name: '多字段 multi_match', body: { query: { multi_match: { query: '关键词', fields: ['title', 'name'] } } } },
  { name: '精确匹配 term', body: { query: { term: { '字段名.keyword': '精确值' } } } },
  { name: '范围 range(近 7 天)', body: { query: { range: { 时间字段: { gte: 'now-7d', lte: 'now' } } } } },
  { name: 'bool 组合 must+filter', body: { query: { bool: { must: [{ match: { 字段名: '关键词' } }], filter: [{ term: { 状态字段: 1 } }] } } } },
  { name: 'terms 分组聚合', body: { size: 0, aggs: { 分组名: { terms: { field: '字段名.keyword', size: 20 } } } } },
  { name: '排序 + 分页', body: { query: { match_all: {} }, from: 0, size: 20, sort: [{ 字段名: { order: 'desc' } }] } }
];
views.query = {
  title: 'DSL 查询',
  _last: null,
  async render(el) {
    if (!state.connected) { el.innerHTML = unconnectedHTML(); bindGotoConnections(el); return; }
    const saved = LS.get('queryState', { index: '', size: 10, body: '{\n  "query": {\n    "match_all": {}\n  }\n}' });
    this._last = null;
    try { await loadIndices(); } catch (e) { /* 忽略 */ }
    el.innerHTML = `
      <div class="query-layout">
        <div class="query-col">
          <div class="toolbar" style="margin-bottom:0">
            <input class="input" id="qIndex" list="qIndexList" placeholder="索引名(支持通配符如 log-*)" style="flex:1" value="${esc(saved.index)}">
            <datalist id="qIndexList">${allowedIndices(state.indices).map((i) => `<option value="${esc(i.index)}">`).join('')}</datalist>
            <input class="input" id="qSize" type="number" min="1" max="10000" value="${saved.size}" style="width:80px" title="返回条数 size">
            <button class="btn primary" id="qRun">运行</button>
          </div>
          <textarea class="textarea editor" id="qBody" spellcheck="false">${esc(saved.body)}</textarea>
          <div class="toolbar" style="margin:8px 0 0">
            <select class="select" id="qTpl" style="flex:1">
              <option value="">插入常用模板…</option>
              ${QUERY_TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}
            </select>
            <button class="btn" id="qFmt" title="格式化当前 JSON">格式化</button>
          </div>
          <div class="hint">完整查询体 JSON(query / sort / aggs…)<kbd>${CMD}</kbd> + <kbd>↵</kbd> 运行,结果可切表格 / JSON 视图</div>
        </div>
        <div class="query-col">
          <div class="result-panel" id="qResult" style="flex:1"><div class="empty">运行查询后在此查看结果</div></div>
        </div>
      </div>`;
    const run = async () => {
      const pats = wlPatterns();
      const index = $('#qIndex', el).value.trim() || (pats ? pats.join(',') : '_all');
      const size = Number($('#qSize', el).value) || 10;
      let body;
      try { body = JSON.parse($('#qBody', el).value || '{}'); } catch (e) { toast('查询体 JSON 格式错误:' + e.message, 'err'); return; }
      LS.set('queryState', { index: $('#qIndex', el).value.trim(), size, body: $('#qBody', el).value });
      if (!body.size) body.size = size;
      const panel = $('#qResult', el);
      panel.innerHTML = loadingHTML();
      const t0 = Date.now();
      const r = await apiReq('POST', `/${encodeURIComponent(index)}/_search`, body);
      const cost = Date.now() - t0;
      this._last = { r, cost };
      this.renderResult(el, r, cost, 'json');
    };
    $('#qRun', el).addEventListener('click', run);
    $('#qBody', el).addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); });
    $('#qTpl', el).addEventListener('change', (e) => {
      if (e.target.value === '') return;
      const t = QUERY_TEMPLATES[Number(e.target.value)];
      $('#qBody', el).value = JSON.stringify(t.body, null, 2);
      LS.set('queryState', { index: $('#qIndex', el).value.trim(), size: Number($('#qSize', el).value) || 10, body: $('#qBody', el).value });
      e.target.value = '';
      $('#qBody', el).focus();
    });
    $('#qFmt', el).addEventListener('click', () => {
      try { $('#qBody', el).value = JSON.stringify(JSON.parse($('#qBody', el).value || '{}'), null, 2); }
      catch (e) { toast('JSON 格式错误:' + e.message, 'err'); }
    });
  },
  renderResult(el, r, cost, mode) {
    const panel = $('#qResult', el);
    if (!r.ok) {
      panel.innerHTML = `<div class="status-chip s${Math.floor(r.status / 100)}">HTTP ${r.status || 0}</div>
        <pre class="json" style="margin-top:10px;color:var(--red);white-space:pre-wrap;user-select:text">${esc(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2))}</pre>`;
      return;
    }
    const hits = (r.body.hits && r.body.hits.hits) || [];
    const total = r.body.hits ? (typeof r.body.hits.total === 'object' ? r.body.hits.total.value : r.body.hits.total) : 0;
    let content;
    if (mode === 'table') {
      if (!hits.length) {
        content = '<div class="empty">没有命中数据</div>';
      } else {
        const flat = hits.map((h) => { const o = {}; flattenDoc(h._source, '', o, 0); return o; });
        const cols = [...new Set(flat.slice(0, 50).flatMap((o) => Object.keys(o)))].slice(0, 30);
        content = `<div class="table-wrap" style="max-height:calc(100% - 46px)"><table class="tbl"><thead><tr>
          <th>_id</th>${cols.map((c) => `<th class="ellipsis" title="${esc(c)}">${esc(c)}</th>`).join('')}
        </tr></thead><tbody>
        ${hits.map((h, i) => `<tr>
          <td class="mono dim" style="user-select:text">${esc(trunc(h._id, 20))}</td>
          ${cols.map((c) => {
            const v = displayVal(flat[i][c]);
            return `<td class="ellipsis" title="${esc(v == null ? '' : v)}">${v == null ? '<span class="faint">null</span>' : esc(v)}</td>`;
          }).join('')}
        </tr>`).join('')}
        </tbody></table></div>`;
      }
    } else {
      const display = { ...r.body, hits: r.body.hits ? { ...r.body.hits, hits } : undefined };
      content = `<pre class="json" style="user-select:text">${highlightJSON(display)}</pre>`;
    }
    panel.innerHTML = `
      <div class="result-meta" style="margin-bottom:10px">
        <span class="status-chip s2">200 OK</span>
        <span>命中 <b class="num" style="color:var(--text)">${fmtNum(total)}</b> 条</span>
        <span>耗时 <b class="num" style="color:var(--text)">${r.body.took}</b> ms(往返 ${cost} ms)</span>
        ${r.body.hits && r.body.hits.max_score != null ? `<span>max_score ${r.body.hits.max_score}</span>` : ''}
        <div style="flex:1"></div>
        <button class="btn sm ${mode === 'table' ? '' : 'primary'}" id="qTabJson">JSON</button>
        <button class="btn sm ${mode === 'table' ? 'primary' : ''}" id="qTabTbl">表格</button>
        <button class="btn sm" id="qCopy">复制完整结果</button>
      </div>
      ${mode === 'table' ? `<div style="height:calc(100% - 46px);overflow:auto">${content}</div>` : `<div style="overflow:auto">${content}</div>`}`;
    $('#qTabJson', el).addEventListener('click', () => this.renderResult(el, r, cost, 'json'));
    $('#qTabTbl', el).addEventListener('click', () => this.renderResult(el, r, cost, 'table'));
    $('#qCopy', el).addEventListener('click', () => copyText(JSON.stringify(r.body, null, 2)));
  }
};

/* ---------------------------- 控制台(原生 DSL / REST,Kibana Dev Tools 风格) ---------------------------- */
const CONSOLE_METHOD_RE = /^\s*(GET|POST|PUT|DELETE|HEAD)\s+\/\S*/;
function parseConsoleRequest(text, caret) {
  const lines = text.split('\n');
  const lineIdx = Math.max(0, text.slice(0, caret).split('\n').length - 1);
  const isMethod = (l) => CONSOLE_METHOD_RE.test(l) && !/^\s*#/.test(l);
  let mLine = -1;
  for (let i = Math.min(lineIdx, lines.length - 1); i >= 0; i--) {
    if (isMethod(lines[i])) { mLine = i; break; }
  }
  if (mLine === -1) return null;
  const mm = lines[mLine].trim().match(/^(GET|POST|PUT|DELETE|HEAD)\s+(\S+)$/);
  if (!mm) return null;
  const bodyLines = [];
  let lastBodyLine = mLine;
  for (let i = mLine + 1; i < lines.length; i++) {
    if (isMethod(lines[i])) break;
    if (/^\s*#/.test(lines[i])) continue; // 注释行跳过
    bodyLines.push(lines[i]);
    if (lines[i].trim() !== '') lastBodyLine = i;
  }
  return { method: mm[1], path: mm[2], body: bodyLines.join('\n').trim(), mLine, lastBodyLine };
}
views.console = {
  title: '请求控制台',
  async render(el) {
    if (!state.connected) { el.innerHTML = unconnectedHTML(); bindGotoConnections(el); return; }
    const seed = [
      '# 原生 DSL / REST 控制台(用法同 Kibana Dev Tools)',
      '# 一个请求 = 方法行 + JSON 体,直到下一个请求;# 开头是注释',
      '# 光标放在请求内,' + CMD + '+回车(或点「运行当前请求」)执行该请求',
      '',
      'GET /_cat/indices?format=json&h=health,index,docs.count,store.size&s=index',
      '',
      'GET /_cluster/health',
      '',
      'POST /_search',
      '{',
      '  "size": 3,',
      '  "query": {',
      '    "match_all": {}',
      '  }',
      '}',
      ''
    ].join('\n');
    const doc = LS.get('consoleDoc', '') || seed;
    el.innerHTML = `
      <div class="query-layout">
        <div class="query-col" style="flex:1.35">
          <div class="toolbar" style="margin-bottom:0">
            <button class="btn primary" id="cRun">▶ 运行当前请求</button>
            <button class="btn" id="cFmt" title="格式化光标所在请求的 JSON 体">格式化</button>
            <button class="btn" id="cReset">恢复示例</button>
          </div>
          <textarea class="textarea editor" id="cDoc" spellcheck="false">${esc(doc)}</textarea>
        </div>
        <div class="query-col">
          <div class="result-panel" id="cResult" style="flex:1"><div class="empty">发送请求后在此查看响应</div></div>
          <div class="card" style="max-height:200px;overflow:auto">
            <div class="dim" style="margin-bottom:8px;font-size:12px">历史记录(最近 20 条,点击载入)</div>
            <div class="history-list" id="cHistory"></div>
          </div>
        </div>
      </div>`;
    const editor = $('#cDoc', el);
    editor.addEventListener('input', () => LS.set('consoleDoc', editor.value));
    const run = async () => {
      const req = parseConsoleRequest(editor.value, editor.selectionStart);
      if (!req) { toast('光标处没有找到请求:需要「GET /路径」这样的请求行', 'warn'); return; }
      let body = null;
      if (req.body) {
        try { JSON.parse(req.body); } catch (e) { toast(`${req.method} ${req.path} 的请求体不是合法 JSON:` + e.message, 'err'); return; }
        body = req.body;
      }
      const hist = LS.get('consoleHistory', []);
      hist.unshift({ method: req.method, path: req.path, body: req.body, ts: Date.now() });
      LS.set('consoleHistory', hist.slice(0, 20));
      const panel = $('#cResult', el);
      panel.innerHTML = loadingHTML();
      const t0 = Date.now();
      const r = await apiReq(req.method, req.path, body);
      const cost = Date.now() - t0;
      const cls = 's' + (r.status ? Math.floor(r.status / 100) : 0);
      let out;
      if (r.error) out = r.error;
      else if (typeof r.body === 'string') out = r.body || '(空响应)';
      else out = JSON.stringify(r.body, null, 2);
      panel.innerHTML = `
        <div class="result-meta">
          <span class="mono" style="color:var(--text-dim)">${esc(req.method)} ${esc(req.path)}</span>
          <span class="status-chip ${cls}">${r.status ? 'HTTP ' + r.status : '请求失败'}</span>
          <span>耗时 <b class="num" style="color:var(--text)">${cost}</b> ms</span>
          <div style="flex:1"></div>
          <button class="btn sm" id="cCopy">复制响应</button>
        </div>
        <pre class="json" style="user-select:text">${typeof out === 'string' && r.error ? esc(out) : highlightJSON(out)}</pre>`;
      $('#cCopy', el).addEventListener('click', () => copyText(typeof out === 'string' ? out : JSON.stringify(out, null, 2)));
      this.renderHistory(el);
    };
    $('#cRun', el).addEventListener('click', run);
    editor.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); });
    $('#cFmt', el).addEventListener('click', () => {
      const req = parseConsoleRequest(editor.value, editor.selectionStart);
      if (!req || !req.body) { toast('光标处请求没有请求体可格式化', 'warn'); return; }
      let obj;
      try { obj = JSON.parse(req.body); } catch (e) { toast('请求体不是合法 JSON:' + e.message, 'err'); return; }
      const lines = editor.value.split('\n');
      const pretty = (req.method + ' ' + req.path + '\n' + JSON.stringify(obj, null, 2)).split('\n');
      lines.splice(req.mLine, req.lastBodyLine - req.mLine + 1, ...pretty);
      editor.value = lines.join('\n');
      LS.set('consoleDoc', editor.value);
    });
    $('#cReset', el).addEventListener('click', async () => {
      const ok = await confirmModal({ title: '恢复示例内容', body: '将清空编辑区并恢复为示例请求(不影响历史记录)。', okText: '恢复' });
      if (!ok) return;
      editor.value = seed;
      LS.set('consoleDoc', seed);
      editor.focus();
    });
    this.renderHistory(el);
  },
  renderHistory(el) {
    const hist = LS.get('consoleHistory', []);
    $('#cHistory', el).innerHTML = hist.length ? hist.map((h, i) => `<div class="history-item" data-i="${i}">
      <div class="hp"><span class="m-${esc(h.method)}" style="font-weight:700">${esc(h.method)}</span> ${esc(h.path)}</div>
      <div class="ht">${new Date(h.ts).toLocaleString('zh-CN')}</div>
    </div>`).join('') : '<div class="hint">暂无</div>';
    this.bindHistory(el);
  },
  bindHistory(el) {
    $$('.history-item', el).forEach((item) => item.addEventListener('click', () => {
      const h = LS.get('consoleHistory', [])[Number(item.dataset.i)];
      if (!h) return;
      const editor = $('#cDoc', el);
      editor.value = h.method + ' ' + h.path + (h.body ? '\n' + h.body : '');
      LS.set('consoleDoc', editor.value);
      editor.focus();
    }));
  }
};

/* ---------------------------- 连接管理 ---------------------------- */
views.connections = {
  title: '连接管理',
  async render(el) {
    const cfg = state.cfg;
    el.innerHTML = `
      <div id="connWrap">
      <div class="section-title">连接管理
        <div class="spacer"></div>
        <button class="btn primary" id="cnAdd">+ 新增连接</button>
      </div>
      ${cfg.connections.map((c) => `
        <div class="conn-card" data-id="${esc(c.id)}">
          <div class="info">
            <div class="name">${esc(c.name)}
              ${c.id === state.connId ? '<span class="badge teal">当前</span>' : ''}
              ${c.username ? '<span class="badge gray">Basic 认证</span>' : c.apiKey ? '<span class="badge gray">ApiKey</span>' : '<span class="badge gray">无认证</span>'}
              ${c.ignoreTLS ? '<span class="badge yellow">忽略证书</span>' : ''}
              ${c.whitelistEnabled && (c.whitelist || []).length ? `<span class="badge yellow" title="${esc(c.whitelist.join('\n'))}">🔒 白名单 ${c.whitelist.length} 条</span>` : ''}
              ${c.blockDanger ? '<span class="badge red" title="删除索引 / 关闭索引 / 按查询删除 已在主进程拦截">🛡 危险操作已屏蔽</span>' : ''}
            </div>
            <div class="url">${esc(c.url)}</div>
          </div>
          <div class="conn-actions">
            <button class="btn sm" data-act="connect">连接</button>
            <button class="btn sm" data-act="test">测试</button>
            <button class="btn sm" data-act="edit">编辑</button>
            <button class="btn sm danger" data-act="del">删除</button>
          </div>
        </div>`).join('') || '<div class="empty">还没有连接,点击右上角新增</div>'}
      <div class="hint" style="margin-top:14px">
        连接配置保存在本机(Electron userData 目录下的 config.json),密码明文存储,请勿在公共电脑使用。
      </div>
      </div>`;
    $('#cnAdd', el).addEventListener('click', () => this.editForm(null, el));
    $('#connWrap', el).addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.conn-card').dataset.id;
      const c = cfg.connections.find((x) => x.id === id);
      const act = btn.dataset.act;
      if (act === 'connect') { connect(id); switchView(state.view === 'connections' ? 'overview' : state.view); }
      else if (act === 'test') {
        btn.textContent = '测试中…'; btn.disabled = true;
        const r = await apiReq('GET', '/', null, c);
        btn.textContent = '测试'; btn.disabled = false;
        if (r.ok) toast(`✅ 连接成功:${r.body.cluster_name}(ES ${r.body.version.number})`);
        else toast('❌ ' + errText(r), 'err', 8000);
      }
      else if (act === 'edit') this.editForm(c, el);
      else if (act === 'del') {
        if (cfg.connections.length <= 1) { toast('至少保留一个连接', 'warn'); return; }
        const ok = await confirmModal({ title: `删除连接「${c.name}」`, body: '仅删除本客户端的连接配置,不影响 ES 集群。', okText: '删除', danger: true });
        if (!ok) return;
        cfg.connections = cfg.connections.filter((x) => x.id !== id);
        if (cfg.activeId === id) cfg.activeId = cfg.connections[0].id;
        await window.api.saveConfig(cfg);
        if (state.connId === id) { state.connected = false; state.connId = cfg.activeId; setConnStatus('off', '未连接'); }
        this.render(el);
        renderConnSelect();
      }
    });
  },
  editForm(c, el) {
    const isNew = !c;
    const v = c || { name: '', url: 'http://', username: '', password: '', apiKey: '', ignoreTLS: false, timeout: 30000, whitelistEnabled: false, whitelist: [], blockDanger: true };
    const { root, close, modal } = openModal(`
      <div class="modal-head">${isNew ? '新增连接' : '编辑连接 — ' + esc(v.name)}<button class="modal-close">✕</button></div>
      <div class="modal-body"><div class="form-grid">
        <label class="fld">名称<input class="input" id="ecName" value="${esc(v.name)}" placeholder="如:dev 集群"></label>
        <label class="fld">超时(毫秒)<input class="input" id="ecTimeout" type="number" value="${esc(v.timeout)}" min="1000"></label>
        <label class="fld full">地址 http(s)://host:port<input class="input mono" id="ecUrl" value="${esc(v.url)}" placeholder="http://127.0.0.1:9200"></label>
        <label class="fld">用户名(可空)<input class="input" id="ecUser" value="${esc(v.username)}" autocomplete="off"></label>
        <label class="fld">密码(可空)<input class="input" id="ecPass" type="password" value="${esc(v.password)}" autocomplete="new-password"></label>
        <label class="fld full">API Key(可选,优先于账号密码)<input class="input mono" id="ecKey" value="${esc(v.apiKey)}" placeholder="留空则使用上面的账号密码"></label>
        <label class="fld full" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" id="ecTLS" ${v.ignoreTLS ? 'checked' : ''} style="width:15px;height:15px">
          <span>忽略 TLS 证书错误(自签名 https 时勾选)</span>
        </label>
        <div class="fld full fieldset" style="margin:0">
          <div class="legend">🛡 安全防护(共用集群建议开启,在主进程统一拦截,控制台也无法绕过)</div>
          <label class="fld full" style="flex-direction:row;align-items:center;gap:8px;margin-bottom:10px">
            <input type="checkbox" id="ecWL" ${v.whitelistEnabled ? 'checked' : ''} style="width:15px;height:15px">
            <span>启用索引白名单:仅白名单内的索引<b>可见、可读、可写</b>;白名单外的索引界面不显示,直接请求也会被拦截(含 _all 查询)</span>
          </label>
          <label class="fld full" style="margin-bottom:10px">白名单索引(每行一条,支持 * 通配符,如 <span class="mono">acm_*</span>)
            <textarea class="textarea" id="ecWLT" rows="3" placeholder="acm_product_search_mall&#10;mall_*">${esc((v.whitelist || []).join('\n'))}</textarea>
          </label>
          <label class="fld full" style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="ecBD" ${v.blockDanger ? 'checked' : ''} style="width:15px;height:15px">
            <span>屏蔽危险操作:删除索引 / 关闭索引 / 按查询删除(即使索引在白名单内也拦截)</span>
          </label>
        </div>
      </div></div>
      <div class="modal-foot">
        <button class="btn" id="ecTest">测试连接</button>
        <div style="flex:1"></div>
        <button class="btn" id="ecCancel">取消</button>
        <button class="btn primary" id="ecSave">保存</button>
      </div>`);
    maskCloseGuard(root, () => {});
    $('#ecCancel', modal).addEventListener('click', close);
    const readForm = () => ({
      name: $('#ecName', modal).value.trim() || '未命名连接',
      url: $('#ecUrl', modal).value.trim(),
      username: $('#ecUser', modal).value.trim(),
      password: $('#ecPass', modal).value,
      apiKey: $('#ecKey', modal).value.trim(),
      ignoreTLS: $('#ecTLS', modal).checked,
      timeout: Number($('#ecTimeout', modal).value) || 30000,
      whitelistEnabled: $('#ecWL', modal).checked,
      whitelist: $('#ecWLT', modal).value.split('\n').map((s) => s.trim()).filter(Boolean),
      blockDanger: $('#ecBD', modal).checked
    });
    $('#ecTest', modal).addEventListener('click', async () => {
      const t = readForm();
      if (!t.url) { toast('请填写地址', 'warn'); return; }
      const btn = $('#ecTest', modal);
      btn.textContent = '测试中…'; btn.disabled = true;
      const r = await apiReq('GET', '/', null, t);
      btn.textContent = '测试连接'; btn.disabled = false;
      if (r.ok) toast(`✅ 连接成功:${r.body.cluster_name}(ES ${r.body.version.number})`);
      else toast('❌ ' + errText(r), 'err', 8000);
    });
    $('#ecSave', modal).addEventListener('click', async () => {
      const t = readForm();
      if (!/^https?:\/\/.+/.test(t.url)) { toast('地址需以 http:// 或 https:// 开头', 'warn'); return; }
      if (isNew) {
        t.id = 'c' + Date.now();
        state.cfg.connections.push(t);
      } else {
        Object.assign(c, t);
      }
      await window.api.saveConfig(state.cfg);
      renderConnSelect();
      close();
      toast('已保存');
      this.render(el);
    });
  }
};

/* =========================================================================
 * 路由 & 启动
 * ========================================================================= */
function switchView(v) {
  state.view = v;
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  render(v);
}
function render(v) {
  const el = $('#main');
  const view = views[v];
  if (!view) return;
  Promise.resolve(view.render(el)).catch((e) => {
    el.innerHTML = `<div class="empty" style="color:var(--red);white-space:pre-wrap;user-select:text">${esc(e && e.message || e)}</div>`;
    toast((e && e.message) || String(e), 'err');
  });
}

async function init() {
  if (!window.api) {
    document.body.innerHTML = '<div class="empty" style="padding-top:120px">请在 Electron 中运行本应用(npm start)</div>';
    return;
  }
  // textarea 内 Tab 输入两个空格缩进(写 DSL 更顺手)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && e.target && e.target.tagName === 'TEXTAREA') {
      e.preventDefault();
      e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
    }
  });
  state.cfg = await window.api.getConfig();
  if (!state.cfg.connections.length) state.cfg = { connections: [], activeId: null };
  state.connId = state.cfg.activeId || (state.cfg.connections[0] && state.cfg.connections[0].id);
  renderConnSelect();
  $('#connSelect').addEventListener('change', (e) => connect(e.target.value));
  $('#btnManageConn').addEventListener('click', () => switchView('connections'));
  $$('#nav .nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  // 启动即用当前选中连接尝试连接(失败不弹错误,状态栏红点提示)
  if (state.connId) await connect(state.connId, { silent: true });
  else switchView('connections');
}
init();
