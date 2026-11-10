'use strict';
/*
 * Logalyzer – server
 * Serves the UI (public/, shared/) and provides the API under /api.
 *
 *   docker compose up -d      -> app + MongoDB, http://localhost:3000
 *   npm start                 -> app only, needs MongoDB (default mongodb://localhost:27017/logalyzer)
 *
 * Environment variables: PORT (3000), HOST (127.0.0.1), MONGO_URL, MONGO_DB
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/schema.js');
const A = require('../shared/analyze.js');
const store = require('./store/index.js').createStore();

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 50 * 1024 * 1024;
const VERSION = require('../package.json').version;

const STATIC = { '/': 'public', '/shared/': 'shared' };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

// ---------- Helpers ----------
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function send(res, status, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
const json = (res, body, status) => send(res, status || 200, body);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'The data is too large (max. 50 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const isJson = (req) => (req.headers['content-type'] || '').includes('application/json');
async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Invalid JSON in request.'); }
}
/** Text body: JSON { text, ... } or raw text. */
async function readText(req, q) {
  if (isJson(req)) return readJSON(req);
  return { text: await readBody(req), name: q.get('name'), type: q.get('type') };
}

/** Filter from the query: from, to, q, status and f.<field>=value */
function filterFrom(q) {
  const f = { fields: {} };
  for (const k of ['from', 'to', 'q', 'status']) if (q.get(k)) f[k] = q.get(k);
  for (const [k, v] of q) if (k.startsWith('f.') && v !== '') f.fields[k.slice(2)] = v;
  return f;
}
const hasFilter = (f) => !!(f.from || f.to || f.q || f.status || Object.keys(f.fields).length);

function typeOr404(id) {
  const s = store.getType(id);
  if (!s) throw new HttpError(404, `Unknown log type «${id}».`);
  return s;
}

/** Short report on a parser result (for preview and import). */
function summary(res) {
  const times = res.events.map((e) => e.time).sort();
  return { format: res.format || '', matched: res.events.length, from: times[0] || null, to: times[times.length - 1] || null, skipped: res.skipped };
}
/** Entries that only matched the fallback rule (rule without pattern). */
function fallbackHits(res, schema) {
  const fb = (schema.rules || []).find((r) => !r.pattern);
  if (!fb) return [];
  const keys = Object.entries(fb.set || {}).filter(([, v]) => typeof v === 'string' && !/[{$]/.test(v));
  if (!keys.length) return [];
  return res.events.filter((e) => keys.every(([k, v]) => e[k] === v)).map((e) => e.message || A.eventKey(e)).slice(0, 50);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function csv(res, name, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${name}"`
  });
  res.end(buf);
}

/** Best log type for a text, or an error with candidates. */
function pickType(text) {
  const cand = S.detect(text, store.listTypes());
  const best = cand[0];
  if (!best || best.share < 0.5) throw new HttpError(422, 'No log type fits this text. Choose a type or create a new log type.', { candidates: cand });
  return best.id;
}

function parseOrFail(type, text) {
  const schema = typeOr404(type);
  const parsed = S.parse(text, schema);
  if (parsed.error) throw new HttpError(400, parsed.error);
  if (!parsed.events.length) throw new HttpError(422, 'No events found' + (parsed.skipped.length ? ` (${parsed.skipped.length} lines did not match the log type «${schema.name}»).` : '.'));
  return { schema, parsed };
}
/** Import: always merge, entries that are already stored are skipped. */
async function doImport(res, type, text, name) {
  const { schema, parsed } = parseOrFail(type, text);
  const r = await store.importParsed(type, parsed, name);
  json(res, Object.assign({ type }, summary(parsed), { fallback: fallbackHits(parsed, schema) }, r, { total: (await store.get(type)).events.length }));
}

