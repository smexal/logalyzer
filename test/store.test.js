'use strict';
// Store against MongoDB: MONGO_URL (default mongodb://localhost:27017/logalyzer_test).
// If no MongoDB is running (docker compose up -d mongo), the test is skipped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/schema.js');
const { createStore } = require('../server/store/index.js');

const read = (p) => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8');
const NET = JSON.parse(read('network.json'));
const LOG = read('network.log');
const env = { MONGO_URL: process.env.MONGO_URL || 'mongodb://localhost:27017/logalyzer_test' };

async function freshStore(t) {
  const s0 = createStore(env, { retries: 1 });
  try { await s0.init(); } catch (e) { await s0.close(); t.skip('MongoDB not reachable: ' + e.message); return null; }
  await s0.b.db.dropDatabase();
  await s0.close();
  const s = createStore(env, { retries: 1 });
  await s.init();
  return s;
}

test('Store (MongoDB): types, import with duplicate check, reload, read findings, delete type', async (t) => {
  const s = await freshStore(t);
  if (!s) return;
  try {
    // An empty database starts without log types
    assert.deepStrictEqual(s.listTypes(), []);
    await s.saveType(NET);
    const all = S.parse(LOG, NET);

    assert.deepStrictEqual(await s.checkDuplicates('network', all), { new: 17, existing: 0 });
    assert.deepStrictEqual(await s.importParsed('network', all, 'First'), { added: 17, dupes: 0 });
    assert.strictEqual((await s.analysis('network')).outages.length, 9);

    // The same log again: nothing new
    assert.deepStrictEqual(await s.checkDuplicates('network', all), { new: 0, existing: 17 });
    assert.deepStrictEqual(await s.importParsed('network', all, 'Again'), { added: 0, dupes: 17 });
    assert.strictEqual((await s.get('network')).events.length, 17);

    // Partly new
    const extra = S.parse('2026-11-07 09:00  sw4  link down eth1\n' + LOG.split(/\r?\n/)[0], NET);
    assert.deepStrictEqual(await s.checkDuplicates('network', extra), { new: 1, existing: 1 });
    assert.deepStrictEqual(await s.importParsed('network', extra, 'Extra'), { added: 1, dupes: 1 });

    // The same line twice in one log stays twice; a repeated import only adds the missing one
    await s.saveType({ id: 'test', name: 'Test', format: { type: 'csv' }, fields: [{ name: 'time', type: 'time', source: 'Time' }, { name: 'value', type: 'number', source: 'Value' }] });
    await assert.rejects(() => s.saveType({ id: 'broken', name: 'X', format: { type: 'csv' }, fields: [] }));
    const one = S.parse('Time;Value\n2026-11-10 08:00;1,5', s.getType('test'));
    const two = S.parse('Time;Value\n2026-11-10 08:00;1,5\n2026-11-10 08:00;1,5', s.getType('test'));
    assert.deepStrictEqual(await s.importParsed('test', one, 'a'), { added: 1, dupes: 0 });
    assert.deepStrictEqual(await s.importParsed('test', two, 'b'), { added: 1, dupes: 1 });
    assert.deepStrictEqual(await s.importParsed('test', two, 'c'), { added: 0, dupes: 2 });

    // Reloading from the database yields the same data
    const before = JSON.stringify((await s.get('network')).events);
    const s2 = createStore(env, { retries: 1 });
    await s2.init();
    assert.strictEqual(JSON.stringify((await s2.get('network')).events), before);
    assert.deepStrictEqual((await s2.get('network')).sources.map((x) => [x.name, x.count, x.dupes]), [['First', 17, 0], ['Again', 0, 17], ['Extra', 1, 1]]);
    assert.deepStrictEqual((await s2.get('test')).events, [{ no: 1, time: '2026-11-10T08:00', value: 1.5 }, { no: 2, time: '2026-11-10T08:00', value: 1.5 }]);
    await s2.close();

    // Mark findings as read, show them again; deleting the type removes them
    const f = (await s.analysis('network')).findings;
    assert.ok(f.length && f.every((b) => /^[0-9a-f]{16}$/.test(b.k)));
    await s.markRead('network', f[0]);
    await s.markRead('network', f[0]);
    await s.markRead('test', f[0]);
    assert.deepStrictEqual((await s.listRead('network')).map((g) => [g.k, g.title]), [[f[0].k, f[0].title]]);
    await assert.rejects(() => s.markRead('network', { title: 'no k' }));
    assert.strictEqual(await s.unmarkRead('network', f[0].k), 1);
    assert.strictEqual(await s.unmarkRead('network', f[0].k), 0);

    // Notes on values: stored apart from the events, empty note removes, unknown fields are rejected
    const eventsBefore = JSON.stringify((await s.get('network')).events);
    assert.deepStrictEqual((await s.setNote('network', { field: 'object', value: 'sw1 eth0', note: ' Core switch ' })).map((n) => [n.field, n.value, n.note]), [['object', 'sw1 eth0', 'Core switch']]);
    await s.setNote('network', { field: 'object', value: 'sw1 eth0', note: 'Core switch, rack 2' });
    await s.setNote('network', { field: 'host', value: 'gw1', note: 'Gateway' });
    assert.deepStrictEqual((await s.listNotes('network')).map((n) => n.field + '=' + n.value + ':' + n.note), ['host=gw1:Gateway', 'object=sw1 eth0:Core switch, rack 2']);
    await assert.rejects(() => s.setNote('network', { field: 'nope', value: 'x', note: 'y' }), /Unknown field/);
    await assert.rejects(() => s.setNote('network', { field: 'time', value: 'x', note: 'y' }));
    await assert.rejects(() => s.setNote('network', { field: 'host', value: '', note: 'y' }));
    assert.deepStrictEqual((await s.setNote('network', { field: 'host', value: 'gw1', note: '' })).map((n) => n.value), ['sw1 eth0']);
    assert.strictEqual(JSON.stringify((await s.get('network')).events), eventsBefore, 'notes do not change the events');
    await s.setNote('test', { field: 'value', value: '1.5', note: 'x' });

    await s.deleteType('test');
    assert.strictEqual(s.getType('test'), null);
    assert.deepStrictEqual(await s.listRead('test'), []);
    assert.deepStrictEqual(await s.listNotes('test'), []);
  } finally {
    await s.b.db.dropDatabase().catch(() => {});
    await s.close();
  }
});

