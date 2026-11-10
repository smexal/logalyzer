'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/schema.js');
const A = require('../shared/analyze.js');
const { migrateSchema } = require('../server/store/migrate.js');

const read = (p) => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8');
const NET = JSON.parse(read('network.json'));
const MON = JSON.parse(read('monitoring.json'));
const LOG = read('network.log');
const MONCSV = read('monitoring.csv');

test('Fixture schemas are valid', () => {
  assert.deepStrictEqual(S.validate(NET), []);
  assert.deepStrictEqual(S.validate(MON), []);
});

test('Regex log: rules, mappings, outages, newest-first order', () => {
  const r = S.parse(LOG, NET);
  assert.strictEqual(r.format, 'regex');
  assert.strictEqual(r.events.length, 17);
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['does not match the pattern']);
  assert.strictEqual(r.events[0].time, '2026-11-01T08:00', 'reversed into chronological order');
  assert.deepStrictEqual(r.events.map((e) => e.no), r.events.map((e, i) => i + 1));
  const vpn = r.events.find((e) => e.message === 'vpn lost user alice');
  assert.deepStrictEqual([vpn.component, vpn.status, vpn.object, vpn.user], ['VPN', 'Down', 'VPN alice', 'alice']);
  const other = r.events.find((e) => e.component === 'Other');
  assert.deepStrictEqual([other.status, other.object], ['Down', 'power supply']);
  const outs = A.outages(r.events, NET);
  assert.strictEqual(outs.length, 9);
  assert.strictEqual(outs.filter((a) => a.resolution === 'open').length, 2);
  assert.strictEqual(outs.find((a) => a.object === 'sw2 eth0').duration_min, 135);
});

test('Findings', () => {
  const ev = S.parse(LOG, NET).events;
  const f = A.findings(ev, A.outages(ev, NET), NET);
  const tags = f.map((b) => b.tag);
  for (const t of ['Open', 'Simultaneous', 'During outage', 'Long outage', 'Repeated', 'Pattern']) assert.ok(tags.includes(t), t);
  assert.ok(f.every((b) => /^[0-9a-f]{16}$/.test(b.k)));
  assert.strictEqual(new Set(f.map((b) => b.k)).size, f.length);
  assert.deepStrictEqual(f.find((b) => b.tag === 'Simultaneous').focus, { from: '2026-11-01T07:30', to: '2026-11-01T10:45' });
});

test('Export CSV can be read back (comma and semicolon)', () => {
  const ev = S.parse(LOG, NET).events;
  const csv = S.toCSV(ev, S.columns(NET));
  assert.ok(csv.startsWith('﻿no,time,host,'));
  assert.deepStrictEqual(S.parse(csv, NET).events, ev);
  const [head, ...rest] = csv.split('\r\n');
  const semi = [head.replace(/,/g, ';'), ...rest.map((l) => l.replace(/","/g, '";"'))].join('\r\n');
  assert.deepStrictEqual(S.parse(semi, NET).events, ev);
});

test('Monitoring (CSV with column mapping, numbers)', () => {
  const r = S.parse(MONCSV, MON);
  assert.ok(r.events.length > 100);
  assert.strictEqual(r.skipped.length, 0);
  assert.strictEqual(typeof r.events[0].response_ms, 'number');
  const outs = A.outages(r.events, MON);
  assert.ok(outs.length > 5);
  assert.ok(A.findings(r.events, outs, MON).some((b) => b.tag === 'Simultaneous'));
  const m = A.metrics(r.events, outs, MON);
  assert.strictEqual(m.events, r.events.length);
  assert.ok(m.numbers.response_ms.max > m.numbers.response_ms.min);
});

test('Type detection', () => {
  assert.strictEqual(S.detect(LOG, [NET, MON])[0].id, 'network');
  assert.strictEqual(S.detect(MONCSV, [NET, MON])[0].id, 'monitoring');
});

