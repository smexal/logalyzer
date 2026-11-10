'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/schema.js');
const P = require('../shared/prompts.js');

const schema = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', id + '.json'), 'utf8'));

test('Log type prompt contains sample, taken ids and a valid example schema', () => {
  const p = P.logTypePrompt({ sample: 'a;b\n1;2', name: 'Firewall', existingIds: ['monitoring'] });
  assert.match(p, /Name: Firewall/);
  assert.match(p, /```\na;b\n1;2\n```/);
  assert.match(p, /`monitoring`/);
  const r = P.schemaFromReply(p); // the embedded example schema is the last JSON block with fields
  assert.ok(r.schema);
  assert.deepStrictEqual(S.validate(r.schema), []);
  assert.match(P.logTypePrompt({}), /Paste some typical lines/);
});

test('Extract schema from Claude\'s reply', () => {
  const s = { id: 'x', name: 'X', format: { type: 'csv' }, fields: [{ name: 'time', type: 'time' }] };
  assert.deepStrictEqual(P.schemaFromReply('Here:\n```json\n' + JSON.stringify(s) + '\n```\nDone.').schema, s);
  assert.deepStrictEqual(P.schemaFromReply(JSON.stringify(s)).schema, s);
  assert.ok(P.schemaFromReply('```json\n{ broken\n```').error);
});

for (const id of ['monitoring', 'network']) {
  test(`CSV following the prompt is detected and read by ${id}`, () => {
    const sc = schema(id);
    const p = P.csvPrompt(sc, { values: { host: ['web01'] }, text: 'anything' });
    const head = p.match(/header:\n```\n(.*)\n```/)[1];
    assert.strictEqual(head, S.columns(sc).filter((c) => c !== 'no').join(','));
    assert.match(p, /## Text\n```\nanything\n```/);
    // A CSV as Claude is asked to produce it: all values quoted, ISO time, derived fields empty
    const cols = head.split(',');
    const row = (vals) => cols.map((c) => '"' + (vals[c] == null ? '' : vals[c]) + '"').join(',');
    const rows = id === 'monitoring'
      ? [row({ time: '2026-11-10T08:00:00', host: 'web01', service: 'HTTP', state: 'CRITICAL', response_ms: '1200', message: 'timeout' }),
        row({ time: '2026-11-10T08:05', host: 'web01', service: 'HTTP', state: 'OK', response_ms: '80', message: 'ok' })]
      : [row({ time: '2026-11-10T08:00', host: 'sw9', message: 'link down eth3' })];
    const csv = [head].concat(rows).join('\n');
    assert.strictEqual(S.detect(csv, [schema('monitoring'), schema('network')])[0].id, id);
    const r = S.parse(csv, sc);
    assert.strictEqual(r.format, 'csv-export');
    assert.strictEqual(r.skipped.length, 0);
    assert.strictEqual(r.events.length, rows.length);
    if (id === 'monitoring') {
      assert.strictEqual(r.events[0].response_ms, 1200);
      assert.match(p, /`CRITICAL` = outage, `OK` = back to normal/);
      assert.match(p, /seen so far .*`web01`/);
    } else {
      assert.strictEqual(r.events[0].component, 'Link', 'rules fill derived fields');
      assert.strictEqual(r.events[0].status, 'Down');
      assert.match(p, /Only these values: `Down`, `Restored`, `Notice`/);
    }
  });
}
