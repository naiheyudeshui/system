package local.studykb;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.graphics.Color;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.webkit.URLUtil;
import android.widget.Toast;
import android.widget.TextView;
import android.widget.Button;
import android.widget.ScrollView;
import android.app.AlertDialog;
import com.chaquo.python.Python;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

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
    private static final String LOCAL_URL = "http://127.0.0.1:" + BuildConfig.SERVER_PORT + "/";
    private static final int NOTIFICATION_REQUEST = 1;

    private WebView webView;
    private View rootView;
    private TextView statusView;
    private boolean pageLoaded;
    private ValueCallback<Uri[]> fileSelection;
    private String pendingDownload;
    private final ActivityResultLauncher<Intent> chooseUpload = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileSelection == null) return;
            Uri[] selected = WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData());
            fileSelection.onReceiveValue(selected);
            fileSelection = null;
        });
    private final ActivityResultLauncher<Intent> saveDownload = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(), result -> {
            String source = pendingDownload;
            pendingDownload = null;
            Uri target = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() == RESULT_OK && target != null && source != null) {
                streamDownload(source, target);
            }
        });
    private final StudyServerState.Listener listener = this::render;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        setContentView(R.layout.activity_main);
        View root = findViewById(R.id.root);
        rootView = root;
        applySystemInsets(root);
        webView = findViewById(R.id.web);
        statusView = findViewById(R.id.status);
        webView.setBackgroundColor(getColor(R.color.app_background));
        if (BuildConfig.SHOW_CONTRACT_DIAGNOSTICS) {
            setTitle("学习库 · 重构测试版");
            Button tests = findViewById(R.id.contract_tests);
            tests.setVisibility(View.VISIBLE);
            tests.setOnClickListener(view -> runContractTests(tests));
        }
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.getSettings().setSupportZoom(true);
        webView.getSettings().setBuiltInZoomControls(true);
        webView.getSettings().setDisplayZoomControls(false);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams parameters) {
                if (fileSelection != null) fileSelection.onReceiveValue(null);
                fileSelection = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                chooseUpload.launch(intent);
                return true;
            }
        });
        webView.setDownloadListener((url, userAgent, disposition, mime, length) ->
            offerDownload(url, URLUtil.guessFileName(url, disposition, mime), mime));
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void onThemeChanged() {
                runOnUiThread(MainActivity.this::syncSystemBarColor);
            }
            @JavascriptInterface
            public void downloadFile(String url, String filename, String mime) {
                // JS may start the document picker before a large HTTP export,
                // avoiding WebView's preliminary download then re-download.
                runOnUiThread(() -> offerDownload(url, filename, mime));
            }
        }, "StudyNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isLocal(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageLoaded = true;
                syncSystemBarColor();
                view.evaluateJavascript(
                    "(function(){if(window.__studyNativeThemeObserver)return;" +
                    "window.__studyNativeThemeObserver=true;let pending=false;" +
                    "new MutationObserver(function(){if(pending)return;pending=true;" +
                    "requestAnimationFrame(function(){pending=false;" +
                    "if(window.StudyNative)window.StudyNative.onThemeChanged();});})" +
                    ".observe(document.documentElement,{attributes:true," +
                    "attributeFilter:['data-theme','style','class']});})()",
                    null
                );
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
        if (pageLoaded) syncSystemBarColor();
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
                if (BuildConfig.SHOW_CONTRACT_DIAGNOSTICS) {
                    TextView address = findViewById(R.id.contract_address);
                    address.setText(detail + "\n仅限可信局域网，允许访问测试副本，不连接正式主库");
                    address.setVisibility(View.VISIBLE);
                }
                if (!detail.isEmpty()) {
                    statusView.setText(detail);
                }
                if (!pageLoaded) {
                    webView.loadUrl(LOCAL_URL);
                }
            }
        });
    }

    private void runContractTests(Button button) {
        button.setEnabled(false);
        button.setText("正在运行分支自测…");
        new Thread(() -> {
            String report;
            try {
                File runtime = new File(getFilesDir(), "runtime");
                if (!new File(runtime, "contract-v2-build.json").isFile()) {
                    throw new IllegalStateException("运行时尚未准备好，请等待服务启动");
                }
                report = Python.getInstance().getModule("contract_selftest")
                    .callAttr("run", runtime.getAbsolutePath(), getCacheDir().getAbsolutePath()).toString();
            } catch (Throwable error) {
                report = "自测未完成：" + error;
            }
            final String result = report;
            runOnUiThread(() -> {
                button.setEnabled(true);
                button.setText("重构分支自测（临时数据，不写正式库）");
                if (isFinishing() || isDestroyed()) return;
                TextView text = new TextView(this);
                text.setText(result);
                text.setTextIsSelectable(true);
                text.setPadding(24, 16, 24, 16);
                ScrollView scroll = new ScrollView(this);
                scroll.addView(text);
                new AlertDialog.Builder(this).setTitle("重构分支自测结果")
                    .setView(scroll).setPositiveButton("关闭", null).show();
            });
        }, "contract-selftest").start();
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

    private void syncSystemBarColor() {
        if (webView == null || isFinishing() || isDestroyed()) return;
        webView.evaluateJavascript(
            "getComputedStyle(document.documentElement).getPropertyValue('--page').trim()",
            value -> {
                if (value == null || isFinishing() || isDestroyed()) return;
                String css = value.trim();
                if (css.length() >= 2 && css.startsWith("\"") && css.endsWith("\"")) {
                    css = css.substring(1, css.length() - 1);
                }
                try {
                    int color = Color.parseColor(css);
                    rootView.setBackgroundColor(color);
                    webView.setBackgroundColor(color);
                    statusView.setBackgroundColor(color);
                    // On edge-to-edge Android versions the root paints behind
                    // the bars; on older versions these also color the bars.
                    getWindow().setStatusBarColor(color);
                    getWindow().setNavigationBarColor(color);
                    boolean light = ((Color.red(color) * 299
                        + Color.green(color) * 587
                        + Color.blue(color) * 114) / 1000) > 160;
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), rootView);
                    controller.setAppearanceLightStatusBars(light);
                    controller.setAppearanceLightNavigationBars(light);
                } catch (IllegalArgumentException ignored) {
                    // Keep the initial theme if --page is not a supported color.
                }
            }
        );
    }

    private void offerDownload(String url, String filename, String mime) {
        Uri uri = Uri.parse(url);
        if (!isLocal(uri) || uri.getPort() != BuildConfig.SERVER_PORT) {
            Toast.makeText(this, "请使用本机资料库的文件下载链接", Toast.LENGTH_LONG).show();
            return;
        }
        if (pendingDownload != null) {
            Toast.makeText(this, "请先完成当前文件的保存选择", Toast.LENGTH_SHORT).show();
            return;
        }
        pendingDownload = url;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime == null ? "application/octet-stream" : mime);
        String safeName = filename == null ? "study-backup.zip" : filename.replace('\\', '/');
        safeName = safeName.substring(safeName.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}]", "");
        intent.putExtra(Intent.EXTRA_TITLE, safeName.isEmpty() ? "study-backup.zip" : safeName);
        saveDownload.launch(intent);
    }

    private void streamDownload(String source, Uri target) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            String result;
            try {
                connection = (HttpURLConnection) new URL(source).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(120000);
                if (connection.getResponseCode() != 200) throw new java.io.IOException("下载失败 HTTP " + connection.getResponseCode());
                long expected = connection.getContentLengthLong();
                long received = 0;
                try (InputStream input = connection.getInputStream();
                     OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                    if (output == null) throw new java.io.IOException("无法打开目标文档");
                    byte[] buffer = new byte[65536];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        received += count;
                    }
                    output.flush();
                }
                if (expected >= 0 && expected != received) throw new java.io.IOException("文件下载不完整，请重新导出");
                result = "文件已保存到所选位置；请妥善保存，备份可能含私人资料";
            } catch (Exception error) {
                result = "保存未完成，请删除目标位置的不完整文件后重试：" + error.getMessage();
            } finally {
                if (connection != null) connection.disconnect();
            }
            final String message = result;
            runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show());
        }, "study-file-download").start();
    }

    @Override
    protected void onDestroy() {
        if (fileSelection != null) {
            fileSelection.onReceiveValue(null);
            fileSelection = null;
        }
        super.onDestroy();
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
