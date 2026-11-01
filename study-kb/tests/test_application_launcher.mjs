import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createApplicationLauncher, applicationLauncherLabels } from "../../3dStudio/3dworkbench/web/components/applicationLauncher.mjs";
import { createApplicationLauncherState, searchApplications } from "../../3dStudio/3dworkbench/web/components/applicationLauncherState.mjs";

const applications = [
  { applicationId: "demo.table", label: "表格", searchTerms: ["Table", "数据网格"], icon: "/table.svg" },
  { applicationId: "demo.timer", label: "番茄钟", searchTerms: ["Pomodoro", "Timer"] },
  { applicationId: "demo.off", label: "Disabled", available: false },
];
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(options = {}) {
  const dom = new JSDOM('<div id="mount"></div><button id="outside">Outside</button>', { url: "http://localhost" });
  const document = dom.window.document;
  const activated = [], errors = [];
  const launcher = createApplicationLauncher({ document, mount: document.querySelector("#mount"), storage: dom.window.localStorage, storageKey: "test", onActivate: async (id) => activated.push(id), onError: (error) => errors.push(error), ...options });
  launcher.setApplications(applications);
  const q = (selector) => document.querySelector(selector);
  return { dom, document, launcher, activated, errors, q };
}

test("legacy pins migrate once, retain order, and do not auto-pin newly installed apps", () => {
  let saved = JSON.stringify({ order: ["demo.timer", "missing", "demo.table", "demo.timer"], hidden: ["demo.table"] });
  let writes = 0;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } };
  const state = createApplicationLauncherState({ storage, storageKey: "test" });
  state.setApplications(applications);
  assert.deepEqual(state.pinnedIds(), ["demo.timer", "missing"]);
  state.setApplications([...applications, { applicationId: "new", label: "New" }]);
  assert.deepEqual(state.pinnedIds(), ["demo.timer", "missing"]);
  assert.equal(writes, 1);
  state.setPinned("demo.table", true);
  state.moveBefore("demo.table", "demo.timer");
  const reloaded = createApplicationLauncherState({ storage, storageKey: "test" });
  reloaded.setApplications(applications);
  assert.deepEqual(reloaded.pinnedIds(), ["demo.table", "demo.timer", "missing"]);
});

test("search matches Unicode, names, aliases and ID, with all tokens required", () => {
  const found = (query) => searchApplications(applications, query).map((app) => app.applicationId);
  assert.deepEqual(found("  ＴＡＢＬＥ  "), ["demo.table"]);
  assert.deepEqual(found("数据 网格"), ["demo.table"]);
  assert.deepEqual(found("表格 TIMER"), []);
  assert.deepEqual(found("DEMO.TIMER"), ["demo.timer"]);
  assert.deepEqual(found("番茄"), ["demo.timer"]);
  assert.deepEqual(found(""), ["demo.table", "demo.timer"]);
});