test('Store (MongoDB): migrates a database written by the German version', async (t) => {
  const s0 = await freshStore(t);
  if (!s0) return;
  const db = s0.b.db;
  try {
    // Data as the German version wrote it
    await db.collection('types').insertOne({
      _id: 'alt', id: 'alt', name: 'Alt', format: { art: 'csv', trennzeichen: ';' },
      felder: [{ name: 'zeit', label: 'Zeit', typ: 'zeit', quelle: 'Zeit' }, { name: 'wert', label: 'Wert', typ: 'zahl', quelle: 'Wert' }]
    });
    await db.collection('events').insertMany([
      { typ: 'alt', seq: 1, zeit: '2026-11-10T08:00', k: 'old#1', d: { zeit: '2026-11-10T08:00', wert: 1 } },
      { typ: 'alt', seq: 2, zeit: '2026-11-10T09:00', k: 'old#2', d: { zeit: '2026-11-10T09:00', wert: 2 } }
    ]);
    await db.collection('events').createIndex({ typ: 1, k: 1 }, { unique: true, name: 'duplikate' });
    await db.collection('sources').insertOne({ typ: 'alt', name: 'Import', format: 'csv', anzahl: 2, doppelt: 0, at: '2026-11-10T10:00:00Z' });
    await db.collection('gelesen').insertOne({ typ: 'alt', k: 'abc', sev: 'bad', tag: 'Offen', titel: 'T', text: 'x', at: '2026-11-10T10:00:00Z' });
    await s0.close();

    const s = createStore(env, { retries: 1 });
    await s.init();
    try {
      assert.deepStrictEqual(s.getType('alt').fields.map((f) => [f.name, f.type, f.source]), [['time', 'time', 'Zeit'], ['wert', 'number', 'Wert']]);
      const d = await s.get('alt');
      assert.deepStrictEqual(d.events, [{ no: 1, time: '2026-11-10T08:00', wert: 1 }, { no: 2, time: '2026-11-10T09:00', wert: 2 }]);
      assert.deepStrictEqual(d.sources.map((x) => [x.name, x.count, x.dupes]), [['Import', 2, 0]]);
      assert.deepStrictEqual((await s.listRead('alt')).map((g) => [g.k, g.title]), [['abc', 'T']]);
      // Keys were recomputed: importing the same data again adds nothing
      const csv = S.parse('Zeit;Wert\n10.11.2026 08:00;1\n10.11.2026 09:00;2', s.getType('alt'));
      assert.deepStrictEqual(await s.importParsed('alt', csv, 'again'), { added: 0, dupes: 2 });
    } finally {
      await s.b.db.dropDatabase().catch(() => {});
      await s.close();
    }
  } catch (e) {
    await db.dropDatabase().catch(() => {});
    throw e;
  }
});
