/* ═══════════════════════════════════════════════════════════════════════════
   reader.js — az olvasófelület

   Ez a képernyő, amit hallgatás közben nézel, ezért itt minden döntés arról
   szól, hogy ne vonja el a figyelmet.

   A KEZELŐK ELTŰNNEK. Lejátszás közben három másodperc után lecsúszik a
   lejátszósáv és elhalványulnak a zónafeliratok: csak a szöveg marad. Egy
   koppintás a képernyő tetején vagy alján visszahozza őket.

   AZ ÉRINTÉS ZÓNÁKRA OSZLIK, nem gombokra. Olvasás közben nem akarsz apró
   gombokat célozni:
       bal 30 %    → előző mondat
       jobb 30 %   → következő mondat
       közép 40 %  → szünet / folytatás
       fent / lent → a kezelők előhívása

   A GÖRGETÉS KÖZÉPRE IGAZÍT, nem a tetejére: az éppen hangzó mondat a képernyő
   közepén áll meg, így a következő kettő-három sor előre látszik, és marad idő
   elolvasni, mielőtt elhangzik.
   ═══════════════════════════════════════════════════════════════════════════ */

import { settings, saveSettings } from './store.js';
import * as P from './player.js';
import { haptic } from './native.js';

const dom = {
  reader: document.getElementById('reader'),
  flow: document.getElementById('reader-flow'),
  dock: document.getElementById('dock'),
  seek: document.getElementById('seek'),
  seekFill: document.getElementById('seek-fill'),
  seekKnob: document.getElementById('seek-knob'),
  timeNow: document.getElementById('time-now'),
  timeAll: document.getElementById('time-all'),
  play: document.getElementById('p-play'),
  rate: document.getElementById('p-rate'),
  lang: document.getElementById('p-lang'),
  exit: document.getElementById('p-exit'),
  prev: document.getElementById('p-prev'),
  next: document.getElementById('p-next'),
  status: document.getElementById('dock-status'),
  zoneLeft: document.getElementById('zone-left'),
  zoneRight: document.getElementById('zone-right'),
  zoneCenter: document.getElementById('zone-center'),
  title: document.getElementById('head-title'),
  titleMain: document.getElementById('head-title-main'),
  titleSub: document.getElementById('head-title-sub'),
};

const LANG_LABEL = { hu: 'magyar', both: 'kétnyelvű', en: 'angol' };

let pairNodes = [];
let suppressClick = false;

/** Ennyi időn belül érkező második koppintás számít duplának. */
const DUPLA_MS = 260;
let dupplaVar = null;
let hideTimer = null;
let onExit = () => {};
let onMakeSubs = null;
let scrolling = false;

/* ─────────────────────────── megnyitás / bezárás ─────────────────────────── */

export function openReader(episode, rows, source, exitCallback, makeSubsCallback) {
  onExit = exitCallback || (() => {});
  onMakeSubs = makeSubsCallback || null;

  dom.reader.hidden = false;
  applyLang(settings.lang);
  applyFontSize(settings.fontSize);

  dom.titleMain.textContent = episode.title;
  dom.titleSub.textContent = episode.series;
  dom.title.hidden = false;

  renderRows(rows, source);
  showControls();
  flashHints();
  updateDock();
}

export function closeReader() {
  dom.reader.hidden = true;
  dom.title.hidden = true;
  clearTimeout(hideTimer);
  dom.flow.innerHTML = '';
  pairNodes = [];
}

/* ─────────────────────────── a szöveg kirajzolása ─────────────────────────── */