test('Schema suggestion from CSV and JSON lines', () => {
  const c = S.infer(MONCSV);
  assert.deepStrictEqual(c.fields.map((f) => [f.name, f.type]), [['time', 'time'], ['host', 'category'], ['service', 'category'], ['state', 'category'], ['response_ms', 'number'], ['message', 'text']]);
  const j = S.infer('{"ts":"2026-11-10T08:00:00Z","level":"error","msg":"x","ctx":{"user":"a"}}\n{"ts":"2026-11-10T08:01:00Z","level":"info","msg":"y","ctx":{"user":"b"}}');
  assert.strictEqual(j.format.type, 'jsonl');
  assert.deepStrictEqual(j.fields.map((f) => f.source), ['ts', 'level', 'msg', 'ctx.user']);
  const s = { id: 'app', name: 'App', format: j.format, fields: j.fields };
  const r = S.parse('{"ts":"2026-11-10T08:00:00Z","level":"error","msg":"x","ctx":{"user":"a"}}', s);
  assert.strictEqual(r.events[0].ctx_user, 'a');
  assert.strictEqual(r.events[0].time, '2026-11-10T08:00:00');
});

test('Time formats', () => {
  assert.strictEqual(S.normTime('09.11.2026 9:14'), '2026-11-09T09:14');
  assert.strictEqual(S.normTime('2026-11-09 09:14:05'), '2026-11-09T09:14:05');
  assert.strictEqual(S.normTime('[10/Nov/2026:08:00:01 +0100]'), '2026-11-10T08:00:01');
  assert.strictEqual(S.normTime('11/10/2026 08:00', 'MM/DD/YYYY HH:mm'), '2026-11-10T08:00');
  assert.strictEqual(S.normTime('nothing'), null);
  assert.strictEqual(A.fmtTime('2026-10-30T17:34'), '30 Oct 17:34');
  assert.strictEqual(A.fmtDuration(1505), '1 d 1 h 5 min');
});

test('Merging skips duplicates', () => {
  const ev = S.parse(LOG, NET).events;
  const m = A.merge(ev, ev.slice(0, 10));
  assert.strictEqual(m.addedCount, 0);
  assert.strictEqual(m.dupes, 10);
  assert.strictEqual(m.events.length, 17);
});

test('Migration of a German schema', () => {
  const old = {
    _id: 'alt', id: 'alt', name: 'Alt', beschreibung: 'd',
    format: { art: 'regex', muster: '^(?<zeit>\\S+) (?<meldung>.*)$' },
    felder: [{ name: 'zeit', label: 'Zeit', typ: 'zeit', quelle: 'zeit' }, { name: 'meldung', label: 'Meldung', typ: 'text', tabelle: true }, { name: 'zustand', label: 'Zustand', typ: 'kategorie', filter: true, diagramm: true }],
    regeln: [{ feld: 'meldung', muster: '(ab|auf)', setze: { zustand: '$1' } }, { setze: { zustand: { vorlage: '{meldung}', ersetze: [['x', 'y']], sonst: '{zeit}' } } }],
    abbildungen: { zustand: { werte: [{ muster: 'ab', wert: 'AB' }], sonst: 'X' } },
    zustand: { feld: 'zustand', ab: ['AB'], auf: ['auf'], schluessel: ['meldung'], bezeichnung: '{meldung}', gruppe: 'zustand' }
  };
  const s = migrateSchema(old);
  assert.deepStrictEqual(S.validate(s), []);
  assert.strictEqual(s.format.pattern, '^(?<time>\\S+) (?<meldung>.*)$');
  assert.deepStrictEqual(s.fields.map((f) => [f.name, f.type]), [['time', 'time'], ['meldung', 'text'], ['zustand', 'category']]);
  assert.strictEqual(s.fields[0].source, 'time', 'regex source follows the renamed group');
  assert.deepStrictEqual(s.rules[1].set.zustand, { template: '{meldung}', replace: [['x', 'y']], fallback: '{time}' });
  assert.deepStrictEqual(s.mappings.zustand, { values: [{ pattern: 'ab', value: 'AB' }], fallback: 'X' });
  assert.deepStrictEqual(s.state, { field: 'zustand', down: ['AB'], up: ['auf'], keys: ['meldung'], label: '{meldung}', group: 'zustand' });
  assert.strictEqual(S.parse('2026-11-10T08:00 ab', s).events[0].zustand, 'AB');
});
