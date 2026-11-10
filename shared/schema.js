/*
 * Logalyzer – schema engine
 * A log type (schema) describes how text is split into events and which fields exist.
 *
 * Schema:
 *   id, name, description, sample (file name in samples/)
 *   format:   { type: 'csv' | 'regex' | 'jsonl', delimiter: 'auto'|','|';'|'\t', pattern: '<regex with named groups>', flags }
 *   fields:   [{ name, label, type: 'time'|'text'|'category'|'number', source, format, filter, chart, table }]
 *             exactly one field is called "time" and has type 'time' (main timestamp, stored as YYYY-MM-DDTHH:MM[:SS])
 *             source = column name (CSV), group name (regex) or path a.b.c (JSON); empty = name
 *   rules:    [{ field, pattern, flags, set: { field: template } }]  the first matching rule wins;
 *             a rule without pattern always matches (fallback rule). set only fills empty fields.
 *             template: text with $1, $<group>, {field}  or  { template, replace: [[pattern, replacement, flags]], trim, fallback }
 *   mappings: { field: { values: [{ pattern, value }], fallback, flags } }  normalises values (e.g. "lost" -> "Down")
 *   state:    { field, down: [..], up: [..], keys: [fields], label: template, group: field, related: field }
 *             optional: pairs down/up per key into outages (timeline, outage table, findings)
 */
