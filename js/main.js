/* ═══════════════════════════════════════════════════════════════════════════
   main.js — belépési pont

   Csak összeköt: indulás, nézetváltás, és a felület eseményeinek bekötése.
   Üzleti logika NINCS benne — az a többi modulban lakik. Ha ez a fájl elkezd
   nőni, az annak a jele, hogy valami rossz helyre került.
   ═══════════════════════════════════════════════════════════════════════════ */

import { settings, saveSettings, cache, getLastPlayed, getProgress } from './store.js';
import * as native from './native.js';
import { buildLibrary, loadSubtitles } from './library.js';
import { parseSrt, findSubtitleFile } from './srt.js';
import * as P from './player.js';
import { openReader, closeReader, applyLang, applyFontSize, replaceRows } from './reader.js';
import { cloud, onCloudChange, isPaired, pair, unpair, sync, startAutoSync } from './cloud.js';
import { getSeriesCover } from './covers.js';

const $ = id => document.getElementById(id);

const app = {
  folder: null,      // { name, treeUri, audio: [], text: [] }
  episodes: [],
  series: [],
  currentSeries: null,
  view: 'library',

  // A folyamatos lejátszáshoz: melyik listából és hányadik részt játsszuk.
  playlist: [],
  playIndex: -1,
};

/* ─────────────────────────── nézetváltás ─────────────────────────── */

function showView(name) {
  app.view = name;
  for (const id of ['library', 'series', 'settings']) {
    $(`view-${id}`).classList.toggle('on', id === name);
  }
  $('btn-back').hidden = (name === 'library');
  $('brand').hidden = (name !== 'library');
  $('main').scrollTop = 0;
}

$('btn-back').addEventListener('click', () => {
  if (app.view === 'series' || app.view === 'settings') showView('library');
});
$('btn-settings').addEventListener('click', () => {
  showView(app.view === 'settings' ? 'library' : 'settings');
  renderSettings();
});

/* ─────────────────────────── üzenetek ─────────────────────────── */

let toastTimer = null;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('on'), 2400);
}

/* ─────────────────────────── könyvtár megjelenítése ─────────────────────────── */

function fmtDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} ó ${m} p` : `${m} perc`;
}

function renderLibrary() {
  const hasFolder = !!app.folder;
  $('first-run').hidden = hasFolder;
  $('folder-card').hidden = !hasFolder;

  if (hasFolder) {
    const magyar = app.episodes.filter(e => e.hasHu).length;
    const csakAngol = app.episodes.filter(e => !e.hasHu && (e.hasEn || e.hasCloudSubs)).length;
    $('folder-info').textContent =
      `${app.folder.name} · ${app.episodes.length} rész · ${magyar} magyar`
      + (csakAngol ? ` · ${csakAngol} csak angol` : '');
  }

  renderHero();

  const list = $('series-list');
  list.innerHTML = '';
  $('library-empty').hidden = !(hasFolder && app.episodes.length === 0);

  const grid = document.createElement('div');
  grid.className = 'cover-grid';

  for (const s of app.series) {
    const done = s.finished;
    const arany = s.episodes.length ? (done / s.episodes.length) * 100 : 0;

    const btn = document.createElement('button');
    btn.className = 'cover-tile';
    btn.innerHTML = `
      <div class="cover-art">
        <img alt="">
        ${done ? `<span class="done">${done} kész</span>` : ''}
        ${arany > 0 ? `<span class="bar"><i style="width:${arany}%"></i></span>` : ''}
      </div>
      <div class="cover-name">${escapeHtml(s.name)}</div>
      <div class="cover-sub">${s.episodes.length} rész · ${s.ready} feliratos</div>`;
    btn.addEventListener('click', () => openSeries(s));
    grid.appendChild(btn);

    // A borító betöltése NEM várakoztatja meg a listát: a rács azonnal
    // megjelenik, a képek pedig ahogy elkészülnek, beúsznak a helyükre.
    // Egy beágyazott borító kiolvasása fájlonként pár száz ezredmásodperc, és
    // sorozatonként csak egyszer fut le — utána a tárolóból jön.
    const img = btn.querySelector('img');
    getSeriesCover(s, app.folder)
      .then(url => { if (url) { img.src = url; img.classList.add('on'); } })
      .catch(err => console.warn('Borító:', s.name, err));
  }

  list.appendChild(grid);
}

function renderHero() {
  const last = getLastPlayed();
  const hero = $('hero');
  if (!last) { hero.hidden = true; return; }

  const ep = app.episodes.find(e => e.key === last.key);
  if (!ep) { hero.hidden = true; return; }

  const prog = getProgress(ep.key);
  const ratio = prog.duration > 0 ? prog.position / prog.duration : 0;

  $('hero-title').textContent = ep.title;
  $('hero-meta').textContent =
    `${ep.series} · ${fmtDuration(prog.position)} / ${fmtDuration(prog.duration || ep.duration)}`;
  $('hero-bar-fill').style.width = `${Math.min(100, ratio * 100)}%`;
  hero.hidden = false;

  $('hero-play').onclick = () => openEpisode(ep);
}

function openSeries(series) {
  app.currentSeries = series;
  $('series-name').textContent = series.name;
  $('series-meta').textContent = `${series.episodes.length} rész · ${series.ready} feliratos`;

  const list = $('episode-list');
  list.innerHTML = '';

  for (const ep of series.episodes) {
    const prog = getProgress(ep.key);
    const ratio = prog.duration > 0 ? prog.position / prog.duration : 0;
    const finished = ratio > 0.97;

    const badge = ep.hasHu
      ? '<span class="badge hu">magyar</span>'
      : (ep.hasEn || ep.hasCloudSubs)
        ? '<span class="badge en">csak angol</span>'
        : '<span class="badge none">nincs felirat</span>';
    const doneBadge = finished ? '<span class="badge done">kész</span>' : '';

    const btn = document.createElement('button');
    btn.className = 'tile';
    btn.innerHTML = `
      <div class="tile-title">${escapeHtml(ep.title)}${badge}${doneBadge}</div>
      <div class="tile-sub">${fmtDuration(prog.duration || ep.duration) || 'ismeretlen hossz'}${
        prog.position > 30 && !finished ? ` · itt tartasz: ${fmtDuration(prog.position)}` : ''}</div>
      ${ratio > 0 ? `<div class="tile-bar"><i style="width:${Math.min(100, ratio * 100)}%"></i></div>` : ''}`;
    btn.addEventListener('click', () => openEpisode(ep));
    list.appendChild(btn);
  }

  showView('series');
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ─────────────────────────── epizód megnyitása ─────────────────────────── */

async function openEpisode(episode, lista = null) {
  // A lejátszási lista alapból az aktuális sorozat részei, abban a sorrendben,
  // ahogy a listában látod.
  app.playlist = lista || (app.currentSeries ? app.currentSeries.episodes : app.episodes);
  app.playIndex = app.playlist.indexOf(episode);

  toast('Betöltés…');
  try {
    const { rows, source } = await loadSubtitles(episode, app.folder, {
      findSubtitleFile, readText: native.readText, parseSrt,
    });

    // A pozíció a felhőből is jöhetett, ezért közvetlenül indulás előtt kérjük le.
    episode.position = getProgress(episode.key).position;

    await P.load(episode, rows);
    openReader(episode, rows, source, exitReader, rows.length ? null : () => keszitsFeliratot(episode));

    if (settings.keepAwake) native.keepAwake(true);
    await P.play();
  } catch (err) {
    console.error(err);
    toast(`Nem sikerült megnyitni: ${err.message}`);
  }
}

/* ─────────────────────────── szükség-fordító ───────────────────────────

   Csak akkor lép működésbe, ha kifejezetten kéred, és a modult is csak ekkor
   töltjük be (dinamikus import). Így az olvasó indulási ideje nem függ tőle,
   és ha valami baja van, az olvasás attól még hibátlanul működik.
   ─────────────────────────────────────────────────────────────── */

let forditasFut = false;

async function keszitsFeliratot(episode) {
  if (forditasFut) { toast('Már fut egy feliratozás.'); return; }

  if (!settings.groqKey) {
    showView('settings');
    renderSettings();
    toast('Előbb add meg a Groq API-kulcsot a beállításokban.');
    return;
  }

  const rendben = confirm(
`Elkészítsem itt a feliratot?

