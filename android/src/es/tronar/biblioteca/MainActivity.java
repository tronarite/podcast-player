package es.tronar.biblioteca;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

// Abre la web del reproductor a pantalla completa. La dirección del servidor se pide la primera
// vez (y de nuevo si no conecta) y se guarda en el móvil.
public class MainActivity extends Activity {
    private static final String KEY = "url";
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("config", MODE_PRIVATE);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() { // los enlaces se abren dentro de la app
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) askUrl("No se pudo conectar. Revisa la dirección del servidor.");
            }
        });
        setContentView(web);
        String url = prefs.getString(KEY, null);
        if (state != null) web.restoreState(state);
        else if (url != null) web.loadUrl(url);
        else askUrl("Dirección del servidor, p. ej. http://192.168.1.10:48213/");
    }

    private void askUrl(String message) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(prefs.getString(KEY, "http://"));
        new AlertDialog.Builder(this)
            .setTitle("Servidor")
            .setMessage(message)
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Conectar", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    String url = input.getText().toString().trim();
                    if (!url.matches("(?i)https?://.*")) url = "http://" + url;
                    prefs.edit().putString(KEY, url).apply();
                    web.loadUrl(url);
                }
            })
            .show();
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
