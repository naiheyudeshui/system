package local.studykb;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Copies the packaged runtime into app-private storage. */
public final class RuntimeExtractor {
    private static final String ASSET_ROOT = "runtime";
    private static final String MANIFEST = "runtime-manifest.txt";
    private static final String STAMP = "runtime-stamp.txt";
    private static final String DATABASE = "study-kb/data/study.sqlite";

    private RuntimeExtractor() {
    }

    public static File extract(Context context) throws IOException {
        File root = new File(context.getFilesDir(), ASSET_ROOT);
        if (!root.isDirectory() && !root.mkdirs()) {
            throw new IOException("cannot create " + root);
        }
        AssetManager assets = context.getAssets();
        String stamp = readAsset(assets, ASSET_ROOT + "/" + STAMP).trim();
        File stampFile = new File(root, STAMP);
        File server = new File(root, "study-kb/tools/serve_workbench.py");
        if (server.isFile() && stampFile.isFile() && stamp.equals(readFile(stampFile).trim())) {
            return root;
        }
        for (String rel : readAsset(assets, ASSET_ROOT + "/" + MANIFEST).split("\n")) {
            String path = rel.trim().replace('\\', '/');
            if (path.isEmpty() || path.contains("..")) {
                continue;
            }
            File dest = new File(root, path);
            if (DATABASE.equals(path) && dest.isFile()) {
                continue;
            }
            File parent = dest.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("cannot create " + parent);
            }
            try (InputStream input = assets.open(ASSET_ROOT + "/" + path);
                 FileOutputStream output = new FileOutputStream(dest)) {
                byte[] buffer = new byte[65536];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                }
            }
        }
        try (FileOutputStream output = new FileOutputStream(stampFile)) {
            output.write((stamp + "\n").getBytes(StandardCharsets.UTF_8));
        }
        if (!server.isFile()) {
            throw new IOException("missing " + server);
        }
        if (!new File(root, DATABASE).isFile()) {
            throw new IOException("missing study database");
        }
        return root;
    }

    private static String readAsset(AssetManager assets, String path) throws IOException {
        try (InputStream input = assets.open(path)) {
            return readText(input);
        }
    }

    private static String readFile(File file) throws IOException {
        try (InputStream input = new java.io.FileInputStream(file)) {
            return readText(input);
        }
    }

    private static String readText(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
