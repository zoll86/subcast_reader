package hu.zoll86.subcast;

import android.content.Context;
import android.net.Uri;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * MINI HTTP-KISZOLGÁLÓ a kijelölt mappa hangfájljaihoz — csak a hurok-illesztőn.
 *
 * MIÉRT KELL EGYÁLTALÁN
 * ---------------------
 * A WebView <audio> eleme nem tud `content://` címet lejátszani. A kézenfekvő
 * megkerülés — a fájl átmásolása az app gyorsítótárába — nagyon rossz: egy
 * nyolcórás hangoskönyvnél másodpercekig tartó fagyás, és a fájl kétszer
 * foglal helyet. (A SubCast korábbi telefonos változata pontosan ezt csinálta.)
 *
 * Ez a néhány száz soros kiszolgáló ehelyett Range-fejléccel szolgálja ki a
 * fájlt, tehát az <audio> KÖZVETLENÜL streameli: az indulás azonnali, a
 * tekerés működik, és semmi nem másolódik sehova.
 *
 * BIZTONSÁG
 * ---------
 *  · kizárólag a 127.0.0.1 címen hallgat, tehát a hálózatról elérhetetlen;
 *  · minden kérésnek fel kell mutatnia egy futásonként generált titkos jegyet;
 *  · csak azt a `content://` URI-t adja ki, amit a kérés megnevez, és amire az
 *    appnak amúgy is van olvasási joga a rendszertől.
 */
class MappaSzerver implements Runnable {

    private final Context ctx;
    private final String jegy;

    private ServerSocket sock;
    private volatile boolean fut = true;
    private int port = 0;

