/* ═══════════════════════════════════════════════════════════════════════════
   library.js — a könyvtár összeállítása

   HÁROM FORRÁSBÓL LESZ EGY LISTA
   ------------------------------
   1. a telefon mappája      → mely hangfájlok vannak ténylegesen a kezünkben
   2. a gépről kapott index  → cím, sorozat, hossz, van-e magyar felirat
   3. a mappában talált .srt → tartalék felirat, ha nincs (vagy még nincs) felhő

   Az összekötő kapocs a KULCS: a fájlnév kiterjesztés nélkül, kisbetűsen.
   A gép ugyanígy képzi (lásd cloud_sync_service.py `_sync_key`), ezért ugyanaz
   az epizód mindkét oldalon ugyanazt a kulcsot kapja.

   Ami a mappában megvan, de a gép nem ismeri, attól még megjelenik — csak nem
   lesz hozzá felirat. Ami a gép szerint létezik, de a mappában nincs, azt nem
   mutatjuk: nem tudnánk lejátszani.
   ═══════════════════════════════════════════════════════════════════════════ */

import { syncKey, getProgress, cache } from './store.js';

const EGYEB = 'Egyéb';

/**
 * @param {object} folder  a native.pickFolder eredménye
 * @param {object|null} cloudIndex  a gépről kapott index ({items: [...]})
 * @returns {{episodes: Array, series: Array}}
 */
export function buildLibrary(folder, cloudIndex) {
  const meta = new Map();
  for (const item of (cloudIndex && cloudIndex.items) || []) {
    meta.set(item.k, item);
  }

  const episodes = [];

  for (const audio of folder.audio || []) {
    const key = syncKey(audio.name);
    if (!key) continue;

    const m = meta.get(key);
    const prog = getProgress(key);

    episodes.push({
      key,
      file: audio,                                   // amivel lejátszható
      title: (m && m.t) || prettyTitle(audio.name),
      series: (m && m.s) || seriesFromPath(audio.path),
      number: m ? m.n : null,
      duration: (m && m.d) || prog.duration || 0,
      // A "van felirat" és a "van MAGYAR felirat" két külön dolog. A Magnus
      // Archives-nál például csak angol átirat készült el eddig: van feliratsor,
      // de magyar szöveg nincs benne. Ha a kettőt összemossuk, a telefon
      // magyarnak jelzi azt, ami nem az.
      hasCloudSubs: !!(m && m.sub),
      hasHu: !!(m && m.hu),
      hasEn: !!(m && m.en),
      position: prog.position,
      positionTs: prog.ts,
    });
  }

  // Rendezés: sorozaton belül epizódszám, annak híján fájlnév szerint.
  episodes.sort((a, b) => {
    if (a.series !== b.series) return a.series.localeCompare(b.series, 'hu');
    if (a.number != null && b.number != null) return a.number - b.number;
    return a.file.name.localeCompare(b.file.name, 'hu', { numeric: true });
  });

  return { episodes, series: groupSeries(episodes) };
}

function groupSeries(episodes) {
  const map = new Map();

  for (const ep of episodes) {
    let s = map.get(ep.series);
    if (!s) {
      s = { name: ep.series, episodes: [], ready: 0, finished: 0, started: 0 };
      map.set(ep.series, s);
    }
    s.episodes.push(ep);
    if (ep.hasHu) s.ready++;
    const ratio = ep.duration > 0 ? ep.position / ep.duration : 0;
    if (ratio > 0.97) s.finished++;
    else if (ep.position > 30) s.started++;
  }

  return [...map.values()].sort((a, b) => b.episodes.length - a.episodes.length);
}

/** "S1E10.mp3" → "S1E10";  "002_-_1_-_Pilot.mp3" → "002 - 1 - Pilot" */
function prettyTitle(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return base.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** A sorozat neve a mappaszerkezetből, ha a gép nem tud róla. */
function seriesFromPath(path) {
  if (!path) return EGYEB;
  const parts = path.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : EGYEB;
}

/* ─────────────────────────── feliratok betöltése ─────────────────────────── */

/**
 * Egy epizód feliratsorai. Először a felhőből (IndexedDB), utána a mappában
 * talált .srt fájlból. Ha egyik sincs, üres tömböt ad — az olvasó ilyenkor
 * elmondja, hogy ehhez a részhez még nincs fordítás.
 */
export async function loadSubtitles(episode, folder, deps) {
  const fromCloud = await cache.getSubs(episode.key);
  if (fromCloud && fromCloud.length) return { rows: fromCloud, source: 'felhő' };

  const file = deps.findSubtitleFile(episode.file, folder.text || []);
  if (file) {
    try {
      const text = await deps.readText(file);
      const rows = deps.parseSrt(text, 'hu');
      if (rows.length) {
        // Eltesszük, hogy legközelebb ne kelljen újra beolvasni a fájlt.
        await cache.setSubs(episode.key, rows);
        return { rows, source: 'mappa' };
      }
    } catch (e) {
      console.warn('SRT beolvasás sikertelen:', e);
    }
  }

  return { rows: [], source: 'nincs' };
}
