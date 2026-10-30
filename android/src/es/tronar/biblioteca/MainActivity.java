package es.tronar.biblioteca;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

// Abre la web del reproductor a pantalla completa. Nada más.
public class MainActivity extends Activity {
    private static final String URL = "__APP_URL__"; // build.sh lo sustituye por APP_URL
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient()); // los enlaces se abren dentro de la app
        setContentView(web);
        if (state != null) web.restoreState(state);
        else web.loadUrl(URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // Atrás: vuelve en el historial; si no hay, deja la app en segundo plano (el audio sigue).
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }
}
