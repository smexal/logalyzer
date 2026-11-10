/*
 * Logalyzer – prompts for Claude
 *   logTypePrompt(opts)             let Claude design a new log type (schema JSON) from a sample
 *   csvPrompt(schema, opts)         let Claude turn any text into a CSV that can be imported into this log type directly
 *   knownValues(events, schema)     known values per category field (for csvPrompt)
 *   schemaFromReply(text)           extract the schema JSON from Claude's reply
 * UMD like schema.js: Node via require, browser as window.Prompts. Needs Schema (schema.js).
 */
(function (root) {
  'use strict';
  const SC = typeof module !== 'undefined' && module.exports ? require('./schema.js') : root.Schema;

  const MAX_LINES = 80, MAX_CHARS = 12000;
  const TYPE_TEXT = {
    time: 'timestamp',
    text: 'free text',
    category: 'category (few distinct values)',
    number: 'number (dot as decimal separator, no unit)'
  };

  function shorten(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
    let out = lines.slice(0, MAX_LINES).join('\n');
    if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
    const shortened = out.length < lines.join('\n').length;
    return { text: out, shortened, lines: lines.length };
  }

  const EXAMPLE_SCHEMA = {
    id: 'monitoring',
    name: 'Server monitoring',
    description: 'Checks per host and service with state and response time.',
    format: { type: 'csv', delimiter: 'auto' },
    fields: [
      { name: 'time', label: 'Time', type: 'time', source: 'Timestamp', format: 'DD.MM.YYYY HH:mm' },
      { name: 'host', label: 'Host', type: 'category', source: 'Host', filter: true, chart: true, table: true },
      { name: 'state', label: 'State', type: 'category', source: 'State', filter: true, table: true },
      { name: 'response_ms', label: 'Response time (ms)', type: 'number', source: 'Response ms', table: true },
      { name: 'message', label: 'Message', type: 'text', source: 'Message', table: true }
    ],
    state: { field: 'state', down: ['CRITICAL'], up: ['OK'], keys: ['host'], label: '{host}', group: 'host' }
  };

  /**
   * Prompt for designing a new log type.
   * opts: { sample, name, description, existingIds: [] }
   */
  function logTypePrompt(opts) {
    opts = opts || {};
    const b = shorten(opts.sample);
    const ids = (opts.existingIds || []).filter(Boolean);
    const L = [];
    L.push('I analyse logs with «Logalyzer», a local web app. Every kind of log is a **log type** there: a JSON schema that defines how lines are split, which fields exist and how they are displayed. Help me design a new log type for the log below.');
    L.push('');
    L.push('## Approach');
    L.push('1. Look at the sample and briefly describe what a line contains.');
    L.push('2. Suggest the fields (name, label, type, what they are useful for). If it is unclear which columns I need or whether there are outage/recovery messages, ask me briefly first.');
    L.push('3. At the end, output the **complete schema as exactly one ```json block**. I will paste it into the field «Reply from Claude» in Logalyzer.');
    L.push('');
    L.push('## Schema format');
    L.push('- `id`: lowercase letters, digits, `_` or `-`' + (ids.length ? `; already taken: ${ids.map((x) => '`' + x + '`').join(', ')}` : '') + '. `name`: display name. `description`: one sentence.');
    L.push('- `format.type`:');
    L.push('  - `"csv"`: table with header line; `delimiter` `"auto"`, `","`, `";"`, `"\\t"` or `"|"`.');
    L.push('  - `"jsonl"`: one JSON object per line.');
    L.push('  - `"regex"`: text lines; `pattern` is a JavaScript regex with **named groups** `(?<name>…)`, optional `flags`. Double the backslashes in JSON (`\\\\d`). Lines that do not match are skipped.');
    L.push('- `fields`: list of `{ name, label, type, source, format, filter, chart, table }`');
    L.push('  - `name`: short, lowercase, `a-z0-9_`. **Exactly one field is called `time` and has `type: "time"`** (timestamp of the entry). `no` is reserved.');
    L.push('  - `type`: `time`, `text`, `category` (few distinct values such as host, level, status), `number`.');
    L.push('  - `source`: CSV column name, regex group name or JSON path (`ctx.user`). Empty = same as `name`; fields without a source can be filled by `rules`.');
    L.push('  - `format` (only for `time`): e.g. `DD.MM.YYYY HH:mm`, `YYYY-MM-DD HH:mm:ss`, `MM/DD/YYYY`, `DD/MMM/YYYY:HH:mm:ss`. Omit = automatic (ISO, DD.MM.YYYY, Apache, syslog, Unix time). Time zones are ignored.');
    L.push('  - `filter: true` = offer as a filter (for categories), `chart: true` = chart of the most frequent values (categories with 2–15 values), `table: true` = column in the table.');
    L.push('- `rules` (optional, mainly for text logs): `[{ "field": "message", "pattern": "Regex", "flags": "i", "set": { "field": "template" } }]`. The first matching rule wins; a rule without `pattern` always matches (fallback, e.g. `"component": "Other"`). `set` only fills empty fields. Template: text with `$1`, `$<group>`, `{field}`.');
    L.push('- `mappings` (optional): `{ "status": { "values": [{ "pattern": "lost|down", "value": "Down" }], "fallback": "Notice" } }` normalises values.');
    L.push('- `state` (optional, only if the log reports outages and recoveries): `{ "field": "state", "down": ["CRITICAL"], "up": ["OK"], "keys": ["host"], "label": "{host}", "group": "host", "related": "user" }`. An outage starts with a `down` value and ends with the next `up` value of the same object (`keys`). `related` (optional): other entries with the same value during an outage are reported.');
    L.push('');
    L.push('Example of a finished log type:');
    L.push('```json');
    L.push(JSON.stringify(EXAMPLE_SCHEMA, null, 2));
    L.push('```');
    L.push('');
    L.push('## My log');
    if (opts.name) L.push(`Name: ${opts.name}`);
    if (opts.description) L.push(`Description: ${opts.description}`);
    if (b.text.trim()) {
      L.push(b.shortened ? `The first lines (of ${b.lines} in total):` : 'Sample:');
      L.push('```');
      L.push(b.text);
      L.push('```');
    } else {
      L.push('(Paste some typical lines of the log here.)');
    }
    return L.join('\n');
  }

  /** Known values per category field from stored entries: { field: [values by frequency] } */
  function knownValues(events, schema, max) {
    max = max || 25;
    const out = {};
    for (const f of schema.fields || []) {
      if (f.type !== 'category') continue;
      const c = new Map();
      for (const e of events || []) { const v = e[f.name]; if (v !== '' && v != null) c.set(String(v), (c.get(String(v)) || 0) + 1); }
      out[f.name] = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map((x) => x[0]);
    }
    return out;
  }

  /** Target values of a mapping (the field can only take these values). */
  function mappedValues(schema, field) {
    const s = new Set();
    const a = (schema.mappings || {})[field];
    if (a) { (a.values || []).forEach((w) => s.add(w.value)); if (a.fallback != null && a.fallback !== '') s.add(a.fallback); }
    return [...s];
  }
  /** Values of the state field with their meaning: [[value, 'outage'|'back to normal']] */
  function stateValues(schema, field) {
    const st = schema.state;
    if (!st || st.field !== field) return [];
    return (st.down || []).map((v) => [v, 'outage']).concat((st.up || []).map((v) => [v, 'back to normal']));
  }

  const csvCell = (v) => '"' + String(v).replace(/"/g, '""') + '"';

  /**
   * Prompt for turning any text into a CSV for this log type.
   * opts: { values: knownValues(...), text }
   * The CSV has the field names as header line; Logalyzer maps such columns by name.
   */
  function csvPrompt(schema, opts) {
    opts = opts || {};
    const cols = SC.columns(schema).filter((c) => c !== 'no');
    const fields = cols.map((n) => (schema.fields || []).find((f) => f.name === n)).filter(Boolean);
    const values = opts.values || {};
    const st = schema.state;
    const L = [];
    L.push(`Convert the text below into a CSV file for my log type «${schema.name}», which I will import into Logalyzer (a local log analysis tool).` + (schema.description ? ` The log type: ${schema.description}` : ''));
    L.push('');
    L.push('## CSV format');
    L.push('- First line exactly this header:');
    L.push('```');
    L.push(cols.join(','));
    L.push('```');
    L.push('- Comma as delimiter, **every value in double quotes**, double any quotes inside a value (`""`). No line breaks inside a value.');
    L.push('- One line per event, in the order of the text.');
    L.push('- `time` always as `YYYY-MM-DDTHH:MM:SS` (or `YYYY-MM-DDTHH:MM` if no seconds are known). If the year is missing in the text, take it from the context; if the time is missing entirely, leave the line out and mention it below.');
    L.push('- Leave unknown values empty (`""`), do not invent anything.');
    L.push('');
    L.push('## Columns');
    for (const f of fields) {
      let line = `- \`${f.name}\` – ${f.label || f.name}: ${TYPE_TEXT[f.type] || f.type}`;
      const fixed = mappedValues(schema, f.name);
      const sv = stateValues(schema, f.name);
      const named = fixed.concat(sv.map((x) => x[0]));
      const known = fixed.length ? [] : (values[f.name] || []).filter((v) => !named.includes(v));
      if (fixed.length) line += `. Only these values: ${fixed.map((v) => '`' + v + '`').join(', ')}`;
      if (sv.length) line += `. Values with meaning: ${sv.map(([v, b]) => '`' + v + '` = ' + b).join(', ')}`;
      if (known.length) line += `. ${sv.length ? 'Other values' : 'Values'} seen so far (use the same spelling, new values are allowed): ${known.map((v) => '`' + v + '`').join(', ')}`;
      if (!f.source && (schema.rules || []).some((r) => r.set && Object.prototype.hasOwnProperty.call(r.set, f.name)) && !fixed.length) line += '. May stay empty, Logalyzer derives it from the message';
      L.push(line + '.');
    }
    if (st) {
      L.push('');
      L.push('## Outages');
      L.push(`Logalyzer analyses outages via \`${st.field}\`: ${(st.down || []).map((v) => '`' + v + '`').join(' / ')} = outage starts, ${(st.up || []).map((v) => '`' + v + '`').join(' / ')} = back to normal. An object is identified by ${(st.keys || []).map((v) => '`' + v + '`').join(' + ') || 'the whole entry'}. Set these values carefully and write the object columns identically for outage and recovery so that the pairs match.`);
    }
    L.push('');
    L.push('## Output');
    L.push('Output the CSV as **one** ```csv block. Afterwards briefly: how many lines, and which parts of the text you did not include (with the reason).');
    L.push('');
    L.push('Example line (only for the form):');
    L.push('```csv');
    L.push(cols.join(','));
    L.push(fields.map((f) => csvCell(f.name === 'time' ? '2026-11-10T08:15:00' : f.type === 'number' ? '42' : (mappedValues(schema, f.name)[0] || (stateValues(schema, f.name)[0] || [])[0] || (values[f.name] || [])[0] || '…'))).join(','));
    L.push('```');
    L.push('');
    L.push('## Text');
    const t = String(opts.text || '').trim();
    if (t) { L.push('```'); L.push(t); L.push('```'); } else L.push('(Paste the text here.)');
    return L.join('\n');
  }

  /** Schema object from a reply with a ```json block or plain JSON. -> { schema } | { error } */
  function schemaFromReply(text) {
    const t = String(text || '');
    const blocks = [...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const cand = blocks.length ? blocks : [t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
    let last;
    for (const c of cand.reverse()) {
      try {
        const o = JSON.parse(c);
        if (o && typeof o === 'object' && Array.isArray(o.fields)) return { schema: o };
        last = 'The JSON has no «fields» property.';
      } catch (e) { last = 'Not valid JSON: ' + e.message; }
    }
    return { error: last || 'No JSON found.' };
  }

  const api = { logTypePrompt, csvPrompt, knownValues, schemaFromReply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Prompts = api;
})(typeof window !== 'undefined' ? window : globalThis);
