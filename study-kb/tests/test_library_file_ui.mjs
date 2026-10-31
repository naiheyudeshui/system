import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderLibrarySyncPanel } from "../web/studyLibrarySync.mjs";
import { renderFileReferenceAudit } from "../web/studyFileReferenceAudit.mjs";

test("library UI streams scoped downloads and reuses ambiguous import requests", async () => {
  const dom = new JSDOM("<div id='panel'></div>", { url: "http://localhost:18034" });
  const previous = Object.fromEntries(["window", "document", "location", "fetch", "StudyNative"].map(key => [key, globalThis[key]]));
  const calls = [], downloads = [];
  let imports = 0, reloads = 0;
  Object.assign(globalThis, {
    document: dom.window.document, location: { href: dom.window.location.href },
    window: { confirm: () => true, location: { reload: () => reloads++ } },
    StudyNative: { downloadFile: (...args) => downloads.push(args) },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("tree-roots")) return Response.json({ roots: [{ id: "node:root", title: "所选章节" }] });
      if (url.endsWith("/status")) return Response.json({ initialized: true });
      if (url.includes("/bundles/import")) {
        if (++imports === 1) throw new Error("Network interrupted after upload");
        return Response.json({ scope: "unit", imported: { roots: ["node:copy"] } });
      }
      throw new Error("Unexpected request " + url);
    },
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const panel = document.getElementById("panel"); renderLibrarySyncPanel(panel); await tick();
    const button = label => [...panel.querySelectorAll("button")].find(item => item.textContent === label);
    button("导出所选知识树 ZIP").click(); await tick();
    assert.equal(downloads.length, 1);
    const url = new URL(downloads[0][0]);
    assert.equal(url.searchParams.get("scope"), "unit");
    assert.equal(url.searchParams.get("id"), "node:root");
    assert.equal(calls.filter(item => item.url.includes("bundles/export")).length, 0, "browser must not materialize backup as a Blob");
    const input = panel.querySelector('input[type="file"]');
    for (let attempt = 0; attempt < 2; attempt++) {
      button("导入知识树为副本").click();
      Object.defineProperty(input, "files", { configurable: true, value: [new dom.window.File(["ZIP"], "tree.zip", { type: "application/zip", lastModified: 42 })] });
      input.dispatchEvent(new dom.window.Event("change")); await tick(); await tick();
    }
    const posts = calls.filter(item => item.url.includes("bundles/import"));
    assert.equal(posts.length, 2); assert.equal(posts[0].url, posts[1].url, "ambiguous retry must confirm the same job");
    assert.equal(new URL(posts[0].url, dom.window.location.href).searchParams.get("replace"), null);
    assert.equal(reloads, 1);
  } finally {
    Object.assign(globalThis, previous); dom.window.close();
  }
});

test("reference audit requires inspection and confirmation, then retries the same rebuild after response loss", async () => {
  const dom = new JSDOM("<div id='panel'></div>", { url: "http://localhost:18034" });
  const previous = globalThis.fetch, calls = [], busy = [];
  const report = { token: "a".repeat(64), canRebuild: true, ownersScanned: 3, assetsChecked: 2, referencesAdded: 2, referencesRemoved: 1, blockingIssues: 0, unsupportedSources: 1, unknownOwners: 1, issues: [{ code: "legacy-workspace-unmapped", source: "<img src=x onerror=alert(1)>" }] };
  let attempts = 0, confirm = false;
  dom.window.confirm = () => confirm;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/preview")) return Response.json(report);
    if (++attempts === 1) throw new Error("Response lost");
    return Response.json({ rebuilt: true, replayed: true, filesDeleted: 0 });
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const panel = dom.window.document.getElementById("panel");
    const controls = renderFileReferenceAudit(panel, { onBusy: value => busy.push(value) });
    const [inspect, rebuild] = panel.querySelectorAll("button");
    assert.equal(calls.length, 0); assert.equal(rebuild.disabled, true);
    controls.setBusy(true); inspect.click(); assert.equal(calls.length, 0); controls.setBusy(false);
    inspect.click(); inspect.click(); await tick();
    assert.equal(calls.length, 1); assert.equal(rebuild.disabled, false);
    assert.equal(panel.querySelector("img"), null);
    assert.match(panel.textContent, /待补 2 条、待清 1 条/);
    rebuild.click(); await tick(); assert.equal(calls.length, 1, "cancel must not post");
    confirm = true; rebuild.click(); await tick(); assert.equal(rebuild.disabled, false);
    rebuild.click(); await tick();
    const posts = calls.filter(item => item.options.method === "POST");
    assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body);
    assert.equal(posts[0].options.credentials, "same-origin");
    assert.match(panel.querySelector('[role="status"]').textContent, /已确认上次重建成功/);
    assert.equal(rebuild.disabled, true);
    assert.deepEqual(busy, [true, false, true, false, true, false]);
  } finally { globalThis.fetch = previous; dom.window.close(); }
});

test("blocked audit and stale confirmation keep rebuild disabled until a new inspection", async () => {
  const dom = new JSDOM("<div id='panel'></div>", { url: "http://localhost:18034" });
  const previous = globalThis.fetch;
  let blocked = true, posts = 0;
  dom.window.confirm = () => true;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/preview")) return Response.json({ token: "b".repeat(64), canRebuild: !blocked, ownersScanned: 1, assetsChecked: 1, referencesAdded: 1, referencesRemoved: 0, blockingIssues: +blocked, unsupportedSources: 0, unknownOwners: 0, issues: [] });
    posts++; return Response.json({ error: "Attachment references changed", code: "audit_changed" }, { status: 409 });
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const panel = dom.window.document.getElementById("panel"); renderFileReferenceAudit(panel);
    const [inspect, rebuild] = panel.querySelectorAll("button");
    inspect.click(); await tick(); rebuild.click(); assert.equal(posts, 0);
    assert.equal(rebuild.disabled, true);
    blocked = false; inspect.click(); await tick(); assert.equal(rebuild.disabled, false);
    rebuild.click(); await tick(); assert.equal(posts, 1); assert.equal(rebuild.disabled, true);
    assert.match(panel.querySelector('[role="status"]').textContent, /请重新检查/);
  } finally { globalThis.fetch = previous; dom.window.close(); }
});
