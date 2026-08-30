/* ═══════════════════════════════════════════════════════════════════════════
   covers.js — borítóképek

   HONNAN JÖN A BORÍTÓ, ebben a sorrendben:

   1. KÉPFÁJL A SOROZAT MAPPÁJÁBÓL. Ha van benne cover.jpg / folder.jpg vagy
      bármilyen kép, azt használjuk — ez a leggyorsabb és általában a legjobb
      minőségű.
   2. AZ MP3-BA ÁGYAZOTT KÉP (ID3v2 APIC keret). A vizsgált könyvtárban a
      sorozatok többsége így hordozza a borítót.
   3. GENERÁLT HELYETTESÍTŐ. Ha egyik sincs, a sorozat nevéből számolt színekkel
      rajzolunk egyet. Nem dísz: enélkül üres lyukak tátonganának a rácsban, és
      a szem nem tudna hova kapaszkodni.

   MIÉRT NEM OLVASSUK BE A TELJES FÁJLT
   ------------------------------------
   Egy nyolcórás hangoskönyv több száz megabájt. A borító viszont a fájl
   ELEJÉN, az ID3-fejlécben van. Ezért csak az első pár száz kilobájtot kérjük
   le — telefonon Range-fejléccel a helyi kiszolgálótól.

   A kész borítót elmentjük (IndexedDB), így minden sorozatnál pontosan egyszer
   kell kiolvasni.
   ═══════════════════════════════════════════════════════════════════════════ */

import { cache } from './store.js';
import { readBytes, readImageDataUrl } from './native.js';

/** Ennyit olvasunk a fájl elejéből a borító kereséséhez. */
const HEADER_BYTES = 1_500_000;

/** Ennél nagyobb beágyazott képet nem tárolunk el. */
const MAX_COVER_BYTES = 3 * 1024 * 1024;

/* ─────────────────────────── ID3v2 ─────────────────────────── */

function synchsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function uint32(b, o) {
  return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
}

function latin1(b, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Beágyazott borító-JELÖLTEK kikeresése egy ID3v2 fejlécből.
 * Több jelölt is lehet (lásd readPictureFrame); a hívó választ közülük úgy,
 * hogy megpróbálja betölteni őket.
 * @returns {Array<{mime: string, bytes: Uint8Array}>}
 */
export function parseId3Cover(buf) {
  if (buf.length < 10) return [];
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return [];    // "ID3"

  const major = buf[3];
  const flags = buf[5];
  const tagSize = synchsafe(buf, 6);

  let pos = 10;
  if (flags & 0x40) {
    // Kiterjesztett fejléc — a méretét át kell ugrani.
    pos += major >= 4 ? synchsafe(buf, pos) : uint32(buf, pos) + 4;
  }

  const tagEnd = Math.min(10 + tagSize, buf.length);
  const idLen = major === 2 ? 3 : 4;
  const sizeLen = major === 2 ? 3 : 4;

  while (pos + idLen + sizeLen <= tagEnd) {
    const id = latin1(buf, pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;          // kifutottunk a keretekből

    let size;
    if (major === 2) size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
    else if (major >= 4) size = synchsafe(buf, pos + 4);
    else size = uint32(buf, pos + 4);

    if (size <= 0) break;

    const headerLen = major === 2 ? 6 : 10;
    const bodyStart = pos + headerLen;
    const bodyEnd = Math.min(bodyStart + size, buf.length);

    if (id === 'APIC' || id === 'PIC') {
      const jeloltek = readPictureFrame(buf, bodyStart, bodyEnd, major);
      if (jeloltek.length) return jeloltek;
    }

    pos = bodyStart + size;
  }
  return [];
}

/**
 * UTF-8 kettős kódolás visszafordítása.
 *
 * MIÉRT KELL: több sorozat MP3-jában a beágyazott kép SÉRÜLTEN van benne. A
 * címkéző program a bináris képadatot szövegnek nézte, és UTF-8-ban újrakódolta,
 * ezért minden 0x80 feletti bájt kettévált:
 *     FF D8 FF E0  (JPEG kezdete)   →   C3 BF C3 98 C3 BF C3 A0
 * Ez a fájlokban van elrontva, nem nálunk — de tökéletesen visszafordítható,
 * mert a művelet veszteségmentes: elég a bájtsort UTF-8-ként értelmezni, és
 * minden kódpontot visszaírni egyetlen bájtra.
 */
function undoUtf8Mojibake(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;                    // nem érvényes UTF-8: nem ez a hiba
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) return null;      // nem visszafordítható
    out[i] = c;
  }
  return out;
}

