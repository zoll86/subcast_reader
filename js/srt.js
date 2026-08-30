/* ═══════════════════════════════════════════════════════════════════════════
   srt.js — feliratfájlok beolvasása

   Akkor van rá szükség, ha egy epizódhoz nem a felhőből, hanem a mappából
   érkezik a felirat: például mert USB-n másoltad át a .hu.srt fájlokat, vagy
   mert még nem párosítottad az appot a géppel.

   A kimenet ugyanaz az alak, amit a felhő is ad — így az olvasó nem tudja meg,
   honnan jött a szöveg:  [[kezdet, vég, magyar, angol], …]
   ═══════════════════════════════════════════════════════════════════════════ */

/** "00:01:23,456" vagy "00:01:23.456" → 83.456 */
function toSeconds(stamp) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(stamp);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

/**
 * SRT vagy WebVTT szöveg feldolgozása.
 * @param {string} text
 * @param {'hu'|'en'} lang  melyik oszlopba kerüljön a szöveg
 */
export function parseSrt(text, lang = 'hu') {
  if (!text) return [];

  const rows = [];
  // A blokkokat üres sor választja el. A sorvégek vegyesek lehetnek (\r\n / \n).
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) continue;

    // Az időbélyeg-sor megkeresése: lehet előtte sorszám, a WebVTT-ben fejléc is.
    const timeIndex = lines.findIndex(l => l.includes('-->'));
    if (timeIndex === -1) continue;

    const [fromRaw, toRaw] = lines[timeIndex].split('-->');
    const start = toSeconds(fromRaw);
    const end = toSeconds(toRaw);
    if (end <= 0 && start <= 0) continue;

    const body = lines.slice(timeIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')      // egyszerű címkék eltávolítása
      .trim();
    if (!body) continue;

    rows.push(lang === 'en' ? [start, end, '', body] : [start, end, body, '']);
  }

  return rows;
}

/**
 * Egy hangfájlhoz tartozó feliratfájl megkeresése a beolvasott szövegfájlok közt.
 * A ".hu.srt" előnyt élvez a sima ".srt"-vel szemben.
 */
export function findSubtitleFile(audioItem, textItems) {
  const dot = audioItem.name.lastIndexOf('.');
  const base = (dot > 0 ? audioItem.name.slice(0, dot) : audioItem.name).toLowerCase();

  let plain = null;
  for (const t of textItems) {
    const lower = t.name.toLowerCase();
    if (!lower.startsWith(base)) continue;
    if (lower === `${base}.hu.srt` || lower === `${base}.hu.vtt`) return t;   // legjobb találat
    if (lower === `${base}.srt` || lower === `${base}.vtt`) plain = t;
  }
  return plain;
}