A telefonos felismerés gyengébb, mint a gépes, és mobilneten adatot fogyaszt.
Egy egyórás rész néhány percig tart.`);
  if (!rendben) return;

  forditasFut = true;
  try {
    const { feliratotKeszit } = await import('./asr.js');

    // A hangot a lejátszás forrásából vesszük: telefonon a helyi kiszolgálótól,
    // böngészőben a kiválasztott fájlból.
    toast('Hangfájl előkészítése…');
    const url = await native.audioUrl(episode.file);
    const blob = await (await fetch(url)).blob();
    native.releaseAudioUrl(url);

    const rows = await feliratotKeszit(episode, blob, settings.groqKey,
      (szakasz, szazalek) => toast(`${szakasz} — ${szazalek}%`));

    replaceRows(rows, 'telefonon készült');
    P.player.rows = rows;
    episode.hasCloudSubs = true;
    toast(`Kész: ${rows.length} mondat.`);
  } catch (err) {
    console.error(err);
    toast(err.message);
  } finally {
    forditasFut = false;
  }
}

/* ─────────────────────────── folyamatos lejátszás ───────────────────────────

   Ha egy rész véget ér, magától jön a következő — ugyanabban a sorrendben,
   ahogy a listában látod. Ez az alapértelmezett viselkedés: sorozatot az ember
   végighallgat, nem epizódonként indítgat újra.

   Megáll, ha:
     · elfogyott a sorozat,
     · vagy kiléptél az olvasóból (a kilépés törli a listát).
   ─────────────────────────────────────────────────────────────── */

let lancFut = false;

async function kovetkezoResz() {
  if (lancFut) return;
  if (!app.playlist.length || app.playIndex < 0) return;

  const kov = app.playlist[app.playIndex + 1];
  if (!kov) {
    toast('Ez volt a sorozat utolsó része.');
    return;
  }

  lancFut = true;
  try {
    toast(`Következik: ${kov.title}`);
    // Rövid szünet, hogy a lezáró mondat még leülepedjen, és lásd az üzenetet.
    await new Promise(r => setTimeout(r, 1200));
    await openEpisode(kov, app.playlist);
  } catch (err) {
    console.error(err);
    toast(`Nem sikerült a következő rész: ${err.message}`);
  } finally {
    lancFut = false;
  }
}

P.on('ended', () => {
  // Csak akkor lépünk tovább, ha tényleg az olvasóban vagyunk. Ha közben
  // kiléptél, a lejátszó leállítása is 'ended'-et adhat — abból ne induljon
  // el a következő rész.
  if (!$('reader').hidden) kovetkezoResz();
});

function exitReader() {
  app.playlist = [];
  app.playIndex = -1;
  P.pause();
  P.unload();
  closeReader();
  native.keepAwake(false);
  refreshFromFolder();          // frissüljenek a haladásjelzők
  showView(app.currentSeries ? 'series' : 'library');
  if (app.currentSeries) openSeries(app.currentSeries);
}

// Az Android vissza-gombja az olvasóból a könyvtárba lépjen, ne zárja be az appot.
document.addEventListener('backbutton', e => { e.preventDefault(); handleBack(); });
window.addEventListener('popstate', () => handleBack());
function handleBack() {
  if (!$('reader').hidden) exitReader();
  else if (app.view !== 'library') showView('library');
}

/* ─────────────────────────── mappa ─────────────────────────── */

async function pickFolder() {
  try {
    toast('Mappa kiválasztása…');
    const folder = await native.pickFolder(msg => toast(msg));
    if (!folder) return;
    await useFolder(folder);
    toast(`${app.episodes.length} rész beolvasva.`);
  } catch (err) {
    console.error(err);
    toast(`Hiba a mappa beolvasásakor: ${err.message}`);
  }
}

async function useFolder(folder) {
  app.folder = folder;
  await cache.setLibrary(folder);
  await refreshFromFolder();
  await lookForPairingFile(folder);
}

async function refreshFromFolder() {
  if (!app.folder) return;
  const index = await cache.getIndex();
  const built = buildLibrary(app.folder, index);
  app.episodes = built.episodes;
  app.series = built.series;
  renderLibrary();
}

/**
 * Ha a gépes program kiírta a subcast_cloud.json fájlt a podcast-mappába, akkor
 * USB-s másolás után az itt van — párosítsunk vele magunktól, hogy ne kelljen
 * kódot másolgatni telefonra.
 */
async function lookForPairingFile(folder) {
  if (isPaired()) return;
  const file = (folder.text || []).find(t => t.name === 'subcast_cloud.json');
  if (!file) return;
  try {
    const text = await native.readText(file);
    await pair(text);
    toast('Párosítva a géppel a mappában talált kód alapján.');
    sync();
  } catch (e) {
    console.warn('Automatikus párosítás nem sikerült:', e);
  }
}

$('btn-pick-folder').addEventListener('click', pickFolder);
$('btn-rescan').addEventListener('click', async () => {
  toast('Újraolvasás…');
  const folder = await native.rescanFolder(msg => toast(msg)) || await native.pickFolder(msg => toast(msg));
  if (folder) { await useFolder(folder); toast('Kész.'); }
});

/* ─────────────────────────── szinkron ─────────────────────────── */

$('btn-sync').addEventListener('click', async () => {
  if (!isPaired()) { showView('settings'); renderSettings(); toast('Előbb párosítsd a géppel.'); return; }
  const res = await sync({ force: false });
  if (res.ok) await refreshFromFolder();
  toast(cloud.message);
});

onCloudChange(state => {
  const dot = $('sync-dot');
  dot.className = 'dot ' + ({ busy: 'busy', ok: 'ok', error: 'err' }[state.state] || '');
  if (app.view === 'settings') renderCloudState();
});

/* ─────────────────────────── beállítások ─────────────────────────── */

function renderCloudState() {
  const box = $('cloud-state');
  if (!isPaired()) {
    box.className = 'state-row';
    box.textContent = 'Nincs párosítva.';
    $('btn-unpair').hidden = true;
    return;
  }
  box.className = 'state-row ' + (cloud.state === 'error' ? 'err' : 'ok');
  const when = cloud.lastSync ? new Date(cloud.lastSync).toLocaleTimeString('hu-HU') : 'még nem futott';
  box.textContent = `${settings.pair.login} · ${cloud.message || 'kész'} · ${when}`;
  $('btn-unpair').hidden = false;
}

function renderSettings() {
  renderCloudState();
  $('groq-key').value = settings.groqKey || '';
  $('claude-key').value = settings.claudeKey || '';
  markSeg('seg-claude-model', settings.claudeModel);
  markSeg('seg-font', settings.fontSize);
  markSeg('seg-lang', settings.lang);
  markSeg('seg-haptics', settings.haptics);
  markSeg('seg-awake', settings.keepAwake);
  $('about-info').textContent =
    `SubCast Olvasó · ${native.platformName()} · ${app.episodes.length} rész a könyvtárban`;
}

function markSeg(id, value) {
  for (const btn of $(id).querySelectorAll('button')) {
    btn.classList.toggle('on', String(btn.dataset.v) === String(value));
  }
}

function bindSeg(id, apply) {
  $(id).addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    apply(btn.dataset.v);
    markSeg(id, btn.dataset.v);
  });
}

bindSeg('seg-font', v => applyFontSize(+v));
bindSeg('seg-lang', v => applyLang(v));
bindSeg('seg-haptics', v => {
  saveSettings({ haptics: +v });
  native.setHaptics(+v);
  native.haptic(1.4);          // azonnal érezd, mit választottál
});

bindSeg('seg-awake', v => {
  saveSettings({ keepAwake: +v });
  native.keepAwake(+v === 1 && !$('reader').hidden);
});

$('btn-pair').addEventListener('click', async () => {
  const code = $('pair-input').value.trim();
  try {
    const login = await pair(code);
    $('pair-input').value = '';
    toast(`Párosítva: ${login}. Szinkronizálás…`);
    renderCloudState();
    const res = await sync({ force: true });
    if (res.ok) await refreshFromFolder();
    toast(cloud.message);
  } catch (err) {
    toast(err.message);
  }
});

$('btn-pair-file').addEventListener('click', async () => {
  if (!app.folder) { toast('Előbb válaszd ki a podcast-mappát.'); return; }
  const file = (app.folder.text || []).find(t => t.name === 'subcast_cloud.json');
  if (!file) { toast('Nincs subcast_cloud.json a mappában. A gépes programban kattints a „Párosító kód megjelenítése" gombra.'); return; }
  $('pair-input').value = await native.readText(file);
  toast('Kód betöltve — nyomd meg a Párosítás gombot.');
});

bindSeg('seg-claude-model', v => saveSettings({ claudeModel: v }));

$('btn-save-claude').addEventListener('click', () => {
  saveSettings({ claudeKey: $('claude-key').value.trim() });
  toast(settings.claudeKey
    ? 'Claude-kulcs elmentve — mostantól ezzel fordít a Google helyett.'
    : 'Claude-kulcs törölve — a fordítás visszaáll a Google-re.');
});

$('btn-save-groq').addEventListener('click', () => {
  saveSettings({ groqKey: $('groq-key').value.trim() });
  toast(settings.groqKey ? 'Groq-kulcs elmentve.' : 'Groq-kulcs törölve.');
});

$('btn-unpair').addEventListener('click', () => {
  unpair();
  renderCloudState();
  toast('Párosítás törölve.');
});

/* ─────────────────────────── indulás ─────────────────────────── */

async function boot() {
  applyFontSize(settings.fontSize);
  applyLang(settings.lang);
  native.setHaptics(settings.haptics);

  // 1) A korábbi könyvtár azonnal — hogy ne legyen üres képernyő indításkor.
  const saved = await cache.getLibrary();
  if (saved) {
    app.folder = saved;
    await refreshFromFolder();
  } else {
    renderLibrary();
  }

  // 2) Telefonon a mappajogosultság tartós: olvassuk újra a háttérben, hátha
  //    új fájlokat másoltál rá azóta.
  if (native.isNative()) {
    const current = await native.currentFolder();
    if (current) {
      native.rescanFolder(() => {})
        .then(folder => { if (folder) return useFolder(folder); })
        .catch(err => console.warn('Háttér-újraolvasás:', err));
    }
  }

  // 3) Szinkron
  if (isPaired()) {
    sync({ quiet: true }).then(res => { if (res.ok) refreshFromFolder(); });
  }
  startAutoSync(() => P.isPlaying());

  native.reacquireWakeLockOnVisible(() => settings.keepAwake === 1 && !$('reader').hidden);

  showView('library');
}

boot().catch(err => {
  console.error('Indulási hiba:', err);
  toast(`Indulási hiba: ${err.message}`);
});
