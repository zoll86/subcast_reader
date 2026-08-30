/* ═══════════════════════════════════════════════════════════════════════════
   player.js — hanglejátszás és felirat-követés

   Egyetlen <audio> elemet kezel. Nem tud a felületről semmit: eseményeket ad ki,
   és a reader.js dönti el, mit rajzol belőlük.

   HOL TARTOK — a mentés szabálya
   ------------------------------
   A pozíciót nem minden másodpercben mentjük (fölösleges írás), és nem is csak
   kilépéskor (mert az Android bármikor megölheti az appot). A megoldás: öt
   másodpercenként, valamint MINDEN olyan pillanatban, ami után az app eltűnhet
   — szüneteltetés, epizódváltás, háttérbe kerülés, lap bezárása.
   ═══════════════════════════════════════════════════════════════════════════ */

import { setProgress, setLastPlayed } from './store.js';
import { audioUrl, releaseAudioUrl } from './native.js';

const el = document.getElementById('audio');

export const player = {
  episode: null,
  rows: [],
  activeIndex: -1,
  ready: false,
};

let currentUrl = null;
let lastSaved = 0;

/* ─────────────────────────── események ─────────────────────────── */

const handlers = { tick: [], active: [], state: [], ended: [] };
export function on(event, fn) { handlers[event].push(fn); return () => {
  const i = handlers[event].indexOf(fn); if (i >= 0) handlers[event].splice(i, 1);
}; }
function fire(event, ...args) {
  for (const fn of handlers[event]) { try { fn(...args); } catch (e) { console.warn(e); } }
}

/* ─────────────────────────── betöltés ─────────────────────────── */

export async function load(episode, rows, startAt = null) {
  await saveNow();
  if (currentUrl) { releaseAudioUrl(currentUrl); currentUrl = null; }

  player.episode = episode;
  player.rows = rows || [];
  player.activeIndex = -1;
  player.ready = false;

  currentUrl = await audioUrl(episode.file);
  el.src = currentUrl;
  el.playbackRate = rate;

  // A pozíció visszaállítása csak akkor lehetséges, ha a böngésző már ismeri a
  // fájl hosszát — ezért várunk a metaadatokra.
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('A hangfájl nem játszható le.')); };
    const cleanup = () => {
      el.removeEventListener('loadedmetadata', ok);
      el.removeEventListener('error', bad);
    };
    el.addEventListener('loadedmetadata', ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });

  const target = startAt != null ? startAt : (episode.position || 0);
  if (target > 0 && target < el.duration - 2) el.currentTime = target;

  player.ready = true;
  setLastPlayed({ key: episode.key, title: episode.title, series: episode.series });
  fire('state');
}

export function unload() {
  el.pause();
  el.removeAttribute('src');
  el.load();
  if (currentUrl) { releaseAudioUrl(currentUrl); currentUrl = null; }
  player.episode = null;
  player.rows = [];
  player.activeIndex = -1;
  player.ready = false;
}

/* ─────────────────────────── vezérlés ─────────────────────────── */

export function isPlaying() { return !el.paused && !el.ended && el.readyState > 2; }
export function duration() { return el.duration || player.episode?.duration || 0; }
export function currentTime() { return el.currentTime || 0; }

export async function play() {
  try { await el.play(); } catch (e) { console.warn('Lejátszás elutasítva:', e); }
  fire('state');
}

export function pause() {
  el.pause();
  saveNow();
  fire('state');
}

export function toggle() { isPlaying() ? pause() : play(); }

export function seek(seconds) {
  if (!isFinite(seconds)) return;
  el.currentTime = Math.max(0, Math.min(seconds, (el.duration || 0) - 0.3));
  syncActive(true);
}

export function nudge(delta) { seek(el.currentTime + delta); }

let rate = 1.0;
const RATES = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5];
export function cycleRate() {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  el.playbackRate = rate;
  return rate;
}
export function getRate() { return rate; }

/* ─────────────────────────── mondatléptetés ─────────────────────────── */

export function jumpSentence(direction) {
  const rows = player.rows;
  if (!rows.length) { nudge(direction * 15); return; }

  const now = el.currentTime;
  let index = findRow(now);

  if (direction < 0) {
    // Ha épp az elején vagyunk, az ELŐZŐ mondatra ugrunk; ha a közepén, akkor
    // ennek az elejére. Ez az, amit olvasás közben elvár az ember.
    if (index < 0) index = 0;
    else if (now - rows[index][0] < 1.2) index = Math.max(0, index - 1);
  } else {
    index = index < 0 ? 0 : Math.min(rows.length - 1, index + 1);
  }

  seek(rows[index][0] + 0.02);
}

/** Melyik feliratsor szól most? Bináris keresés — 1700 sornál is azonnali. */
function findRow(time) {
  const rows = player.rows;
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= time) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  // Ha a talált sor már véget ért és rés van a következőig, maradjon az utolsó:
  // olvasás közben kevésbé zavaró, mint eltűnő kiemelés.
  return found;
}

function syncActive(force = false) {
  const index = findRow(el.currentTime);
  if (index !== player.activeIndex || force) {
    player.activeIndex = index;
    fire('active', index);
  }
}

/* ─────────────────────────── haladás mentése ─────────────────────────── */

export async function saveNow() {
  const ep = player.episode;
  if (!ep || !el.duration) return;
  const t = el.currentTime;
  if (t <= 0) return;
  setProgress(ep.key, t, el.duration);
  ep.position = t;
  lastSaved = t;
}

/* ─────────────────────────── bekötés ─────────────────────────── */

el.addEventListener('timeupdate', () => {
  syncActive();
  fire('tick', el.currentTime, el.duration || 0);
  if (Math.abs(el.currentTime - lastSaved) >= 5) saveNow();
});

el.addEventListener('play', () => fire('state'));
el.addEventListener('pause', () => fire('state'));
el.addEventListener('ended', () => { saveNow(); fire('ended'); fire('state'); });

// Az Android bármikor kilőheti a háttérbe került appot — mentsünk azonnal.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});
window.addEventListener('pagehide', () => saveNow());