function readPictureFrame(buf, start, end, major) {
  if (start >= end) return null;

  // A KÉP ALÁÍRÁSÁT KERESSÜK MEG, nem a mezőhatárokat számoljuk ki.
  //
  // A szabvány szerint a keret így épül fel: kódolás, MIME, képtípus, leírás,
  // majd a képadat. A gyakorlatban viszont a mezők tele vannak
  // szabálytalansággal — mértük: van, ahol a MIME csak "image/", van, ahol
  // "image/jpg", és a leírás kódolása sem mindig egyezik a jelzettel. A pontos
  // mezőelemzés emiatt három sorozatnál is rossz eltolást adott: a kép vagy
  // elveszett, vagy törött adat lett belőle.
  //
  // A képadat viszont MINDIG az utolsó mező, és minden formátum jól felismerhető
  // aláírással kezdődik. Ezért egyszerűen megkeressük az első érvényes aláírást
  // a kereten belül, és onnantól a keret végéig veszünk mindent. Ez érzéketlen
  // a fejlécmezők összes szabálytalanságára.
  const kereses = (adat) => {
    const hatar = Math.min(300, adat.length);
    for (let i = 0; i < hatar; i++) {
      const mime = sniffMime(adat.subarray(i, Math.min(i + 16, adat.length)));
      if (mime) return { mime, bytes: adat.subarray(i) };
    }
    return null;
  };

  // MINDKÉT ÉRTELMEZÉST VISSZAADJUK, és a hívó dönti el, melyik a jó — úgy,
  // hogy megpróbálja tényleg megjeleníteni.
  //
  // Miért nem elég egyet választani: a kettős kódolású PNG-nél a nyers keresés
  // TÉVESEN talál aláírást. A "C2 89" pár második bájtja épp 0x89, utána pedig
  // a "PNG" és a többi bájt 0x80 alatti, tehát változatlan — így egy bájttal
  // odébbról nézve tökéletes PNG-aláírásnak látszik, pedig a mögötte lévő adat
  // használhatatlan. Aláírás alapján ezt nem lehet megkülönböztetni; csak úgy,
  // ha megnézzük, betöltődik-e a kép.
  const jeloltek = [];

  const nyers = kereses(buf.subarray(start, end));
  if (nyers) jeloltek.push(nyers);

  const helyre = undoUtf8Mojibake(buf.subarray(start, end));
  if (helyre) {
    const javitott = kereses(helyre);
    if (javitott) jeloltek.push(javitott);
  }

  return jeloltek.filter(j => j.bytes.length >= 500 && j.bytes.length <= MAX_COVER_BYTES);
}

/**
 * A képformátum megállapítása a BÁJTOKBÓL, nem a címkében megadott MIME-ből.
 *
 * Miért: a valódi fájlokban a megadott MIME gyakran hibás. A vizsgált
 * könyvtárban háromféle hiba fordult elő: "image/" üres altípussal (ebből
 * `data:image/;base64,…` lenne, amit a böngésző nem jelenít meg), "image/jpg"
 * (nem létező típus), és teljesen hiányzó mező. A fájl első bájtjai viszont
 * egyértelműen megmondják, mi az.
 */
function sniffMime(b) {
  // A JPEG-nél a negyedik bájt egy valódi jelölő (0xC0-0xFE), a PNG-nél pedig a
  // TELJES nyolc bájtos aláírást megköveteljük. A lazább, négybájtos ellenőrzés
  // mérve téves találatot adott: egy hangfájl címkéjében véletlenül előfordult a
  // PNG első négy bájtja, és emiatt egy törött „képet" fogadtunk el valódinak.
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
      && b[3] >= 0xc0 && b[3] <= 0xfe) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
}

/* ─────────────────────────── data: URL ─────────────────────────── */

