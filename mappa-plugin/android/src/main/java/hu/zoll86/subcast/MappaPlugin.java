package hu.zoll86.subcast;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.UUID;

/**
 * PODCAST-MAPPA — a SubCast Olvasó natív mappa-hozzáférése.
 *
 * MIÉRT KELL
 * ----------
 * Az androidos böngészőben nincs könyvtárválasztó API. Enélkül a webapp minden
 * hangfájlt a saját tárolójába másolna: dupla helyfoglalás, és minden fájlt
 * kézzel kellene behúzni. Ez a bővítmény a rendszer könyvtárválasztóját (Storage
 * Access Framework) használja: EGYSZER kijelölöd a podcast-mappát, az app tartós
 * olvasási jogot kap rá, és onnantól a könyvtár = a mappa tartalma. A fájlok ott
 * maradnak, ahol vannak.
 *
 * SZÁNDÉKOSAN KICSI
 * -----------------
 * Hat metódus, semmi több. Nincs benne beszédfelismerés, letöltéskezelő,
 * beszédszintézis, RSS-proxy vagy előtér-szolgáltatás — az elődje azoktól nőtt
 * több mint ezer sorosra, és lett átláthatatlan. Amire a telefonos olvasónak
 * szüksége van: mappa kijelölése, listázás, szövegfájl beolvasása, és a hang
 * kiszolgálása streamelhető módon.
 */
@CapacitorPlugin(name = "Mappa")
public class MappaPlugin extends Plugin {

    private static final String PREF = "subcast_mappa";
    private static final String KEY_TREE = "tree_uri";

    private MappaSzerver szerver;
    private String jegy;

