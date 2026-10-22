import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../../3dStudio/3dworkbench/web/hostHelp.mjs", import.meta.url), "utf8");
const studySource = await readFile(new URL("../web/studyHelp.mjs", import.meta.url), "utf8");
const fixtures = JSON.parse(await readFile(new URL("../../3dStudio/tests/contracts/schema-fixtures.json", import.meta.url), "utf8"));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const texts = (title) => ({ zh: { title, hint: title + "提示", body: title + "正文" }, en: { title: title + " EN", hint: "Hint", body: "Body" } });

async function setup() {
  const dom = new JSDOM('<html lang="zh-CN"><body><header class="topbar"><div class="toolbar"><button id="refresh">Refresh</button></div></header><section data-help-plugin="sample"><section data-help-page="plans"><input value="draft"></section><section data-help-page="preview" hidden><button data-help-action="apply">Preview</button></section><section data-help-page="editor" hidden></section></section><section data-help-plugin="other" hidden><section data-help-page="session"></section></section></body></html>', { url: "http://localhost/" });
  const document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  const context = vm.createContext({ document, window: dom.window, structuredClone, console });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => {}); await module.evaluate();
  const study = new vm.SourceTextModule(studySource, { context });
  await study.link(() => {}); await study.evaluate();
  const api = module.namespace;
  const topics = [
    { pluginId: "sample", locales: texts("Plugin") },
    { pluginId: "sample", page: "plans", locales: texts("Plans") },
    { pluginId: "sample", page: "preview", locales: texts("Preview") },
    { pluginId: "sample", page: "preview", action: "apply", locales: texts("Apply") },
    { pluginId: "other", page: "session", locales: texts("Other") },
  ];
  const install = (extra = {}) => api.installHostHelp({ topics, getContext: () => ({ pluginId: "sample" }), ...extra });
  return { dom, document, api, topics, install, study: study.namespace };
}

test("help registry resolves action, page, plugin then host with language fallback", async () => {
  const ui = await setup();
  try {
    const registry = ui.api.createHelpRegistry([...ui.api.builtinHelpTopics, ...ui.topics]);
    assert.equal(registry.resolve({ pluginId: "sample", page: "preview", action: "apply" }).title, "Apply");
    assert.equal(registry.resolve({ pluginId: "sample", page: "preview", action: "missing" }).title, "Preview");
    assert.equal(registry.resolve({ pluginId: "sample", page: "missing" }).title, "Plugin");
    assert.equal(registry.resolve({ pluginId: "missing" }).title, "工作台帮助");
    assert.equal(registry.resolve({ pluginId: "sample", page: "plans" }, "en").title, "Plans EN");
    assert.equal(registry.resolve({ pluginId: "sample" }, "unknown").title, "Plugin");
  } finally { ui.dom.window.close(); }
});

test("help registration rejects duplicate scopes and matches shared schema fixtures", async () => {
  const ui = await setup();
  try {
    assert.throws(() => ui.api.createHelpRegistry([ui.topics[0], ui.topics[0]]), /Duplicate/);
    for (const fixture of fixtures.filter((item) => item.schema === "help.schema.json")) {
      if (fixture.valid) assert.doesNotThrow(() => ui.api.createHelpRegistry([fixture.value]));
      else assert.throws(() => ui.api.createHelpRegistry([fixture.value]));
    }
    const registry = ui.api.createHelpRegistry([ui.topics[0]]);
    ui.topics[0].locales.zh.title = "mutated";
    assert.equal(registry.resolve({ pluginId: "sample" }).title, "Plugin");
  } finally { ui.dom.window.close(); }
});

