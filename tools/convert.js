#!/usr/bin/env node
'use strict';
/*
 * Converts a log into a CSV in Logalyzer format according to a log type (schema).
 * Uses the same engine as server and UI (shared/schema.js).
 *
 *   node tools/convert.js <schema.json> <input> [output.csv]
 *
 *   schema.json  path to a schema (e.g. exported from the app via GET /api/types/<id>)
 *   Without an output file the CSV goes to stdout.
 */
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/schema.js');

const [schemaFile, input, output] = process.argv.slice(2);
if (!schemaFile || !input) {
  console.error('Usage: node tools/convert.js <schema.json> <input> [output.csv]');
  process.exit(2);
}

const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
const text = fs.readFileSync(input, 'utf8');

const err = S.validate(schema);
if (err.length) { console.error('Invalid schema:\n  ' + err.join('\n  ')); process.exit(1); }

const res = S.parse(text, schema);
if (res.error) { console.error(res.error); process.exit(1); }
for (const s of res.skipped) console.error(`Skipped (line ${s.line}, ${s.reason}): ${s.text}`);

const csv = S.toCSV(res.events, S.columns(schema));
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, csv, 'utf8');
  const t = res.events.map((e) => e.time).sort();
  console.log(`${res.events.length} events (${schema.name}, ${res.format}${t.length ? `, ${t[0]} to ${t[t.length - 1]}` : ''}) -> ${output}`);
  console.log(`${res.skipped.length} lines skipped`);
} else {
  process.stdout.write(csv);
}
