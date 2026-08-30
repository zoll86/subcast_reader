# SubCast Olvasó

Kétnyelvű podcast-olvasó és -hallgató telefonra. Az elhangzó mondatot mutatja
magyarul és angolul, és **folyamatosan szinkronban van a gépen futó SubCast
Studióval**: amint ott elkészül egy fordítás, pár másodpercen belül itt van, és
mindkét eszköz tudja, hol tartasz.

---

## Mit csinál — és mit nem

**Csinálja**

- lejátssza a telefonra másolt podcastokat, és mutatja hozzá a magyar feliratot
- középre görgeti az éppen elhangzó mondatot, az angolt alá írja
- megjegyzi, hol tartasz — és ezt megosztja a géppel, mindkét irányban
- magától lehozza a gépen elkészült új fordításokat
- net nélkül is teljesen működik (a már letöltött anyagon)

**Nem csinálja**

- **nem játszik le a háttérben.** Ez szándékos: ez egy *olvasó*. A képernyő
  bekapcsolva marad olvasás közben, és nincs se értesítés, se zárképernyő-vezérlő.
- nem másol sehova hangfájlt — a mappádból streameli őket
- nem tölt le semmit az internetről a szinkronon kívül (nincs CDN, nincs webfont)

---

## Felépítés

Minden fájlnak egy dolga van. Ha valamelyik elkezd nőni, az annak a jele, hogy
rossz helyre került valami.

```
index.html          a váz — csak szerkezet, semmi logika
css/app.css         a teljes megjelenés, dizájn-tokenekkel
js/
  main.js           belépési pont: indulás, nézetváltás, események bekötése
  store.js          állapot, beállítások, haladás (localStorage + IndexedDB)
  native.js         az Android-réteg burkolója (böngésző-tartalékkal)
  library.js        a könyvtár összeállítása a mappából + a gép indexéből
  srt.js            SRT/VTT feliratfájlok beolvasása
  player.js         hanglejátszás és felirat-követés
  reader.js         az olvasófelület: szöveg, gesztusok, lejátszósáv
  cloud.js          szinkron a géppel GitHub Gist-en át
  asr.js            szükség-fordító (külön modul, csak kérésre töltődik be)
mappa-plugin/       natív Android: mappa-hozzáférés + helyi hangkiszolgáló
.github/workflows/  automatikus, aláírt APK-építés
```

---

## Hogyan szinkronizál

A telefon és a gép ritkán van egy hálózaton, ezért nem közvetlenül beszélnek,
hanem egy közös postaládán keresztül: egy **titkos GitHub gist**-en. Ingyenes,
bárhonnan elérhető, és nem kell hozzá szervert üzemeltetni.

| fájl a gist-ben  | ki írja | mi van benne |
|------------------|---------|--------------|
| `beat.json`      | gép     | csak revíziószámok, pár száz bájt |
| `positions.json` | gép     | hol tartasz a gépen |
| `index.json`     | gép     | epizódok címe, sorozata, hossza |
| `bundle_NN.txt`  | gép     | a feliratok, tömörítve és csoportosítva |
| `phone.json`     | telefon | hol tartasz a telefonon |

A gép és a telefon **soha nem írja ugyanazt a fájlt**, tehát nincs írásütközés.

A telefon sűrűn csak a `beat.json`-t kérdezi le, és **csak azt tölti le, aminek
megváltozott a revíziója**. Így egy új fordítás után egyetlen csomag jön át, nem
az egész könyvtár. Mérve: változás nélküli lekérdezés ≈ 300 bájt, egy új
fordítás ≈ egy csomag.

**Ütközésfeloldás:** minden pozícióhoz tartozik időbélyeg, és a frissebb nyer.
Egyetlen szabály, mindkét oldalon ugyanaz. Az egy másodperces ráhagyás
megakadályozza, hogy a két óra apró eltérése miatt oda-vissza billegjen.

---

## Beüzemelés

### 1. A gépen

A SubCast Studióban: **Telefon & USB Szinkronizáció → Felhő-szinkron**.

1. Hozz létre egy GitHub tokent a `gist` jogosultsággal
   ([közvetlen link](https://github.com/settings/tokens/new?scopes=gist&description=SubCast%20szinkron)) —
   görgess le, *Generate token*, és másold ki.
2. Illeszd be a mezőbe, és kattints a **Csatlakozás** gombra. A program létrehozza
   magának a titkos gist-et.
3. **Párosító kód megjelenítése** — ez a kódot a podcast-mappádba is kiírja
   `subcast_cloud.json` néven.

### 2. A telefonon

- **Ha USB-n másolod a podcastokat:** semmit nem kell csinálni. A `subcast_cloud.json`
  átmásolódik a többi fájllal, és az app a mappa beolvasásakor magától párosít.
- **Egyébként:** Beállítások → illeszd be a párosító kódot → Párosítás.

### 3. Az APK

A `main` ágra való minden feltöltés után a GitHub magától épít egy aláírt APK-t,
és felteszi a **Releases** közé `apk-latest` néven. Onnan töltsd le a telefonra.

Az APK állandó kulccsal van aláírva, ezért a következő verziók **frissítésként**
telepednek: a kijelölt mappa, a párosítás és a haladás megmarad.

---

## Érintésvezérlés olvasás közben

```
┌─────────────────────────────┐
│          kezelők            │  fent: a lejátszósáv elő/eltüntetése
├─────────┬─────────┬─────────┤
│  előző  │ szünet /│következő│
│ mondat  │folytatás│  mondat │
│  (30%)  │  (40%)  │  (30%)  │
├─────────┴─────────┴─────────┤
│          kezelők            │  lent: ugyanaz
└─────────────────────────────┘
```

Hosszú koppintás bármelyik mondaton: odaugrik. Lejátszás közben a kezelők három
másodperc után eltűnnek, hogy csak a szöveg maradjon.

---

## Szükség-fordító

Ha útközben olyan részhez érsz, amihez még nincs felirat, a telefon is el tudja
készíteni: Beállítások → Groq API-kulcs, majd az olvasóban a *Készítsek itt
feliratot?* gomb.

Ez **szükségmegoldás**, nem a gép helyettesítője: ott Whisper large-v3 fut a
videokártyán és Claude fordít, itt egy távoli szolgáltatás dolgozik gyengébb
eredménnyel. Ha később a gépen is elkészül, a szinkron egyszerűen felülírja.

Korlát: darabolni csak MP3-at tud. A nagyobb m4a/m4b fájlokat a gépen kell
elkészíteni.

---

## Fejlesztés

Nincs fordítási lépés — natív ES-modulok, semmi csomagoló.

```bash
python -m http.server 8792
```

Ezután nyisd meg a `http://127.0.0.1:8792` címet. Böngészőben a mappaválasztás a
File System Access API-val (vagy mappa-feltöltéssel) működik, a natív bővítmény
helyett.