(function (root) {
  'use strict';

  const TYPES = ['time', 'text', 'category', 'number'];
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = { jan: 1, feb: 2, mar: 3, mär: 3, mrz: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12 };

  function slug(s) {
    const t = String(s || '').trim().toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^[a-z_]/.test(t) ? t : 'f_' + t;
  }

  // ---------- Time ----------
  const iso = (Y, M, D, h, m, s) => `${Y}-${pad(M)}-${pad(D)}T${pad(h || 0)}:${pad(m || 0)}${s != null && s !== '' ? ':' + pad(s) : ''}`;
  const valid = (Y, M, D, h, m) => M >= 1 && M <= 12 && D >= 1 && D <= 31 && (h || 0) <= 23 && (m || 0) <= 59 && Y > 1900;
  function fromDate(d, sec) { return iso(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), sec ? d.getSeconds() : null); }

  const AUTO = [
    [/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/, (m) => [m[1], m[2], m[3], m[4], m[5], m[6]]],
    [/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/, (m) => [m[3], m[2], m[1], m[4], m[5], m[6]]],
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/, (m) => [m[1], m[2], m[3], m[4], m[5], m[6]]],
    [/^(\d{1,2})\/([A-Za-zäÄ]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})/, (m) => [m[3], MONTHS[m[2].toLowerCase()], m[1], m[4], m[5], m[6]]],
    [/^([A-Za-zäÄ]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/, (m) => [new Date().getFullYear(), MONTHS[m[1].toLowerCase()], m[2], m[3], m[4], m[5]]]
  ];

  function normTime(value, format) {
    const s = String(value == null ? '' : value).trim().replace(/^\[/, '');
    if (!s) return null;
    if (format) return timeWithFormat(s, format);
    if (/^\d{10}(\.\d+)?$/.test(s)) return fromDate(new Date(parseFloat(s) * 1000), true);
    if (/^\d{13}$/.test(s)) return fromDate(new Date(+s), true);
    for (const [re, f] of AUTO) {
      const m = s.match(re);
      if (!m) continue;
      const [Y, M, D, h, mi, sec] = f(m).map((x) => (x == null || x === '' ? null : +x));
      if (valid(Y, M, D, h, mi)) return iso(Y, M, D, h, mi, sec);
    }
    return null;
  }

  const fmtCache = new Map();
  function timeWithFormat(s, format) {
    let c = fmtCache.get(format);
    if (!c) {
      const order = [];
      const src = format.replace(/YYYY|YY|MMM|MM|M|DD|D|HH|H|mm|ss|[.*+?^${}()|[\]\\]/g, (t) => {
        const map = { YYYY: '(\\d{4})', YY: '(\\d{2})', MMM: '([A-Za-zäÄ]{3})', MM: '(\\d{1,2})', M: '(\\d{1,2})', DD: '(\\d{1,2})', D: '(\\d{1,2})', HH: '(\\d{1,2})', H: '(\\d{1,2})', mm: '(\\d{2})', ss: '(\\d{2})' };
        if (map[t]) { order.push(t); return map[t]; }
        return '\\' + t;
      }).replace(/\s+/g, '\\s+');
      c = { re: new RegExp('^' + src), order };
      fmtCache.set(format, c);
    }
    const m = s.match(c.re);
    if (!m) return null;
    const v = {};
    c.order.forEach((t, i) => { v[t] = m[i + 1]; });
    const Y = v.YYYY ? +v.YYYY : v.YY ? 2000 + +v.YY : new Date().getFullYear();
    const M = v.MMM ? MONTHS[v.MMM.toLowerCase()] : +(v.MM || v.M);
    const D = +(v.DD || v.D), h = +(v.HH || v.H || 0), mi = +(v.mm || 0);
    if (!valid(Y, M, D, h, mi)) return null;
    return iso(Y, M, D, h, mi, v.ss);
  }

  // ---------- CSV ----------
  function detectDelimiter(headerLine) {
    const counts = [',', ';', '\t', '|'].map((d) => [d, splitLine(headerLine, d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][0];
  }
  function splitLine(line, d) { return splitCSV(line, d)[0] || []; }
  function splitCSV(text, delim) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }
  function quote(v) { return '"' + (v == null ? '' : String(v)).replace(/"/g, '""') + '"'; }
  function toCSV(rows, columns) {
    return '﻿' + [columns.join(',')].concat(rows.map((r) => columns.map((c) => quote(r[c])).join(','))).join('\r\n') + '\r\n';
  }

  // ---------- Templates ----------
  function fill(tpl, m, e) {
    return String(tpl).replace(/\$(\d+)|\$<(\w+)>|\{(\w+)\}/g, (_, n, g, f) => {
      const v = n != null ? (m && m[+n]) : g != null ? (m && m.groups && m.groups[g]) : e[f];
      return v == null ? '' : String(v);
    });
  }
  function value(spec, m, e) {
    if (spec == null) return '';
    if (typeof spec !== 'object') return fill(spec, m, e);
    let v = fill(spec.template || '', m, e);
    for (const [pat, rep, fl] of spec.replace || []) v = v.replace(new RegExp(pat, fl == null ? 'g' : fl), rep == null ? '' : rep);
    if (spec.trim !== false) v = v.trim();
    if (!v && spec.fallback != null) v = fill(spec.fallback, m, e);
    return v;
  }

  // ---------- Compile ----------
  const compiled = new WeakMap();
  function compile(schema) {
    let c = compiled.get(schema);
    if (c) return c;
    const fmt = schema.format || {};
    c = {
      fields: (schema.fields || []).filter((f) => f && f.name),
      line: fmt.type === 'regex' && fmt.pattern ? new RegExp(fmt.pattern, fmt.flags || '') : null,
      rules: (schema.rules || []).map((r) => ({ field: r.field || '', re: r.pattern ? new RegExp(r.pattern, r.flags == null ? 'i' : r.flags) : null, set: r.set || {} })),
      mappings: Object.entries(schema.mappings || {}).map(([field, a]) => ({
        field, fallback: a.fallback, targets: new Set((a.values || []).map((w) => w.value).concat(a.fallback != null ? [a.fallback] : [])),
        values: (a.values || []).map((w) => ({ re: new RegExp(w.pattern, a.flags == null ? 'i' : a.flags), value: w.value }))
      }))
    };
    compiled.set(schema, c);
    return c;
  }

  function columns(schema) {
    const rest = (schema.fields || []).map((f) => f.name).filter((n) => n && n !== 'time');
    return ['no', 'time'].concat(rest);
  }

  // A record { source -> raw value } becomes an event.
  function build(rec, schema, c, byName) {
    const e = {};
    for (const f of c.fields) {
      const raw = byName ? rec[f.name] : rec[f.source || f.name];
      let v = raw == null ? '' : String(raw).replace(/\t/g, ' ').trim();
      // With a fixed time format: if it does not match, fall back to automatic detection (e.g. a CSV written by Claude)
      if (f.type === 'time') v = v ? (byName ? normTime(v) : normTime(v, f.format) || (f.format ? normTime(v) : '')) || '' : '';
      else if (f.type === 'number') { const n = v === '' ? NaN : Number(v.replace(/'/g, '').replace(',', '.')); v = Number.isFinite(n) ? n : ''; }
      e[f.name] = v;
    }
    for (const r of c.rules) {
      const m = r.re ? String(e[r.field] == null ? '' : e[r.field]).match(r.re) : [];
      if (!m) continue;
      for (const [k, spec] of Object.entries(r.set)) if (e[k] === '' || e[k] == null) e[k] = value(spec, m, e);
      break;
    }
    for (const a of c.mappings) {
      const v = e[a.field] == null ? '' : String(e[a.field]);
      if (a.targets.has(v)) continue;
      const hit = a.values.find((w) => w.re.test(v));
      e[a.field] = hit ? hit.value : a.fallback != null ? a.fallback : v;
    }
    return e;
  }

  function getPath(o, p) { return String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }

  // Does the text look like a Logalyzer export of this type (header line with field names)?
  function looksLikeExport(firstLine, schema) {
    const head = splitLine(firstLine, detectDelimiter(firstLine)).map((h) => h.trim().toLowerCase());
    const names = (schema.fields || []).map((f) => f.name.toLowerCase());
    return head.includes('time') && names.filter((n) => head.includes(n)).length >= Math.min(3, names.length);
  }

  /**
   * Split text according to a schema.
   * -> { events, skipped: [{ line, text, reason }], format }
   */
  function parse(text, schema, opts) {
    opts = opts || {};
    const c = compile(schema);
    const t = String(text || '').replace(/^﻿/, '');
    const kind = (schema.format || {}).type || 'csv';
    const first = (t.split(/\r?\n/, 1)[0] || '');
    const events = [], skipped = [];
    let format = kind;
    const push = (rec, line, raw, byName) => {
      const e = build(rec, schema, c, byName);
      if (!e.time) { skipped.push({ line, text: raw, reason: 'no valid time' }); return; }
      events.push(e);
    };

    const exportHead = looksLikeExport(first, schema);
    if (kind === 'csv' || exportHead) {
      // Map columns by "source"; if that does not fit but the header contains the field names
      // (Logalyzer export), map by field name.
      const fixed = kind === 'csv' && (schema.format || {}).delimiter && schema.format.delimiter !== 'auto' ? schema.format.delimiter : null;
      const d = fixed || detectDelimiter(first);
      const headCols = splitLine(first, d).map((h) => h.trim());
      const sourcesOk = c.fields.filter((f) => f.source).every((f) => headCols.includes(f.source));
      const byName = exportHead && (kind !== 'csv' || !sourcesOk);
      format = byName ? 'csv-export' : 'csv';
      const rows = splitCSV(t, d);
      if (!rows.length) return { events, skipped, format, error: 'No data.' };
      const head = rows[0].map((h) => h.trim());
      const lower = head.map((h) => h.toLowerCase());
      rows.slice(1).forEach((r, i) => {
        const rec = {};
        head.forEach((h, k) => { rec[h] = r[k]; if (byName) rec[lower[k]] = r[k]; });
        if (opts.limit && events.length >= opts.limit) return;
        push(rec, i + 2, r.join(' | '), byName);
      });
    } else if (kind === 'jsonl') {
      t.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim() || (opts.limit && events.length >= opts.limit)) return;
        let o;
        try { o = JSON.parse(line); } catch (e) { skipped.push({ line: i + 1, text: line, reason: 'not JSON' }); return; }
        const rec = {};
        for (const f of c.fields) rec[f.source || f.name] = getPath(o, f.source || f.name);
        push(rec, i + 1, line);
      });
    } else if (kind === 'regex') {
      if (!c.line) return { events, skipped, format, error: 'The pattern for format «regex» is missing.' };
      t.split(/\r?\n/).forEach((line, i) => {
        if (!line.trim() || (opts.limit && events.length >= opts.limit)) return;
        const m = line.match(c.line);
        if (!m) { skipped.push({ line: i + 1, text: line, reason: 'does not match the pattern' }); return; }
        const rec = Object.assign({}, m.groups || {});
        m.slice(1).forEach((v, k) => { rec['$' + (k + 1)] = v; });
        push(rec, i + 1, line);
      });
    } else {
      return { events, skipped, format, error: `Unknown format «${kind}».` };
    }

    // Logs are often newest first: reverse them so that "no" is chronological.
    if (events.length > 1 && events[0].time > events[events.length - 1].time) events.reverse();
    const cols = columns(schema);
    const out = events.map((e, k) => {
      const o = { no: k + 1 };
      for (const col of cols) if (col !== 'no') o[col] = e[col] == null ? '' : e[col];
      return o;
    });
    return { events: out, skipped, format };
  }

  /** Which types fit the text? -> [{ id, name, share, matched, filled }] best first */
  function detect(text, schemas) {
    const sample = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 60).join('\n');
    return schemas.map((s) => {
      let r;
      try { r = parse(sample, s); } catch (e) { r = { events: [], skipped: [] }; }
      const n = r.events.length + r.skipped.length;
      const known = r.events.length ? countFilled(r.events, s) : 0;
      return { id: s.id, name: s.name, matched: r.events.length, share: n ? r.events.length / n : 0, filled: known };
    }).sort((a, b) => b.share - a.share || b.filled - a.filled);
  }
  function countFilled(events, s) {
    const names = (s.fields || []).map((f) => f.name);
    let filled = 0;
    for (const e of events) for (const n of names) if (e[n] !== '' && e[n] != null) filled++;
    return filled / (events.length * Math.max(1, names.length));
  }

  /** Schema suggestion from a sample (CSV with header line or JSON lines). */
  function infer(text) {
    const t = String(text || '').replace(/^﻿/, '').trim();
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return { error: 'No sample.' };
    let kind, head, rows, delim;
    if (lines[0].trim().startsWith('{')) {
      kind = 'jsonl';
      const objs = lines.slice(0, 200).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const keys = [];
      const walk = (o, p) => { for (const [k, v] of Object.entries(o)) { const q = p ? p + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, q); else if (!keys.includes(q)) keys.push(q); } };
      objs.forEach((o) => walk(o, ''));
      head = keys;
      rows = objs.map((o) => keys.map((k) => { const v = getPath(o, k); return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }));
    } else {
      kind = 'csv';
      delim = detectDelimiter(lines[0]);
      const all = splitCSV(lines.slice(0, 501).join('\n'), delim);
      head = all[0].map((h) => h.trim());
      rows = all.slice(1);
      if (head.length < 2) return { error: 'No columns found. Text logs without columns need a regex pattern (format «regex»).' };
    }
    const used = new Set();
    let timeDone = false;
    const fields = head.map((h, i) => {
      const vals = rows.map((r) => (r[i] == null ? '' : String(r[i]).trim())).filter((v) => v !== '');
      const distinct = new Set(vals).size;
      let type = 'text';
      if (vals.length && vals.filter((v) => normTime(v)).length >= vals.length * 0.8) type = 'time';
      else if (vals.length && vals.every((v) => /^-?[\d']+([.,]\d+)?$/.test(v))) type = 'number';
      else if (vals.length && distinct <= 30 && distinct <= Math.max(3, vals.length * 0.5)) type = 'category';
      let name = type === 'time' && !timeDone ? 'time' : slug(h);
      if (type === 'time' && !timeDone) timeDone = true; else if (type === 'time') type = 'text';
      while (used.has(name) || name === 'no') name += '_';
      used.add(name);
      const longest = vals.reduce((m, v) => Math.max(m, v.length), 0);
      return {
        name, label: h, type, source: h, use: true,
        filter: type === 'category', chart: type === 'category' && distinct > 1 && distinct <= 15,
        table: type !== 'time', sample: vals.slice(0, 3), distinct, length: longest
      };
    });
    if (!timeDone) return { error: 'No column with a date/time found. Without timestamps the events cannot be analysed.', fields, format: { type: kind, delimiter: delim || 'auto' } };
    return { format: { type: kind, delimiter: kind === 'csv' ? 'auto' : undefined }, fields };
  }

  /** Checks a schema. -> [error messages] */
  function validate(s) {
    const err = [];
    if (!s || typeof s !== 'object') return ['Schema is missing.'];
    if (!s.id || !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(s.id)) err.push('id: only lowercase letters, digits, - and _ (max. 41 characters).');
    if (!s.name || !String(s.name).trim()) err.push('name is missing.');
    const kind = (s.format || {}).type;
    if (!['csv', 'regex', 'jsonl'].includes(kind)) err.push('format.type must be csv, regex or jsonl.');
    if (kind === 'regex') { try { new RegExp(s.format.pattern, s.format.flags || ''); } catch (e) { err.push('format.pattern: ' + e.message); } }
    const f = s.fields || [];
    if (!f.length) err.push('At least one field is required.');
    const names = new Set();
    for (const x of f) {
      if (!x.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)) err.push(`Field name «${x.name}»: only letters, digits and _ (must not start with a digit).`);
      if (x.name === 'no') err.push('Field name «no» is reserved.');
      if (names.has(x.name)) err.push(`Field name «${x.name}» is used twice.`);
      names.add(x.name);
      if (!TYPES.includes(x.type)) err.push(`Field «${x.name}»: type must be ${TYPES.join(', ')}.`);
    }
    const t = f.filter((x) => x.type === 'time');
    if (!f.some((x) => x.name === 'time' && x.type === 'time')) err.push('A field «time» of type time is required.');
    if (t.length > 1) err.push('Only one field of type time is allowed (add further timestamps as text).');
    for (const [i, r] of (s.rules || []).entries()) {
      if (r.pattern) { try { new RegExp(r.pattern, r.flags == null ? 'i' : r.flags); } catch (e) { err.push(`rules[${i}].pattern: ${e.message}`); } }
      for (const k of Object.keys(r.set || {})) if (!names.has(k)) err.push(`rules[${i}] sets unknown field «${k}».`);
    }
    for (const [k, a] of Object.entries(s.mappings || {})) {
      if (!names.has(k)) err.push(`mappings: unknown field «${k}».`);
      for (const w of a.values || []) { try { new RegExp(w.pattern); } catch (e) { err.push(`mappings.${k}: ${e.message}`); } }
    }
    if (s.state) {
      const st = s.state;
      if (!names.has(st.field)) err.push(`state.field «${st.field}» is not a field.`);
      if (!(st.down || []).length || !(st.up || []).length) err.push('state needs values for down and up.');
      for (const k of st.keys || []) if (!names.has(k)) err.push(`state.keys: unknown field «${k}».`);
      if (!(st.keys || []).length) err.push('state.keys: at least one field that identifies the object.');
      for (const k of ['group', 'related']) if (st[k] && !names.has(st[k])) err.push(`state.${k}: unknown field «${st[k]}».`);
    }
    return err;
  }

  /** Key and display name of an event's object (for timeline and outages). */
  function objectKey(e, st) { return st.keys.map((k) => e[k]).join('|'); }
  function objectName(e, st) { return st.label ? value(st.label, null, e) : st.keys.map((k) => e[k]).filter((v) => v !== '').join(' · '); }

  const api = { TYPES, slug, normTime, detectDelimiter, splitCSV, toCSV, parse, detect, infer, validate, columns, objectKey, objectName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Schema = api;
})(typeof window !== 'undefined' ? window : globalThis);
