/* 演示模式:?demo=1 时用本地假数据运行整个界面(不连真实 ES)
   用途:截图、录屏、GitHub Pages 在线体验 */
(function () {
  if (!/[?&]demo=1/.test(location.search)) return;

  // ---------- 假数据 ----------
  var BRANDS = ['Acebit', 'NovaTech', 'Lumio', 'Orbita', 'PicoLab', 'Vertex', 'Zenith'];
  var TYPES = ['键盘', '显示器', '鼠标', '音箱', '摄像头', '耳机', '扩展坞'];
  var STATUSES = ['on_sale', 'off_sale', 'draft'];
  var PRODUCTS = [];
  var seed = 42;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  function pick(a) { return a[Math.floor(rnd() * a.length)]; }
  for (var i = 1; i <= 86; i++) {
    PRODUCTS.push({
      id: 10000 + i,
      product_name: pick(BRANDS) + ' ' + pick(TYPES) + ' ' + pick(['Pro', 'Air', 'Max', 'Lite', 'Ultra']) + ' ' + (i + 100),
      brand: pick(BRANDS),
      category: pick(TYPES),
      price: Math.round(rnd() * 4800) / 10 + 49,
      stock: Math.floor(rnd() * 500),
      status: pick(STATUSES),
      in_stock: rnd() > 0.2,
      rating: Math.round(rnd() * 50) / 10,
      created_at: '2026-' + String(1 + Math.floor(rnd() * 9)).padStart(2, '0') + '-' + String(1 + Math.floor(rnd() * 28)).padStart(2, '0') + ' 10:' + String(Math.floor(rnd() * 60)).padStart(2, '0') + ':00',
      tags: [pick(['热卖', '新品', '推荐', '联名'])]
    });
  }

  var INDICES = [
    { health: 'green', status: 'open', index: 'demo_products', pri: '1', rep: '1', 'docs.count': String(PRODUCTS.length), 'store.size': '3.2mb' },
    { health: 'green', status: 'open', index: 'demo_orders', pri: '1', rep: '1', 'docs.count': '10240', 'store.size': '18.6mb' },
    { health: 'yellow', status: 'open', index: 'demo_users', pri: '1', rep: '1', 'docs.count': '356', 'store.size': '812kb' },
    { health: 'green', status: 'close', index: 'demo_logs_202512', pri: '1', rep: '1', 'docs.count': '982103', 'store.size': '1.2gb' }
  ];

  var MAPPING = {
    demo_products: { mappings: { properties: {
      id: { type: 'long' },
      product_name: { type: 'text', fields: { keyword: { type: 'keyword' }, py: { type: 'text' } } },
      brand: { type: 'keyword' },
      category: { type: 'keyword' },
      price: { type: 'double' },
      stock: { type: 'long' },
      status: { type: 'keyword' },
      in_stock: { type: 'boolean' },
      rating: { type: 'float' },
      created_at: { type: 'date' },
      tags: { type: 'keyword' }
    } } }
  };

  // ---------- 迷你查询引擎 ----------
  function val(doc, f) { return f.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, doc); }
  function like(v, q) { return String(v == null ? '' : v).toLowerCase().includes(q.toLowerCase()); }
  function matchQ(q, doc) {
    if (!q.query) return true;
    if (q.simple_query_string) { var s = q.simple_query_string.query; return Object.keys(doc).some(function (k) { return like(val(doc, k), s); }); }
    if (q.match) { var fk = Object.keys(q.match)[0]; return like(val(doc, fk), q.match[fk]); }
    if (q.match_phrase) { var fp = Object.keys(q.match_phrase)[0]; return like(val(doc, fp), q.match_phrase[fp]); }
    if (q.term) { var ft = Object.keys(q.term)[0]; var tv = q.term[ft]; return String(val(doc, ft)) === String(tv); }
    if (q.terms) { var fts = Object.keys(q.terms)[0]; return q.terms[fts].map(String).includes(String(val(doc, fts))); }
    if (q.prefix) { var fpr = Object.keys(q.prefix)[0]; return String(val(doc, fpr) || '').startsWith(q.prefix[fpr]); }
    if (q.wildcard) { var fw = Object.keys(q.wildcard)[0]; var pat = q.wildcard[fw].value || q.wildcard[fw]; try { return new RegExp('^' + String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(String(val(doc, fw))); } catch (e) { return false; } }
    if (q.range) { var fr = Object.keys(q.range)[0]; var r = q.range[fr]; var v = Number(val(doc, fr)); if (isNaN(v)) return false; if (r.gt != null && !(v > r.gt)) return false; if (r.gte != null && !(v >= r.gte)) return false; if (r.lt != null && !(v < r.lt)) return false; if (r.lte != null && !(v <= r.lte)) return false; return true; }
    if (q.exists) { return val(doc, q.exists.field) != null; }
    if (q.bool) {
      var ok = true;
      (q.bool.must || []).forEach(function (c) { if (!matchQ(c, doc)) ok = false; });
      (q.bool.must_not || []).forEach(function (c) { if (matchQ(c, doc)) ok = false; });
      (q.bool.should || []).forEach(function () {});
      if (q.bool.minimum_should_match && !(q.bool.should || []).some(function (c) { return matchQ(c, doc); })) ok = false;
      return ok;
    }
    if (q.match_all) return true;
    return true;
  }

  function doSearch(body) {
    var from = body && body.from || 0;
    var size = body && body.size != null ? body.size : 10;
    var list = PRODUCTS.filter(function (d) { return matchQ((body && body.query) || { match_all: {} }, d); });
    if (body && body.sort && body.sort.length) {
      var sf = Object.keys(body.sort[0])[0];
      var dir = typeof body.sort[0][sf] === 'object' ? body.sort[0][sf].order : body.sort[0][sf];
      list = list.slice().sort(function (a, b) {
        var x = val(a, sf), y = val(b, sf);
        var c = (typeof x === 'number' && typeof y === 'number') ? x - y : String(x).localeCompare(String(y));
        return dir === 'desc' ? -c : c;
      });
    }
    var hits = list.slice(from, from + size).map(function (d, i) {
      return { _index: 'demo_products', _id: 'demo_' + d.id, _score: 1, _source: d };
    });
    return {
      took: 3 + Math.floor(Math.random() * 15),
      hits: { total: { value: list.length, relation: 'eq' }, max_score: 1, hits: hits }
    };
  }

  // ---------- mock api ----------
  var DEMO_CONN = { connections: [{ id: 'demo', name: '演示集群(假数据)', url: 'http://demo.local:9200', username: '', password: '', apiKey: '', ignoreTLS: false, timeout: 5000, whitelistEnabled: false, whitelist: [], blockDanger: false }], activeId: 'demo' };

  window.api = {
    getConfig: function () { return Promise.resolve(JSON.parse(JSON.stringify(DEMO_CONN))); },
    saveConfig: function () { return Promise.resolve(DEMO_CONN); },
    info: function () { return Promise.resolve({ electron: 'demo', node: 'demo' }); },
    request: function (p) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var m = (p.method || 'GET').toUpperCase();
          var path = String(p.path || '/').split('?')[0];
          var res;
          if (path === '/' || path === '') {
            res = { cluster_name: 'demo-cluster', cluster_uuid: 'demo', version: { number: '8.11.0', build_flavor: 'default' }, tagline: 'Demo Mode' };
          } else if (path === '/_cluster/health') {
            res = { cluster_name: 'demo-cluster', status: 'green', timed_out: false, active_shards: 12, unassigned_shards: 1, active_primary_shards: 6 };
          } else if (path === '/_cluster/stats') {
            res = { indices: { count: 4, docs: { count: 992785, deleted: 1024 }, store: { size_in_bytes: 1308622848 } }, nodes: { count: { total: 3 }, shards: { total_count: 12 } } };
          } else if (path.indexOf('/_cat/nodes') === 0) {
            res = [
              { name: 'es-node-1', ip: '10.0.0.11', role: 'cdfhilmrstw', master: '*', 'heap.percent': '41', 'ram.percent': '63', cpu: '9' },
              { name: 'es-node-2', ip: '10.0.0.12', role: 'cdfhilmrstw', master: '-', 'heap.percent': '38', 'ram.percent': '60', cpu: '6' },
              { name: 'es-node-3', ip: '10.0.0.13', role: 'di', master: '-', 'heap.percent': '22', 'ram.percent': '48', cpu: '3' }
            ];
          } else if (path.indexOf('/_cat/indices') === 0) {
            res = INDICES;
          } else if (/\/_mapping$/.test(path) && MAPPING[path.split('/')[1]]) {
            var r = {}; r[path.split('/')[1]] = MAPPING[path.split('/')[1]]; res = r;
          } else if (/\/_search$/.test(path)) {
            try { res = doSearch(typeof p.body === 'string' ? JSON.parse(p.body || '{}') : (p.body || {})); }
            catch (e) { resolve({ ok: false, status: 400, body: { error: { type: 'parse_exception', reason: e.message } } }); return; }
          } else if (/\/_doc(\/[^/]+)?$/.test(path) && m === 'POST') {
            res = { result: 'created', _id: 'demo_new_' + Date.now() };
          } else if (/\/_update\//.test(path)) {
            res = { result: 'updated' };
          } else if (m === 'DELETE') {
            res = { acknowledged: true };
          } else {
            resolve({ ok: false, status: 404, body: { error: { type: 'demo_mode', reason: '演示模式仅支持界面展示的功能' } } });
            return;
          }
          resolve({ ok: true, status: 200, body: res, tookMs: 12 + Math.floor(Math.random() * 40) });
        }, 150);
      });
    }
  };
})();
