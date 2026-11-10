# Logalyzer

Web app for analysing logs of any kind by **log types** (schemas). Node backend (`node:http`, only dependency `mongodb`) with a REST API under `/api`, UI in `public/` (vanilla JS, no build), data in MongoDB. Run: `docker compose up -d --build` (app + MongoDB, http://localhost:3000). Development: `docker compose up -d mongo`, then `npm run dev` (default `MONGO_URL=mongodb://localhost:27017/logalyzer`). MongoDB is the only storage, there is no file storage. No log types are shipped; the user creates them in the app.
Machine: Windows, PowerShell 5.1, Node, Docker Desktop. No Python. `Set-Content -Encoding UTF8` writes a BOM in PS 5.1: for JSON/JS files use the Write tool or `[IO.File]::WriteAllText` with `UTF8Encoding($false)`.
All code, identifiers, comments, UI texts and docs are in English.

`shared/schema.js`, `shared/analyze.js` and `shared/prompts.js` are UMD modules: server and CLI load them via `require`, the browser as `<script>` under `/shared/`. No ES modules, no Node APIs in them. Schema format and API are documented in `README.md`.

## When the user pastes a log into the chat

1. Write the text unchanged (keep tabs) to `imports/<name>.<log|csv|jsonl>` (git-ignored).
2. Find a matching log type with the server running: `POST /api/detect` (body = text). If a type fits (≥ 50 % of the lines), continue with 4.
3. If none fits: design a new log type.
   - CSV/JSON lines: `POST /api/schema/infer` suggests fields; pick fields, set names/types/display flags.
   - Text log: `format.type = "regex"` with named groups; derived fields via `rules` and `mappings` (example: `test/fixtures/network.json`).
   - If there are outage/recovery messages: set `state`.
   - Check with `POST /api/schema/test` `{ schema, text }` (matched, skipped, errors), then `PUT /api/types/<id>`. Agree on the draft with the user first (which columns do they need?).
4. Check duplicates first: `POST /api/check` `{ text, type }` returns `new` and `existing`; tell the user if everything is already stored. Import (duplicates are always skipped): `Invoke-RestMethod -Method Post "http://localhost:3000/api/t/<type>/import?name=<name>" -ContentType "text/plain; charset=utf-8" -Body (Get-Content imports\<file> -Raw -Encoding UTF8)`. Without a server: `node tools/convert.js <schema.json> imports/<file> imports/<name>.csv`.
5. Report skipped lines and entries of the fallback rule (`fallback` in the response); summarise the result (range, count, `GET /api/t/<type>/findings`).

## Prompts in the app

`shared/prompts.js` builds the prompts the user sends to Claude (e.g. claude.ai): `logTypePrompt` (editor «Set up with Claude», reply = schema JSON, applied with `schemaFromReply`) and `csvPrompt` (import dialog, text -> CSV with field names as header; `parse` reads it as `csv-export`). When the schema format changes, update the prompt text; `test/prompts.test.js` checks that a CSV in prompt form is detected and read.

## Changing rules

After changes to `shared/schema.js`, `shared/analyze.js` or the fixtures: `npm test`. The tests use the synthetic fixtures in `test/fixtures/` (`network.json`/`.log`: regex, rules, mappings, state; `monitoring.json`/`.csv`: CSV with column mapping).
A changed log type in the running app is updated via `PUT /api/types/<id>`; existing entries are not re-read. There is deliberately no «delete data» and no replace mode; only `DELETE /api/types/<id>` removes a type with its entries (only when the user explicitly asks for it).

## Storage

MongoDB only. `server/store/index.js` keeps types and (on access) the entries per type in memory and caches outages/findings; `server/store/mongo.js` writes. Collections: `types` (`_id` = id), `events` `{ type, seq, time, k, d }` (`no` is computed from `time, seq` when loading), `sources` `{ type, name, count, dupes, … }`, `read_findings` `{ type, k, sev, tag, title, text, at }`, `notes` `{ type, field, value, note, at }` (notes on field values; display only, shown in brackets next to the value in the UI; never written into events, never used by analysis, search or export).
Duplicates: `k` = SHA-1 of `eventKey` (all field values) + `#` + occurrence in the import; unique index `{ type, k }`, insert with `ordered: false`, duplicate errors 11000 are counted. Entries without `k` get one on startup.
`server/store/migrate.js` + `MongoBackend.migrateGerman()` convert data of the earlier German version once on startup (schema keys, field `zeit` -> `time`, collection `gelesen` -> `read_findings`); user-chosen field names and values stay.
`test/store.test.js` runs against `mongodb://localhost:27017/logalyzer_test` (or `MONGO_URL`), drops this test DB afterwards and is skipped if no MongoDB is running.

## Analysis

`shared/analyze.js`: outages per `state.keys`; within the same minute «down» counts before «up». Findings return `{ sev, tag, title, text, focus, k }`; `focus` sets range/search/state in the UI, `k` (`findingKey`, from tag + title) identifies a finding for «mark as read». Findings must be worded schema-independently (field names via `label`).
