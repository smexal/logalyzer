/*
 * Logalyzer – charts (plain SVG, no libraries)
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const A = root.Analyze;

  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, str, attrs) {
    const t = svgEl('text', Object.assign({ x, y }, attrs || {}), parent);
    t.textContent = str;
    return t;
  }
  function measure(svg, labels, cls) {
    const g = svgEl('g', {}, svg);
    let m = 0;
    for (const l of labels) { const t = text(g, 0, 0, l, { class: cls || '' }); m = Math.max(m, t.getComputedTextLength() || l.length * 7); }
    g.remove();
    return m;
  }
  function makeSvg(container, h, label) {
    container.replaceChildren();
    const w = Math.max(260, container.clientWidth);
    const svg = svgEl('svg', { width: '100%', height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': label }, container);
    return { svg, w };
  }
  function empty(container, msg) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = msg;
    container.replaceChildren(p);
  }

  // ---------- Tooltip ----------
  function tooltip(container) {
    const t = document.createElement('div');
    t.className = 'tip';
    t.hidden = true;
    container.appendChild(t);
    return {
      show(ev, lines) {
        t.replaceChildren(...lines.filter(Boolean).map((l, i) => { const d = document.createElement('div'); d.textContent = l; d.className = i ? 'tip-sub' : 'tip-head'; return d; }));
        t.hidden = false;
        const r = container.getBoundingClientRect();
        let x = ev.clientX - r.left + 14;
        const y = ev.clientY - r.top + 14;
        if (x + t.offsetWidth > container.clientWidth) x = Math.max(0, ev.clientX - r.left - t.offsetWidth - 14);
        t.style.left = x + 'px';
        t.style.top = y + 'px';
      },
      hide() { t.hidden = true; }
    };
  }
  function hover(node, tip, lines) {
    node.addEventListener('pointermove', (ev) => tip.show(ev, typeof lines === 'function' ? lines() : lines));
    node.addEventListener('pointerleave', () => tip.hide());
  }

  // ---------- Scales ----------
  const linear = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / ((d1 - d0) || 1)) * (r1 - r0);
  function niceMax(v) {
    if (v <= 5) return Math.max(1, Math.ceil(v));
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= v) return s * p;
    return 10 * p;
  }
  function intTicks(max, n) {
    const raw = Math.max(1, max / n);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * p).find((s) => s >= raw && Number.isInteger(s)) || 10 * p;
    const out = [];
    for (let v = 0; v <= max; v += step) out.push(v);
    return out;
  }

  const MIN = 60000, H = 60 * MIN, D = 24 * H;
  const STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D];
  const p2 = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayLabel = (n) => n.getDate() + ' ' + MON[n.getMonth()];
  function timeTicks(t0, t1, maxCount) {
    const spanMs = t1 - t0;
    const step = STEPS.find((s) => spanMs / s <= maxCount) || STEPS[STEPS.length - 1];
    const d = new Date(t0);
    if (step >= D) d.setHours(0, 0, 0, 0);
    else if (step >= H) d.setHours(Math.floor(d.getHours() / (step / H)) * (step / H), 0, 0, 0);
    else d.setMinutes(Math.floor(d.getMinutes() / (step / MIN)) * (step / MIN), 0, 0);
    const out = [];
    let t = d.getTime();
    while (t <= t1) {
      if (t >= t0) out.push(t);
      if (step >= D) { const n = new Date(t); n.setDate(n.getDate() + step / D); t = n.getTime(); } else t += step;
    }
    const fmt = spanMs > 3 * D
      ? (x) => dayLabel(new Date(x))
      : spanMs > D
        ? (x) => { const n = new Date(x); return n.getHours() === 0 && n.getMinutes() === 0 ? dayLabel(n) : p2(n.getHours()) + ':' + p2(n.getMinutes()); }
        : (x) => { const n = new Date(x); return p2(n.getHours()) + ':' + p2(n.getMinutes()); };
    return { ticks: out, fmt };
  }

  const COLOR = { down: 'var(--bad)', up: 'var(--ok)', other: 'var(--warn)' };
  const SC = root.Schema;

  // ---------- Timeline ----------
  // One row per object (state.keys). Only for schemas with a state.
  // opts: { events, outages, schema, textField, from, to (Date|null), onRange(fromDate, toDate), onPick(objectName),
  //         decorate(objectName, event) -> display name (e.g. with notes; onPick still gets the original name) }
  function timeline(container, opts) {
    const { events, outages, schema } = opts;
    const st = schema.state;
    if (!events.length && !outages.length) return empty(container, 'No events for this selection.');
    const times = events.map((e) => A.toDate(e.time).getTime());
    outages.forEach((a) => { times.push(A.toDate(a.start).getTime()); if (a.end) times.push(A.toDate(a.end).getTime()); });
    let t0 = opts.from ? opts.from.getTime() : Math.min(...times);
    let t1 = opts.to ? opts.to.getTime() : Math.max(...times);
    if (!opts.from || !opts.to) {
      const pad = Math.max(5 * MIN, (t1 - t0) * 0.02);
      if (!opts.from) t0 -= pad;
      if (!opts.to) t1 += pad;
    }
    if (t1 <= t0) t1 = t0 + H;

    // Rows: key -> { name, display, group }
    const info = new Map();
    const add = (key, e) => {
      if (info.has(key)) return;
      const name = SC.objectName(e, st);
      info.set(key, { name, display: opts.decorate ? opts.decorate(name, e) : name, group: st.group ? String(e[st.group]) : '' });
    };
    events.forEach((e) => add(SC.objectKey(e, st), e));
    outages.forEach((a) => add(a.key, a.event));
    const cmp = (a, b) => a.localeCompare(b, 'en', { numeric: true });
    const lanes = [...info.keys()].sort((a, b) => cmp(info.get(a).group, info.get(b).group) || cmp(info.get(a).name, info.get(b).name));
    const nameOf = (k) => info.get(k).name;
    const displayOf = (k) => info.get(k).display;

    const rowH = 22, mt = 4, mb = 26;
    const h = mt + lanes.length * rowH + mb;
    const { svg, w } = makeSvg(container, h, `Timeline with ${lanes.length} objects`);
    const narrow = w < 560;
    const label = (k) => { const o = displayOf(k); const max = narrow ? 20 : 48; return o.length > max ? o.slice(0, max - 1) + '…' : o; };
    const ml = Math.min(w * 0.42, measure(svg, lanes.map(label), 'lane') + 14);
    const mr = 10;
    const x = linear(t0, t1, ml, w - mr);
    const laneIdx = new Map(lanes.map((k, i) => [k, i]));
    const y = (k) => mt + laneIdx.get(k) * rowH;
    const plotBottom = mt + lanes.length * rowH;
    const tip = tooltip(container);

    lanes.forEach((k, i) => {
      if (i % 2 === 0) svgEl('rect', { x: ml, y: y(k), width: w - mr - ml, height: rowH, class: 'stripe' }, svg);
      const t = text(svg, ml - 8, y(k) + rowH / 2, label(k), { class: 'lane clickable', 'text-anchor': 'end', dy: '0.35em' });
      t.addEventListener('click', () => opts.onPick && opts.onPick(nameOf(k)));
      hover(t, tip, [displayOf(k), info.get(k).group, 'Click: filter the event log']);
    });

    const { ticks, fmt } = timeTicks(t0, t1, Math.max(2, Math.floor((w - ml) / 80)));
    for (const tk of ticks) {
      svgEl('line', { x1: x(tk), x2: x(tk), y1: mt, y2: plotBottom, class: 'grid' }, svg);
      text(svg, x(tk), plotBottom + 16, fmt(tk), { class: 'tick', 'text-anchor': 'middle' });
    }
    svgEl('line', { x1: ml, x2: w - mr, y1: plotBottom, y2: plotBottom, class: 'axis' }, svg);

    const clip = 'clip' + Math.random().toString(36).slice(2);
    const cp = svgEl('clipPath', { id: clip }, svgEl('defs', {}, svg));
    svgEl('rect', { x: ml, y: 0, width: w - mr - ml, height: h }, cp);
    const plot = svgEl('g', { 'clip-path': `url(#${clip})` }, svg);

    const msgField = opts.textField;
    for (const a of outages) {
      const xa = x(A.toDate(a.start).getTime());
      const xb = a.end ? x(A.toDate(a.end).getTime()) : w - mr;
      const r = svgEl('rect', {
        x: Math.max(ml - 2, xa), y: y(a.key) + 4, width: Math.max(3, xb - Math.max(ml - 2, xa)), height: rowH - 8, rx: 2,
        class: 'outage' + (a.end ? '' : ' open')
      }, plot);
      hover(r, tip, [displayOf(a.key), 'Down ' + A.fmtTime(a.start), a.end ? 'Back ' + A.fmtTime(a.end) : 'No recovery in the log', 'Duration: ' + A.fmtDuration(a.duration_min), a.repeated ? 'Outage reported more than once' : '']);
    }
    for (const e of events) {
      const k = SC.objectKey(e, st);
      const c = svgEl('circle', { cx: x(A.toDate(e.time).getTime()), cy: y(k) + rowH / 2, r: 3.5, class: 'dot', style: `fill:${COLOR[A.classify(e, schema)]}` }, plot);
      hover(c, tip, [displayOf(k), A.fmtTime(e.time) + ' · ' + e[st.field], msgField ? String(e[msgField]) : '']);
    }

    // Zoom: drag in the chart
    const brush = svgEl('rect', { class: 'brush', y: mt, height: plotBottom - mt, x: 0, width: 0, visibility: 'hidden' }, svg);
    let start = null;
    const toX = (ev) => { const r = svg.getBoundingClientRect(); return (ev.clientX - r.left) * (w / r.width); };
    svg.addEventListener('pointerdown', (ev) => {
      const px = toX(ev);
      if (px < ml || ev.button !== 0) return;
      start = px;
      svg.setPointerCapture(ev.pointerId);
      brush.setAttribute('visibility', 'visible');
      brush.setAttribute('x', px); brush.setAttribute('width', 0);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (start == null) return;
      const px = Math.min(w - mr, Math.max(ml, toX(ev)));
      brush.setAttribute('x', Math.min(start, px)); brush.setAttribute('width', Math.abs(px - start));
    });
    svg.addEventListener('pointerup', (ev) => {
      if (start == null) return;
      const px = Math.min(w - mr, Math.max(ml, toX(ev)));
      const a = Math.min(start, px), b = Math.max(start, px);
      start = null;
      brush.setAttribute('visibility', 'hidden');
      if (b - a < 6) return;
      const inv = (px2) => t0 + ((px2 - ml) / (w - mr - ml)) * (t1 - t0);
      opts.onRange && opts.onRange(new Date(inv(a)), new Date(inv(b)));
    });
  }

  // ---------- Stacked columns per day ----------
  // rows: [{ day, down, up, other, total }]; labels: { down, up, other } or null (not stacked)
  function days(container, rows, onPick, labels) {
    if (!rows.length) return empty(container, 'No data.');
    const h = 220, mt = 18, mb = 26, mr = 4;
    const { svg, w } = makeSvg(container, h, 'Entries per day');
    const max = niceMax(Math.max(...rows.map((r) => r.total)));
    const ticks = intTicks(max, 4);
    const ml = measure(svg, ticks.map(String), 'tick') + 10;
    const y = linear(0, max, h - mb, mt);
    const bw = (w - ml - mr) / rows.length;
    const tip = tooltip(container);
    for (const v of ticks) { svgEl('line', { x1: ml, x2: w - mr, y1: y(v), y2: y(v), class: 'grid' }, svg); text(svg, ml - 6, y(v), String(v), { class: 'tick', 'text-anchor': 'end', dy: '0.35em' }); }
    const every = Math.ceil(rows.length / Math.max(1, Math.floor((w - ml) / 46)));
    rows.forEach((r, i) => {
      const x0 = ml + i * bw + bw * 0.12, bwi = bw * 0.76;
      let acc = 0;
      if (labels) {
        for (const k of ['down', 'other', 'up']) {
          if (!r[k]) continue;
          svgEl('rect', { x: x0, width: bwi, y: y(acc + r[k]), height: y(acc) - y(acc + r[k]), style: `fill:${COLOR[k]}` }, svg);
          acc += r[k];
        }
      } else if (r.total) {
        svgEl('rect', { x: x0, width: bwi, y: y(r.total), height: y(0) - y(r.total), class: 'bar' }, svg);
      }
      if (r.total && bwi > 12) text(svg, x0 + bwi / 2, y(r.total) - 4, String(r.total), { class: 'tick', 'text-anchor': 'middle' });
      if (i % every === 0) text(svg, x0 + bwi / 2, h - mb + 16, dayLabel(new Date(+r.day.slice(0, 4), +r.day.slice(5, 7) - 1, +r.day.slice(8, 10))), { class: 'tick', 'text-anchor': 'middle' });
      const hit = svgEl('rect', { x: ml + i * bw, width: bw, y: mt, height: h - mb - mt, class: 'hit' + (r.total ? ' clickable' : '') }, svg);
      hover(hit, tip, [weekday(r.day), r.total + ' entries', labels ? `${r.down} ${labels.down} · ${r.up} ${labels.up} · ${r.other} ${labels.other}` : '', r.total ? 'Click: show this day' : '']);
      if (r.total) hit.addEventListener('click', () => onPick(r.day));
    });
    svgEl('line', { x1: ml, x2: w - mr, y1: h - mb, y2: h - mb, class: 'axis' }, svg);
  }
  function weekday(day) {
    const d = new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + A.fmtDay(day);
  }

  // ---------- Horizontal bars: most frequent values of a field ----------
  // rows: [{ value, count, minutes?, open?, objects? }]  (minutes set = outages per value)
  // decorate(value) -> display text (e.g. with a note); onPick still gets the original value
  function bars(container, rows, onPick, fieldLabel, decorate) {
    const disp = (r) => (decorate ? decorate(r.value) : r.value);
    if (!rows.length) return empty(container, 'No values in this selection.');
    const rowH = 24, mt = 2;
    const h = mt + rows.length * rowH + 4;
    const { svg, w } = makeSvg(container, h, 'Most frequent values of ' + fieldLabel);
    const outs = rows[0].minutes != null;
    const end = (r) => (outs ? `${r.count}× · ${A.fmtDuration(r.minutes)}${r.open ? ' · ' + r.open + ' open' : ''}` : String(r.count));
    const narrow = w < 420;
    const lab = (s) => (s.length > (narrow ? 16 : 28) ? s.slice(0, narrow ? 15 : 27) + '…' : s);
    const ml = Math.min(w * 0.45, measure(svg, rows.map((r) => lab(disp(r))), 'lane') + 10);
    const mr = Math.min(w * 0.5, measure(svg, rows.map(end), 'tick') + 10);
    const max = Math.max(...rows.map((r) => r.count));
    const x = linear(0, max, ml, w - mr);
    const tip = tooltip(container);
    rows.forEach((r, i) => {
      const yy = mt + i * rowH;
      const g = svgEl('g', { class: 'clickable' }, svg);
      svgEl('rect', { x: 0, y: yy, width: w, height: rowH, class: 'hit' }, g);
      text(g, ml - 8, yy + rowH / 2, lab(disp(r)), { class: 'lane', 'text-anchor': 'end', dy: '0.35em' });
      svgEl('rect', { x: ml, y: yy + 4, height: rowH - 8, width: Math.max(2, x(r.count) - ml), rx: 2, class: r.open ? 'bar bar-bad' : 'bar' }, g);
      text(g, x(r.count) + 6, yy + rowH / 2, end(r), { class: 'tick', dy: '0.35em' });
      hover(g, tip, outs
        ? [fieldLabel + ': ' + disp(r), `${r.count} outages on ${r.objects} object(s)`, 'Downtime: ' + A.fmtDuration(r.minutes), r.open ? r.open + ' still open' : '', 'Click: filter by it']
        : [fieldLabel + ': ' + disp(r), r.count + ' entries', 'Click: filter by it']);
      g.addEventListener('click', () => onPick(r.value));
    });
  }

  // ---------- Columns per hour ----------
  // rows: [{ hour, count }]
  function hours(container, rows, what) {
    const total = rows.reduce((s, r) => s + r.count, 0);
    if (!total) return empty(container, `No ${what} in this selection.`);
    const h = 190, mt = 14, mb = 26, mr = 4;
    const { svg, w } = makeSvg(container, h, what + ' per hour of the day');
    const max = niceMax(Math.max(...rows.map((r) => r.count)));
    const ticks = intTicks(max, 3);
    const ml = measure(svg, ticks.map(String), 'tick') + 10;
    const y = linear(0, max, h - mb, mt);
    const bw = (w - ml - mr) / 24;
    const tip = tooltip(container);
    for (const v of ticks) { svgEl('line', { x1: ml, x2: w - mr, y1: y(v), y2: y(v), class: 'grid' }, svg); text(svg, ml - 6, y(v), String(v), { class: 'tick', 'text-anchor': 'end', dy: '0.35em' }); }
    rows.forEach((r, i) => {
      const x0 = ml + i * bw + bw * 0.1;
      if (r.count) svgEl('rect', { x: x0, width: bw * 0.8, y: y(r.count), height: y(0) - y(r.count), class: 'bar' }, svg);
      if (i % (w < 420 ? 6 : 3) === 0) text(svg, x0 + bw * 0.4, h - mb + 16, p2(i) + ':00', { class: 'tick', 'text-anchor': 'middle' });
      const hit = svgEl('rect', { x: ml + i * bw, width: bw, y: mt, height: h - mb - mt, class: 'hit' }, svg);
      hover(hit, tip, [p2(i) + ':00–' + p2(i) + ':59', r.count + ' ' + what]);
    });
    svgEl('line', { x1: ml, x2: w - mr, y1: h - mb, y2: h - mb, class: 'axis' }, svg);
  }

  root.Charts = { timeline, days, bars, hours };
})(window);
