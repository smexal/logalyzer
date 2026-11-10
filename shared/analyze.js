/*
 * Logalyzer – analysis (schema independent)
 * Outages (down until up per object, if the schema has a "state"), metrics,
 * distributions and automatic findings.
 */
(function (root) {
  'use strict';
  const S = typeof module !== 'undefined' && module.exports ? require('./schema.js') : root.Schema;

  // ---------- Time ----------
  function utcMs(time) {
    const m = time.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  function minutes(a, b) { return Math.round((utcMs(b) - utcMs(a)) / 60000); }
  function toDate(time) {
    const m = time.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  function addMinutes(time, min) { return new Date(utcMs(time) + min * 60000).toISOString().slice(0, 16); }
  const fmtDuration = (m) => {
    if (m == null) return 'open';
    if (m < 1) return 'under 1 minute';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), r = m % 60;
    if (m < 1440) return h + ' h' + (r ? ' ' + r + ' min' : '');
    return Math.floor(m / 1440) + ' d ' + Math.floor((m % 1440) / 60) + ' h' + (r ? ' ' + r + ' min' : '');
  };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "2026-10-30T17:34" -> "30 Oct 17:34" */
  const fmtTime = (t) => (t ? +t.slice(8, 10) + ' ' + MON[+t.slice(5, 7) - 1] + ' ' + t.slice(11, 16) : '');
  /** "2026-10-30" -> "30 Oct 2026" */
  const fmtDay = (d) => (d ? +d.slice(8, 10) + ' ' + MON[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4) : '');

  // ---------- State ----------
  /** Class of an event: 'down' | 'up' | 'other' (always 'other' without a state in the schema). */
  function classify(e, schema) {
    const st = schema && schema.state;
    if (!st) return 'other';
    const v = String(e[st.field]);
    if (st.down.includes(v)) return 'down';
    if (st.up.includes(v)) return 'up';
    return 'other';
  }
  const RANK = { down: 0, other: 1, up: 2 };

  // Chronological; at the same time "down" before "up", because the line order within a minute is not reliable.
  function sortEvents(events, schema) {
    return events.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : (RANK[classify(a, schema)] - RANK[classify(b, schema)]) || (a.no - b.no)));
  }

  function outages(events, schema) {
    const st = schema && schema.state;
    if (!st) return [];
    const open = new Map();
    const out = [];
    for (const e of sortEvents(events, schema)) {
      const c = classify(e, schema);
      if (c === 'other') continue;
      const key = S.objectKey(e, st);
      const run = open.get(key);
      if (c === 'down') {
        if (run) { run.repeated = true; continue; }
        const a = { id: e.no, key, object: S.objectName(e, st), start: e.time, end: '', duration_min: null, resolution: 'open', repeated: false, event: e };
        open.set(key, a);
        out.push(a);
      } else if (run) {
        run.end = e.time;
        run.duration_min = minutes(run.start, e.time);
        run.resolution = 'resolved';
        open.delete(key);
      }
    }
    return out;
  }

  /** Outages as flat rows (for table/CSV): outage columns + fields of the triggering event. */
  function outageRows(outs, schema) {
    const fields = (schema.fields || []).map((f) => f.name).filter((n) => n !== 'time');
    return outs.map((a) => {
      const r = { id: a.id, object: a.object, start: a.start, end: a.end, duration_min: a.duration_min == null ? '' : a.duration_min, resolution: a.resolution, repeated: a.repeated ? 'yes' : 'no' };
      for (const n of fields) if (!(n in r)) r[n] = a.event[n];
      return r;
    });
  }
  function outageColumns(schema) {
    const base = ['id', 'object', 'start', 'end', 'duration_min', 'resolution', 'repeated'];
    return base.concat((schema.fields || []).map((f) => f.name).filter((n) => n !== 'time' && !base.includes(n)));
  }

  // ---------- Metrics ----------
  function metrics(events, outs, schema) {
    const times = events.map((e) => e.time).sort();
    const k = { events: events.length, first: times[0] || '', last: times[times.length - 1] || '', numbers: {}, categories: {} };
    for (const f of schema.fields || []) {
      if (f.type === 'number') {
        const v = events.map((e) => e[f.name]).filter((x) => typeof x === 'number');
        if (v.length) k.numbers[f.name] = { count: v.length, min: Math.min(...v), max: Math.max(...v), mean: v.reduce((s, x) => s + x, 0) / v.length, sum: v.reduce((s, x) => s + x, 0) };
      } else if (f.type === 'category') {
        k.categories[f.name] = new Set(events.map((e) => e[f.name]).filter((x) => x !== '')).size;
      }
    }
    if (schema.state) {
      const resolved = outs.filter((a) => a.resolution === 'resolved');
      Object.assign(k, {
        outages: outs.length,
        open: outs.length - resolved.length,
        short: resolved.filter((a) => a.duration_min <= 1).length,
        downtime_min: resolved.reduce((s, a) => s + a.duration_min, 0),
        longest: resolved.reduce((m, a) => (!m || a.duration_min > m.duration_min ? a : m), null),
        objects: new Set(events.map((e) => S.objectKey(e, schema.state))).size
      });
    }
    return k;
  }

  // ---------- Distributions ----------
  function perDay(events, schema) {
    if (!events.length) return [];
    const days = events.map((e) => e.time.slice(0, 10)).sort();
    const out = [];
    for (let t = Date.parse(days[0] + 'T00:00Z'); t <= Date.parse(days[days.length - 1] + 'T00:00Z'); t += 86400000) {
      out.push({ day: new Date(t).toISOString().slice(0, 10), down: 0, up: 0, other: 0, total: 0 });
    }
    const idx = new Map(out.map((d, i) => [d.day, i]));
    for (const e of events) { const d = out[idx.get(e.time.slice(0, 10))]; d[classify(e, schema)]++; d.total++; }
    return out;
  }
  /** Per hour of the day: the "down" events if there is a state, otherwise all. */
  function perHour(events, schema) {
    const out = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const downOnly = !!(schema && schema.state);
    for (const e of events) if (!downOnly || classify(e, schema) === 'down') out[+e.time.slice(11, 13)].count++;
    return out;
  }
  /**
   * Most frequent values of a field. With a state: outages per value (count, minutes, open), otherwise events per value.
   * -> [{ value, count, minutes?, open?, objects? }]
   */
  function topValues(events, outs, schema, field, max) {
    const m = new Map();
    if (schema.state) {
      for (const a of outs) {
        const v = a.event[field];
        if (v === '' || v == null) continue;
        const r = m.get(v) || { value: String(v), count: 0, minutes: 0, open: 0, objects: new Set() };
        r.count++; r.minutes += a.duration_min || 0; if (a.resolution === 'open') r.open++; r.objects.add(a.key);
        m.set(v, r);
      }
    } else {
      for (const e of events) {
        const v = e[field];
        if (v === '' || v == null) continue;
        const r = m.get(v) || { value: String(v), count: 0 };
        r.count++;
        m.set(v, r);
      }
    }
    return [...m.values()].map((r) => (r.objects ? Object.assign(r, { objects: r.objects.size }) : r))
      .sort((a, b) => b.count - a.count || (b.minutes || 0) - (a.minutes || 0) || a.value.localeCompare(b.value, 'en', { numeric: true }))
      .slice(0, max || 15);
  }

  // ---------- Findings ----------
  const span = (a, padMin) => ({ from: addMinutes(a.start, -padMin), to: addMinutes(a.end || a.start, padMin + (a.end ? 0 : 60)) });
  const lbl = (schema, name) => ((schema.fields || []).find((f) => f.name === name) || {}).label || name;

  function findings(events, outs, schema) {
    const out = [];
    const st = schema.state;
    const sorted = sortEvents(events, schema);
    const last = sorted.length ? sorted[sorted.length - 1].time : '';

    if (st) {
      // Open outages
      for (const a of outs.filter((x) => x.resolution === 'open')) {
        out.push({
          sev: 'bad', tag: 'Open', title: `${a.object} without recovery`,
          text: `«${a.event[st.field]}» on ${fmtTime(a.start)}. ${fmtDuration(last ? minutes(a.start, last) : null)} passed until the last log entry without «${st.up.join('/')}».`,
          focus: { from: addMinutes(a.start, -60), to: last ? addMinutes(last, 30) : addMinutes(a.start, 120), q: a.object }
        });
      }
      // Simultaneous outages (same minute, at least two objects, not only short interruptions)
      const byMin = new Map();
      for (const a of outs) { const k = a.start.slice(0, 16); (byMin.get(k) || byMin.set(k, []).get(k)).push(a); }
      for (const [min, list] of byMin) {
        if (list.length < 2 || list.every((a) => a.duration_min != null && a.duration_min <= 1)) continue;
        const max = list.reduce((m, a) => Math.max(m, a.duration_min == null ? 0 : a.duration_min), 0);
        out.push({
          sev: 'bad', tag: 'Simultaneous', title: `${list.length} objects went down at the same time on ${fmtTime(min)}`,
          text: `${list.map((a) => a.object + ' (' + fmtDuration(a.duration_min) + ')').join(', ')}. A shared point in time suggests a common cause.`,
          focus: { from: addMinutes(min, -30), to: addMinutes(min, Math.max(60, max + 30)) }
        });
      }
      // Other events with the same related value during an outage (e.g. «user does not answer»)
      if (st.related) {
        const hits = new Map();
        for (const e of events) {
          if (classify(e, schema) !== 'other' || e[st.related] === '' || e[st.related] == null) continue;
          const a = outs.find((x) => x.event[st.related] === e[st.related] && x.start <= e.time && (!x.end || x.end >= e.time));
          if (a) (hits.get(a) || hits.set(a, []).get(a)).push(e);
        }
        for (const [a, es] of hits) {
          const what = [...new Set(es.map((e) => e[st.group] || e[st.field]))].join(', ');
          out.push({
            sev: 'bad', tag: 'During outage', title: `${es.length}× ${what} while ${a.object} was down`,
            text: `Between ${fmtTime(a.start)} and ${a.end ? fmtTime(a.end) : 'the end of the log'}, ${es.length} further entries concerned the same ${lbl(schema, st.related)} ${a.event[st.related]} (${es.map((e) => e.time.slice(11, 16)).join(', ')}).`,
            focus: Object.assign(span(a, 30), { q: String(a.event[st.related]) })
          });
        }
      }
      // Long outages
      for (const a of outs.filter((x) => x.duration_min > 60).sort((x, y) => y.duration_min - x.duration_min).slice(0, 3)) {
        out.push({
          sev: a.duration_min > 480 ? 'bad' : 'warn', tag: 'Long outage', title: `${a.object}: ${fmtDuration(a.duration_min)}`,
          text: `From ${fmtTime(a.start)} to ${fmtTime(a.end)}${a.repeated ? '; another outage was reported in between' : ''}.`,
          focus: span(a, Math.max(30, Math.round(a.duration_min * 0.1)))
        });
      }
      // Objects or groups affected repeatedly
      const perObj = new Map();
      for (const a of outs) { const r = perObj.get(a.key) || { a, n: 0, min: 0 }; r.n++; r.min += a.duration_min || 0; perObj.set(a.key, r); }
      for (const r of [...perObj.values()].filter((x) => x.n >= 3).sort((x, y) => y.n - x.n).slice(0, 3)) {
        out.push({
          sev: 'warn', tag: 'Repeated', title: `${r.a.object}: ${r.n} outages`,
          text: `Total downtime ${fmtDuration(r.min)}. Repeated outages of the same object point to a persistent cause.`,
          focus: { q: r.a.object }
        });
      }
      if (st.related) {
        for (const r of topValues(events, outs, schema, st.related, 50).filter((x) => x.count >= 3 && x.objects > 1).slice(0, 3)) {
          out.push({
            sev: 'warn', tag: 'Repeated', title: `${lbl(schema, st.related)} ${r.value}: ${r.count} outages on ${r.objects} objects`,
            text: `Total downtime ${fmtDuration(r.minutes)}${r.open ? ', ' + r.open + ' of them still open' : ''}.`,
            focus: { q: r.value }
          });
        }
      }
      // Short interruptions
      const short = outs.filter((a) => a.duration_min != null && a.duration_min <= 1);
      if (short.length >= 3) {
        out.push({
          sev: 'info', tag: 'Pattern', title: `${short.length} short interruptions of at most 1 minute`,
          text: `Affected: ${[...new Set(short.map((a) => a.object))].slice(0, 8).join(', ')}${short.length > 8 ? ' …' : ''}. Harmless on their own, but frequent ones indicate unstable connections.`,
          focus: { status: st.down[0] }
        });
      }
      // Many recoveries without a preceding outage (restart, or outage before the log starts)
      const orphans = [];
      const seen = new Set();
      for (const e of sorted) {
        const k = S.objectKey(e, st), c = classify(e, schema);
        if (c === 'down') seen.add(k); else if (c === 'up' && !seen.has(k)) orphans.push(e);
      }
      for (let i = 0; i < orphans.length;) {
        let j = i;
        while (j + 1 < orphans.length && minutes(orphans[i].time, orphans[j + 1].time) <= 30) j++;
        const grp = orphans.slice(i, j + 1);
        if (grp.length >= 8) {
          out.push({
            sev: 'info', tag: 'Restart', title: `${grp.length} recoveries from ${fmtTime(grp[0].time)}`,
            text: `Within ${minutes(grp[0].time, grp[grp.length - 1].time)} min objects came back without an outage in the log before. The outage happened before the log starts or was not logged.`,
            focus: { from: addMinutes(grp[0].time, -10), to: addMinutes(grp[grp.length - 1].time, 15) }
          });
        }
        i = j + 1;
      }
    }

    // Unusual days (for every schema)
    const days = perDay(events, schema).filter((d) => d.total);
    if (days.length >= 4) {
      const med = days.map((d) => d.total).sort((a, b) => a - b)[Math.floor(days.length / 2)];
      for (const d of days.filter((x) => x.total >= Math.max(10, med * 3)).sort((a, b) => b.total - a.total).slice(0, 2)) {
        out.push({
          sev: 'warn', tag: 'Spike', title: `${d.total} entries on ${fmtDay(d.day)}`,
          text: `A typical day in this log has ${med} entries. This day is worth a closer look.`,
          focus: { from: d.day + 'T00:00', to: d.day + 'T23:59' }
        });
      }
    }
    // Number fields: outliers
    for (const f of (schema.fields || []).filter((x) => x.type === 'number')) {
      const v = events.filter((e) => typeof e[f.name] === 'number');
      if (v.length < 20) continue;
      const s = v.map((e) => e[f.name]).sort((a, b) => a - b);
      const p95 = s[Math.floor(s.length * 0.95)], med = s[Math.floor(s.length / 2)];
      const high = v.filter((e) => e[f.name] > Math.max(p95, med * 3)).sort((a, b) => b[f.name] - a[f.name]);
      if (high.length && p95 > med * 2) {
        out.push({
          sev: 'info', tag: 'Outlier', title: `${high.length} values of ${f.label || f.name} above ${fmtNumber(Math.max(p95, med * 3))}`,
          text: `Median ${fmtNumber(med)}, highest value ${fmtNumber(high[0][f.name])} on ${fmtTime(high[0].time)}.`,
          focus: { from: addMinutes(high[0].time, -60), to: addMinutes(high[0].time, 60) }
        });
      }
    }

    const rank = { bad: 0, warn: 1, info: 2 };
    out.forEach((b) => { b.k = findingKey(b); });
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }
  /** Stable key of a finding (tag + title), e.g. to remember it as read. If the title changes, it counts as new. */
  function findingKey(b) {
    const str = b.tag + '|' + b.title;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  const fmtNumber = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US');

  // ---------- Filter (same in UI and API) ----------
  // f = { from, to, q, status, fields: { name: value } }; empty values do not filter.
  function matchesQ(q, values) {
    if (!q) return true;
    const hay = values.join(' ').toLowerCase();
    return String(q).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }
  const vals = (e) => Object.keys(e).filter((k) => k !== 'no').map((k) => e[k]);
  function matchesFields(e, ff) {
    for (const k in ff || {}) if (ff[k] !== '' && ff[k] != null && String(e[k]) !== String(ff[k])) return false;
    return true;
  }
  function filterEvents(events, f, schema) {
    f = f || {};
    const st = schema && schema.state;
    return events.filter((e) =>
      (!f.from || e.time >= f.from) && (!f.to || e.time <= f.to) &&
      (!f.status || !st || String(e[st.field]) === f.status) &&
      matchesFields(e, f.fields) && matchesQ(f.q, vals(e)));
  }
  function filterOutages(outs, f) {
    f = f || {};
    return outs.filter((a) =>
      (!f.to || a.start <= f.to) && (!f.from || !a.end || a.end >= f.from) &&
      matchesFields(a.event, f.fields) && matchesQ(f.q, [a.object].concat(vals(a.event))));
  }

  // ---------- Merge ----------
  function renumber(list) {
    list.forEach((e, i) => { e._ord = i; });
    list.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a._ord - b._ord));
    list.forEach((e, i) => { e.no = i + 1; delete e._ord; });
    return list;
  }
  /** Duplicate key: all values except "no". */
  function eventKey(e) { return Object.keys(e).filter((k) => k !== 'no').sort().map((k) => k + '=' + e[k]).join('\u001f'); }
  function merge(existing, incoming) {
    const have = new Map();
    existing.forEach((e) => { const k = eventKey(e); have.set(k, (have.get(k) || 0) + 1); });
    const seen = new Map();
    const added = [];
    for (const e of incoming) {
      const k = eventKey(e);
      const c = (seen.get(k) || 0) + 1;
      seen.set(k, c);
      if (c > (have.get(k) || 0)) added.push(e);
    }
    const base = existing.slice().sort((a, b) => a.no - b.no);
    const inc = added.slice().sort((a, b) => a.no - b.no);
    return { events: renumber(base.concat(inc).map((e) => Object.assign({}, e))), added: inc, addedCount: added.length, dupes: incoming.length - added.length };
  }

  const api = {
    classify, sortEvents, outages, outageRows, outageColumns, metrics, perDay, perHour, topValues, findings, findingKey,
    minutes, toDate, addMinutes, utcMs, fmtDuration, fmtTime, fmtDay, fmtNumber, filterEvents, filterOutages, renumber, merge, eventKey
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
