'use strict';
/*
 * Storage in MongoDB.
 *
 * Collections
 *   types          one document per log type (schema), _id = id
 *   events         { type, seq, time, k, d: { field values without "no" } }
 *                  seq = insertion order per type; "no" is computed from (time, seq) when loading
 *                  k   = duplicate key: hash of all field values + "#" + occurrence (1, 2, …).
 *                        Unique index { type, k }: the same entry never ends up twice in the database,
 *                        not even with concurrent imports. If a line occurs several times in a log, the
 *                        occurrence is counted, so genuine repetitions are kept.
 *   sources        { type, name, format, count, dupes, at } per import
 *   read_findings  { type, k, sev, tag, title, text, at } findings marked as read (k = findingKey)
 */
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const A = require('../../shared/analyze.js');
const { migrateSchema } = require('./migrate.js');

const DUP = 11000;
const hash = (e) => crypto.createHash('sha1').update(A.eventKey(e)).digest('base64url');

class MongoBackend {
  constructor(url, dbName, opts) {
    this.kind = 'mongo';
    this.url = url;
    this.dbName = dbName || undefined;
    this.retries = (opts && opts.retries) || 30;
  }
  describe() { return this.url.replace(/\/\/[^@/]*@/, '//***@'); }

  async init() {
    this.client = new MongoClient(this.url, { serverSelectionTimeoutMS: 2000 });
    for (let i = 1; ; i++) {
      try { await this.client.connect(); break; } catch (e) {
        if (i >= this.retries) throw new Error(`MongoDB at ${this.describe()} is not reachable: ${e.message}`);
        console.log(`Waiting for MongoDB (${i}/${this.retries}) …`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.db = this.client.db(this.dbName || this.client.options.dbName || 'logalyzer');
    this.types = this.db.collection('types');
    this.events = this.db.collection('events');
    this.sources = this.db.collection('sources');
    this.read = this.db.collection('read_findings');
    await this.migrateGerman();
    await this.addMissingKeys();
    await this.events.createIndex({ type: 1, time: 1, seq: 1 });
    await this.events.createIndex({ type: 1, seq: -1 });
    await this.events.createIndex({ type: 1, k: 1 }, { unique: true, name: 'duplicates' });
    await this.sources.createIndex({ type: 1, at: 1 });
    await this.read.createIndex({ type: 1, k: 1 }, { unique: true });
  }
  async close() { if (this.client) await this.client.close(); }

  /**
   * One-time migration of databases written by the German version (schema keys such as "felder",
   * field "zeit", collection "gelesen"). Runs only if such data exists; afterwards it is a no-op.
   */
  async migrateGerman() {
    const oldTypes = await this.types.find({ felder: { $exists: true } }).toArray();
    const oldEvents = await this.events.countDocuments({ typ: { $exists: true } });
    const oldSources = await this.sources.countDocuments({ typ: { $exists: true } });
    const names = (await this.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    if (!oldTypes.length && !oldEvents && !oldSources && !names.includes('gelesen')) return;
    console.log('Migrating data from the German version …');

    for (const t of oldTypes) {
      const s = migrateSchema(t);
      await this.types.replaceOne({ _id: t._id }, Object.assign({ _id: s.id }, s));
    }
    if (oldEvents) {
      // Old indexes refer to "typ"/"zeit"; the duplicate keys change with the field names and are recomputed.
      for (const ix of await this.events.indexes().catch(() => [])) if (ix.name !== '_id_') await this.events.dropIndex(ix.name);
      await this.events.updateMany({ typ: { $exists: true } }, { $rename: { typ: 'type', zeit: 'time', 'd.zeit': 'd.time' }, $unset: { k: '' } });
      console.log(`  ${oldEvents} events converted.`);
    }
    if (oldSources) {
      for (const ix of await this.sources.indexes().catch(() => [])) if (ix.name !== '_id_') await this.sources.dropIndex(ix.name);
      await this.sources.updateMany({ typ: { $exists: true } }, { $rename: { typ: 'type', anzahl: 'count', doppelt: 'dupes' } });
    }
    if (names.includes('gelesen')) {
      const old = await this.db.collection('gelesen').find({}).toArray();
      for (const g of old) {
        await this.read.updateOne({ type: g.typ, k: g.k }, { $set: { type: g.typ, k: g.k, sev: g.sev, tag: g.tag, title: g.titel, text: g.text, at: g.at } }, { upsert: true });
      }
      await this.db.collection('gelesen').drop();
    }
    console.log(`  ${oldTypes.length} log types converted.`);
  }

  /** Add duplicate keys to entries that have none (older versions); duplicates are removed on the way. */
  async addMissingKeys() {
    const types = await this.events.distinct('type', { k: { $exists: false } });
    for (const type of types) {
      const docs = await this.events.find({ type }).sort({ seq: 1 }).toArray();
      const count = new Map(), ops = [];
      for (const x of docs) {
        const h = hash(x.d), n = (count.get(h) || 0) + 1;
        count.set(h, n);
        ops.push({ updateOne: { filter: { _id: x._id }, update: { $set: { k: h + '#' + n } } } });
      }
      if (ops.length) await this.events.bulkWrite(ops, { ordered: false });
      console.log(`Duplicate keys added for ${ops.length} entries of «${type}».`);
    }
  }

  async listTypes() {
    const docs = await this.types.find({}).toArray();
    return docs.map((d) => { const s = Object.assign({}, d); delete s._id; return s; });
  }
  async saveType(schema) { await this.types.replaceOne({ _id: schema.id }, Object.assign({ _id: schema.id }, schema), { upsert: true }); }
  async deleteType(id) {
    await this.types.deleteOne({ _id: id });
    await this.events.deleteMany({ type: id });
    await this.sources.deleteMany({ type: id });
    await this.read.deleteMany({ type: id });
  }

  // ---------- Read findings ----------
  async listRead(type) { return this.read.find({ type }, { projection: { _id: 0, type: 0 } }).sort({ at: -1 }).toArray(); }
  async setRead(type, b) { await this.read.replaceOne({ type, k: b.k }, Object.assign({ type }, b), { upsert: true }); }
  async deleteRead(type, k) { return (await this.read.deleteOne({ type, k })).deletedCount; }

  async loadAll(type) {
    const docs = await this.events.find({ type }, { projection: { d: 1 } }).sort({ time: 1, seq: 1 }).toArray();
    const events = docs.map((x, i) => Object.assign({ no: i + 1 }, x.d));
    const sources = await this.sources.find({ type }, { projection: { _id: 0, type: 0 } }).sort({ at: 1 }).toArray();
    return { events, sources };
  }

  /** Keys per entry in reading order: hash + occurrence within this import. */
  static keys(list) {
    const count = new Map();
    return list.map((e) => {
      const d = Object.assign({}, e); delete d.no;
      const h = hash(d), n = (count.get(h) || 0) + 1;
      count.set(h, n);
      return { k: h + '#' + n, d };
    });
  }

  /** How many entries of an import are already in the database (nothing is stored). */
  async countExisting(type, list) {
    const ks = MongoBackend.keys(list).map((x) => x.k);
    let n = 0;
    for (let i = 0; i < ks.length; i += 5000) n += await this.events.countDocuments({ type, k: { $in: ks.slice(i, i + 5000) } });
    return n;
  }

  /** Inserts only entries whose key is missing. Returns { added, dupes }. */
  async insert(type, list, source) {
    const docs = MongoBackend.keys(list);
    const last = await this.events.find({ type }, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
    let seq = last.length ? last[0].seq : 0;
    let added = 0;
    for (let i = 0; i < docs.length; i += 5000) {
      const batch = docs.slice(i, i + 5000).map((x) => ({ type, seq: ++seq, time: x.d.time, k: x.k, d: x.d }));
      try {
        added += (await this.events.insertMany(batch, { ordered: false })).insertedCount;
      } catch (e) {
        const errs = e.writeErrors ? [].concat(e.writeErrors) : null;
        if (!errs || errs.some((w) => (w.code || (w.err && w.err.code)) !== DUP)) throw e;
        added += e.insertedCount != null ? e.insertedCount : (e.result && e.result.insertedCount) || batch.length - errs.length;
      }
    }
    const dupes = docs.length - added;
    await this.sources.insertOne(Object.assign({ type }, source, { count: added, dupes }));
    return { added, dupes };
  }
}

module.exports = MongoBackend;