    /* Külön szál minden kapcsolathoz.
       A lejátszó HOSSZAN ÉLŐ kapcsolatot tart nyitva, amíg szól a hang. Ha a
       kiszolgáló egy szálon, sorban kezelné a kéréseket, minden további kérés
       (pl. a következő rész előtöltése) a lejátszás végéig várna, majd
       időtúllépéssel elhasalna. */
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "subcast-kapcsolat");
        t.setDaemon(true);
        return t;
    });

    MappaSzerver(Context ctx, String jegy) {
        this.ctx = ctx;
        this.jegy = jegy;
    }

    int indit() throws Exception {
        sock = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
        port = sock.getLocalPort();
        Thread t = new Thread(this, "subcast-szerver");
        t.setDaemon(true);
        t.start();
        return port;
    }

    void leallit() {
        fut = false;
        try { if (sock != null) sock.close(); } catch (Exception ignored) { }
        try { pool.shutdownNow(); } catch (Exception ignored) { }
    }

    int getPort() { return port; }

    @Override
    public void run() {
        while (fut) {
            try {
                final Socket s = sock.accept();
                pool.execute(() -> {
                    try { kezel(s); }
                    catch (Exception ignored) { /* a lejátszó gyakran félbehagyja: normális */ }
                    finally { try { s.close(); } catch (Exception ignored) { } }
                });
            } catch (Exception e) {
                /* a bezárt socket kivétele leállításkor normális */
            }
        }
    }

    private void kezel(Socket s) throws Exception {
        s.setSoTimeout(60000);
        InputStream in = s.getInputStream();
        OutputStream out = s.getOutputStream();

        /* ---- kéréssor és fejlécek beolvasása ---- */
        StringBuilder fej = new StringBuilder();
        int c, ures = 0;
        while ((c = in.read()) != -1) {
            fej.append((char) c);
            if (c == '\n') { if (++ures == 2) break; }
            else if (c != '\r') { ures = 0; }
            if (fej.length() > 16384) break;
        }

        String[] sorok = fej.toString().split("\r?\n");
        if (sorok.length == 0) return;
        String[] elso = sorok[0].split(" ");
        if (elso.length < 2) { hiba(out, 400, "hibás kérés"); return; }

        String metodus = elso[0];
        String utvonal = elso[1];

        String range = null;
        for (int i = 1; i < sorok.length; i++) {
            int k = sorok[i].indexOf(':');
            if (k < 0) continue;
            if (sorok[i].substring(0, k).trim().equalsIgnoreCase("Range")) {
                range = sorok[i].substring(k + 1).trim();
            }
        }

        /* ---- jegy és cél ellenőrzése ---- */
        String uriS = param(utvonal, "uri");
        String jegyS = param(utvonal, "t");
        if (jegyS == null || !jegy.equals(jegyS)) { hiba(out, 403, "hibás jegy"); return; }
        if (uriS == null) { hiba(out, 400, "nincs uri"); return; }

        Uri uri = Uri.parse(uriS);
        long teljes = meret(uri);
        if (teljes <= 0) { hiba(out, 404, "a fájl nem olvasható"); return; }

        /* ---- bájt-tartomány ---- */
        long tol = 0, ig = teljes - 1;
        boolean reszleges = false;
        if (range != null && range.startsWith("bytes=")) {
            String r = range.substring(6).trim();
            int m = r.indexOf('-');
            if (m >= 0) {
                try {
                    String a = r.substring(0, m).trim();
                    String b = r.substring(m + 1).trim();
                    if (!a.isEmpty()) {
                        tol = Long.parseLong(a);
                        if (!b.isEmpty()) ig = Math.min(teljes - 1, Long.parseLong(b));
                    } else if (!b.isEmpty()) {          /* bytes=-N : az utolsó N bájt */
                        tol = Math.max(0, teljes - Long.parseLong(b));
                    }
                    reszleges = true;
                } catch (Exception ignored) { }
            }
        }
        if (tol >= teljes) { hiba(out, 416, "a kért tartomány a fájl végén túl van"); return; }
        long hossz = ig - tol + 1;

        /* ---- válaszfejléc ---- */
        StringBuilder h = new StringBuilder();
        h.append(reszleges ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        h.append("Content-Type: ").append(tipus(uriS)).append("\r\n");
        h.append("Content-Length: ").append(hossz).append("\r\n");
        h.append("Accept-Ranges: bytes\r\n");
        if (reszleges) {
            h.append("Content-Range: bytes ").append(tol).append('-').append(ig)
             .append('/').append(teljes).append("\r\n");
        }
        /* a WebView más origin-ből kéri, ezért kell a CORS-engedély */
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Headers: Range\r\n");
        h.append("Access-Control-Expose-Headers: Content-Range, Content-Length\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));

        if ("HEAD".equalsIgnoreCase(metodus) || "OPTIONS".equalsIgnoreCase(metodus)) {
            out.flush();
            return;
        }

        /* ---- törzs ---- */
        InputStream fin = null;
        try {
            fin = ctx.getContentResolver().openInputStream(uri);
            if (fin == null) return;

            long ugrando = tol;
            while (ugrando > 0) {
                long n = fin.skip(ugrando);
                if (n <= 0) break;
                ugrando -= n;
            }

            byte[] buf = new byte[131072];
            long marad = hossz;
            while (marad > 0) {
                int n = fin.read(buf, 0, (int) Math.min(buf.length, marad));
                if (n <= 0) break;
                out.write(buf, 0, n);
                marad -= n;
            }
            out.flush();
        } catch (Exception ignored) {
            /* seek-nél a lejátszó félbehagyja a kérést — ez normális */
        } finally {
            try { if (fin != null) fin.close(); } catch (Exception ignored) { }
        }
    }

    private long meret(Uri uri) {
        android.database.Cursor cur = null;
        try {
            cur = ctx.getContentResolver().query(uri,
                    new String[]{ android.provider.DocumentsContract.Document.COLUMN_SIZE },
                    null, null, null);
            if (cur != null && cur.moveToFirst()) return cur.getLong(0);
        } catch (Exception ignored) {
        } finally {
            if (cur != null) try { cur.close(); } catch (Exception ignored) { }
        }
        return 0;
    }

    private String tipus(String nev) {
        String n = nev.toLowerCase();
        if (n.contains(".mp3")) return "audio/mpeg";
        if (n.contains(".m4b") || n.contains(".m4a") || n.contains(".mp4")) return "audio/mp4";
        if (n.contains(".aac")) return "audio/aac";
        if (n.contains(".wav")) return "audio/wav";
        if (n.contains(".ogg") || n.contains(".opus")) return "audio/ogg";
        if (n.contains(".flac")) return "audio/flac";
        if (n.contains(".jpg") || n.contains(".jpeg")) return "image/jpeg";
        if (n.contains(".png")) return "image/png";
        if (n.contains(".webp")) return "image/webp";
        return "application/octet-stream";
    }

    private String param(String utvonal, String kulcs) {
        int q = utvonal.indexOf('?');
        if (q < 0) return null;
        for (String p : utvonal.substring(q + 1).split("&")) {
            int e = p.indexOf('=');
            if (e < 0) continue;
            if (p.substring(0, e).equals(kulcs)) {
                try { return URLDecoder.decode(p.substring(e + 1), "UTF-8"); }
                catch (Exception ex) { return null; }
            }
        }
        return null;
    }

    private void hiba(OutputStream out, int kod, String szoveg) {
        try {
            byte[] b = szoveg.getBytes("UTF-8");
            out.write(("HTTP/1.1 " + kod + " Error\r\n" +
                       "Content-Length: " + b.length + "\r\n" +
                       "Access-Control-Allow-Origin: *\r\n" +
                       "Connection: close\r\n\r\n").getBytes("UTF-8"));
            out.write(b);
            out.flush();
        } catch (Exception ignored) { }
    }
}
