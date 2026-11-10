/*
 * Logalyzer – UI: analysis of one log type
 * Everything that is shown (filters, metrics, charts, columns) follows the schema.
 */
(function () {
  'use strict';
  const SC = window.Schema, A = window.Analyze, C = window.Charts, Pr = window.Prompts;
  const $ = (s) => document.querySelector(s);
  const LAST = 'logalyzer.type';

  const S = {
    types: [],
    type: '',
    schema: null,
    events: [],
    sources: [],
    outages: [],
    findings: [],
    read: [],
    notes: [],
    findingsTab: 'open',
    filter: emptyFilter(),
    lanes: 'outage',
    logStatus: '',
    sort: { key: 'resolution', asc: true }
  };
  function emptyFilter() { return { from: '', to: '', q: '', fields: {} }; }

  // ---------- Backend ----------
  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw new Error('Server not reachable. Is the server running (docker compose up or npm start)?'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Error ${r.status}`); e.data = data; throw e; }
    return data;
  }
  const enc = encodeURIComponent;

  async function loadTypes() {
    S.types = await api('GET', '/api/types');
    const sel = $('#type');
    sel.replaceChildren(...S.types.map((t) => new Option(`${t.name} (${t.count})`, t.id)));
    fillImportTypes();
  }
  function fillImportTypes() {
    const sel = $('#imp-type');
    const cur = sel.value;
    sel.replaceChildren(new Option('Detect automatically', ''), ...S.types.map((t) => new Option(t.name, t.id)));
    sel.value = cur && S.types.some((t) => t.id === cur) ? cur : '';
  }

  async function selectType(id, keepFilter) {
    if (!S.types.length) { S.type = ''; S.schema = null; S.events = []; render(); return; }
    if (!S.types.some((t) => t.id === id)) id = S.types[0].id;
    S.type = id;
    S.schema = S.types.find((t) => t.id === id);
    $('#type').value = id;
    try { localStorage.setItem(LAST, id); } catch (e) { /* not important */ }
    if (location.hash !== '#/t/' + id && !location.hash.startsWith('#/types')) history.replaceState(null, '', '#/t/' + id);
    const d = await api('GET', `/api/t/${enc(id)}/data`);
    S.events = d.events || [];
    S.sources = d.sources || [];
    S.read = await api('GET', `/api/t/${enc(id)}/read`).catch(() => []);
    setNotes(await api('GET', `/api/t/${enc(id)}/notes`).catch(() => []));
    recompute();
    if (!keepFilter) { S.filter = emptyFilter(); S.logStatus = ''; S.sort = { key: 'resolution', asc: true }; }
    render();
  }
  function recompute() {
    S.outages = A.outages(S.events, S.schema);
    S.findings = A.findings(S.events, S.outages, S.schema);
  }
  async function refreshCounts() {
    const cur = S.type;
    await loadTypes();
    $('#type').value = cur;
  }

  // ---------- Import ----------
  async function importText(text, name, type) {
    let r;
    try {
      r = type ? await api('POST', `/api/t/${enc(type)}/import`, { text, name })
        : await api('POST', '/api/import', { text, name });
    } catch (e) {
      const k = e.data && e.data.candidates;
      toast(e.message + (k && k.length ? ` Best match: ${k[0].name} (${Math.round(k[0].share * 100)} %).` : ''));
      return false;
    }
    await refreshCounts();
    await selectType(r.type);
    const t = S.types.find((x) => x.id === r.type);
    const skip = r.skipped.length ? `, ${r.skipped.length} lines skipped` : '';
    toast(`${t ? t.name + ': ' : ''}` + (!r.added
      ? `No new entries – all ${r.dupes} are already stored${skip}.`
      : `${r.added} new entries stored${r.dupes ? `, ${r.dupes} duplicates skipped` : ''}${skip}.`));
    return true;
  }

  // ---------- Filter ----------
  const filteredEvents = () => A.filterEvents(S.events, S.filter, S.schema);
  const filteredOutages = () => A.filterOutages(S.outages, S.filter);
  function resetFilter(doRender) {
    S.filter = emptyFilter();
    S.logStatus = '';
    if (doRender !== false) render();
  }
  const isoLocal = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const field = (name) => (S.schema.fields || []).find((f) => f.name === name) || { name, label: name };
  const label = (name) => field(name).label || name;
  /** Click on a value: as a field filter if the field is filterable, otherwise as a search. */
  function pickValue(name, v) {
    if (field(name).filter) S.filter.fields[name] = v; else S.filter.q = v;
    render();
    scrollTo('#tbl-log');
  }

  // ---------- Notes on values ----------
  // Only for display: the events stay unchanged, analysis/search/export use the original values.
  let NOTES = new Map();
  const noteKey = (f, v) => f + '\u001f' + v;
  function setNotes(list) {
    S.notes = list || [];
    NOTES = new Map(S.notes.map((n) => [noteKey(n.field, n.value), n.note]));
  }
  const noteOf = (f, v) => (v === '' || v == null ? '' : NOTES.get(noteKey(f, String(v))) || '');
  /** Value with its note in brackets, as plain text. */
  const withNote = (f, v) => { const n = noteOf(f, v); return n ? `${v} (${n})` : String(v); };
  /** Notes of the fields that identify an object (state.keys). */
  function objectNotes(e) {
    const st = S.schema.state;
    return st ? st.keys.map((k) => noteOf(k, e[k])).filter(Boolean).join(', ') : '';
  }
  const objectLabel = (name, e) => { const n = objectNotes(e); return n ? `${name} (${n})` : name; };
  /** Text node(s): value plus the note in brackets. */
  function noted(text, note) {
    const s = document.createElement('span');
    s.append(String(text));
    if (note) { const a = document.createElement('span'); a.className = 'annot'; a.textContent = ` (${note})`; s.appendChild(a); }
    return s;
  }
  function noteButton(e, fields) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'note-btn'; b.textContent = '✎';
    const has = fields.some((f) => noteOf(f, e[f]));
    b.title = has ? 'Edit note' : 'Add note';
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); openNote(e, fields); });
    return b;
  }

  let noteCtx = null;
  function openNote(e, fields) {
    fields = fields.filter((f) => f !== 'time' && e[f] !== '' && e[f] != null);
    if (!fields.length) return;
    noteCtx = { e, fields };
    fillSelect($('#note-field'), null, fields.map((f) => [f, label(f)]), fields.find((f) => noteOf(f, e[f])) || fields[0]);
    $('#note-field-f').hidden = fields.length < 2;
    syncNoteDialog();
    $('#dlg-note').showModal();
    $('#note-text').focus();
  }
  function syncNoteDialog() {
    const f = $('#note-field').value, v = String(noteCtx.e[f]);
    $('#note-value').textContent = v;
    $('#note-text').value = noteOf(f, v);
    $('#note-remove').hidden = !noteOf(f, v);
  }
  async function saveNote(remove) {
    const field = $('#note-field').value, value = String(noteCtx.e[field]);
    const note = remove ? '' : $('#note-text').value.trim();
    try { setNotes(await api('PUT', `/api/t/${enc(S.type)}/notes`, { field, value, note })); } catch (e) { toast(e.message); return; }
    $('#dlg-note').close();
    render();
    toast(note ? 'Note saved.' : 'Note removed.');
  }

  function renderNotes() {
    $('#notes-count').textContent = S.notes.length ? `${S.notes.length} note${S.notes.length === 1 ? '' : 's'}` : 'none yet';
    const ul = $('#notes-list');
    if (!S.notes.length) {
      const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No notes yet. Use ✎ next to a value in the tables.';
      ul.replaceChildren(li);
      return;
    }
    ul.replaceChildren(...S.notes.map((n) => {
      const li = document.createElement('li');
      const f = document.createElement('span'); f.className = 'n-field'; f.textContent = label(n.field);
      const m = document.createElement('span'); m.className = 'n-main'; m.appendChild(noted(n.value, n.note));
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn ghost'; edit.textContent = 'Edit';
      edit.addEventListener('click', () => openNote({ [n.field]: n.value }, [n.field]));
      li.append(f, m, edit);
      return li;
    }));
  }

  // ---------- Render ----------
  function render() {
    const sc = S.schema;
    const has = !!sc && S.events.length > 0;
    $('#welcome').hidden = has;
    $('#content').hidden = !has;
    $('#sources-info').textContent = has ? `${S.events.length} entries · ${S.sources.map((s) => s.name).join(', ') || 'stored data'}` : '';
    $('#exp-outages').hidden = !(sc && sc.state);
    if (!sc) {
      $('#w-title').textContent = 'No log type yet';
      $('#w-text').textContent = 'Create a log type under «Log types»: paste a sample, choose the columns, save.';
      return;
    }
    if (!has) {
      $('#w-title').textContent = `${sc.name}: no data yet`;
      $('#w-text').textContent = (sc.description ? sc.description + ' ' : '') + 'Import a log of this type (paste text or drag a file into the window).';
      return;
    }

    const ev = filteredEvents();
    const outs = filteredOutages();
    syncControls();
    renderInfo(ev);
    renderKpis(ev, outs);
    renderFindings();
    const st = sc.state;
    $('#timeline-card').hidden = !st;
    $('#outages-card').hidden = !st;
    if (st) renderTimeline(ev, outs);
    renderCharts(ev, outs);
    if (st) renderOutageTable(outs);
    renderLog(ev);
    renderNotes();
  }

  function syncControls() {
    const f = S.filter, sc = S.schema;
    $('#f-from').value = f.from;
    $('#f-to').value = f.to;
    // Field filters
    const box = $('#f-fields');
    box.replaceChildren(...(sc.fields || []).filter((x) => x.filter).map((x) => {
      const d = document.createElement('div');
      d.className = 'field';
      const l = document.createElement('label');
      l.textContent = x.label || x.name;
      l.htmlFor = 'ff-' + x.name;
      const sel = document.createElement('select');
      sel.id = 'ff-' + x.name;
      const values = [...new Set(S.events.map((e) => e[x.name]).filter((v) => v !== '' && v != null).map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      fillSelect(sel, 'All', values.slice(0, 500).map((v) => [v, withNote(x.name, v)]), f.fields[x.name]);
      sel.addEventListener('change', () => { if (sel.value) S.filter.fields[x.name] = sel.value; else delete S.filter.fields[x.name]; render(); });
      d.append(l, sel);
      return d;
    }));
    if (document.activeElement !== $('#f-search')) $('#f-search').value = f.q;
    // Day selection
    const days = A.perDay(S.events, sc).filter((d) => d.total);
    const dayVal = f.from && f.to && f.from.endsWith('T00:00') && f.to.endsWith('T23:59') && f.from.slice(0, 10) === f.to.slice(0, 10) ? f.from.slice(0, 10) : (f.from || f.to ? '_' : '');
    const opts = days.map((d) => [d.day, A.fmtDay(d.day) + ' · ' + d.total + ' entries']);
    if (dayVal === '_') opts.unshift(['_', 'Custom range']);
    fillSelect($('#tl-day'), 'Whole range', opts, dayVal);
    $('#tl-rows').value = S.lanes;
    // State filter in the log
    const ls = $('#log-status');
    ls.hidden = !sc.state;
    if (sc.state) {
      const values = [...new Set(S.events.map((e) => String(e[sc.state.field])))].filter(Boolean).sort();
      fillSelect(ls, 'All ' + label(sc.state.field), values.map((v) => [v, v]), S.logStatus);
    }
  }
  function fillSelect(sel, allLabel, opts, value) {
    sel.replaceChildren(...(allLabel != null ? [new Option(allLabel, '')] : []), ...opts.map(([v, l]) => new Option(l, v)));
    sel.value = value || '';
  }

  function renderInfo(ev) {
    const f = S.filter, parts = [];
    if (f.from || f.to) parts.push(`Range ${f.from ? A.fmtTime(f.from) + ' ' + f.from.slice(0, 4) : 'start'} to ${f.to ? A.fmtTime(f.to) + ' ' + f.to.slice(0, 4) : 'end'}`);
    for (const [k, v] of Object.entries(f.fields)) parts.push(`${label(k)} ${withNote(k, v)}`);
    if (f.q) parts.push(`Search «${f.q}»`);
    $('#filterinfo').textContent = parts.length ? `Filtered: ${parts.join(' · ')} → ${ev.length} of ${S.events.length} entries` : '';
    $('#f-reset').hidden = !parts.length && !S.logStatus;
  }

  function renderKpis(ev, outs) {
    const sc = S.schema;
    const k = A.metrics(ev, outs, sc);
    const tiles = [['Entries', k.events, `${A.fmtTime(k.first)} to ${A.fmtTime(k.last)}`]];
    if (sc.state) {
      tiles.push(
        ['Outages', k.outages, `${k.objects} objects in the log`],
        ['Still open', k.open, 'no recovery in the log', k.open ? 'bad' : ''],
        ['Short interruptions', k.short, 'at most 1 minute'],
        ['Downtime', A.fmtDuration(k.downtime_min), 'sum of resolved outages'],
        ['Longest outage', k.longest ? A.fmtDuration(k.longest.duration_min) : '–', k.longest ? k.longest.object : 'no resolved outage']);
    }
    for (const [name, z] of Object.entries(k.numbers)) tiles.push(['Ø ' + label(name), A.fmtNumber(z.mean), `min ${A.fmtNumber(z.min)} · max ${A.fmtNumber(z.max)}`]);
    for (const [name, n] of Object.entries(k.categories)) {
      if (tiles.length >= 8 || !field(name).filter) continue;
      tiles.push([label(name), n, 'distinct values']);
    }
    $('#kpis').replaceChildren(...tiles.map(([l, v, n, cls]) => {
      const d = document.createElement('div');
      d.className = 'kpi';
      d.innerHTML = '<div class="lbl"></div><div class="val"></div><div class="note"></div>';
      d.children[0].textContent = l;
      d.children[1].textContent = v;
      if (cls) d.children[1].classList.add(cls);
      d.children[2].textContent = n;
      return d;
    }));
  }

  function renderFindings() {
    const read = new Set(S.read.map((g) => g.k));
    const open = S.findings.filter((b) => !read.has(b.k));
    $('#fd-tab-open').textContent = `Open (${open.length})`;
    $('#fd-tab-read').textContent = `Read (${S.read.length})`;
    for (const [tab, id] of [['open', '#findings'], ['read', '#findings-read']]) {
      $('#fd-tab-' + tab).setAttribute('aria-selected', String(S.findingsTab === tab));
      $(id).hidden = S.findingsTab !== tab;
    }
    $('#fd-hint').textContent = S.findingsTab === 'open'
      ? 'Detected automatically. Click a finding to zoom and filter the view, ✓ marks it as read.'
      : 'Findings marked as read. «Show again» moves one back to the open ones.';
    renderRead();
    const ol = $('#findings');
    if (!open.length) {
      const li = document.createElement('li'); li.className = 'none';
      li.textContent = S.findings.length ? 'All findings have been read.' : 'Nothing unusual detected.';
      ol.replaceChildren(li);
      return;
    }
    ol.replaceChildren(...open.map((b) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'finding ' + b.sev;
      for (const [cls, t] of [['b-tag', b.tag], ['b-title', b.title], ['b-text', b.text]]) {
        const d = document.createElement('div'); d.className = cls; d.textContent = t; btn.appendChild(d);
      }
      btn.addEventListener('click', () => {
        const f = b.focus || {};
        S.filter = { from: f.from || '', to: f.to || '', q: f.q || '', fields: {} };
        S.logStatus = f.status || '';
        render();
        scrollTo(S.schema.state ? '#timeline-card' : '#tbl-log');
      });
      btn._full = b.title + '\n\n' + b.text;
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'finding-ok'; ok.textContent = '✓';
      ok.title = 'Mark as read'; ok.setAttribute('aria-label', 'Mark as read: ' + b.title);
      ok.addEventListener('click', () => markRead(b));
      li.append(btn, ok);
      return li;
    }));
    findingTooltips();
  }

  function renderRead() {
    const ol = $('#findings-read');
    if (!S.read.length) {
      const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No findings marked as read yet.';
      ol.replaceChildren(li);
      return;
    }
    const current = new Set(S.findings.map((b) => b.k));
    ol.replaceChildren(...S.read.map((g) => {
      const li = document.createElement('li'); li.className = g.sev;
      const main = document.createElement('div'); main.className = 'g-main';
      const t = document.createElement('div'); t.className = 'g-title'; t.textContent = g.title;
      main.title = g.title + '\n\n' + g.text;
      const meta = document.createElement('div'); meta.className = 'g-meta';
      const tag = document.createElement('span'); tag.className = 'b-tag'; tag.textContent = g.tag;
      meta.append(tag, 'read on ' + new Date(g.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }));
      if (!current.has(g.k)) { const old = document.createElement('span'); old.className = 'g-alt'; old.textContent = ' · no longer applies'; meta.append(old); }
      main.append(t, meta);
      const back = document.createElement('button');
      back.type = 'button'; back.className = 'btn ghost'; back.textContent = 'Show again';
      back.addEventListener('click', () => unmarkRead(g));
      li.append(main, back);
      return li;
    }));
  }

  async function markRead(b) {
    try {
      const g = await api('POST', `/api/t/${enc(S.type)}/read`, { k: b.k, sev: b.sev, tag: b.tag, title: b.title, text: b.text });
      S.read = [g].concat(S.read.filter((x) => x.k !== g.k));
      renderFindings();
      toast('Finding marked as read.');
    } catch (e) { toast(e.message); }
  }
  async function unmarkRead(g) {
    try {
      await api('DELETE', `/api/t/${enc(S.type)}/read/${enc(g.k)}`);
    } catch (e) { if (!/not marked as read/.test(e.message)) { toast(e.message); return; } }
    S.read = S.read.filter((x) => x.k !== g.k);
    renderFindings();
  }

  // Truncated findings show the full text as a tooltip; re-check when the width changes.
  function findingTooltips() {
    for (const btn of document.querySelectorAll('#findings .finding')) {
      const truncated = [...btn.querySelectorAll('.b-title, .b-text')].some((d) => d.scrollHeight > d.clientHeight + 1);
      if (truncated) btn.title = btn._full; else btn.removeAttribute('title');
    }
  }
  if (window.ResizeObserver) new ResizeObserver(findingTooltips).observe($('#findings'));

  /** First text field that serves as the message in tooltips. */
  function textField() {
    const f = (S.schema.fields || []).filter((x) => x.type === 'text' && x.table);
    return (f.find((x) => /message|msg|text|meldung/i.test(x.name)) || f[f.length - 1] || {}).name;
  }

  function renderTimeline(ev, outs) {
    const st = S.schema.state;
    let events = ev, shown = outs;
    if (S.lanes === 'outage') {
      const keep = new Set(outs.map((a) => a.key).concat(ev.filter((e) => A.classify(e, S.schema) === 'other').map((e) => SC.objectKey(e, st))));
      events = ev.filter((e) => keep.has(SC.objectKey(e, st)));
      shown = outs.filter((a) => keep.has(a.key));
    }
    C.timeline($('#ch-timeline'), {
      events, outages: shown, schema: S.schema, textField: textField(), decorate: objectLabel,
      from: S.filter.from ? A.toDate(S.filter.from) : null,
      to: S.filter.to ? A.toDate(S.filter.to) : null,
      onRange: (a, b) => { S.filter.from = isoLocal(a); S.filter.to = isoLocal(b); render(); },
      onPick: (o) => { S.filter.q = o; render(); scrollTo('#tbl-log'); }
    });
    const leg = [['sw-out', 'Outage'], ['sw-bad', st.down.join(' / ')], ['sw-ok', st.up.join(' / ')], ['sw-warn', 'other']];
    $('#tl-legend').replaceChildren(...leg.map(([c, t]) => { const s = document.createElement('span'); const i = document.createElement('i'); i.className = 'sw ' + c; s.append(i, t); return s; }));
  }

  function card(title, hint) {
    const sec = document.createElement('section');
    sec.className = 'card';
    sec.innerHTML = '<div class="card-head"><h2></h2></div><p class="hint"></p><div class="chart"></div>';
    sec.querySelector('h2').textContent = title;
    sec.querySelector('.hint').textContent = hint;
    return sec;
  }
  function renderCharts(ev, outs) {
    const sc = S.schema, st = sc.state;
    const box = $('#charts');
    const cards = [];
    const perDay = card('Entries per day', 'Click a day to zoom there.');
    cards.push([perDay, (el) => C.days(el, A.perDay(ev, sc), (day) => zoomDay(day), st ? { down: st.down.join('/'), up: st.up.join('/'), other: 'other' } : null)]);
    for (const f of (sc.fields || []).filter((x) => x.chart)) {
      const t = card(st ? `Outages per ${f.label || f.name}` : `Most frequent ${f.label || f.name}`, st ? 'At the end of the bar: count and downtime. Click to filter.' : 'Number of entries per value. Click to filter.');
      cards.push([t, (el) => C.bars(el, A.topValues(ev, outs, sc, f.name, 15), (v) => pickValue(f.name, v), f.label || f.name, (v) => withNote(f.name, v))]);
    }
    const what = st ? st.down.join('/') : 'entries';
    const hrs = card(`${st ? 'Outages' : 'Entries'} by time of day`, 'All days of the selection added up.');
    cards.push([hrs, (el) => C.hours(el, A.perHour(ev, sc), what)]);
    box.replaceChildren(...cards.map(([c]) => c));
    for (const [c, draw] of cards) draw(c.querySelector('.chart'));
  }

  function pill(text, cls) {
    const s = document.createElement('span'); s.className = 'pill ' + cls; s.textContent = text; return s;
  }
  const CLS = { down: 'bad', up: 'ok', other: 'warn' };

  function renderOutageTable(outs) {
    const st = S.schema.state;
    $('#outages-hint').textContent = `From «${st.down.join('/')}» to the next «${st.up.join('/')}» of the same object. Click a row to zoom there.`;
    const cols = [['object', 'Object']];
    if (st.group) cols.push(['group', label(st.group)]);
    cols.push(['start', 'Down'], ['end', 'Back'], ['duration_min', 'Duration'], ['resolution', 'State']);
    const thead = $('#tbl-outages thead');
    const tr0 = document.createElement('tr');
    for (const [k, l] of cols) {
      const th = document.createElement('th');
      th.textContent = l; th.dataset.sort = k;
      if (k === 'duration_min') th.className = 'num';
      th.classList.toggle('sorted', S.sort.key === k);
      th.classList.toggle('asc', S.sort.key === k && S.sort.asc);
      th.addEventListener('click', () => { S.sort = { key: k, asc: S.sort.key === k ? !S.sort.asc : k !== 'duration_min' }; render(); });
      tr0.appendChild(th);
    }
    thead.replaceChildren(tr0);
    const { key, asc } = S.sort;
    const val = (a) => (key === 'resolution' ? (a.resolution === 'open' ? 0 : 1) : key === 'duration_min' ? (a.duration_min == null ? Infinity : a.duration_min) : key === 'group' ? String(a.event[st.group]) : a[key] || '');
    const rows = outs.slice().sort((x, y) => {
      const a = val(x), b = val(y);
      const c = a < b ? -1 : a > b ? 1 : (y.duration_min || 0) - (x.duration_min || 0);
      return asc ? c : -c;
    });
    const tb = $('#tbl-outages tbody');
    if (!rows.length) { tb.replaceChildren(emptyRow(cols.length, 'No outages for this selection.')); return; }
    tb.replaceChildren(...rows.map((a) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.title = 'Click to zoom to this outage';
      const oc = cell(tr, noted(a.object, objectNotes(a.event)), 'nw');
      oc.appendChild(noteButton(a.event, st.keys));
      if (st.group) cell(tr, noted(String(a.event[st.group]), noteOf(st.group, a.event[st.group])), 'nw');
      cell(tr, A.fmtTime(a.start), 'nw');
      cell(tr, a.end ? A.fmtTime(a.end) : '–', 'nw');
      cell(tr, A.fmtDuration(a.duration_min), 'num nw');
      const zc = cell(tr, pill(a.resolution, a.resolution === 'open' ? 'bad' : 'ok'), 'nw');
      if (a.repeated) { zc.append(' '); zc.appendChild(pill('repeated', 'warn')); }
      tr.addEventListener('click', () => {
        const pad = Math.max(30, Math.round((a.duration_min || 60) * 0.15));
        S.filter.from = A.addMinutes(a.start, -pad);
        S.filter.to = A.addMinutes(a.end || a.start, a.end ? pad : 120);
        render();
        scrollTo('#timeline-card');
      });
      return tr;
    }));
  }

  const LOG_MAX = 3000;
  function logColumns() {
    const f = (S.schema.fields || []).filter((x) => x.name !== 'time');
    const t = f.filter((x) => x.table);
    return t.length ? t : f;
  }
  function renderLog(ev) {
    const sc = S.schema, st = sc.state;
    const cols = logColumns();
    const tr0 = document.createElement('tr');
    for (const l of ['Time'].concat(cols.map((c) => c.label || c.name))) { const th = document.createElement('th'); th.textContent = l; tr0.appendChild(th); }
    $('#tbl-log thead').replaceChildren(tr0);
    const rows = ev.filter((e) => !S.logStatus || !st || String(e[st.field]) === S.logStatus).sort((a, b) => b.no - a.no);
    $('#log-count').textContent = `${rows.length} of ${S.events.length} entries` + (rows.length > LOG_MAX ? ` (first ${LOG_MAX} shown)` : '');
    const tb = $('#tbl-log tbody');
    if (!rows.length) { tb.replaceChildren(emptyRow(cols.length + 1, 'No entry matches these filters.')); return; }
    tb.replaceChildren(...rows.slice(0, LOG_MAX).map((e) => {
      const tr = document.createElement('tr');
      cell(tr, A.fmtTime(e.time) + ' ' + e.time.slice(0, 4) + (e.time.length > 16 ? e.time.slice(16) : ''), 'nw');
      for (const c of cols) {
        const v = e[c.name];
        if (st && c.name === st.field) cell(tr, pill(String(v), CLS[A.classify(e, sc)]), 'nw');
        else if (c.type === 'number') cell(tr, v === '' ? '' : A.fmtNumber(v), 'num nw');
        else if (c.type === 'text' && String(v).length > 40) cell(tr, String(v), 'msg');
        else {
          const td = cell(tr, noted(String(v), noteOf(c.name, v)), 'nw');
          if (v !== '' && v != null) td.appendChild(noteButton(e, [c.name]));
        }
      }
      return tr;
    }));
  }
  function cell(tr, content, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    if (content instanceof Node) td.appendChild(content); else td.textContent = content;
    tr.appendChild(td);
    return td;
  }
  function emptyRow(n, msg) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = n; td.className = 'msg'; td.textContent = msg; tr.appendChild(td); return tr;
  }

  function zoomDay(day) {
    S.filter.from = day + 'T00:00';
    S.filter.to = day + 'T23:59';
    render();
    scrollTo(S.schema.state ? '#timeline-card' : '#tbl-log');
  }
  function scrollTo(sel) {
    const el = $(sel);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - $('.topbar').offsetHeight - 10;
    window.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  // ---------- Export (the server builds the CSV) ----------
  function query(f, status) {
    const p = new URLSearchParams();
    for (const k of ['from', 'to', 'q']) if (f[k]) p.set(k, f[k]);
    for (const [k, v] of Object.entries(f.fields || {})) if (v) p.set('f.' + k, v);
    if (status) p.set('status', status);
    const s = p.toString();
    return s ? '?' + s : '';
  }
  function download(url) {
    const a = document.createElement('a');
    a.href = url; a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function doExport(kind) {
    if (!S.events.length) { toast('No data to export.'); return; }
    const base = `/api/t/${enc(S.type)}/export/`;
    if (kind === 'all') download(base + 'events.csv');
    else if (kind === 'events') download(base + 'events.csv' + query(S.filter, S.logStatus));
    else if (kind === 'outages') download(base + 'outages.csv' + query(S.filter));
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // ---------- Import dialog ----------
  function readFiles(files) {
    const list = [...files];
    if (!list.length) return;
    (async () => {
      for (const f of list) {
        let text;
        try { text = await f.text(); } catch (e) { toast(`${f.name} could not be read.`); continue; }
        const type = $('#dlg-import').open ? $('#imp-type').value : '';
        await importText(text, f.name, type);
      }
      if ($('#dlg-import').open) $('#dlg-import').close();
    })();
  }
  function openImport(text) {
    $('#raw').value = text || '';
    $('#imp-claude').open = false;
    fillImportTypes();
    updatePreview();
    $('#dlg-import').showModal();
    $('#raw').focus();
  }
  /** Preview in the browser with the same engine as the server. */
  function updatePreview() {
    const txt = $('#raw').value;
    const out = $('#raw-preview');
    const btn = $('#raw-import');
    setDupInfo(null);
    btn.disabled = true;
    if (!txt.trim()) { out.textContent = ''; claudePrompt($('#imp-type').value || S.type, ''); return; }
    let type = $('#imp-type').value;
    let note = '';
    if (!type) {
      const best = SC.detect(txt, S.types)[0];
      if (!best || best.share < 0.5) {
        out.replaceChildren(warn('No log type fits this text. Choose a log type and let Claude convert the text with the prompt below, or create a new one under «Log types».'));
        claudePrompt(S.type, txt, true);
        return;
      }
      type = best.id;
      note = ` · detected as ${best.name}`;
    }
    const schema = S.types.find((t) => t.id === type);
    const res = SC.parse(txt, schema);
    // Text does not fit (completely): include it in the prompt and expand the prompt
    const fits = !res.error && res.events.length && !res.skipped.length;
    claudePrompt(type, fits ? '' : txt, !res.events.length);
    if (res.error) { out.replaceChildren(warn(res.error)); return; }
    btn.disabled = !res.events.length;
    if (res.events.length) checkDuplicates(txt, type);
    out.replaceChildren();
    const b = document.createElement('b'); b.textContent = `${res.events.length} entries recognised`;
    out.append(b, note);
    if (res.events.length) {
      const t = res.events.map((e) => e.time).sort();
      out.append(` · ${A.fmtTime(t[0])} to ${A.fmtTime(t[t.length - 1])}`);
    }
    if (res.skipped.length) out.append(warn(` · ${res.skipped.length} lines skipped, e.g. line ${res.skipped[0].line} (${res.skipped[0].reason}): «${res.skipped[0].text.slice(0, 80)}»`));
  }
  function warn(t) { const s = document.createElement('span'); s.className = 'warn'; s.textContent = t; return s; }

  // ---------- Prompt for Claude: text -> CSV of the log type ----------
  const valuesCache = new Map(); // type -> known values per category field
  let promptArgs = null;
  function claudePrompt(type, text, expand) {
    const schema = S.types.find((t) => t.id === type) || S.types[0];
    if (!schema) return;
    promptArgs = { type: schema.id, text };
    $('#imp-claude-type').textContent = schema.name;
    if (expand) $('#imp-claude').open = true;
    if (schema.id === S.type) valuesCache.set(schema.id, Pr.knownValues(S.events, schema));
    else if (!valuesCache.has(schema.id)) {
      valuesCache.set(schema.id, {});
      api('GET', `/api/t/${enc(schema.id)}/events?limit=3000`).then((d) => {
        valuesCache.set(schema.id, Pr.knownValues(d.events, schema));
        if (promptArgs && promptArgs.type === schema.id) renderPrompt();
      }).catch(() => {});
    }
    renderPrompt();
  }
  function renderPrompt() {
    const schema = S.types.find((t) => t.id === promptArgs.type);
    const p = Pr.csvPrompt(schema, { values: valuesCache.get(schema.id) || {}, text: promptArgs.text });
    $('#imp-prompt').value = p;
    $('#imp-prompt-info').textContent = `${p.length.toLocaleString('en-US')} characters · ` + (promptArgs.text ? 'with the pasted text' : 'attach the text in Claude or paste it above');
  }
  /** Copies the text of a text field to the clipboard. */
  async function copy(el, msg) {
    try { await navigator.clipboard.writeText(el.value); }
    catch (e) { el.focus(); el.select(); document.execCommand('copy'); }
    toast(msg || 'Copied.');
  }

  /** Asks the server how many entries are already stored (debounced, only the latest request counts). */
  let dupTimer, dupSeq = 0;
  function setDupInfo(node) { $('#raw-dupes').replaceChildren(...(node ? [node] : [])); }
  function checkDuplicates(text, type) {
    clearTimeout(dupTimer);
    const my = ++dupSeq;
    setDupInfo(document.createTextNode('Checking for duplicates …'));
    dupTimer = setTimeout(async () => {
      let r;
      try { r = await api('POST', '/api/check', { text, type }); } catch (e) { if (my === dupSeq) setDupInfo(warn('Duplicate check failed: ' + e.message)); return; }
      if (my !== dupSeq) return;
      const t = S.types.find((x) => x.id === r.type);
      if (!r.new) {
        setDupInfo(warn(`All ${r.existing} entries are already stored in «${t ? t.name : r.type}» – nothing to import.`));
        $('#raw-import').disabled = true;
        return;
      }
      const b = document.createElement('b'); b.textContent = `${r.new} new`;
      const span = document.createElement('span');
      span.append(b, r.existing ? `, ${r.existing} already stored (will be skipped)` : ', no duplicates');
      setDupInfo(span);
    }, 300);
  }

  async function submitImport() {
    const txt = $('#raw').value;
    if (!txt.trim()) { toast('Please paste a log first.'); return; }
    const name = 'Pasted ' + A.fmtTime(isoLocal(new Date()));
    $('#raw-import').disabled = true;
    const ok = await importText(txt, name, $('#imp-type').value);
    if (ok) $('#dlg-import').close(); else $('#raw-import').disabled = false;
  }

  // ---------- Views ----------
  function showView() {
    const ed = location.hash.startsWith('#/types');
    $('#dashboard').hidden = ed;
    $('#editor').hidden = !ed;
    document.body.classList.toggle('editing', ed);
    if (ed) window.Editor && window.Editor.open(decodeURIComponent(location.hash.split('/')[2] || ''));
    else { const m = location.hash.match(/^#\/t\/(.+)$/); if (m && decodeURIComponent(m[1]) !== S.type) selectType(decodeURIComponent(m[1])); else render(); }
  }

  function wire() {
    $('#type').addEventListener('change', (e) => { location.hash = '#/t/' + e.target.value; });
    $('#btn-import').addEventListener('click', () => openImport());
    $('#btn-import2').addEventListener('click', () => { openImport(); $('#imp-type').value = S.type; updatePreview(); });
    $('#btn-types').addEventListener('click', () => { location.hash = '#/types/' + (S.type || ''); });
    $('#btn-types2').addEventListener('click', () => { location.hash = '#/types/' + (S.type || ''); });
    $('#raw').addEventListener('input', updatePreview);
    $('#imp-type').addEventListener('change', updatePreview);
    $('#raw-import').addEventListener('click', () => submitImport());
    $('#imp-prompt-copy').addEventListener('click', () => copy($('#imp-prompt'), 'Prompt copied – send it to Claude and paste the CSV above.'));
    $('#file').addEventListener('change', (e) => { readFiles(e.target.files); e.target.value = ''; });

    const menuBtn = $('#btn-export'), menu = $('#export-menu');
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', () => { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); });
    menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => doExport(b.dataset.export)));

    $('#f-from').addEventListener('change', (e) => { S.filter.from = e.target.value; render(); });
    $('#f-to').addEventListener('change', (e) => { S.filter.to = e.target.value; render(); });
    let qt;
    $('#f-search').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { S.filter.q = e.target.value.trim(); render(); }, 180); });
    $('#f-reset').addEventListener('click', () => resetFilter());
    for (const tab of ['open', 'read']) $('#fd-tab-' + tab).addEventListener('click', () => { S.findingsTab = tab; renderFindings(); });
    $('#tl-day').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === '_') return;
      if (!v) { S.filter.from = ''; S.filter.to = ''; render(); } else zoomDay(v);
    });
    $('#tl-rows').addEventListener('change', (e) => { S.lanes = e.target.value; render(); });
    $('#log-status').addEventListener('change', (e) => { S.logStatus = e.target.value; render(); });
    $('#note-field').addEventListener('change', syncNoteDialog);
    $('#note-save').addEventListener('click', () => saveNote(false));
    $('#note-remove').addEventListener('click', () => saveNote(true));
    $('#note-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveNote(false); } });

    // Drag & drop
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; document.body.classList.add('dropping'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dropping'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
      if (document.body.classList.contains('editing')) { window.Editor && window.Editor.dropFile(e.dataTransfer.files[0]); return; }
      readFiles(e.dataTransfer.files);
    });

    // Paste directly into the window (Ctrl+V outside of input fields)
    document.addEventListener('paste', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (document.body.classList.contains('editing')) return;
      const txt = e.clipboardData && e.clipboardData.getData('text');
      if (!txt || !txt.trim()) return;
      openImport(txt);
    });

    window.addEventListener('hashchange', showView);
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!$('#dashboard').hidden) render(); }, 150); });
  }

  // Interface for the editor
  window.App = {
    api, toast, copy,
    get types() { return S.types; },
    get type() { return S.type; },
    async reloadTypes(selectId) { await loadTypes(); if (selectId !== undefined) S.type = selectId; },
    async importInto(type, text, name) { return importText(text, name, type); },
    selectType
  };

  (async () => {
    wire();
    try {
      await loadTypes();
      let start = '';
      const m = location.hash.match(/^#\/t\/(.+)$/);
      if (m) start = decodeURIComponent(m[1]);
      else { try { start = localStorage.getItem(LAST) || ''; } catch (e) { /* not important */ } }
      await selectType(start);
    } catch (e) { render(); toast(e.message); }
    showView();
  })();
})();
