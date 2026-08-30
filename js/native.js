/* ═══════════════════════════════════════════════════════════════════════════
   native.js — a natív Android réteg burkolója

   Egyetlen dolga: elrejteni, hogy telefonon vagy böngészőben futunk. A többi
   modul csak az itteni függvényeket hívja, és soha nem tudja meg a különbséget.

   TELEFONON a `Mappa` Capacitor-bővítmény szolgál ki minket:
     · a rendszer mappaválasztójával EGYSZER kijelölöd a podcast-mappát, és az
       app tartós olvasási jogot kap rá — nem kell újra és újra tallózni;
     · a hangot egy helyi (127.0.0.1) mini HTTP-kiszolgáló adja Range-fejléccel,
       tehát az <audio> KÖZVETLENÜL streameli. A korábbi változat minden
       lejátszás előtt átmásolta a teljes fájlt a gyorsítótárba: egy nyolcórás
       hangoskönyvnél ez másodpercekig tartó fagyás és dupla tárhely volt.

   BÖNGÉSZŐBEN a File System Access API, illetve mappa-feltöltés a tartalék.
   Ez teszi lehetővé, hogy az appot gépen is lehessen próbálni.
   ═══════════════════════════════════════════════════════════════════════════ */

const AUDIO_EXT = ['.mp3', '.m4a', '.m4b', '.wav', '.ogg', '.opus', '.aac', '.flac'];
const TEXT_EXT = ['.srt', '.vtt'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

function plugin() {
  return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Mappa) || null;
}

export function isNative() {
  return !!plugin();
}

export function platformName() {
  if (isNative()) return 'Android (natív mappa-hozzáférés)';
  if (window.showDirectoryPicker) return 'böngésző (mappaválasztóval)';
  return 'böngésző (mappa-feltöltéssel)';
}

export function hasExt(name, list) {
  const lower = (name || '').toLowerCase();
  return list.some(ext => lower.endsWith(ext));
}

/* ─────────────────────────── helyi hangkiszolgáló ─────────────────────────── */

let server = null;   // { base, ticket }

async function ensureServer() {
  const p = plugin();
  if (!p) return null;
  if (server) return server;
  const res = await p.serve();
  server = { base: res.base || res.url || '', ticket: res.ticket || res.jegy || res.token || '' };
  return server;
}

/**
 * Lejátszható URL egy hangfájlhoz.
 * Telefonon a helyi kiszolgáló címe, böngészőben egy blob URL.
 */
export async function audioUrl(item) {
  if (isNative()) {
    const s = await ensureServer();
    if (!s || !s.base) throw new Error('A helyi hangkiszolgáló nem indult el.');
    return `${s.base}?t=${encodeURIComponent(s.ticket)}&uri=${encodeURIComponent(item.uri)}`;
  }
  if (item.file) return URL.createObjectURL(item.file);
  throw new Error('Nincs lejátszható forrás ehhez a fájlhoz.');
}

/** A blob URL-eket el kell engedni, különben elszivárog a memória. */
export function releaseAudioUrl(url) {
  if (url && url.startsWith('blob:')) {
    try { URL.revokeObjectURL(url); } catch { /* nem baj */ }
  }
}

/**
 * Egy fájl ELEJÉNEK beolvasása, bájtokban.
 *
 * A borítókép az MP3 fejlécében (ID3v2) van, jellemzően az első pár száz
 * kilobájtban. Egy nyolcórás hangoskönyv teljes beolvasása megölné a WebView-t,
 * ezért csak a szükséges darabot kérjük:
 *   · telefonon a helyi kiszolgálótól, Range-fejléccel,
 *   · böngészőben a File objektum slice-ával.
 */