    /* Sötét rendszersávok. A navigációs sáv az Androidé, nem a weboldalé, tehát
       CSS-ből elérhetetlen: ha a téma nem ad neki színt, világos csík marad a
       sötét olvasófelület alatt. Kódból is beállítjuk, minden indulásnál. */
    @Override
    public void load() {
        super.load();
        final android.app.Activity a = getActivity();
        if (a == null) return;
        a.runOnUiThread(() -> {
            try {
                android.view.Window w = a.getWindow();
                final int hatter = 0xFF0B0A0E;         /* az app alapszíne */
                w.getDecorView().setBackgroundColor(hatter);
                w.setNavigationBarColor(hatter);
                w.setStatusBarColor(hatter);
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    android.view.View d = w.getDecorView();
                    int f = d.getSystemUiVisibility();
                    f &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    f &= ~android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    d.setSystemUiVisibility(f);
                }
            } catch (Exception ignored) { }
        });
    }

    /* ═══════════════ 1. helyi hangkiszolgáló ═══════════════ */

    @PluginMethod
    public void serve(PluginCall call) {
        try {
            if (szerver == null || szerver.getPort() == 0) {
                jegy = UUID.randomUUID().toString();
                szerver = new MappaSzerver(getContext(), jegy);
                szerver.indit();
            }
            JSObject out = new JSObject();
            out.put("base", "http://127.0.0.1:" + szerver.getPort() + "/hang");
            out.put("ticket", jegy);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("A helyi hangkiszolgáló nem indult el: " + e.getMessage());
        }
    }

    /* ═══════════════ 2-4. mappa kijelölése és megjegyzése ═══════════════ */

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                      | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "mappaKijelolve");
    }

    @ActivityCallback
    private void mappaKijelolve(PluginCall call, ActivityResult result) {
        if (call == null) return;

        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(new JSObject());          // a felhasználó megszakította
            return;
        }

        Uri tree = data.getData();
        try {
            // TARTÓS jog: enélkül az app újraindítása után elveszne a hozzáférés,
            // és minden indításnál újra kellene tallózni.
            getContext().getContentResolver().takePersistableUriPermission(
                    tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) { }

        getContext().getSharedPreferences(PREF, 0).edit()
                .putString(KEY_TREE, tree.toString()).apply();

        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        out.put("name", mappaNev(tree));
        call.resolve(out);
    }

    @PluginMethod
    public void current(PluginCall call) {
        String saved = getContext().getSharedPreferences(PREF, 0).getString(KEY_TREE, null);
        JSObject out = new JSObject();
        if (saved != null) {
            out.put("uri", saved);
            out.put("name", mappaNev(Uri.parse(saved)));
        }
        call.resolve(out);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        getContext().getSharedPreferences(PREF, 0).edit().remove(KEY_TREE).apply();
        call.resolve();
    }

    /* ═══════════════ 5. a mappa bejárása ═══════════════ */

    @PluginMethod
    public void list(PluginCall call) {
        String uriS = call.getString("uri");
        if (uriS == null) uriS = getContext().getSharedPreferences(PREF, 0).getString(KEY_TREE, null);
        if (uriS == null) { call.reject("Nincs kijelölt mappa."); return; }

        try {
            JSArray files = new JSArray();
            bejar(Uri.parse(uriS), "", files);
            JSObject out = new JSObject();
            out.put("files", files);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("A mappa beolvasása nem sikerült: " + e.getMessage());
        }
    }

    /**
     * Szélességi bejárás, egyetlen lekérdezéssel mappánként.
     *
     * A DocumentFile.listFiles() minden fájlhoz KÜLÖN lekérdezést indít — több
     * száz epizódnál ez percekig tart. A DocumentsContract közvetlen
     * használatával egy mappa teljes tartalma egyetlen kurzorral megjön.
     * Rekurzió helyett saját sor, hogy mély szerkezetnél se fogyjon el a verem.
     */
    private void bejar(Uri tree, String gyoker, JSArray ki) throws Exception {
        String rootDoc = DocumentsContract.getTreeDocumentId(tree);

        ArrayDeque<String[]> sor = new ArrayDeque<>();   // { documentId, relatívÚt }
        sor.add(new String[]{ rootDoc, gyoker });

        while (!sor.isEmpty()) {
            String[] elem = sor.poll();
            Uri gyerekek = DocumentsContract.buildChildDocumentsUriUsingTree(tree, elem[0]);

            Cursor cur = null;
            try {
                cur = getContext().getContentResolver().query(gyerekek, new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE
                }, null, null, null);

                if (cur == null) continue;

                while (cur.moveToNext()) {
                    String docId = cur.getString(0);
                    String nev = cur.getString(1);
                    String mime = cur.getString(2);
                    long meret = cur.getLong(3);

                    if (nev == null || nev.startsWith(".")) continue;
                    String rel = elem[1].isEmpty() ? nev : elem[1] + "/" + nev;

                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        sor.add(new String[]{ docId, rel });
                        continue;
                    }

                    if (!erdekel(nev)) continue;

                    JSObject f = new JSObject();
                    f.put("name", nev);
                    f.put("path", rel);
                    f.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString());
                    f.put("size", meret);
                    ki.put(f);
                }
            } finally {
                if (cur != null) try { cur.close(); } catch (Exception ignored) { }
            }
        }
    }

    /** Csak azt visszük át a webrétegnek, amivel az olvasó tud kezdeni valamit. */
    private boolean erdekel(String nev) {
        String n = nev.toLowerCase();
        return n.endsWith(".mp3") || n.endsWith(".m4a") || n.endsWith(".m4b")
            || n.endsWith(".wav") || n.endsWith(".ogg") || n.endsWith(".opus")
            || n.endsWith(".aac") || n.endsWith(".flac")
            || n.endsWith(".srt") || n.endsWith(".vtt")
            || n.equals("subcast_cloud.json");
    }

    /* ═══════════════ 6. szövegfájl beolvasása ═══════════════ */

    @PluginMethod
    public void readText(PluginCall call) {
        String uriS = call.getString("uri");
        if (uriS == null) { call.reject("Nincs megadva fájl."); return; }

        try (InputStream is = getContext().getContentResolver().openInputStream(Uri.parse(uriS));
             BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {

            StringBuilder sb = new StringBuilder();
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);

            JSObject out = new JSObject();
            out.put("text", sb.toString());
            call.resolve(out);
        } catch (Exception e) {
            call.reject("A fájl nem olvasható: " + e.getMessage());
        }
    }

    /* ═══════════════ segéd ═══════════════ */

    private String mappaNev(Uri tree) {
        try {
            String id = DocumentsContract.getTreeDocumentId(tree);
            int k = id.lastIndexOf('/');
            String nev = k >= 0 ? id.substring(k + 1) : id;
            k = nev.lastIndexOf(':');
            if (k >= 0) nev = nev.substring(k + 1);
            return nev.isEmpty() ? "podcast-mappa" : nev;
        } catch (Exception e) {
            return "podcast-mappa";
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (szerver != null) szerver.leallit();
    }
}
