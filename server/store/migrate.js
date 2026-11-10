'use strict';
/*
 * Converts a log type (schema) of the German version into the English format.
 * Only the structure is translated (keys, field types, the main time field "zeit" -> "time").
 * Field names, labels and values chosen by the user are data and stay as they are.
 */
const TYPE = { zeit: 'time', text: 'text', kategorie: 'category', zahl: 'number' };

/** Renames the field "zeit" to "time" in names, templates ({zeit}) and regex groups (?<zeit>). */
const rn = (name) => (name === 'zeit' ? 'time' : name);
const rnText = (s) => (typeof s === 'string' ? s.replace(/\{zeit\}/g, '{time}').replace(/\(\?<zeit>/g, '(?<time>').replace(/\$<zeit>/g, '$<time>') : s);

function template(v) {
  if (v == null || typeof v !== 'object') return rnText(v);
  const t = { template: rnText(v.vorlage != null ? v.vorlage : v.template || '') };
  const rep = v.ersetze || v.replace;
  if (rep) t.replace = rep;
  if (v.trim != null) t.trim = v.trim;
  const fb = v.sonst != null ? v.sonst : v.fallback;
  if (fb != null) t.fallback = rnText(fb);
  return t;
}

function migrateSchema(old) {
  const s = { id: old.id || old._id, name: old.name };
  if (old.beschreibung) s.description = old.beschreibung;
  if (old.beispiel) s.sample = old.beispiel;
  const f = old.format || {};
  s.format = { type: f.art || f.type || 'csv' };
  if (f.trennzeichen != null) s.format.delimiter = f.trennzeichen;
  if (f.muster != null) s.format.pattern = rnText(f.muster);
  if (f.flags != null) s.format.flags = f.flags;

  s.fields = (old.felder || []).map((x) => {
    const o = { name: rn(x.name), label: x.label, type: TYPE[x.typ] || x.typ };
    // In regex format the source is a group name, and the group (?<zeit>) was renamed above.
    // CSV columns and JSON paths are names in the log itself and stay unchanged.
    if (x.quelle) o.source = s.format.type === 'regex' ? rn(x.quelle) : x.quelle;
    if (x.format) o.format = x.format;
    if (x.filter) o.filter = true;
    if (x.diagramm) o.chart = true;
    if (x.tabelle) o.table = true;
    return o;
  });

  if (old.regeln) {
    s.rules = old.regeln.map((r) => {
      const o = {};
      if (r.feld) o.field = rn(r.feld);
      if (r.muster) o.pattern = r.muster;
      if (r.flags != null) o.flags = r.flags;
      o.set = {};
      for (const [k, v] of Object.entries(r.setze || {})) o.set[rn(k)] = template(v);
      return o;
    });
  }
  if (old.abbildungen) {
    s.mappings = {};
    for (const [k, a] of Object.entries(old.abbildungen)) {
      const o = { values: (a.werte || []).map((w) => ({ pattern: w.muster, value: w.wert })) };
      if (a.sonst != null) o.fallback = a.sonst;
      if (a.flags != null) o.flags = a.flags;
      s.mappings[rn(k)] = o;
    }
  }
  if (old.zustand) {
    const z = old.zustand;
    s.state = { field: rn(z.feld), down: z.ab || [], up: z.auf || [], keys: (z.schluessel || []).map(rn) };
    if (z.bezeichnung) s.state.label = template(z.bezeichnung);
    if (z.gruppe) s.state.group = rn(z.gruppe);
    if (z.bezug) s.state.related = rn(z.bezug);
  }
  return s;
}

module.exports = { migrateSchema };
