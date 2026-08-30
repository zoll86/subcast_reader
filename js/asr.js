/* ═══════════════════════════════════════════════════════════════════════════
   asr.js — SZÜKSÉG-FORDÍTÓ a telefonon

   MI EZ ÉS MI NEM
   ---------------
   Ez a modul kizárólag arra való, hogy útközben megments egy epizódot, amihez
   otthon elfelejtettél feliratot csinálni. NEM a gépes SubCast helyettesítője:
   ott Whisper large-v3 fut a videokártyán, és Claude fordít a podcast stílusára
   hangolva. Itt egy távoli szolgáltatás dolgozik, gyengébb eredménnyel.

   Ezért a modul KÜLÖN ÁLL, és csak akkor töltődik be, amikor tényleg kéred
   (dinamikus import a main.js-ből). Az olvasó működését semmilyen módon nem
   befolyásolja, és ha ezt a fájlt törlöd, az app ugyanúgy elindul.

   HOGYAN
   ------
   1. A hangot darabokra vágjuk. MP3-nál KERETHATÁRON — ez fontos: ha bárhol
      elvágnánk, a szolgáltatás sercegést vagy csonka keretet kapna, és
      elcsúsznának az időbélyegek.
   2. Minden darabot elküldünk a Groq Whisper végpontjára, ami mondatonkénti
      időbélyegeket ad vissza. A darab kezdetét hozzáadjuk az időkhöz.
   3. A mondatokat kötegelve lefordítjuk magyarra.
   4. Az eredmény ugyanabban az alakban kerül a tárolóba, mint a felhőből jövő
      felirat — az olvasó nem tudja megkülönböztetni őket.

   KORLÁTOK, KIMONDVA
   ------------------
   · Csak MP3-at tudunk darabolni. Az m4a/m4b konténer szerkezetét nem bontjuk;
     ha az ilyen fájl elfér egy kérésben, elküldjük egyben, ha nem, szólunk,
     hogy ezt a részt a gépen kell elkészíteni.
   · Kell hozzá net és egy Groq API-kulcs.
   ═══════════════════════════════════════════════════════════════════════════ */

import { cache, settings } from './store.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

/** Egy kérésbe küldhető legnagyobb hangdarab. A Groq korlátja 25 MB; tartunk tőle némi távolságot. */
const MAX_DARAB_BAJT = 20 * 1024 * 1024;

/** Egy darab célhossza másodpercben. Rövidebb darab = gyakoribb visszajelzés és kisebb újrapróbálási veszteség. */
const DARAB_MP = 600;

/* ═══════════════ MP3 KERETTÉRKÉP ═══════════════ */

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES_V1 = [44100, 48000, 32000];
const RATES_V2 = [22050, 24000, 16000];
const RATES_V25 = [11025, 12000, 8000];

/**
 * Végigpásztázza az MP3 kereteit, és időbélyeg→bájteltolás párokat gyűjt.
 *
 * Ablakonként olvas (1 MB), nem egyben: egy nyolcórás hangoskönyv memóriába
 * olvasása megölné a WebView-t.
 */
async function mp3Kerettterkep(file, onProgress) {
  const ABLAK = 1 << 20;
  const pontok = [{ t: 0, b: 0 }];

  let pos = 0;
  let ido = 0;
  let maradek = new Uint8Array(0);

  while (pos < file.size) {
    const chunk = new Uint8Array(await file.slice(pos, Math.min(pos + ABLAK, file.size)).arrayBuffer());
    const buf = new Uint8Array(maradek.length + chunk.length);
    buf.set(maradek, 0);
    buf.set(chunk, maradek.length);

    const bazis = pos - maradek.length;
    let i = 0;

    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }

      const verzioBit = (buf[i + 1] >> 3) & 0x03;      // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const retegBit = (buf[i + 1] >> 1) & 0x03;       // 1 = Layer III
      if (retegBit !== 1 || verzioBit === 1) { i++; continue; }

      const brIdx = (buf[i + 2] >> 4) & 0x0f;
      const srIdx = (buf[i + 2] >> 2) & 0x03;
      if (brIdx === 0 || brIdx === 15 || srIdx === 3) { i++; continue; }

      const mpeg1 = verzioBit === 3;
      const bitrate = (mpeg1 ? BITRATES_V1L3 : BITRATES_V2L3)[brIdx] * 1000;
      const rate = (verzioBit === 3 ? RATES_V1 : verzioBit === 2 ? RATES_V2 : RATES_V25)[srIdx];
      const padding = (buf[i + 2] >> 1) & 0x01;
      const mintak = mpeg1 ? 1152 : 576;

      const hossz = Math.floor((mintak / 8) * bitrate / rate) + padding;
      if (hossz < 24) { i++; continue; }

      ido += mintak / rate;
      i += hossz;

      // Nem minden keretet jegyzünk fel — másodpercenként egy pont bőven elég
      // ahhoz, hogy a vágás kerethatárra essen.
      if (ido - pontok[pontok.length - 1].t >= 1) {
        pontok.push({ t: ido, b: bazis + i });
      }
    }

    maradek = buf.slice(i);
    pos += chunk.length;
    if (onProgress) onProgress(Math.round((pos / file.size) * 100));
  }

  return { pontok, hossz: ido };
}

