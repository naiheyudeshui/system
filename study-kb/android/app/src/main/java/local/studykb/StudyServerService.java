package local.studykb;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import com.chaquo.python.Python;

import java.io.File;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class StudyServerService extends Service {
    private static final int NOTIFICATION_ID = 8033;
    private static final int PORT = 8033;
    private final AtomicBoolean running = new AtomicBoolean(false);

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = notification(getString(R.string.starting));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        if (running.compareAndSet(false, true)) {
            Thread thread = new Thread(this::serve, "study-server");
            thread.start();
        }
        return START_STICKY;
    }

    private void serve() {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        try {
            File runtime = RuntimeExtractor.extract(this);
            Thread server = new Thread(() -> {
                try {
                    Python.getInstance()
                        .getModule("bootstrap")
                        .callAttr("main", runtime.getAbsolutePath());
                } catch (Throwable error) {
                    failure.set(error);
                }
            }, "study-python");
            server.start();
            waitUntilListening(server, failure);
            String status = runningStatus();
            StudyServerState.publish(StudyServerState.READY, status);
            updateNotification(status);
        } catch (Throwable error) {
            running.set(false);
            Throwable cause = failure.get() == null ? error : failure.get();
            StudyServerState.publish(StudyServerState.ERROR, cause.toString());
            updateNotification(getString(R.string.server_failed));
        }
    }

    private void waitUntilListening(Thread server, AtomicReference<Throwable> failure) throws Exception {
        long deadline = System.currentTimeMillis() + 30_000L;
        while (System.currentTimeMillis() < deadline) {
            if (portOpen()) {
                return;
            }
            Throwable error = failure.get();
            if (error != null) {
                if (error instanceof Exception exception) {
                    throw exception;
                }
                throw new IllegalStateException(error);
            }
            if (!server.isAlive()) {
                throw new IllegalStateException("study server exited before listening");
            }
            Thread.sleep(200L);
        }
        throw new IllegalStateException("study server did not listen on 127.0.0.1:" + PORT);
    }

    private boolean portOpen() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", PORT), 200);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private String runningStatus() {
        String address = lanUrl();
        if (address == null) {
            return getString(R.string.running) + " " + getString(R.string.no_lan);
        }
        return getString(R.string.running) + " " + address;
    }

    private String lanUrl() {
        String wifi = null;
        String other = null;
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) {
                    continue;
                }
                String name = nif.getName() == null ? "" : nif.getName().toLowerCase();
                boolean wireless = name.startsWith("wlan") || name.contains("wifi") || name.startsWith("ap");
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) {
                        continue;
                    }
                    String host = addr.getHostAddress();
                    if (host == null || host.startsWith("169.254.")) {
                        continue;
                    }
                    if (wireless) {
                        wifi = host;
                    } else if (other == null) {
                        other = host;
                    }
                }
            }
        } catch (Exception ignored) {
            return null;
        }
        String host = wifi != null ? wifi : other;
        return host == null ? null : "http://" + host + ":" + PORT;
    }

    private void updateNotification(String text) {
        Notification notification = notification(text);
        android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, StudyApp.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    }
}
