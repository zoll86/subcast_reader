/* ═══════════════════════════════════════════════════════════════════════════
   cloud.js — szinkron a géppel, GitHub Gist-en keresztül

   MIÉRT NEM EGYSZERŰEN LETÖLTJÜK AZ EGÉSZET
   -----------------------------------------
   A gist API `GET /gists/{id}` hívása MINDEN fájl tartalmát visszaadja — nálunk
   ez tíz megabájt körül van. Ha ezt kérdezgetnénk percenként, egy óra alatt
   elfogyasztaná a mobilkeretet.

   Ezért a gép egy `beat.json` nevű, pár száz bájtos fájlt is felrak, amiben csak
   REVÍZIÓSZÁMOK vannak. A telefon ezt kérdezi le sűrűn, és csak azt tölti le,
   aminek a revíziója megváltozott. Egy új fordítás után tehát egyetlen csomag
   jön át, nem az egész könyvtár.

   A fájlokat a gist NYERS (raw) címéről töltjük, nem az API-n át: az API-válasz
   mindig az összes fájlt tartalmazza, a nyers cím viszont pontosan egy fájlt ad.
   Titkos gist nyers címe azonosítás nélkül is elérhető, ezért ezekre a kérésekre
   nem teszünk tokent — így nem indul fölösleges CORS-előkérés sem.

   KI MIT ÍR
   ---------
   A gép írja:    beat.json, positions.json, index.json, bundle_NN.txt
   A telefon írja: phone.json
   Soha nem írják ugyanazt a fájlt, tehát nincs írásütközés.
   ═══════════════════════════════════════════════════════════════════════════ */

import { settings, saveSettings, getBeat, setBeat, cache,
         mergeRemoteProgress, progressForUpload } from './store.js';

const API = 'https://api.github.com';
const RAW = 'https://gist.githubusercontent.com';

export const cloud = {
  state: 'idle',      // 'idle' | 'busy' | 'ok' | 'error' | 'off'
  message: '',
  lastSync: 0,
};

const listeners = new Set();
export function onCloudChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(state, message) {
  cloud.state = state;
  cloud.message = message || '';
  listeners.forEach(fn => { try { fn(cloud); } catch (e) { console.warn(e); } });
}

export function isPaired() {
  return !!(settings.pair && settings.pair.token && settings.pair.gistId);
}

/* ─────────────────────────── párosítás ─────────────────────────── */

/**
 * A gépes program által mutatott kód: base64({"t": token, "g": gistId}).
 * Elfogadjuk a nyers JSON-t is (a subcast_cloud.json fájl tartalmát).
 */
export async function pair(codeOrJson) {
  const raw = (codeOrJson || '').trim();
  if (!raw) throw new Error('Nincs beillesztve kód.');

  let token = '';
  let gistId = '';

  // 1) nyers JSON (a mappába kiírt subcast_cloud.json)
  try {
    const obj = JSON.parse(raw);
    token = obj.token || obj.t || '';
    gistId = obj.gist_id || obj.g || '';
  } catch {
    // 2) base64-be csomagolt párosító kód
    try {
      const decoded = atob(raw.replace(/\s+/g, ''));
      const obj = JSON.parse(decoded);
      token = obj.t || obj.token || '';
      gistId = obj.g || obj.gist_id || '';
    } catch {
      throw new Error('A kód nem értelmezhető. Másold be újra a gépes programból.');
    }
  }

  if (!token || !gistId) throw new Error('A kódból hiányzik a token vagy a gist azonosítója.');

  // Ellenőrizzük, hogy a token él, és megjegyezzük a felhasználónevet:
  // a nyers címek felépítéséhez kell.
  const user = await api('GET', '/user', null, token);
  if (!user || !user.login) throw new Error('A token nem érvényes.');

  saveSettings({ pair: { token, gistId, login: user.login } });
  emit('idle', `Párosítva: ${user.login}`);
  return user.login;
}

export function unpair() {
  saveSettings({ pair: null });
  setBeat({});
  emit('off', 'A párosítás törölve.');
}

/* ─────────────────────────── hálózat ─────────────────────────── */

async function api(method, path, body, tokenOverride) {
  const token = tokenOverride || (settings.pair && settings.pair.token);
  const res = await fetch(API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) throw new Error('A token lejárt vagy visszavonták.');
  if (res.status === 404) throw new Error('A gist nem található — párosíts újra.');
  if (!res.ok) throw new Error(`GitHub hiba ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Egyetlen fájl a gist nyers címéről.
 * A `cb` paraméter a gyorsítótár megkerülésére kell: a nyers címeket a GitHub
 * öt percig gyorsítótárazza, enélkül a friss fordítás késve érkezne meg.
 */
async function raw(filename, { cacheBust = false } = {}) {
  const { login, gistId } = settings.pair;
  const url = `${RAW}/${login}/${gistId}/raw/${filename}${cacheBust ? `?_=${Date.now()}` : ''}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;          // még nem hozta létre a gép
  if (!res.ok) throw new Error(`Nem tölthető le: ${filename} (${res.status})`);
  return res.text();
}

/* ─────────────────────────── tömörítés ─────────────────────────── */

/** A gép gzip+base64 alakban tölti fel az indexet és a feliratcsomagokat. */
async function gunzipJson(b64) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Ez az Android-változat nem tud gzip-et kicsomagolni. Frissítsd az Android System WebView-t a Play Áruházból.');
  }
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/* ─────────────────────────── a szinkron maga ─────────────────────────── */