function renderRows(rows, source) {
  dom.flow.innerHTML = '';
  pairNodes = [];

  if (!rows.length) {
    const box = document.createElement('div');
    box.className = 'pair on';

    const cim = document.createElement('div');
    cim.className = 'hu';
    cim.textContent = 'Ehhez a részhez még nincs magyar felirat.';

    const magyarazat = document.createElement('div');
    magyarazat.className = 'en';
    magyarazat.textContent = 'A gépen futó SubCast készíti el; amint kész, magától ideérkezik. '
      + 'Addig is hallgathatod — a lejátszás és a hol-tartok mentése működik.';

    box.append(cim, magyarazat);

    if (onMakeSubs) {
      const gomb = document.createElement('button');
      gomb.className = 'btn small';
      gomb.style.marginTop = 'var(--sp4)';
      gomb.textContent = 'Készítsek itt feliratot?';
      // A zónakattintás ne szüneteltesse a lejátszást, amikor a gombra bökünk.
      gomb.addEventListener('click', e => { e.stopPropagation(); onMakeSubs(); });
      box.appendChild(gomb);
    }

    dom.flow.appendChild(box);
    dom.status.textContent = 'nincs felirat';
    return;
  }

  // Egyetlen töredékbe építjük, hogy 1700 sornál se akadjon meg a felület.
  const frag = document.createDocumentFragment();
  rows.forEach((row, index) => {
    const node = document.createElement('div');
    node.className = 'pair';
    node.dataset.index = index;

    const hu = document.createElement('div');
    hu.className = 'hu';
    hu.textContent = row[2] || '';
    node.appendChild(hu);

    const enText = row[3] || '';
    if (enText) {
      const en = document.createElement('div');
      en.className = 'en';
      en.textContent = enText;
      node.appendChild(en);
    }

    frag.appendChild(node);
    pairNodes.push(node);
  });

  dom.flow.appendChild(frag);
  dom.status.textContent = `${rows.length} mondat · ${source}`;
}

/* ─────────────────────────── az aktív mondat ─────────────────────────── */

let activeNode = null;

function setActive(index) {
  if (activeNode) activeNode.classList.remove('on');
  activeNode = pairNodes[index] || null;
  if (!activeNode) return;
  activeNode.classList.add('on');
  centerOn(activeNode);
}

/* ── A SZÖVEG KÖZÉPRE GÖRGETÉSE ──

   Saját animáció, nem a beépített `behavior: 'smooth'`.

   Miért: a lágy görgetés böngészőnként és beágyazott WebView-nként másképp
   viselkedik — mérve akadt olyan környezet, ahol EGYÁLTALÁN nem csinál semmit,
   így a szöveg soha nem mozdult, az aktív mondat pedig fokozatosan lecsúszott a
   képernyő aljára. A requestAnimationFrame-es változat mindenhol ugyanúgy fut,
   megszakítható, és mi szabjuk meg a lassítás ütemét.

   Abszolút célpontra megyünk, nem relatív eltolással: így akárhányszor hívjuk,
   ugyanoda érkezünk, és a hibák nem adódnak össze. */

let scrollAnim = 0;

function animateScrollTo(target, duration = 420) {
  cancelAnimationFrame(scrollAnim);

  const max = dom.flow.scrollHeight - dom.flow.clientHeight;
  const to = Math.max(0, Math.min(target, max));
  const from = dom.flow.scrollTop;
  const dist = to - from;

  if (Math.abs(dist) < 2) return;

  // Nagy ugrásnál (tekerés, mondatléptetés messzire) ne kússzon oda lassan.
  if (Math.abs(dist) > dom.flow.clientHeight * 2.5) {
    dom.flow.scrollTop = to;
    return;
  }

  // Ha a lap nem látszik (az app háttérben van, vagy a képernyő alszik), a
  // böngésző felfüggeszti a requestAnimationFrame-et — az animáció el sem
  // indulna, és a szöveg ott maradna, ahol volt. Ilyenkor ugorjunk azonnal:
  // mire visszanézel, már a helyén lesz.
  if (document.visibilityState === 'hidden') {
    dom.flow.scrollTop = to;
    return;
  }

  const startedAt = performance.now();
  const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const step = now => {
    const p = Math.min(1, (now - startedAt) / duration);
    dom.flow.scrollTop = from + dist * ease(p);
    if (p < 1) scrollAnim = requestAnimationFrame(step);
  };
  scrollAnim = requestAnimationFrame(step);
}

function centerOn(node) {
  if (scrolling) return;
  animateScrollTo(node.offsetTop + node.offsetHeight / 2 - dom.flow.clientHeight / 2);
}