// ---------- API ----------
// Paths with :param; handlers get (req, res, query, params)
const routes = [
  ['GET', '/api/health', async (req, res) => json(res, { ok: true, version: VERSION, storage: store.kind, types: store.listTypes().length })],

  // Log types
  ['GET', '/api/types', async (req, res) => {
    const out = [];
    for (const s of store.listTypes()) out.push(Object.assign({}, s, { count: (await store.get(s.id)).events.length }));
    json(res, out);
  }],
  ['GET', '/api/types/:id', async (req, res, q, p) => json(res, typeOr404(p.id))],
  ['PUT', '/api/types/:id', async (req, res, q, p) => {
    const s = await readJSON(req);
    s.id = p.id;
    json(res, await store.saveType(s));
  }],
  ['DELETE', '/api/types/:id', async (req, res, q, p) => { typeOr404(p.id); await store.deleteType(p.id); json(res, { ok: true }); }],

  // Schema tools
  ['POST', '/api/schema/infer', async (req, res, q) => {
    const b = await readText(req, q);
    const r = S.infer(String(b.text || ''));
    json(res, r, r.error && !r.fields ? 422 : 200);
  }],
  ['POST', '/api/schema/test', async (req, res) => {
    const b = await readJSON(req);
    const errors = S.validate(b.schema);
    let r = { events: [], skipped: [] };
    if (!errors.length || b.schema && b.schema.fields) {
      try { r = S.parse(String(b.text || ''), b.schema); } catch (e) { errors.push(e.message); }
    }
    if (r.error) errors.push(r.error);
    json(res, Object.assign(summary(r), { errors, columns: b.schema ? S.columns(b.schema) : [], events: r.events.slice(0, Number(b.limit) || 100), skipped: r.skipped.slice(0, 50), skippedCount: r.skipped.length }));
  }],
  ['POST', '/api/detect', async (req, res, q) => json(res, S.detect(String((await readText(req, q)).text || ''), store.listTypes()))],

  // Import with automatic type detection (or type in body/query)
  ['POST', '/api/import', async (req, res, q) => {
    const b = await readText(req, q);
    const text = String(b.text || '');
    if (!text.trim()) throw new HttpError(400, 'Nothing to import.');
    await doImport(res, b.type || pickType(text), text, b.name || 'Import ' + stamp());
  }],
  // Preview with type detection and duplicate check, stores nothing
  ['POST', '/api/check', async (req, res, q) => {
    const b = await readText(req, q);
    const text = String(b.text || '');
    if (!text.trim()) throw new HttpError(400, 'No content.');
    const type = b.type || pickType(text);
    const { schema, parsed } = parseOrFail(type, text);
    json(res, Object.assign({ type }, summary(parsed), { fallback: fallbackHits(parsed, schema) }, await store.checkDuplicates(type, parsed)));
  }],

  // Per log type
  ['POST', '/api/t/:type/import', async (req, res, q, p) => {
    const b = await readText(req, q);
    if (!String(b.text || '').trim()) throw new HttpError(400, 'Nothing to import.');
    await doImport(res, p.type, String(b.text), b.name || 'Import ' + stamp());
  }],
  ['POST', '/api/t/:type/preview', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    const r = S.parse(String((await readText(req, q)).text || ''), schema);
    if (r.error) throw new HttpError(400, r.error);
    json(res, Object.assign(summary(r), { fallback: fallbackHits(r, schema) }, await store.checkDuplicates(p.type, r)));
  }],
  ['GET', '/api/t/:type/data', async (req, res, q, p) => { typeOr404(p.type); json(res, await store.get(p.type)); }],
  ['GET', '/api/t/:type/events', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    const ev = A.filterEvents((await store.get(p.type)).events, filterFrom(q), schema);
    const limit = Number(q.get('limit')) || 0;
    json(res, { count: ev.length, events: limit ? ev.slice(-limit) : ev });
  }],
  ['GET', '/api/t/:type/outages', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    let outs = A.filterOutages((await store.analysis(p.type)).outages, filterFrom(q));
    if (q.get('resolution')) outs = outs.filter((a) => a.resolution === q.get('resolution'));
    json(res, { count: outs.length, outages: A.outageRows(outs, schema) });
  }],
  ['GET', '/api/t/:type/findings', async (req, res, q, p) => {
    typeOr404(p.type);
    const all = (await store.analysis(p.type)).findings;
    if (q.get('all')) return json(res, all);
    const read = new Set((await store.listRead(p.type)).map((g) => g.k));
    json(res, all.filter((b) => !read.has(b.k)));
  }],
  ['GET', '/api/t/:type/read', async (req, res, q, p) => { typeOr404(p.type); json(res, await store.listRead(p.type)); }],
  ['POST', '/api/t/:type/read', async (req, res, q, p) => { typeOr404(p.type); json(res, await store.markRead(p.type, await readJSON(req))); }],
  ['DELETE', '/api/t/:type/read/:k', async (req, res, q, p) => {
    typeOr404(p.type);
    if (!(await store.unmarkRead(p.type, p.k))) throw new HttpError(404, 'This finding is not marked as read.');
    json(res, { ok: true });
  }],
  ['GET', '/api/t/:type/notes', async (req, res, q, p) => { typeOr404(p.type); json(res, await store.listNotes(p.type)); }],
  ['PUT', '/api/t/:type/notes', async (req, res, q, p) => { typeOr404(p.type); json(res, await store.setNote(p.type, await readJSON(req))); }],
  ['GET', '/api/t/:type/metrics', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    const f = filterFrom(q);
    const k = A.metrics(A.filterEvents((await store.get(p.type)).events, f, schema), A.filterOutages((await store.analysis(p.type)).outages, f), schema);
    if (k.longest) k.longest = { object: k.longest.object, start: k.longest.start, end: k.longest.end, duration_min: k.longest.duration_min };
    json(res, k);
  }],
  ['GET', '/api/t/:type/export/events.csv', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    const f = filterFrom(q);
    const ev = A.filterEvents((await store.get(p.type)).events, f, schema);
    csv(res, `${p.type}-events${hasFilter(f) ? '-filtered' : ''}-${stamp()}.csv`, S.toCSV(ev, S.columns(schema)));
  }],
  ['GET', '/api/t/:type/export/outages.csv', async (req, res, q, p) => {
    const schema = typeOr404(p.type);
    const outs = A.filterOutages((await store.analysis(p.type)).outages, filterFrom(q));
    csv(res, `${p.type}-outages-${stamp()}.csv`, S.toCSV(A.outageRows(outs, schema), A.outageColumns(schema)));
  }]
].map(([method, pattern, h]) => {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { method, re, names, h };
});

