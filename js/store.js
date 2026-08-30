/* ═══════════════════════════════════════════════════════════════════════════
   store.js — állapot és megőrzés

   KÉT TÁROLÓ, KÉT OKBÓL
   ---------------------
   localStorage : beállítások és a lejátszási haladás. Kicsi, szinkron elérésű,
                  és indításkor azonnal kell — nem várhatunk rá.
   IndexedDB    : könyvtár és feliratok. A 620 epizód feliratanyaga kicsomagolva
                  több tíz megabájt; a localStorage 5 MB-os korlátjába nem fér
                  bele, és a korábbi változat pont ezen bukott el csendben.
   ═══════════════════════════════════════════════════════════════════════════ */

const LS_SETTINGS = 'subcast.settings';
const LS_PROGRESS = 'subcast.progress';
const LS_BEAT = 'subcast.beat';
const LS_LAST = 'subcast.last';

const DB_NAME = 'subcast';
const DB_VERSION = 2;

/* ─────────────────────────── IndexedDB vékony réteg ─────────────────────── */

let _dbPromise = null;

function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('subs')) d.createObjectStore('subs');
      // A borítóképek külön tárolóban: nagyok, és a feliratoktól függetlenül
      // ürítjük vagy építjük újra.
      if (!d.objectStoreNames.contains('covers')) d.createObjectStore('covers');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    // FONTOS: a get/put IDBRequest-et ad vissza, aminek a `result` mezője a
    // tényleges érték. Ha hiányzó kulcsot kérünk, ez a mező `undefined` — ilyenkor
    // is az `undefined`-ot kell visszaadni, NEM magát a kérésobjektumot. (Ezen
    // csúszott el az első változat: a hiányzó könyvtár igaz értéknek látszott,
    // és az app azt hitte, van már beolvasott mappa.)
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const idb = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  set: (store, key, value) => tx(store, 'readwrite', s => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),
  keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
};

/* ─────────────────────────── beállítások ─────────────────────────── */

const DEFAULT_SETTINGS = {
  fontSize: 22,
  lang: 'both',        // 'hu' | 'both' | 'en'
  keepAwake: 1,
  haptics: 12,                       // rezgés ezredmásodpercben, 0 = kikapcsolva
  pair: null,          // { token, gistId }
  deviceName: 'telefon',
  groqKey: '',                       // felismeréshez (Groq Whisper)
  claudeKey: '',                     // fordításhoz, a Google helyett
  claudeModel: 'claude-opus-5',      // ha van Claude-kulcs, ezzel fordít
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {
    console.warn('Nem sikerült menteni:', key, e);
  }
}

export const settings = Object.assign({}, DEFAULT_SETTINGS, readJSON(LS_SETTINGS, {}));

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  writeJSON(LS_SETTINGS, settings);
}

/* ─────────────────────────── haladás ───────────────────────────

   Alakja: { kulcs: [másodperc, időbélyeg, hossz] }

   Az IDŐBÉLYEG a lényeg: ez dönti el a géppel való összefésülésnél, hogy a
   telefonos vagy a gépes pozíció a frissebb. Nélküle a szinkron csak találgatna.
   ─────────────────────────────────────────────────────────────── */

export const progress = readJSON(LS_PROGRESS, {});

export function getProgress(key) {
  const p = progress[key];
  if (!p) return { position: 0, ts: 0, duration: 0 };
  return { position: p[0] || 0, ts: p[1] || 0, duration: p[2] || 0 };
}

export function setProgress(key, position, duration = 0, ts = null) {
  if (!key) return;
  const prev = progress[key];
  progress[key] = [
    Math.max(0, Math.round(position * 100) / 100),
    ts !== null ? ts : Date.now() / 1000,
    duration || (prev ? prev[2] : 0) || 0,
  ];
  writeJSON(LS_PROGRESS, progress);
}

/** A géptől kapott pozíciót csak akkor fogadjuk el, ha frissebb a miénknél. */
export function mergeRemoteProgress(remote) {
  let changed = 0;
  for (const [key, value] of Object.entries(remote || {})) {
    const pos = Number(value[0]);
    const ts = Number(value[1]);
    if (!isFinite(pos) || !isFinite(ts)) continue;

    const mine = progress[key];
    const mineTs = mine ? mine[1] || 0 : 0;
    // Az 1 másodperces ráhagyás megakadályozza, hogy a két eszköz órájának
    // apró eltérése miatt oda-vissza írogassuk ugyanazt az értéket.
    if (ts > mineTs + 1) {
      progress[key] = [pos, ts, mine ? mine[2] : 0];
      changed++;
    }
  }
  if (changed) writeJSON(LS_PROGRESS, progress);
  return changed;
}

/** Amit a telefon felküld a gépnek. */
export function progressForUpload() {
  const out = {};
  for (const [key, value] of Object.entries(progress)) {
    if (value[0] > 0) out[key] = [value[0], value[1]];
  }
  return out;
}

/* ─────────────────────────── legutóbb hallgatott ─────────────────────────── */

export function getLastPlayed() { return readJSON(LS_LAST, null); }
export function setLastPlayed(entry) { writeJSON(LS_LAST, entry); }

/* ─────────────────────────── felhő-állapot ─────────────────────────── */

export function getBeat() { return readJSON(LS_BEAT, {}); }
export function setBeat(beat) { writeJSON(LS_BEAT, beat || {}); }

/* ─────────────────────────── könyvtár és feliratok ─────────────────────────── */

export const cache = {
  /** A beolvasott mappa (fájllista, mappanév, tartós URI). */
  getLibrary: () => idb.get('kv', 'library'),
  setLibrary: (lib) => idb.set('kv', 'library', lib),

  /** A géptől kapott epizód-metaadatok. */
  getIndex: () => idb.get('kv', 'cloudIndex'),
  setIndex: (idx) => idb.set('kv', 'cloudIndex', idx),

  /** Egy epizód feliratsorai: [[kezdet, vég, magyar, angol], …] */
  getSubs: (key) => idb.get('subs', key),
  setSubs: (key, rows) => idb.set('subs', key, rows),
  subKeys: () => idb.keys('subs'),
  clearSubs: () => idb.clear('subs'),

  /** Borítóképek: kulcs = sorozatnév, érték = data: URL (vagy null, ha nincs). */
  getCover: (key) => idb.get('covers', key),
  setCover: (key, value) => idb.set('covers', key, value),
  clearCovers: () => idb.clear('covers'),

  /** Egyszerre több epizód feliratának mentése (egy csomag kicsomagolásakor). */
  async setManySubs(map) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('subs', 'readwrite');
      const s = t.objectStore('subs');
      for (const [key, rows] of Object.entries(map)) s.put(rows, key);
      t.oncomplete = () => resolve(Object.keys(map).length);
      t.onerror = () => reject(t.error);
    });
  },
};

/* ─────────────────────────── azonosító kulcs ───────────────────────────

   A gép és a telefon ugyanabból a fájlnévből képzi: kiterjesztés nélkül,
   kisbetűsen. Ez az egyetlen kapocs a két eszköz között, ezért a két
   megvalósításnak SZÓ SZERINT egyeznie kell (lásd cloud_sync_service.py).
   ─────────────────────────────────────────────────────────────── */

export function syncKey(filename) {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base.trim().toLowerCase();
}