test("one host question button opens a safe dialog, Escape closes and restores focus", async () => {
  const ui = await setup();
  try {
    const help = ui.install();
    assert.equal(ui.install(), help);
    assert.equal(ui.document.querySelectorAll("#workbench-help").length, 1);
    ui.document.querySelector("#workbench-help").click();
    const dialog = ui.document.querySelector(".wb-help-dialog");
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector("h2").textContent, "Plans");
    ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(dialog.open, false);
    assert.equal(ui.document.activeElement.id, "workbench-help");
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("help trigger is adjacent to refresh and uses an anchored non-modal bubble", async () => {
  const ui = await setup();
  try {
    const help = ui.install();
    const toolbar = ui.document.querySelector(".toolbar");
    assert.equal([...toolbar.children].map((item) => item.id).filter(Boolean).join(","), "workbench-help,refresh");
    assert.equal(ui.document.querySelector(".wb-help-hint").hidden, true);
    const dialog = ui.document.querySelector(".wb-help-dialog");
    assert.equal(dialog.hasAttribute("aria-modal"), false);
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("hidden pages are ignored and help follows visible page changes without losing drafts", async () => {
  const ui = await setup();
  try {
    const help = ui.install();
    help.open();
    const input = ui.document.querySelector("input"); input.value = "unsaved";
    ui.document.querySelector('[data-help-page="plans"]').hidden = true;
    ui.document.querySelector('[data-help-page="preview"]').hidden = false;
    await settle();
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Preview");
    assert.equal(ui.document.querySelector("input"), input);
    assert.equal(input.value, "unsaved");
    ui.document.querySelector('[data-help-action="apply"]').dispatchEvent(new ui.dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Apply");
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("help follows main activation and last interacted visible upper or lower plugin", async () => {
  const ui = await setup();
  try {
    const help = ui.install(); help.open();
    const other = ui.document.querySelector('[data-help-plugin="other"]'); other.hidden = false;
    other.dispatchEvent(new ui.dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Other");
    ui.document.dispatchEvent(new ui.dom.window.CustomEvent("workbench:activecontext", { detail: { pluginId: "sample" } }));
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Plans");
    other.hidden = true;
    other.dispatchEvent(new ui.dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Plans");
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("language change updates help in place without fetching or replacing plugin content", async () => {
  const ui = await setup();
  try {
    let calls = 0; ui.dom.window.fetch = () => { calls++; throw new Error("unexpected fetch"); };
    const help = ui.install(); help.open();
    const root = ui.document.querySelector('[data-help-plugin="sample"]');
    ui.document.documentElement.lang = "en";
    ui.document.dispatchEvent(new ui.dom.window.CustomEvent("workbench:languagechange", { detail: { locale: "en" } }));
    assert.equal(ui.document.querySelector("#workbench-help").getAttribute("aria-label"), "Help");
    assert.equal(ui.document.querySelector(".wb-help-dialog h2").textContent, "Plans EN");
    assert.equal(ui.document.querySelector('[data-help-plugin="sample"]'), root);
    assert.equal(calls, 0);
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("plain help text cannot execute HTML and command references are not buttons", async () => {
  const ui = await setup();
  try {
    const value = '<img src=x onerror="alert(1)">';
    const help = ui.install({ topics: [{ pluginId: "sample", commandIds: ["data.binding.validate"], locales: texts(value) }] });
    help.open();
    const dialog = ui.document.querySelector(".wb-help-dialog");
    assert.equal(dialog.querySelector("img"), null);
    assert.equal(dialog.querySelector("h2").textContent, value);
    assert.match(dialog.querySelector(".wb-help-commands").textContent, /data.binding.validate/);
    assert.equal(dialog.querySelectorAll("button").length, 1);
    help.dispose();
  } finally { ui.dom.window.close(); }
});

test("help disposal removes controls and listeners and allows a fresh installation", async () => {
  const ui = await setup();
  try {
    const help = ui.install(); help.dispose();
    assert.equal(ui.document.querySelector("#workbench-help"), null);
    ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "F1", cancelable: true }));
    assert.equal(ui.document.querySelector("dialog"), null);
    const next = ui.install();
    assert.notEqual(next, help);
    ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "F1", cancelable: true }));
    assert.equal(ui.document.querySelector("dialog").open, true);
    next.dispose();
  } finally { ui.dom.window.close(); }
});

test("Study provides validated bilingual topics for tree plans, editing and review sessions", async () => {
  const ui = await setup();
  try {
    const registry = ui.api.createHelpRegistry([...ui.api.builtinHelpTopics, ...ui.study.studyHelpTopics]);
    assert.equal(registry.resolve({ pluginId: "study.node-tree", page: "node-edit" }).title, "编辑节点");
    assert.equal(registry.resolve({ pluginId: "study.review-table", page: "session" }, "en").title, "Review and rate");
    assert.equal(registry.resolve({ pluginId: "study.node-tree", page: "config" }).title, "配置树数据方案");
    assert.equal(registry.resolve({ pluginId: "study.pomodoro" }).title, "番茄钟");
  } finally { ui.dom.window.close(); }
});
