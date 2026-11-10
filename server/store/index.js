'use strict';
/*
 * Storage: MongoDB (backend in mongo.js).
 *   MONGO_URL  connection, default mongodb://localhost:27017/logalyzer (Docker: mongodb://mongo:27017/logalyzer)
 *   MONGO_DB   database name, default taken from the URL
 *
 * Log types (schemas) and events per type. The events of a type are loaded on first access
 * and kept in memory; outages/findings are cached.
 * Imports are always merged: entries that are already stored are skipped.
 */
const S = require('../../shared/schema.js');
const A = require('../../shared/analyze.js');
const MongoBackend = require('./mongo.js');

const DEFAULT_URL = 'mongodb://localhost:27017/logalyzer';

class Store {
  constructor(backend) {
    this.b = backend;
    this.types = new Map();
    this.data = new Map();    // type -> { events, sources }
    this.derived = new Map(); // type -> { outages, findings }
  }
  get kind() { return this.b.kind; }
  describe() { return this.b.describe(); }

  async init() {
    await this.b.init();
    for (const s of await this.b.listTypes()) this.types.set(s.id, s);
  }
  async close() { if (this.b.close) await this.b.close(); }

  // ---------- Types ----------
  listTypes() { return [...this.types.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')); }
  getType(id) { return this.types.get(id) || null; }
  async saveType(schema) {
    const err = S.validate(schema);
    if (err.length) { const e = new Error('Invalid schema: ' + err.join(' ')); e.status = 400; e.details = err; throw e; }
    const clean = JSON.parse(JSON.stringify(schema));
    await this.b.saveType(clean);
    this.types.set(clean.id, clean);
    this.derived.delete(clean.id);
    return clean;
  }
  async deleteType(id) {
    await this.b.deleteType(id);
    this.types.delete(id);
    this.data.delete(id);
    this.derived.delete(id);
  }

  // ---------- Events ----------
  async get(type) {
    if (!this.data.has(type)) this.data.set(type, await this.b.loadAll(type));
    return this.data.get(type);
  }
  async reload(type) { this.data.set(type, await this.b.loadAll(type)); this.derived.delete(type); }
  async analysis(type) {
    if (!this.derived.has(type)) {
      const schema = this.getType(type);
      const { events } = await this.get(type);
      const outages = A.outages(events, schema);
      this.derived.set(type, { outages, findings: A.findings(events, outages, schema) });
    }
    return this.derived.get(type);
  }

  // ---------- Read findings ----------
  listRead(type) { return this.b.listRead(type); }
  /** Marks a finding as read; the state at the time of reading is stored. */
  async markRead(type, b) {
    const doc = { k: String(b.k || ''), sev: String(b.sev || 'info'), tag: String(b.tag || ''), title: String(b.title || ''), text: String(b.text || ''), at: new Date().toISOString() };
    if (!doc.k) { const e = new Error('Finding without key k.'); e.status = 400; throw e; }
    await this.b.setRead(type, doc);
    return doc;
  }
  unmarkRead(type, k) { return this.b.deleteRead(type, k); }

  /** Duplicate check without storing: { new, existing }. */
  async checkDuplicates(type, res) {
    const existing = await this.b.countExisting(type, res.events);
    return { new: res.events.length - existing, existing };
  }

  /** Stores a parser result; entries that are already stored are skipped. */
  async importParsed(type, res, name) {
    const src = { name, format: res.format || '', at: new Date().toISOString() };
    const r = await this.b.insert(type, res.events, src);
    await this.reload(type);
    return r;
  }
}

function createStore(env, opts) {
  env = env || process.env;
  return new Store(new MongoBackend(env.MONGO_URL || DEFAULT_URL, env.MONGO_DB, opts));
}

module.exports = { Store, createStore, DEFAULT_URL };