/* ─────────────────────────── kezelők elrejtése ─────────────────────────── */

function showControls() {
  dom.reader.classList.add('controls');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (P.isPlaying()) dom.reader.classList.remove('controls');
  }, 3200);
}

function hideControls() {
  clearTimeout(hideTimer);
  dom.reader.classList.remove('controls');
}

/** Az érintészónák felvillantása — rövid emlékeztető, nem állandó felirat. */
let hintTimer = null;
function flashHints() {
  dom.reader.classList.add('hints');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => dom.reader.classList.remove('hints'), 1600);
}

/* ─────────────────────────── lejátszósáv ─────────────────────────── */

function fmt(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function updateDock() {
  const now = P.currentTime();
  const all = P.duration();
  const ratio = all > 0 ? Math.min(1, now / all) : 0;

  dom.seekFill.style.width = `${ratio * 100}%`;
  dom.seekKnob.style.left = `${ratio * 100}%`;
  dom.timeNow.textContent = fmt(now);
  dom.timeAll.textContent = fmt(all);
  dom.play.textContent = P.isPlaying() ? '❚❚' : '▶';
  dom.rate.textContent = `${P.getRate().toFixed(2).replace('.', ',').replace(/,00$/, ',0')}×`;
  dom.lang.textContent = LANG_LABEL[settings.lang];
}

/* ─────────────────────────── megjelenítési beállítások ─────────────────────────── */

export function applyLang(lang) {
  dom.reader.classList.remove('lang-hu', 'lang-en', 'lang-both');
  dom.reader.classList.add(`lang-${lang}`);
  saveSettings({ lang });
  updateDock();
}

export function applyFontSize(px) {
  document.documentElement.style.setProperty('--read-size', `${px}px`);
  saveSettings({ fontSize: px });
}

function cycleLang() {
  const order = ['hu', 'both', 'en'];
  applyLang(order[(order.indexOf(settings.lang) + 1) % order.length]);
  if (activeNode) centerOn(activeNode);
}

/* ─────────────────────────── bekötés ─────────────────────────── */

P.on('active', setActive);
P.on('tick', updateDock);
P.on('state', () => {
  // A LEJÁTSZÁS ÁLLAPOTVÁLTOZÁSA SOHA NEM HOZZA ELŐ A KEZELŐKET.
  //
  // Sem a szüneteltetés, sem a folytatás. Középre koppintva azért állítod meg a
  // hangot, hogy elolvashasd a szöveget — ha ilyenkor felúszna a lejátszósáv,
  // épp az alsó sorokat takarná el. A folytatás pedig azért nem hozhatja elő,
  // mert így két gyors koppintás (szünet, majd folytatás) mindig felvillantotta
  // a menüt, holott egyiket sem azért nyomtad meg.
  //
  // A kezelők KIZÁRÓLAG akkor jelennek meg, ha kifejezetten kéred: a képernyő
  // felső vagy alsó centiméterére koppintva, vagy amikor megnyitod az olvasót.
  updateDock();
});

/* ── ÉRINTÉSZÓNÁK ──
   A koppintást a szövegterület kapja el, és abból számoljuk ki, melyik zónába
   esett. Így a szöveg ugyanazzal az ujjal görgethető is marad — ha külön
   lefedő réteg kezelné a zónákat, az elnyelné a görgetést.
   A `click` csak valódi koppintásra sül el, húzás után nem. */
dom.flow.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }

  const rect = dom.reader.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;

  if (x < 0.30) { P.jumpSentence(-1); flash(dom.zoneLeft); return; }
  if (x > 0.70) { P.jumpSentence(1); flash(dom.zoneRight); return; }

  /* ── KÖZÉP: egy koppintás szünet, DUPLA koppintás a kezelők ──
     A kezelőket korábban a képernyő felső és alsó centiméterére koppintva
     lehetett előhívni. Ez telefonon nem működött: az alsó sáv az Android
     gesztus-területe, a felső az állapotsáv — mindkettőt a rendszer fogja el,
     mielőtt az app megkapná, tehát a koppintás soha nem ért ide.

     A dupla koppintás mindig elérhető. Az egyszeri koppintást ezért egy rövid
     ablakkal késleltetjük: ha közben jön a második, a szüneteltetés elmarad, és
     helyette a kezelők jönnek elő. A késleltetés annyira rövid, hogy a
     szüneteltetés továbbra is azonnalinak érződik. */
  if (dupplaVar) {
    clearTimeout(dupplaVar);
    dupplaVar = null;
    toggleControls();
    flashHints();
    flash(dom.zoneCenter, 1.6);
    return;
  }

  dupplaVar = setTimeout(() => {
    dupplaVar = null;
    P.toggle();
    flash(dom.zoneCenter, 1.6);
  }, DUPLA_MS);
});

