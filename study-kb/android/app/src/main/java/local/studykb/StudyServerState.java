package local.studykb;

import java.util.concurrent.CopyOnWriteArrayList;

/** Process-local status shared by the server thread and the activity. */
public final class StudyServerState {
    public static final String STARTING = "starting";
    public static final String READY = "ready";
    public static final String ERROR = "error";

    public interface Listener {
        void onChanged();
    }

    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();
    private static volatile String status = STARTING;
    private static volatile String detail = "";

    private StudyServerState() {
    }

    public static String status() {
        return status;
    }

    public static String detail() {
        return detail;
    }

    public static void publish(String nextStatus, String nextDetail) {
        status = nextStatus;
        detail = nextDetail == null ? "" : nextDetail;
        for (Listener listener : LISTENERS) {
            listener.onChanged();
        }
    }

    public static void addListener(Listener listener) {
        LISTENERS.add(listener);
    }

    public static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }
}
