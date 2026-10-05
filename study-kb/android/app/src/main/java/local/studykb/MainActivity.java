package local.studykb;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.DisplayCutoutCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends ComponentActivity {
    private static final String LOCAL_URL = "http://127.0.0.1:8033/";
    private static final int NOTIFICATION_REQUEST = 1;

    private WebView webView;
    private TextView statusView;
    private boolean pageLoaded;
    private final StudyServerState.Listener listener = this::render;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);
        View root = findViewById(R.id.root);
        applySystemInsets(root);
        webView = findViewById(R.id.web);
        statusView = findViewById(R.id.status);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setSupportZoom(true);
        webView.getSettings().setBuiltInZoomControls(true);
        webView.getSettings().setDisplayZoomControls(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                statusView.setVisibility(android.view.View.GONE);
            }
        });
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_REQUEST
            );
        }
        ContextCompat.startForegroundService(this, new Intent(this, StudyServerService.class));
    }

    @Override
    protected void onStart() {
        super.onStart();
        StudyServerState.addListener(listener);
        render();
    }

    @Override
    protected void onStop() {
        StudyServerState.removeListener(listener);
        super.onStop();
    }

    private void render() {
        runOnUiThread(() -> {
            String status = StudyServerState.status();
            if (StudyServerState.ERROR.equals(status)) {
                statusView.setVisibility(android.view.View.VISIBLE);
                String detail = StudyServerState.detail();
                statusView.setText(detail.isEmpty() ? getString(R.string.server_failed) : detail);
                return;
            }
            if (StudyServerState.READY.equals(status)) {
                String detail = StudyServerState.detail();
                if (!detail.isEmpty()) {
                    statusView.setText(detail);
                }
                if (!pageLoaded) {
                    webView.loadUrl(LOCAL_URL);
                }
            }
        });
    }

    private void applySystemInsets(View root) {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), root);
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            int types = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = windowInsets.getInsets(types);
            Insets waterfall = Insets.NONE;
            DisplayCutoutCompat cutout = windowInsets.getDisplayCutout();
            if (cutout != null) {
                waterfall = cutout.getWaterfallInsets();
            }
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(
                Math.max(bars.left, waterfall.left),
                Math.max(bars.top, waterfall.top),
                Math.max(bars.right, waterfall.right),
                Math.max(Math.max(bars.bottom, waterfall.bottom), ime.bottom)
            );
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
    }

    private static boolean isLocal(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if ("about".equals(scheme)) {
            return true;
        }
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return false;
        }
        String host = uri.getHost();
        return "127.0.0.1".equals(host) || "localhost".equals(host);
    }
}