function route(method, pathname) {
  let pathOk = false;
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m) continue;
    pathOk = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { h: r.h, params };
  }
  throw new HttpError(pathOk ? 405 : 404, pathOk ? 'Method not allowed.' : 'Unknown API path.');
}

// ---------- Static files ----------
function serveStatic(req, res, pathname) {
  const prefix = pathname.startsWith('/shared/') ? '/shared/' : '/';
  const base = path.join(ROOT, STATIC[prefix]);
  let rel = decodeURIComponent(pathname.slice(prefix.length));
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const t0 = Date.now();
  try {
    if (url.pathname.startsWith('/api/')) {
      const { h, params } = route(req.method, url.pathname);
      await h(req, res, url.searchParams, params);
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0} ms`);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url.pathname);
    } else {
      throw new HttpError(405, 'Method not allowed.');
    }
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    else console.log(`${req.method} ${url.pathname} ${status} ${e.message}`);
    if (!res.headersSent) json(res, Object.assign({ error: e.message }, e.extra || {}, e.details ? { details: e.details } : {}), status);
  }
});

async function main() {
  await store.init();
  server.listen(PORT, HOST, () => {
    console.log(`Logalyzer running at http://localhost:${PORT}`);
    console.log(`Storage: ${store.kind} (${store.describe()}), log types: ${store.listTypes().map((s) => s.id).join(', ') || 'none'}`);
  });
  const stop = async (sig) => {
    console.log(`${sig} received, shutting down …`);
    server.close();
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
