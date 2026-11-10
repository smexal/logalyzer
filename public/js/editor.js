/*
 * Logalyzer – create and edit log types
 * Paste a sample -> detect columns -> choose and type fields -> assign state -> preview -> save.
 * The preview runs in the browser with the same engine (shared/schema.js) as the server.
 */
(function () {
  'use strict';
  const SC = window.Schema, A = window.Analyze;
  const $ = (s) => document.querySelector(s);
  const app = () => window.App;

  const TYPE_LABEL = { time: 'Time', text: 'Text', category: 'Category', number: 'Number' };
  let ED = null;      // working copy
  let dirty = false;
  let idTouched = false;

  function blank() {
    return {
      orig: null, name: '', id: '', description: '', sampleFile: '',
      kind: 'csv', delim: 'auto', pattern: '', flags: '',
      rows: [],
      st: { on: false, field: '', group: '', related: '', values: {}, keys: [], label: '' },
      adv: '', sample: ''
    };
  }

  function fromSchema(s) {
    const e = blank();
    e.orig = s.id; e.name = s.name || ''; e.id = s.id; e.description = s.description || '';
    const f = s.format || {};
    e.kind = f.type || 'csv'; e.delim = f.delimiter || 'auto'; e.pattern = f.pattern || ''; e.flags = f.flags || '';
    e.rows = (s.fields || []).map((x) => ({ use: true, source: x.source || '', name: x.name, label: x.label || '', type: x.type, format: x.format || '', filter: !!x.filter, chart: !!x.chart, table: !!x.table }));
    if (s.state) {
      const st = s.state, values = {};
      st.down.forEach((v) => { values[v] = 'down'; });
      st.up.forEach((v) => { values[v] = 'up'; });
      e.st = { on: true, field: st.field, group: st.group || '', related: st.related || '', values, keys: (st.keys || []).slice(), label: typeof st.label === 'string' ? st.label : '' };
    }
    const adv = {};
    if (s.rules && s.rules.length) adv.rules = s.rules;
    if (s.mappings && Object.keys(s.mappings).length) adv.mappings = s.mappings;
    e.adv = Object.keys(adv).length ? JSON.stringify(adv, null, 2) : '';
    return e;
  }

  /** Schema from the form. -> { schema, errors: [] } */
  function build() {
    const errors = [];
    const fields = ED.rows.filter((r) => r.use && r.name).map((r) => {
      const f = { name: r.name, label: r.label || r.name, type: r.type };
      if (r.source) f.source = r.source;
      if (r.type === 'time' && r.format) f.format = r.format;
      if (r.filter) f.filter = true;
      if (r.chart) f.chart = true;
      if (r.table) f.table = true;
      return f;
    });
    const format = { type: ED.kind };
    if (ED.kind === 'csv') format.delimiter = ED.delim;
    if (ED.kind === 'regex') { format.pattern = ED.pattern; if (ED.flags) format.flags = ED.flags; }
    const s = { id: ED.id, name: ED.name, format, fields };
    if (ED.description) s.description = ED.description;
    if (ED.adv.trim()) {
      try {
        const a = JSON.parse(ED.adv);
        if (a.rules) s.rules = a.rules;
        if (a.mappings) s.mappings = a.mappings;
      } catch (e) { errors.push('Rules (JSON): ' + e.message); }
    }
    if (ED.st.on) {
      const down = Object.keys(ED.st.values).filter((k) => ED.st.values[k] === 'down');
      const up = Object.keys(ED.st.values).filter((k) => ED.st.values[k] === 'up');
      s.state = { field: ED.st.field, down, up, keys: ED.st.keys.filter((k) => fields.some((f) => f.name === k)) };
      if (ED.st.label.trim()) s.state.label = ED.st.label.trim();
      if (ED.st.group) s.state.group = ED.st.group;
      if (ED.st.related) s.state.related = ED.st.related;
    }
    return { schema: s, errors };
  }

  // ---------- Open ----------
  function open(id) {
    renderList(id);
    const s = app().types.find((t) => t.id === id);
    if (ED && ((s && ED.orig === s.id) || (!s && !ED.orig && id === 'new'))) { renderAll(); return; }
    ED = s ? fromSchema(s) : blank();
    idTouched = !!s;
    dirty = false;
    renderAll();
    if (s) loadStoredSample(s);
  }
  async function loadStoredSample(s) {
    // Preview with the stored data of this type if no sample has been pasted
    try {
      const d = await app().api('GET', `/api/t/${encodeURIComponent(s.id)}/events?limit=200`);
      if (ED.orig !== s.id || ED.sample) return;
      if (d.events.length) {
        ED.sample = SC.toCSV(d.events, SC.columns(s)).replace(/^﻿/, '');
        $('#ed-sample').value = ED.sample;
        $('#ed-sample').placeholder = '';
        preview();
        updatePrompt();
      }
    } catch (e) { /* preview stays empty */ }
  }

  function renderList(active) {
    const ul = $('#ed-types');
    ul.replaceChildren(...app().types.map((t) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = t.id === active ? 'active' : '';
      const n = document.createElement('span'); n.textContent = t.name;
      const c = document.createElement('span'); c.className = 'count'; c.textContent = t.count;
      b.append(n, c);
      b.addEventListener('click', () => { if (confirmLeave()) location.hash = '#/types/' + t.id; });
      li.appendChild(b);
      return li;
    }));
  }
  function confirmLeave() { return !dirty || confirm('Discard unsaved changes?'); }

  // ---------- Render ----------
  function renderAll() {
    $('#ed-title').textContent = ED.orig ? `Edit log type «${ED.name}»` : 'New log type';
    $('#ed-name').value = ED.name;
    $('#ed-id').value = ED.id;
    $('#ed-id').readOnly = !!ED.orig;
    $('#ed-description').value = ED.description;
    $('#ed-sample').value = ED.sample;
    $('#ed-sample').placeholder = ED.orig ? 'Paste sample lines to see the preview.' : 'Timestamp;Host;Service;State\n10.11.2026 08:00;web01;HTTP;OK\n…';
    $('#ed-kind').value = ED.kind;
    $('#ed-delim').value = ED.delim;
    $('#ed-pattern').value = ED.pattern;
    $('#ed-json').value = ED.adv;
    $('#ed-st-on').checked = ED.st.on;
    $('#ed-delete').hidden = !ED.orig;
    $('#ed-claude').open = !ED.orig;
    $('#ed-reply').value = '';
    $('#ed-reply-info').textContent = '';
    syncFormat();
    updatePrompt();
    renderRows();
    preview();
  }
  function syncFormat() {
    $('#ed-delim-f').hidden = ED.kind !== 'csv';
    $('#ed-pattern-f').hidden = ED.kind !== 'regex';
  }

  function renderRows() {
    const tb = $('#ed-fields tbody');
    tb.replaceChildren(...ED.rows.map((r, i) => {
      const tr = document.createElement('tr');
      if (!r.use) tr.className = 'off';
      const td = (child, cls) => { const d = document.createElement('td'); if (cls) d.className = cls; if (child) d.appendChild(child); tr.appendChild(d); return d; };
      const chk = (prop, title) => { const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!r[prop]; c.title = title; c.addEventListener('change', () => { r[prop] = c.checked; changed(prop === 'use'); }); return c; };
      const inp = (prop, ph) => { const c = document.createElement('input'); c.type = 'text'; c.value = r[prop] || ''; c.placeholder = ph || ''; c.spellcheck = false; c.addEventListener('input', () => { r[prop] = c.value; changed(prop === 'name'); }); return c; };
      td(chk('use', 'Use column'), 'center');
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = r.source || '(rule)';
      if (r.sample && r.sample.length) { const sm = document.createElement('small'); sm.textContent = r.sample.join(' · '); sm.title = sm.textContent; src.appendChild(sm); }
      const srcTd = td(src);
      if (!r.source || ED.kind === 'jsonl') { srcTd.replaceChildren(inp('source', ED.kind === 'jsonl' ? 'path.to.field' : 'empty = rule')); }
      td(inp('name'));
      td(inp('label'));
      const sel = document.createElement('select');
      for (const t of SC.TYPES) sel.appendChild(new Option(TYPE_LABEL[t], t));
      sel.value = r.type;
      sel.addEventListener('change', () => {
        if (sel.value === 'time') ED.rows.forEach((o) => { if (o !== r && o.type === 'time') { o.type = 'text'; if (o.name === 'time') o.name = 'time_2'; } });
        r.type = sel.value;
        if (r.type === 'time') r.name = 'time';
        renderRows();
        changed(true);
      });
      td(sel);
      const fmt = inp('format', 'automatic');
      fmt.title = 'Empty = automatic. Otherwise e.g. DD.MM.YYYY HH:mm, MM/DD/YYYY, DD/MMM/YYYY:HH:mm:ss';
      fmt.hidden = r.type !== 'time';
      td(fmt);
      td(chk('filter', 'Offer as filter'), 'center');
      td(chk('chart', 'Chart of the most frequent values'), 'center');
      td(chk('table', 'Show in the table'), 'center');
      const tools = document.createElement('span');
      for (const [sym, title, fn] of [['↑', 'Move up', () => move(i, -1)], ['↓', 'Move down', () => move(i, 1)], ['✕', 'Remove', () => { ED.rows.splice(i, 1); renderRows(); changed(true); }]]) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'icon-btn'; b.textContent = sym; b.title = title; b.addEventListener('click', fn); tools.appendChild(b);
      }
      td(tools, 'nw');
      return tr;
    }));
    renderStateSelects();
  }
  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= ED.rows.length) return;
    [ED.rows[i], ED.rows[j]] = [ED.rows[j], ED.rows[i]];
    renderRows();
    changed();
  }

  function usedNames() { return ED.rows.filter((r) => r.use && r.name).map((r) => r.name); }
  function renderStateSelects() {
    $('#ed-st').hidden = !ED.st.on;
    const names = usedNames().filter((n) => n !== 'time');
    const lbl = (n) => { const r = ED.rows.find((x) => x.name === n); return r && r.label ? `${r.label} (${n})` : n; };
    const fill = (sel, val, none) => {
      sel.replaceChildren(...(none ? [new Option(none, '')] : []), ...names.map((n) => new Option(lbl(n), n)));
      sel.value = names.includes(val) ? val : none ? '' : names[0] || '';
      return sel.value;
    };
    ED.st.field = fill($('#ed-st-field'), ED.st.field);
    ED.st.group = fill($('#ed-st-group'), ED.st.group, '– none –');
    ED.st.related = fill($('#ed-st-related'), ED.st.related, '– none –');
    const box = $('#ed-st-keys');
    box.replaceChildren(...names.map((n) => {
      const l = document.createElement('label');
      l.className = 'check value-chip';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = ED.st.keys.includes(n);
      c.addEventListener('change', () => {
        ED.st.keys = c.checked ? ED.st.keys.concat([n]) : ED.st.keys.filter((k) => k !== n);
        changed();
      });
      l.append(c, lbl(n));
      return l;
    }));
    $('#ed-st-label').value = ED.st.label;
  }

  /** Down/up assignment from the values in the preview plus values already assigned. */
  function renderValues(events) {
    const box = $('#ed-st-values');
    if (!ED.st.on) { box.replaceChildren(); return; }
    const count = new Map();
    for (const e of events) { const v = String(e[ED.st.field] == null ? '' : e[ED.st.field]); if (v) count.set(v, (count.get(v) || 0) + 1); }
    for (const v of Object.keys(ED.st.values)) if (!count.has(v)) count.set(v, 0);
    const list = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    if (!list.length) { box.textContent = 'No values in the preview. Paste a sample.'; return; }
    box.replaceChildren(...list.map(([v, n]) => {
      const w = document.createElement('span');
      w.className = 'value-chip ' + (ED.st.values[v] || '');
      const t = document.createElement('span'); t.textContent = `${v}${n ? ' (' + n + ')' : ''}`;
      const sel = document.createElement('select');
      sel.append(new Option('–', ''), new Option('Outage (down)', 'down'), new Option('Back (up)', 'up'));
      sel.value = ED.st.values[v] || '';
      sel.addEventListener('change', () => { if (sel.value) ED.st.values[v] = sel.value; else delete ED.st.values[v]; w.className = 'value-chip ' + sel.value; changed(); });
      w.append(t, sel);
      return w;
    }));
  }

  // ---------- Preview ----------
  let pt;
  function changed(structural) {
    dirty = true;
    if (structural) renderStateSelects();
    clearTimeout(pt);
    pt = setTimeout(() => { preview(); updatePrompt(); }, 200);
  }

  // ---------- Set up with Claude ----------
  function updatePrompt() {
    const p = window.Prompts.logTypePrompt({
      sample: ED.sample, name: ED.name, description: ED.description,
      existingIds: app().types.map((t) => t.id).filter((id) => id !== ED.orig)
    });
    $('#ed-prompt').value = p;
    $('#ed-prompt-info').textContent = ED.sample.trim() ? `${p.length.toLocaleString('en-US')} characters, with sample` : 'No sample yet – paste it under 1., then it is added to the prompt';
  }
  function applyReply() {
    const info = $('#ed-reply-info');
    const r = window.Prompts.schemaFromReply($('#ed-reply').value);
    if (r.error) { info.textContent = r.error; return; }
    const s = r.schema;
    const orig = ED.orig, sample = ED.sample, file = ED.sampleFile;
    if (orig) s.id = orig;
    else {
      s.id = SC.slug(s.id || s.name || ED.name).replace(/^f_/, '').slice(0, 40);
      if (app().types.some((t) => t.id === s.id)) s.id += '_2';
    }
    if (ED.rows.length && !confirm('Replace fields, format and rules with the schema from the reply?')) return;
    ED = fromSchema(s);
    ED.orig = orig;
    ED.sample = sample; ED.sampleFile = file;
    if (!ED.name) ED.name = $('#ed-name').value;
    idTouched = true;
    renderAll();
    $('#ed-claude').open = true;
    dirty = true;
    const errs = SC.validate(build().schema);
    info.textContent = `Applied: ${ED.rows.length} fields${s.state ? ', with state' : ''}${s.rules && s.rules.length ? `, ${s.rules.length} rules` : ''}.` + (errs.length ? ` Still to fix: ${errs[0]}` : ' Check the preview below, then save.');
  }
  function preview() {
    const { schema, errors } = build();
    const errs = errors.concat(SC.validate(schema));
    const stat = $('#ed-stat');
    let res = { events: [], skipped: [] };
    if (ED.sample.trim()) {
      try {
        // Preview even with an incomplete state: parse without it
        const probe = Object.assign({}, schema); delete probe.state;
        if (!SC.validate(probe).length) res = SC.parse(ED.sample, probe, { limit: 500 });
      } catch (e) { errs.push(e.message); }
      if (res.error) errs.push(res.error);
    }
    const ul = $('#ed-errors');
    ul.replaceChildren(...errs.map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
    if (res.skipped.length) {
      const li = document.createElement('li');
      li.textContent = `${res.skipped.length} sample lines skipped, e.g. line ${res.skipped[0].line} (${res.skipped[0].reason}): «${res.skipped[0].text.slice(0, 100)}»`;
      ul.appendChild(li);
    }
    stat.textContent = ED.sample.trim() ? `${res.events.length} entries recognised${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}${schema.state && !errs.length ? ` · ${A.outages(res.events, schema).length} outages` : ''}` : 'No sample';
    renderValues(res.events);
    const cols = SC.columns(schema).filter((c) => c !== 'no');
    const tr0 = document.createElement('tr');
    for (const c of cols) { const th = document.createElement('th'); th.textContent = c; tr0.appendChild(th); }
    $('#ed-preview thead').replaceChildren(tr0);
    $('#ed-preview tbody').replaceChildren(...res.events.slice(0, 30).map((e) => {
      const tr = document.createElement('tr');
      for (const c of cols) { const td = document.createElement('td'); td.textContent = e[c]; td.className = String(e[c]).length > 40 ? 'msg' : 'nw'; tr.appendChild(td); }
      return tr;
    }));
    const ok = !errs.length;
    $('#ed-save').disabled = !ok;
    $('#ed-save-import').disabled = !ok || !res.events.length;
  }

  // ---------- Detect columns ----------
  function infer() {
    const txt = ED.sample;
    if (!txt.trim()) { app().toast('Paste sample lines first.'); return; }
    if (ED.kind === 'regex') return inferRegex();
    const r = SC.infer(txt);
    if (r.error && !r.fields) { app().toast(r.error); return; }
    if (r.error) app().toast(r.error);
    if (ED.rows.length && !confirm('Replace the existing fields with the detected columns?')) return;
    ED.kind = r.format.type;
    ED.delim = r.format.delimiter || 'auto';
    ED.rows = r.fields.map((f) => ({ use: true, source: f.source, name: f.name, label: f.label, type: f.type, format: '', filter: f.filter, chart: f.chart, table: f.table, sample: f.sample }));
    // Suggest a state: category field with typical values
    const cand = r.fields.find((f) => f.type === 'category' && /state|status|zustand/i.test(f.label + ' ' + f.name));
    if (cand && !ED.st.field) ED.st.field = cand.name;
    renderAll();
    changed(true);
  }
  function inferRegex() {
    let re;
    try { re = new RegExp(ED.pattern, ED.flags); } catch (e) { app().toast('Invalid pattern: ' + e.message); return; }
    const groups = [...ED.pattern.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]);
    if (!groups.length) { app().toast('The pattern needs named groups, e.g. (?<time>…) and (?<message>…).'); return; }
    const lines = ED.sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 300);
    const vals = Object.fromEntries(groups.map((g) => [g, []]));
    let hits = 0;
    for (const l of lines) { const m = l.match(re); if (!m) continue; hits++; for (const g of groups) if (m.groups[g] != null) vals[g].push(m.groups[g].trim()); }
    const keep = ED.rows.filter((r) => !r.source && !groups.includes(r.name));
    ED.rows = groups.map((g) => {
      const v = vals[g].filter(Boolean);
      const old = ED.rows.find((r) => r.name === g || r.source === g);
      if (old) return Object.assign(old, { source: old.source && groups.includes(old.source) ? old.source : '', sample: v.slice(0, 3) });
      const distinct = new Set(v).size;
      let type = 'text';
      if (v.length && v.filter((x) => SC.normTime(x)).length >= v.length * 0.8) type = 'time';
      else if (v.length && v.every((x) => /^-?[\d']+([.,]\d+)?$/.test(x))) type = 'number';
      else if (v.length && distinct <= 30 && distinct <= Math.max(3, v.length * 0.5)) type = 'category';
      return { use: true, source: '', name: type === 'time' ? 'time' : SC.slug(g), label: g, type, format: '', filter: type === 'category', chart: type === 'category' && distinct > 1 && distinct <= 15, table: type !== 'time', sample: v.slice(0, 3) };
    }).concat(keep);
    // In regex format the source is the group name = field name if empty
    ED.rows.forEach((r) => { if (groups.includes(r.name) && !r.source) r.source = ''; else if (!r.source && groups.includes(r.label)) r.source = r.label; });
    app().toast(`${hits} of ${lines.length} lines match the pattern, ${groups.length} groups.`);
    renderRows();
    changed(true);
  }

  // ---------- Save / delete ----------
  async function save(withImport) {
    const { schema, errors } = build();
    const errs = errors.concat(SC.validate(schema));
    if (errs.length) { app().toast(errs[0]); return; }
    if (!ED.orig && app().types.some((t) => t.id === schema.id)) { app().toast(`The ID «${schema.id}» is already taken.`); return; }
    try { await app().api('PUT', `/api/types/${encodeURIComponent(schema.id)}`, schema); } catch (e) { app().toast(e.message); return; }
    dirty = false;
    ED.orig = schema.id;
    await app().reloadTypes();
    renderList(schema.id);
    $('#ed-title').textContent = `Edit log type «${schema.name}»`;
    $('#ed-id').readOnly = true;
    $('#ed-delete').hidden = false;
    if (withImport) {
      if (await app().importInto(schema.id, ED.sample, ED.sampleFile || 'Sample from the editor')) location.hash = '#/t/' + schema.id;
    } else {
      app().toast(`Log type «${schema.name}» saved. Stored entries stay as they were read; new fields or rules apply to future imports.`);
      history.replaceState(null, '', '#/types/' + schema.id);
    }
  }
  async function remove() {
    const t = app().types.find((x) => x.id === ED.orig);
    if (!t) return;
    if (!confirm(`Delete log type «${t.name}» and all ${t.count} entries? This cannot be undone.`)) return;
    try { await app().api('DELETE', `/api/types/${encodeURIComponent(t.id)}`); } catch (e) { app().toast(e.message); return; }
    dirty = false;
    ED = null;
    await app().reloadTypes();
    app().toast(`Log type «${t.name}» deleted.`);
    location.hash = '#/types/' + (app().types[0] ? app().types[0].id : 'new');
  }

  async function dropFile(f) {
    if (!f) return;
    ED.sample = await f.text();
    ED.sampleFile = f.name;
    $('#ed-sample').value = ED.sample;
    if (!ED.name) { ED.name = f.name.replace(/\.[^.]+$/, '').replace(/[-_]\d{4}.*$/, ''); $('#ed-name').value = ED.name; autoId(); }
    if (!ED.rows.length) infer(); else changed();
  }
  function autoId() {
    if (ED.orig || idTouched) return;
    ED.id = SC.slug(ED.name).replace(/^f_/, '').slice(0, 40);
    $('#ed-id').value = ED.id;
  }

  // ---------- Wiring ----------
  function wire() {
    $('#ed-new').addEventListener('click', () => { if (!confirmLeave()) return; ED = null; location.hash = '#/types/new'; if (location.hash === '#/types/new') open('new'); });
    $('#ed-back').addEventListener('click', () => { if (confirmLeave()) { dirty = false; location.hash = '#/t/' + (ED && ED.orig ? ED.orig : app().type); } });
    $('#ed-name').addEventListener('input', (e) => { ED.name = e.target.value; autoId(); changed(); });
    $('#ed-id').addEventListener('input', (e) => { ED.id = e.target.value.trim(); idTouched = true; changed(); });
    $('#ed-description').addEventListener('input', (e) => { ED.description = e.target.value; changed(); });
    $('#ed-sample').addEventListener('input', (e) => { ED.sample = e.target.value; changed(); });
    $('#ed-file').addEventListener('change', (e) => { dropFile(e.target.files[0]); e.target.value = ''; });
    $('#ed-infer').addEventListener('click', infer);
    $('#ed-kind').addEventListener('change', (e) => { ED.kind = e.target.value; syncFormat(); renderRows(); changed(); });
    $('#ed-delim').addEventListener('change', (e) => { ED.delim = e.target.value; changed(); });
    $('#ed-pattern').addEventListener('input', (e) => { ED.pattern = e.target.value; changed(); });
    $('#ed-json').addEventListener('input', (e) => { ED.adv = e.target.value; changed(); });
    $('#ed-field-new').addEventListener('click', () => {
      let n = 'field', i = 1;
      while (ED.rows.some((r) => r.name === n)) n = 'field_' + ++i;
      ED.rows.push({ use: true, source: '', name: n, label: '', type: 'text', format: '', filter: false, chart: false, table: true });
      renderRows();
      changed(true);
    });
    $('#ed-st-on').addEventListener('change', (e) => { ED.st.on = e.target.checked; renderStateSelects(); changed(); });
    $('#ed-st-field').addEventListener('change', (e) => { ED.st.field = e.target.value; ED.st.values = {}; changed(); });
    $('#ed-st-group').addEventListener('change', (e) => { ED.st.group = e.target.value; changed(); });
    $('#ed-st-related').addEventListener('change', (e) => { ED.st.related = e.target.value; changed(); });
    $('#ed-st-label').addEventListener('input', (e) => { ED.st.label = e.target.value; changed(); });
    $('#ed-save').addEventListener('click', () => save(false));
    $('#ed-save-import').addEventListener('click', () => save(true));
    $('#ed-delete').addEventListener('click', remove);
    $('#ed-prompt-copy').addEventListener('click', () => app().copy($('#ed-prompt'), 'Prompt copied – now send it to Claude.'));
    $('#ed-reply-ok').addEventListener('click', applyReply);
    window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  wire();
  /** For navigation away from the editor (e.g. the home link): asks about unsaved changes. */
  function canLeave() {
    if ($('#editor').hidden || !confirmLeave()) return $('#editor').hidden;
    dirty = false;
    return true;
  }
  window.Editor = { open: (id) => open(id || 'new'), dropFile, canLeave };
})();