/** A kerettérkép alapján kijelöli a darabhatárokat. */
function darabokatKijelol(terkep, fileMeret) {
  const darabok = [];
  let kezdet = { t: 0, b: 0 };

  for (const p of terkep.pontok) {
    const tartam = p.t - kezdet.t;
    const meret = p.b - kezdet.b;
    if (tartam >= DARAB_MP || meret >= MAX_DARAB_BAJT) {
      darabok.push({ tol: kezdet.b, ig: p.b, kezdIdo: kezdet.t });
      kezdet = p;
    }
  }
  if (kezdet.b < fileMeret) {
    darabok.push({ tol: kezdet.b, ig: fileMeret, kezdIdo: kezdet.t });
  }
  return darabok;
}

/* ═══════════════ FELISMERÉS ═══════════════ */

async function felismer(blob, apiKey, nev) {
  const form = new FormData();
  form.append('file', blob, nev);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('language', 'en');

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form,
  });

  if (res.status === 401) throw new Error('A Groq API-kulcs érvénytelen.');
  if (res.status === 429) throw new Error('Elérted a Groq ingyenes keretét. Próbáld később, vagy készítsd el a gépen.');
  if (!res.ok) throw new Error(`Felismerési hiba (${res.status}): ${(await res.text()).slice(0, 160)}`);

  const data = await res.json();
  return (data.segments || []).map(s => [s.start, s.end, s.text.trim()]);
}

/* ═══════════════ FORDÍTÁS ═══════════════ */

/**
 * Kötegelt fordítás a Google ingyenes végpontjával.
 *
 * A mondatokat egy kérésbe fűzzük egy ritka elválasztóval, mert mondatonként
 * külön kérést küldeni több ezer soros epizódnál percekig tartana, és
 * kimerítené a szolgáltatás türelmét.
 */
async function forditKoteg(mondatok) {
  const JEL = '\n@@@\n';
  const q = mondatok.join(JEL);
  const url = 'https://translate.googleapis.com/translate_a/single'
            + `?client=gtx&sl=en&tl=hu&dt=t&q=${encodeURIComponent(q)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fordítási hiba (${res.status})`);

  const data = await res.json();
  const teljes = (data[0] || []).map(r => r[0]).join('');
  const darabok = teljes.split(/\s*@@@\s*/);

  // Ha az elválasztó elveszett a fordításban, inkább adjuk vissza az eredetit,
  // mint hogy összekeveredjenek a mondatok.
  return darabok.length === mondatok.length ? darabok : null;
}

/* ═══════════════ CLAUDE FORDÍTÓ ═══════════════ */

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Fordítás Claude-dal.
 *
 * A böngészőből való közvetlen hívást egyetlen fejléc engedélyezi:
 *     anthropic-dangerous-direct-browser-access: true
 * Enélkül a kérés el sem indul, a böngésző CORS-hibával elvágja (mérve: a
 * fejléccel szabályos 401 jön vissza érvénytelen kulcsra, nélküle "Failed to
 * fetch"). A "dangerous" a névben arra utal, hogy a kulcs így a kliensen van —
 * a te telefonodon, a te kulcsod, ez itt elfogadható; megosztott weboldalon nem
 * lenne az.
 *
 * Alacsony gondolkodási ráfordítással (effort: low) dolgozunk: a feliratfordítás
 * nem igényel hosszas mérlegelést, viszont epizódonként több ezer mondatról van
 * szó, tehát a ráfordítás közvetlenül a számládon látszik.
 */
async function forditClaudeKoteg(mondatok, apiKey, model) {
  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content:
          `Fordítsd magyarra az alábbi angol feliratmondatokat. Podcast- vagy
hangoskönyv-szövegről van szó: tartsd meg a hangulatot, a szlenget és a
poénokat, és természetes beszélt magyart írj.

CSAK egy JSON-tömböt adj vissza, ugyanannyi elemmel és ugyanabban a sorrendben,
mint a bemenet. Semmi mást — se magyarázatot, se markdownt.

` + JSON.stringify(mondatok, null, 1),
      }],
    }),
  });

  if (res.status === 401) throw new Error('A Claude API-kulcs érvénytelen.');
  if (res.status === 429) throw new Error('Elérted a Claude korlátodat. Próbáld később.');
  if (!res.ok) throw new Error(`Claude hiba (${res.status}): ${(await res.text()).slice(0, 160)}`);

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('A Claude elutasította a kérést.');

  const szoveg = (data.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('').trim();

  const eleje = szoveg.indexOf('[');
  const vege = szoveg.lastIndexOf(']');
  if (eleje < 0 || vege < eleje) throw new Error('A Claude válasza nem értelmezhető.');

  const tomb = JSON.parse(szoveg.slice(eleje, vege + 1));
  if (!Array.isArray(tomb) || tomb.length !== mondatok.length) {
    throw new Error('A Claude nem ugyanannyi mondatot adott vissza.');
  }
  return tomb.map(x => String(x || ''));
}

