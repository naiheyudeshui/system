// Run before styles and app modules so Android starts at the requested density.
// Viewport zoom keeps CSS layout, pointer coordinates and container queries in
// the same coordinate system. Desktop/LAN browser preferences are untouched.
(() => {
  try {
    if (typeof window.StudyNative?.contentScalePercent !== "function") return;
    const percent = Number(window.StudyNative.contentScalePercent());
    if (!Number.isFinite(percent) || percent < 60 || percent > 100) return;
    const viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) return;
    const scale = percent / 100;
    viewport.content = `width=device-width, initial-scale=${scale}`;
    document.documentElement.dataset.studyContentScale = String(scale);
  } catch { /* A missing/older native bridge retains the normal browser scale. */ }
})();