test("all apps opens without search or input focus; second click reveals search; pins do not activate", async () => {
  const ui = setup();
  try {
    ui.q(".app-launcher-button").click();
    const panel = ui.q(".wb-app-menu");
    assert.equal(panel.hidden, false);
    assert.equal(ui.q(".wb-launcher-search"), null);
    assert.equal(ui.q(".wb-launcher-compact-search"), null);
    assert.equal(ui.q(".wb-launcher-panel-search").hidden, true);
    assert.notEqual(ui.document.activeElement.tagName, "INPUT");
    assert.equal(panel.querySelectorAll(".wb-launcher-result").length, 2);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-dock-item").length, 2);
    ui.q('[data-application-id="demo.table"][data-action="pin"]').click();
    assert.deepEqual(ui.activated, []);
    assert.equal(ui.document.querySelectorAll(".wb-launcher-result").length, 2);
    assert.deepEqual(ui.launcher.getPinnedIds(), ["demo.timer"]);
    ui.q(".wb-launcher-search-toggle").click();
    const search = ui.q(".wb-launcher-panel-search");
    assert.equal(search.hidden, false);
    assert.equal(ui.document.activeElement, search);
    search.value = "表格"; search.dispatchEvent(new ui.dom.window.Event("input"));
    assert.equal(ui.q(".wb-app-menu"), panel);
    assert.equal(panel.querySelectorAll(".wb-launcher-result").length, 1);
    assert.equal(ui.q(".wb-launcher-panel-search").value, "表格");
    ui.q(".wb-launcher-result").click(); await settle();
    assert.deepEqual(ui.activated, ["demo.table"]);
    assert.equal(panel.hidden, true);
    ui.q(".app-launcher-button").click();
    assert.equal(search.hidden, true);
    assert.equal(search.value, "");
    assert.notEqual(ui.document.activeElement, search);
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("IME Enter is ignored; arrows navigate; Escape returns to all apps without reopening search", async () => {
  const ui = setup();
  try {
    ui.q(".app-launcher-button").click();
    ui.q(".wb-launcher-search-toggle").click();
    const search = ui.q(".wb-launcher-panel-search");
    search.dispatchEvent(new ui.dom.window.CompositionEvent("compositionstart"));
    search.value = "番茄";
    search.dispatchEvent(new ui.dom.window.Event("input"));
    search.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(); assert.deepEqual(ui.activated, []);
    search.dispatchEvent(new ui.dom.window.CompositionEvent("compositionend"));
    assert.equal(ui.q(".wb-launcher-panel-search").value, "番茄");
    search.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(ui.document.activeElement.dataset.pluginId, "demo.timer");
    ui.document.activeElement.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(ui.q(".wb-app-menu").hidden, true);
    assert.equal(ui.document.activeElement, ui.q(".app-launcher-button"));
    assert.equal(search.hidden, true);
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("icon failure retains accessible shortcut; keyboard sorting replaces order buttons", () => {
  const ui = setup();
  try {
    const shortcut = ui.q('.wb-bsp-dock-item[data-plugin-id="demo.table"]');
    shortcut.querySelector("img").dispatchEvent(new ui.dom.window.Event("error"));
    assert.equal(shortcut.querySelector("img"), null);
    assert.equal(shortcut.querySelector(".wb-launcher-fallback").hidden, false);
    assert.equal(shortcut.getAttribute("aria-label"), "表格");
    assert.equal(ui.q('.wb-launcher-move'), null);
    ui.q('.wb-bsp-dock-item[data-plugin-id="demo.timer"]').dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(ui.launcher.getPinnedIds(), ["demo.timer", "demo.table"]);
    ui.q('.wb-bsp-dock-item[data-plugin-id="demo.timer"]').dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true }));
    assert.deepEqual(ui.launcher.getPinnedIds(), ["demo.table", "demo.timer"]);
    assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem("test")).pinnedIds, ["demo.table", "demo.timer"]);
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("placing pins is atomic, persists once, skips no-ops and leaves the directory intact", () => {
  let saved = JSON.stringify({ version: 2, pinnedIds: ["demo.timer"] }), writes = 0;
  const state = createApplicationLauncherState({ storageKey: "test", storage: { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } } });
  state.setApplications(applications);
  assert.equal(state.placePinned("demo.table", "demo.timer"), true);
  assert.equal(writes, 1);
  assert.deepEqual(state.pinnedIds(), ["demo.table", "demo.timer"]);
  assert.equal(state.placePinned("demo.table", "demo.timer"), false);
  assert.equal(state.placePinned("demo.off", null), false);
  assert.equal(writes, 1);
  assert.deepEqual(state.applications().map(app => app.applicationId), ["demo.table", "demo.timer"]);
});

test("directory order persists independently, retains unavailable preferences and appends new apps", () => {
  let saved = JSON.stringify({ version: 2, pinnedIds: ["demo.table"], directoryIds: ["demo.timer", "missing", "demo.table"] }), writes = 0;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; writes++; } };
  const state = createApplicationLauncherState({ storageKey: "test", storage });
  state.setApplications(applications);
  assert.deepEqual(state.applications().map(app => app.applicationId), ["demo.timer", "demo.table"]);
  assert.equal(state.placeApplication("demo.table", "demo.timer"), true);
  assert.equal(writes, 1);
  assert.deepEqual(state.pinnedIds(), ["demo.table"]);
  assert.equal(state.placeApplication("demo.table", "demo.timer"), false);
  assert.equal(state.placeApplication("demo.off"), false);
  assert.equal(writes, 1);
  const reloaded = createApplicationLauncherState({ storageKey: "test", storage });
  reloaded.setApplications([...applications, { applicationId: "missing" }, { applicationId: "new" }]);
  assert.deepEqual(reloaded.applications().map(app => app.applicationId), ["demo.table", "demo.timer", "missing", "new"]);
  assert.equal(reloaded.placeApplication("demo.table", "demo.timer", { unpin: true }), true);
  assert.equal(writes, 2); assert.deepEqual(reloaded.pinnedIds(), []);
});

test("directory keyboard ordering leaves pins intact and retains focused tile", () => {
  const ui = setup();
  try {
    ui.launcher.open(); const tile = ui.q('.wb-launcher-result[data-plugin-id="demo.table"]'); tile.focus();
    tile.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true, cancelable: true }));
    assert.equal(ui.q('.wb-launcher-result').dataset.pluginId, "demo.timer");
    assert.deepEqual(ui.launcher.getPinnedIds(), ["demo.table", "demo.timer"]);
    assert.equal(ui.document.activeElement.dataset.pluginId, "demo.table");
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("activation deduplicates rapid clicks and reports failure without losing directory", async () => {
  let finish, calls = 0;
  const ui = setup({ onActivate: () => { calls++; return new Promise((_, reject) => { finish = reject; }); } });
  try {
    ui.launcher.open();
    const button = ui.q(".wb-launcher-result");
    button.click(); button.click();
    assert.equal(calls, 1);
    finish(new Error("no space")); await settle();
    assert.equal(ui.q(".wb-app-menu").hidden, false);
    assert.match(ui.q(".wb-launcher-status").textContent, /no space/);
    assert.equal(ui.errors.length, 1);
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("a failed Dock activation never opens All apps as a side effect", async () => {
  const ui = setup({ onActivate: async () => { throw new Error("no space"); } });
  try {
    ui.q(".wb-launcher-shortcut").click(); await settle();
    assert.equal(ui.q(".wb-app-menu").hidden, true);
    assert.equal(ui.q(".app-launcher-button").getAttribute("aria-expanded"), "false");
    assert.equal(ui.errors.length, 1);
  } finally { ui.launcher.dispose(); ui.dom.window.close(); }
});

test("storage failure is nonfatal; dynamic catalog and labels preserve query; dispose cleans document listeners", () => {
  const ui = setup({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } } });
  try {
    assert.equal(ui.errors.length, 1);
    ui.launcher.open({ query: "Table" });
    ui.launcher.setLabels(applicationLauncherLabels.en);
    assert.equal(ui.q(".app-launcher-button").getAttribute("aria-label"), "All apps");
    assert.equal(ui.q(".wb-launcher-panel-search").value, "Table");
    ui.launcher.setApplications(applications.filter((app) => app.applicationId !== "demo.table"));
    assert.equal(ui.q(".wb-launcher-result"), null);
    assert.match(ui.q(".wb-launcher-empty").textContent, /No apps/);
    ui.launcher.setApplications(applications);
    assert.ok(ui.q(".wb-launcher-result"));
    ui.launcher.dispose();
    assert.equal(ui.q(".wb-app-menu"), null);
    assert.equal(ui.q(".wb-application-launcher"), null);
    ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  } finally { ui.dom.window.close(); }
});