export async function readBytes(item, length) {
  if (isNative()) {
    const url = await audioUrl(item);
    const res = await fetch(url, { headers: { Range: `bytes=0-${length - 1}` } });
    if (!res.ok && res.status !== 206) throw new Error(`Nem olvasható: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (item.file) {
    return new Uint8Array(await item.file.slice(0, length).arrayBuffer());
  }
  throw new Error('Nincs olvasható forrás.');
}

/** Teljes kép beolvasása data: URL-ként (mappában talált borítófájlhoz). */
export async function readImageDataUrl(item) {
  let blob;
  if (isNative()) {
    const url = await audioUrl(item);
    blob = await (await fetch(url)).blob();
  } else if (item.file) {
    blob = item.file;
  } else {
    return null;
  }
  if (blob.size > 4 * 1024 * 1024) return null;   // túl nagy borítót nem tárolunk
  return await new Promise(resolve => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

/* ─────────────────────────── szövegfájl olvasása ─────────────────────────── */

export async function readText(item) {
  if (isNative()) {
    const p = plugin();
    const res = await p.readText({ uri: item.uri });
    return (res && (res.text || res.szoveg)) || '';
  }
  if (item.file) return item.file.text();
  return '';
}

/* ─────────────────────────── mappaválasztás és beolvasás ─────────────────────────── */

/**
 * Visszaad: { name, treeUri, audio: [...], text: [...] }
 * Minden elem: { name, path, uri?, size, file? }
 */
export async function pickFolder(onProgress = () => {}) {
  if (isNative()) return pickFolderNative(onProgress);
  if (window.showDirectoryPicker) return pickFolderFsApi(onProgress);
  return pickFolderInput(onProgress);
}

/** A korábban kijelölt mappa újraolvasása, tallózás nélkül. */
export async function rescanFolder(onProgress = () => {}) {
  if (!isNative()) return null;
  const p = plugin();
  const cur = await p.current();
  if (!cur || !cur.uri) return null;
  return listNative(cur.uri, cur.name || '', onProgress);
}

export async function currentFolder() {
  if (!isNative()) return null;
  const p = plugin();
  const cur = await p.current();
  return cur && cur.uri ? cur : null;
}

export async function forgetFolder() {
  if (isNative()) await plugin().forget();
}

async function pickFolderNative(onProgress) {
  const p = plugin();
  const picked = await p.pick();
  if (!picked || !picked.uri) return null;
  return listNative(picked.uri, picked.name || '', onProgress);
}

async function listNative(treeUri, name, onProgress) {
  onProgress('Mappa beolvasása…');
  const res = await plugin().list({ uri: treeUri });
  const files = (res && res.files) || [];

  const audio = [];
  const text = [];
  const images = [];
  for (const f of files) {
    const item = { name: f.name, path: f.path || f.name, uri: f.uri, size: f.size || 0 };
    if (hasExt(f.name, AUDIO_EXT)) audio.push(item);
    else if (hasExt(f.name, IMAGE_EXT)) images.push(item);
    else if (hasExt(f.name, TEXT_EXT)) text.push(item);
    else if (f.name === 'subcast_cloud.json') { item.pairing = true; text.push(item); }
  }
  onProgress(`${audio.length} hangfájl`);
  return { name, treeUri, audio, text, images };
}

/* ── böngésző: File System Access API ── */

async function pickFolderFsApi(onProgress) {
  const dir = await window.showDirectoryPicker();
  const audio = [];
  const text = [];
  const images = [];

  async function walk(handle, prefix) {
    for await (const entry of handle.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await walk(entry, path);
      } else {
        const isAudio = hasExt(entry.name, AUDIO_EXT);
        const isImage = hasExt(entry.name, IMAGE_EXT);
        const isText = hasExt(entry.name, TEXT_EXT) || entry.name === 'subcast_cloud.json';
        if (!isAudio && !isText && !isImage) continue;
        const file = await entry.getFile();
        const item = { name: entry.name, path, size: file.size, file };
        if (isAudio) audio.push(item);
        else if (isImage) images.push(item);
        else text.push(item);
        if ((audio.length + text.length) % 40 === 0) onProgress(`${audio.length} hangfájl…`);
      }
    }
  }

  onProgress('Mappa beolvasása…');
  await walk(dir, '');
  return { name: dir.name, treeUri: null, audio, text, images };
}

/* ── böngésző: mappa-feltöltés (a legrégebbi tartalék) ── */

function pickFolderInput(onProgress) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => {
      const audio = [];
      const text = [];
      const images = [];
      for (const file of input.files) {
        const path = file.webkitRelativePath || file.name;
        const item = { name: file.name, path, size: file.size, file };
        if (hasExt(file.name, AUDIO_EXT)) audio.push(item);
        else if (hasExt(file.name, IMAGE_EXT)) images.push(item);
        else if (hasExt(file.name, TEXT_EXT) || file.name === 'subcast_cloud.json') text.push(item);
      }
      onProgress(`${audio.length} hangfájl`);
      const root = (audio[0] || text[0] || {}).path || '';
      resolve({ name: root.split('/')[0] || 'mappa', treeUri: null, audio, text, images });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/* ─────────────────────────── képernyő ébren tartása ───────────────────────────

   Nem háttérlejátszásról van szó: olvasás közben végig nézed a képernyőt, tehát
   csak azt kell megakadályozni, hogy elaludjon. Ehhez elég a Screen Wake Lock
   API, natív előtér-szolgáltatás nélkül.
   ─────────────────────────────────────────────────────────────── */

let wakeLock = null;

export async function keepAwake(on) {
  try {
    if (on) {
      if (wakeLock) return true;
      if (!navigator.wakeLock) return false;
      wakeLock = await navigator.wakeLock.request('screen');
      // Ha az app háttérbe kerül, a rendszer elveszi a zárat; visszatéréskor kérjük újra.
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      return true;
    }
    if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    return true;
  } catch (e) {
    console.warn('Képernyőzár nem elérhető:', e);
    wakeLock = null;
    return false;
  }
}

export function reacquireWakeLockOnVisible(shouldHold) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && shouldHold()) keepAwake(true);
  });
}