function toggleControls() {
  if (dom.reader.classList.contains('controls')) hideControls();
  else { showControls(); flashHints(); }
}

function flash(node, szorzo = 1) {
  haptic(szorzo);
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 140);
}

// gombok
dom.play.addEventListener('click', () => { haptic(1.6); P.toggle(); showControls(); });
/* MONDATONKÉNTI LÉPTETÉS, nem másodperc-ugrás.
   A feliratban minden mondatnak pontos kezdőideje van, tehát a mondathatár az
   igazi léptetési egység: a −30 másodperc a mondat közepére esik, és onnan
   újra kell keresni a fonalat. */
dom.prev.addEventListener('click', () => { haptic(); P.jumpSentence(-1); showControls(); });
dom.next.addEventListener('click', () => { haptic(); P.jumpSentence(1); showControls(); });
dom.rate.addEventListener('click', () => { haptic(); P.cycleRate(); updateDock(); showControls(); });
dom.lang.addEventListener('click', () => { haptic(); cycleLang(); showControls(); });
dom.exit.addEventListener('click', () => { haptic(1.6); onExit(); });

// idősáv húzása
let seekDragging = false;
function seekFromEvent(e) {
  const rect = dom.seek.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const ratio = Math.max(0, Math.min(1, x / rect.width));
  P.seek(ratio * P.duration());
}
dom.seek.addEventListener('pointerdown', e => { seekDragging = true; seekFromEvent(e); dom.seek.setPointerCapture(e.pointerId); });
dom.seek.addEventListener('pointermove', e => { if (seekDragging) seekFromEvent(e); });
dom.seek.addEventListener('pointerup', () => { seekDragging = false; haptic(); showControls(); });

// Kézi görgetés közben ne rángassa vissza az automatika a szöveget.
let scrollTimer = null;
dom.flow.addEventListener('touchstart', () => { scrolling = true; cancelAnimationFrame(scrollAnim); clearTimeout(scrollTimer); });
dom.flow.addEventListener('touchend', () => {
  scrollTimer = setTimeout(() => { scrolling = false; if (activeNode) centerOn(activeNode); }, 2500);
});

// Egy mondatra koppintva odaugrunk. A zónák elfogják az érintést, ezért ez a
// hosszú koppintásra (500 ms) szól — így nem ütközik a szünet/folytatás zónával.
let pressTimer = null;

dom.flow.addEventListener('pointerdown', e => {
  const node = e.target.closest('.pair');
  if (!node) return;
  pressTimer = setTimeout(() => {
    const row = P.player.rows[+node.dataset.index];
    if (row) {
      P.seek(row[0] + 0.02);
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 140);
      // A hosszú koppintás után ne sülljön el a zóna-kattintás is.
      suppressClick = true;
    }
  }, 500);
});
['pointerup', 'pointercancel', 'pointermove'].forEach(ev =>
  dom.flow.addEventListener(ev, () => clearTimeout(pressTimer)));

/** A szükség-fordító végeztével újrarajzoljuk a szöveget, kilépés nélkül. */
export function replaceRows(rows, source) {
  renderRows(rows, source);
  activeNode = null;
  setActive(P.player.activeIndex);
}

export { updateDock, showControls };
