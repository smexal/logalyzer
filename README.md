# Logalyzer

Web app for analysing logs of any kind. Each kind is a **log type** (schema): it defines how lines are split, which fields exist and how they are displayed. Filters, metrics, charts, tables and findings follow the log type.
UI in the browser, Node backend with a REST API, data in MongoDB. Everything runs locally. No log types are shipped: you create your own in the app.

## Getting started

```
docker compose up -d --build
```

Then open http://localhost:3000. Stop with `docker compose down`; the data stays in the volume `logalyzer_mongo-data` (`docker compose down -v` deletes it).

All data is stored in MongoDB. Without the Docker app (development): `docker compose up -d mongo`, then `npm install` and `npm run dev` (connects to `mongodb://localhost:27017/logalyzer`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port of the server |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Address the server listens on |
| `MONGO_URL` | `mongodb://localhost:27017/logalyzer` | MongoDB connection (Docker: `mongodb://mongo:27017/logalyzer`) |
| `MONGO_DB` | from the URL | Database name |

A database written by the earlier German version (schema keys such as `felder`, field `zeit`) is converted automatically on startup. Field names, labels and values you chose yourself stay as they are.

## Creating a log type

In the app, click **Log types** → **New log type**:

1. Enter a name, paste some lines of the log (or drag a file into the window).
2. **Detect columns**: for CSV with a header line and JSON lines, Logalyzer suggests fields and types. Tick the columns you need, adjust field names and labels, and choose which fields appear as filter, chart or table column.
3. Optional **state**: choose a field (e.g. `State`) and assign values (`CRITICAL` = outage, `OK` = back), plus the fields that identify an object (e.g. host + service). This produces the timeline, the outage table and findings.
4. Check the preview, then **Save and import sample**.

**Set up with Claude**: the editor contains a ready-made prompt (with name, description and sample lines). Copy it, send it to Claude, paste Claude's reply with the schema JSON into the field «Reply from Claude» and click **Apply schema**. Then check the preview and save.

For text logs without columns, choose the format «Text lines (regex)» and enter a pattern with named groups, e.g. `^(?<time>\S+ \S+) (?<level>\w+) (?<message>.*)$`. Claude can write rules and mappings (see below) from a sample.

Stored entries stay as they were read; changed fields or rules apply to future imports. To re-read everything, delete the log type, create it again and import the logs again.

## Loading data

- **Import**: paste text (or Ctrl+V in the window), choose files or drag them into the window. «Detect automatically» picks the log type that most lines match.
- **Unstructured text** (email, notes, ticket …): in the import dialog, «Prompt for Claude» holds a prompt per log type that lets Claude convert the text into a CSV with the fields of this log type (header = field names, ISO times, known category values). If the pasted text fits no log type, it is added to the prompt and the prompt is expanded. Paste Claude's CSV into the dialog; Logalyzer maps the columns by name.
- **Via Claude Code**: paste a log into the chat. Claude creates a log type if needed and imports via the API.
- **Via the API** from scripts (see below).

**Duplicates**: every import is merged with the stored data. An entry is a duplicate if all its fields match a stored entry. Before importing, the import dialog shows how many entries are new and how many are already stored; duplicates are skipped. MongoDB also enforces this with a unique index. If the same line occurs several times in one log, it is kept that many times. A CSV export of a log type can be imported into the same type again (all duplicates).

Deleting individual data is not possible; «Delete log type» in the editor removes the type with all its entries.

## Filters

Range (date with optional time, or a quick range: last 24 hours / 7 days / 30 days), field filters, search, state and highlight filter are kept per log type in the browser (localStorage) and restored after a reload. A quick range is recalculated relative to the current time. «Reset filters» clears them.

## Findings

Findings are detected automatically (open outages, simultaneous outages, long and repeated outages, short interruptions, restarts, spikes, outliers). Click a finding to zoom to it; ✓ marks it as read. Read findings are stored per log type and listed in the «Read» tab, from where they can be shown again. A finding is recognised by its tag and title: if the title changes (e.g. a count after a new import), it counts as new.

## Notes on values

To identify a value better without changing the log, add a note to it: hover over a value in the entry or outage table and click ✎ (e.g. object `Tel. 4130 / Gerät 18` → note `Reception`). The note is shown in brackets wherever the value appears: entries, outages, timeline, charts and filter lists. Notes are stored per log type, field and value, apart from the entries; analysis, search, findings, duplicate check and CSV export use the original values only. «Notes on values» below the entries lists all notes for editing; an empty note removes it.

## Highlights and manual columns

- **Highlight rows**: click the small circle in front of the time of an entry and choose a colour (yellow, red, green, blue). «Highlighted rows» or a colour in the entries toolbar shows only those rows.
- **Manual columns**: «Columns …» in the entries toolbar adds your own text columns to a log type (e.g. «Comment», «Ticket»). Click a cell to write into it; Enter saves, Shift+Enter makes a new line, Esc cancels.

Both are stored on the server per entry, apart from the log entries (an entry is identified by its duplicate key, which stays the same when further logs are imported). The analysis ignores them; the search covers the manual columns, and the CSV export appends the manual columns and, if any, a `highlight` column. Removing a column deletes its values.

## Schema format

```json
{
  "id": "monitoring",
  "name": "Server monitoring",
  "description": "…",
  "format": { "type": "csv", "delimiter": "auto" },
  "fields": [
    { "name": "time", "label": "Time", "type": "time", "source": "Timestamp", "format": "DD.MM.YYYY HH:mm" },
    { "name": "host", "label": "Host", "type": "category", "source": "Host", "filter": true, "chart": true, "table": true },
    { "name": "response_ms", "label": "Response time (ms)", "type": "number", "source": "Response ms", "table": true }
  ],
  "rules": [],
  "mappings": {},
  "state": { "field": "state", "down": ["CRITICAL"], "up": ["OK"], "keys": ["host", "service"], "label": "{host} / {service}", "group": "host" }
}
```

| Part | Meaning |
|---|---|
| `format.type` | `csv` (header line, `delimiter` `auto`, `,`, `;`, tab, `|`), `jsonl` (one JSON object per line) or `regex` (`pattern` with named groups, optional `flags`) |
| `fields[].type` | `time`, `text`, `category` (few distinct values), `number`. Exactly one field is called `time` and has the type `time`. `no` is reserved. |
| `fields[].source` | CSV column, regex group or JSON path (`ctx.user`). Empty: group/column with the field name, otherwise filled by rules. |
| `fields[].format` | only for `time`: e.g. `DD.MM.YYYY HH:mm`, `MM/DD/YYYY`, `DD/MMM/YYYY:HH:mm:ss`. Empty = automatic (ISO, `DD.MM.YYYY`, Apache, syslog, Unix time). Time zones are ignored. |
| `filter`, `chart`, `table` | offer the field as a filter, show a chart of the most frequent values, column in the table |
| `rules` | `[{ field, pattern, flags, set: { field: template } }]`. The first matching rule wins, a rule without `pattern` always matches. `set` only fills empty fields. Template: text with `$1`, `$<group>`, `{field}` or `{ template, replace: [[pattern, replacement, flags]], trim, fallback }`. |
| `mappings` | `{ field: { values: [{ pattern, value }], fallback } }` normalises values, e.g. `lost` → `Down` |
| `state` | optional: `field`, values `down` and `up`, `keys` (fields that identify an object), `label` (template), `group` (sorting in the timeline), `related` (e.g. user: other entries of the same user during an outage are reported) |

`test/fixtures/network.json` is a complete example with rules, mappings and state.

## API

Filter parameters where noted: `from`, `to` (`YYYY-MM-DDTHH:MM`), `q` (full text), `status` (value of the state field), `f.<field>=<value>`.

| Method and path | Purpose |
|---|---|
| `GET /api/health` | health, storage kind |
| `GET /api/types` | all log types with number of entries (`count`) |
| `GET` / `PUT` / `DELETE /api/types/:id` | read, create/update, delete a log type (with all entries) |
| `POST /api/schema/infer` | schema suggestion from a sample (`{ text }`) |
| `POST /api/schema/test` | test a schema on a sample (`{ schema, text }`), stores nothing |
| `POST /api/detect` | matching log types for a text |
| `POST /api/check` | preview with type detection and duplicate check: `{ text, type? }` → `{ type, matched, new, existing, … }`, stores nothing |
| `POST /api/import` | import with type detection: `{ text, name?, type? }` or text as body with `?type=…&name=…` → `{ added, dupes, total, … }` |
| `POST /api/t/:type/import` | import into a specific type |
| `POST /api/t/:type/preview` | like import incl. `new`/`existing`, stores nothing |
| `GET /api/t/:type/data` | all entries (each with its id `_k`), imports (`sources` with `count` new and `dupes`), manual `columns` and per-entry `extras` |
| `GET` / `PUT /api/t/:type/columns` | manual text columns `[{ name, label }]`; `PUT` replaces the list (values of removed columns are deleted) |
| `GET /api/t/:type/extras` | per-entry extras `[{ k, highlight, values }]` |
| `PATCH /api/t/:type/entries/:k` | change one entry's extras: `{ highlight: "yellow"\|"red"\|"green"\|"blue"\|null, values: { column: text } }` (empty text removes a value) |
| `GET /api/t/:type/events` | entries, filter + `limit` |
| `GET /api/t/:type/outages` | outages, filter + `resolution=open\|resolved` |
| `GET /api/t/:type/findings` | automatic findings without the read ones (`?all=1`: all); every finding has a key `k` |
| `GET /api/t/:type/read` | findings marked as read (state when marked, newest first) |
| `POST /api/t/:type/read` | mark a finding as read (body = finding with `k`) |
| `DELETE /api/t/:type/read/:k` | show a finding among the open ones again |
| `GET /api/t/:type/notes` | notes on field values `[{ field, value, note, at }]` |
| `PUT /api/t/:type/notes` | set a note `{ field, value, note }` (empty `note` removes it), returns all notes |
| `GET /api/t/:type/metrics` | metrics, filter |
| `GET /api/t/:type/export/events.csv` | entries as CSV incl. manual columns, filter + `highlight=any\|<colour>` |
| `GET /api/t/:type/export/outages.csv` | outages as CSV, filter |

Example (PowerShell):

```
Invoke-RestMethod -Method Post "http://localhost:3000/api/import?name=today" -ContentType "text/plain; charset=utf-8" -Body (Get-Content imports\today.log -Raw -Encoding UTF8)
Invoke-RestMethod "http://localhost:3000/api/t/monitoring/outages?resolution=open&f.host=web01"
```

## CSV export

UTF-8 with BOM (for Excel), comma, all fields quoted. Columns: `no`, `time`, then the fields of the log type in schema order.

## Structure

```
shared/schema.js        schema engine: splitting (CSV, JSON lines, regex), rules, time formats, type detection, suggestion, validation
shared/analyze.js       outages, metrics, distributions, findings, filters, merging
shared/prompts.js       prompts for Claude: design a new log type, text -> CSV of a log type
server/server.js        HTTP server: static files + /api
server/store/           storage (index.js) in MongoDB (mongo.js), duplicate key per entry, migration of German data (migrate.js)
public/                 UI: js/app.js (analysis), js/editor.js (log types), js/charts.js (SVG)
tools/convert.js        log -> CSV on the command line: node tools/convert.js <schema.json> <input> [output.csv]
test/                   npm test (fixtures in test/fixtures)
```