let running = false;

/**
 * Egy teljes szinkron-kör.
 * @param {boolean} force  Minden fájlt újratölt, a revíziószámokra fittyet hányva.
 */
export async function sync({ force = false, quiet = false } = {}) {
  if (!isPaired()) { emit('off', 'Nincs párosítva.'); return { ok: false, reason: 'unpaired' }; }
  if (running) return { ok: false, reason: 'busy' };

  running = true;
  if (!quiet) emit('busy', 'Szinkronizálás…');

  const summary = { positions: 0, index: false, bundles: 0, covers: 0, pushed: false };

  try {
    const beatText = await raw('beat.json', { cacheBust: true });
    if (!beatText) {
      emit('error', 'A gép még nem töltött fel semmit. Indítsd el a gépes SubCastot.');
      return { ok: false, reason: 'empty' };
    }

    const beat = JSON.parse(beatText);
    const known = force ? {} : getBeat();

    // 1) pozíciók — ez a legkisebb és a legfontosabb
    if (beat.pos_rev && beat.pos_rev !== known.pos_rev) {
      const posText = await raw('positions.json', { cacheBust: true });
      if (posText) {
        const parsed = JSON.parse(posText);
        summary.positions = mergeRemoteProgress(parsed.pos || {});
      }
    }

    // 2) epizód-metaadatok
    if (beat.index_rev && beat.index_rev !== known.index_rev) {
      const indexB64 = await raw('index.json', { cacheBust: true });
      if (indexB64) {
        await cache.setIndex(await gunzipJson(indexB64));
        summary.index = true;
      }
    }

    // 3) borítóképek — a gép küldi, mert ő tud utánuk keresni a neten is
    if (beat.covers_rev && beat.covers_rev !== known.covers_rev) {
      const b64 = await raw('covers.txt', { cacheBust: true });
      if (b64) {
        const covers = await gunzipJson(b64);
        for (const [sorozat, kep] of Object.entries(covers)) {
          // A géptől jövő borító FELÜLÍRJA a helyben kiolvasottat és a
          // generált helyettesítőt is: a gépen te hagytad jóvá, tehát az a jó.
          await cache.setCover(sorozat, `data:image/jpeg;base64,${kep}`);
          summary.covers++;
        }
      }
    }

    // 4) feliratcsomagok — csak a megváltozottak
    const knownBundles = known.bundles || {};
    for (const [name, rev] of Object.entries(beat.bundles || {})) {
      if (knownBundles[name] === rev) continue;
      if (!quiet) emit('busy', `Feliratok letöltése (${summary.bundles + 1}/${Object.keys(beat.bundles).length})…`);
      const b64 = await raw(name, { cacheBust: true });
      if (!b64) continue;
      await cache.setManySubs(await gunzipJson(b64));
      summary.bundles++;
    }

    setBeat(beat);

    // 5) a saját pozícióink felküldése
    summary.pushed = await pushPositions();

    cloud.lastSync = Date.now();
    emit('ok', describe(summary));
    return { ok: true, summary };

  } catch (err) {
    console.warn('Szinkron hiba:', err);
    emit('error', err.message || 'Szinkronhiba');
    return { ok: false, reason: 'error', error: err };
  } finally {
    running = false;
  }
}

function describe(s) {
  const parts = [];
  if (s.bundles) parts.push(`${s.bundles} feliratcsomag`);
  if (s.index) parts.push('könyvtár frissült');
  if (s.covers) parts.push(`${s.covers} borító`);
  if (s.positions) parts.push(`${s.positions} pozíció a gépről`);
  if (s.pushed) parts.push('haladás felküldve');
  return parts.length ? parts.join(' · ') : 'Már naprakész.';
}

/* ─────────────────────────── haladás felküldése ─────────────────────────── */

let lastPushedJson = '';

/** Csak akkor ír a gist-be, ha tényleg változott valami. */
export async function pushPositions(force = false) {
  if (!isPaired()) return false;

  const payload = {
    device: settings.deviceName || 'telefon',
    updated_at: Date.now() / 1000,
    pos: progressForUpload(),
  };
  const fingerprint = JSON.stringify(payload.pos);
  if (!force && fingerprint === lastPushedJson) return false;

  await api('PATCH', `/gists/${settings.pair.gistId}`, {
    files: { 'phone.json': { content: JSON.stringify(payload) } },
  });
  lastPushedJson = fingerprint;
  return true;
}

/* ─────────────────────────── ütemezés ───────────────────────────

   Nem állandó időzítővel dolgozunk, hanem eseményekre:
     · alkalmazásindításkor,
     · valahányszor előtérbe kerül az app (ilyenkor van értelme frissíteni),
     · lejátszás közben ritkábban, hogy a gépen látszódjon, hol tartunk.
   Így háttérben nem fogyaszt semmit.
   ─────────────────────────────────────────────────────────────── */

let timer = null;

export function startAutoSync(getIsPlaying) {
  stopAutoSync();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPaired()) sync({ quiet: true });
  });

  timer = setInterval(() => {
    if (!isPaired() || document.visibilityState !== 'visible') return;
    // Lejátszás közben elég a saját pozíciónkat felküldeni; a teljes kör
    // fölösleges hálózati forgalom lenne.
    if (getIsPlaying()) pushPositions().catch(() => {});
    else sync({ quiet: true });
  }, 60_000);
}

export function stopAutoSync() {
  if (timer) { clearInterval(timer); timer = null; }
}
