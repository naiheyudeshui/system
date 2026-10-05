package local.studykb;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;

import com.chaquo.python.android.PyApplication;

public class StudyApp extends PyApplication {
    public static final String CHANNEL_ID = "study-server";

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