function toDataUrl(mime, bytes) {
  let bin = '';
  const CHUNK = 0x8000;                           // nagy tömbnél a spread túlcsordulna
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Tényleg megjeleníthető ez a kép? Csak így lehet a jelöltek közül választani. */
function validImage(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

/* ─────────────────────────── generált helyettesítő ─────────────────────────── */

/** A névből számolt, de mindig ugyanaz az érték — hogy a borító ne váltson színt. */
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function generateCover(name, size = 400) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  const h = hash(name || '?');
  const arnyalat = h % 360;

  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, `hsl(${arnyalat}, 38%, 26%)`);
  grad.addColorStop(1, `hsl(${(arnyalat + 40) % 360}, 32%, 12%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // Halvány, a névből származó geometria — hogy két sorozat borítója
  // ránézésre is elkülönüljön, ne csak színben.
  g.globalAlpha = 0.10;
  g.strokeStyle = '#fff';
  g.lineWidth = size * 0.02;
  for (let i = 0; i < 5; i++) {
    const y = size * (0.18 + ((h >> (i * 3)) % 70) / 100);
    g.beginPath();
    g.moveTo(size * 0.08, y);
    g.lineTo(size * (0.35 + ((h >> i) % 55) / 100), y);
    g.stroke();
  }
  g.globalAlpha = 1;

  // A név kezdőbetűi
  const betuk = (name || '?')
    .split(/\s+/).filter(Boolean).slice(0, 3)
    .map(w => w[0].toUpperCase()).join('');
  g.fillStyle = 'rgba(255,255,255,.88)';
  g.font = `700 ${size * 0.26}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(betuk, size / 2, size / 2);

  return c.toDataURL('image/jpeg', 0.8);
}

/* ─────────────────────────── a fő belépési pont ─────────────────────────── */

/** A sorozat mappájának neve az elérési útból (az első szint). */
function seriesFolder(path) {
  const parts = (path || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

/** Mennyire valószínű, hogy ez a fájl borító? A tipikus nevek előre kerülnek. */
function coverRank(name) {
  const n = name.toLowerCase();
  if (n.startsWith('cover.')) return 0;
  if (n.startsWith('folder.')) return 1;
  if (n.startsWith('art.') || n.startsWith('albumart')) return 2;
  return 3;
}

/**
 * Egy sorozat borítója. Az eredményt eltesszük, tehát sorozatonként egyszer fut le.
 *
 * @param {object} series  { name, episodes: [...] }
 * @param {object} folder  a beolvasott mappa (images listával)
 * @returns {Promise<string>} data: URL
 */
export async function getSeriesCover(series, folder) {
  const kulcs = series.name;

  const mentett = await cache.getCover(kulcs);
  if (mentett) return mentett;

  let dataUrl = null;

  // 1. képfájl a sorozat mappájában
  const mappa = seriesFolder(series.episodes[0]?.file?.path);
  const jeloltek = (folder.images || [])
    .filter(img => !mappa || seriesFolder(img.path) === mappa)
    .sort((a, b) => coverRank(a.name) - coverRank(b.name));

  if (jeloltek.length) {
    try {
      dataUrl = await readImageDataUrl(jeloltek[0]);
    } catch (e) {
      console.warn('Borítófájl olvasása:', e);
    }
  }

  // 2. az MP3-ba ágyazott kép — több epizódot is megpróbálunk, mert
  //    előfordul, hogy éppen az elsőben nincs
  if (!dataUrl) {
    for (const ep of series.episodes.slice(0, 3)) {
      try {
        const buf = await readBytes(ep.file, HEADER_BYTES);
        for (const jelolt of parseId3Cover(buf)) {
          const proba = toDataUrl(jelolt.mime, jelolt.bytes);
          if (await validImage(proba)) { dataUrl = proba; break; }
        }
        if (dataUrl) break;
      } catch (e) {
        console.warn('Borító kiolvasása:', ep.file?.name, e);
      }
    }
  }

  // 3. generált helyettesítő
  if (!dataUrl) dataUrl = generateCover(series.name);

  await cache.setCover(kulcs, dataUrl);
  return dataUrl;
}