async function forditClaude(mondatok, onProgress) {
  const apiKey = settings.claudeKey;
  const model = settings.claudeModel || 'claude-opus-5';
  const KOTEG = 40;
  const ki = [];

  for (let i = 0; i < mondatok.length; i += KOTEG) {
    const koteg = mondatok.slice(i, i + KOTEG);
    try {
      ki.push(...await forditClaudeKoteg(koteg, apiKey, model));
    } catch (e) {
      // Egy köteg bukása ne vigye el az egész epizódot: üresen hagyjuk, és
      // megy tovább. Az üres mondat látszik a felületen, a rossz nem.
      console.warn('Claude köteg hiba:', e);
      ki.push(...koteg.map(() => ''));
    }
    if (onProgress) onProgress(Math.round(ki.length / mondatok.length * 100));
  }
  return ki;
}

async function fordit(mondatok, onProgress) {
  const KOTEG = 40;
  const ki = [];

  for (let i = 0; i < mondatok.length; i += KOTEG) {
    const koteg = mondatok.slice(i, i + KOTEG);
    let eredmeny = null;
    try {
      eredmeny = await forditKoteg(koteg);
    } catch (e) {
      console.warn('Fordítási köteg hiba:', e);
    }
    // Ha a köteg nem sikerült, egyesével próbáljuk — lassabb, de nem vész el.
    if (!eredmeny) {
      eredmeny = [];
      for (const m of koteg) {
        try { eredmeny.push((await forditKoteg([m]))?.[0] || ''); }
        catch { eredmeny.push(''); }
      }
    }
    ki.push(...eredmeny);
    if (onProgress) onProgress(Math.round((ki.length / mondatok.length) * 100));
  }

  return ki;
}

/* ═══════════════ A TELJES FOLYAMAT ═══════════════ */

/**
 * @param {object} episode  a könyvtár epizódja
 * @param {Blob}   blob     a hangfájl tartalma
 * @param {string} apiKey   Groq API-kulcs
 * @param {(szakasz:string, szazalek:number)=>void} onProgress
 * @returns {Promise<Array>} a feliratsorok, [kezdet, vég, magyar, angol]
 */
export async function feliratotKeszit(episode, blob, apiKey, onProgress = () => {}) {
  if (!apiKey) throw new Error('Nincs megadva Groq API-kulcs. A beállításokban add meg.');

  const nev = episode.file.name.toLowerCase();
  const mp3 = nev.endsWith('.mp3');

  let darabok;
  if (mp3) {
    onProgress('hangfájl átnézése', 0);
    const terkep = await mp3Kerettterkep(blob, p => onProgress('hangfájl átnézése', p));
    darabok = darabokatKijelol(terkep, blob.size);
  } else if (blob.size <= MAX_DARAB_BAJT) {
    darabok = [{ tol: 0, ig: blob.size, kezdIdo: 0 }];
  } else {
    throw new Error(
      'Ez a fájl nem MP3, és túl nagy egyetlen kérésbe. Ezt a részt a gépen kell elkészíteni.');
  }

  /* felismerés darabonként */
  const nyers = [];
  for (let i = 0; i < darabok.length; i++) {
    const d = darabok[i];
    onProgress(`felismerés (${i + 1}/${darabok.length})`, Math.round((i / darabok.length) * 100));
    const resz = blob.slice(d.tol, d.ig, mp3 ? 'audio/mpeg' : blob.type);
    const sorok = await felismer(resz, apiKey, episode.file.name);
    for (const [s, e, t] of sorok) {
      if (t) nyers.push([s + d.kezdIdo, e + d.kezdIdo, t]);
    }
  }

  if (!nyers.length) throw new Error('A felismerés nem talált beszédet a fájlban.');

  /* fordítás — Claude, ha van kulcs; különben a Google ingyenes végpontja */
  const claudeVan = !!(settings.claudeKey || '').trim();
  onProgress(claudeVan ? 'fordítás (Claude)' : 'fordítás (Google)', 0);
  const magyar = claudeVan
    ? await forditClaude(nyers.map(r => r[2]), p => onProgress('fordítás (Claude)', p))
    : await fordit(nyers.map(r => r[2]), p => onProgress('fordítás (Google)', p));

  const sorok = nyers.map((r, i) => [
    Math.round(r[0] * 100) / 100,
    Math.round(r[1] * 100) / 100,
    magyar[i] || '',
    r[2],
  ]);

  /* Ugyanoda kerül, ahova a felhőből jövő felirat — az olvasó nem tesz különbséget.
     Ha később a gépen is elkészül, a szinkron egyszerűen felülírja ezt. */
  await cache.setSubs(episode.key, sorok);
  onProgress('kész', 100);
  return sorok;
}
