import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const shared = new URL("../../3dStudio/3dworkbench/web/", import.meta.url);
const workspaceSource = await readFile(new URL("pluginWorkspace.mjs", shared), "utf8");
const mappingSource = await readFile(new URL("treeMapping.mjs", shared), "utf8");
const managerSource = await readFile(new URL("pluginConfigManager.mjs", shared), "utf8");
const reviewSource = await readFile(new URL("../web/studySqlReview.mjs", import.meta.url), "utf8");
const previewSource = await readFile(new URL("tablePreview.mjs", shared), "utf8");
const platformSource = await readFile(new URL("workbenchPlatform.mjs", shared), "utf8");
const treeSource = await readFile(new URL("treeWorkspace.mjs", shared), "utf8");
const treeAdapterSource = await readFile(new URL("../web/studyTreeWorkspace.mjs", import.meta.url), "utf8");
const workspaceCss = await readFile(new URL("pluginWorkspace.css", shared), "utf8");
const settle = () => new Promise((resolve) => setImmediate(resolve));

function drop(ui, id, target) {
  const event = new ui.dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => id } });
  ui.document.querySelector(target).dispatchEvent(event);
}

async function setup() {
  const dom = new JSDOM('<header class="topbar"><div class="toolbar"></div></header><section class="data-pane"><div class="table-frame">Table</div></section><section class="inspector-pane"><div class="tabs"><button class="tab" data-tab="fields">Fields</button><button class="tab" data-tab="plugins">Plugins</button></div><div id="inspector-fields" class="inspector-panel active"></div><div id="inspector-plugin-panels"></div></section>', { url: "http://localhost" });
  dom.window.confirm = () => true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function (value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  const context = vm.createContext({ document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage, Event: dom.window.Event, Option: dom.window.Option, structuredClone, console, requestAnimationFrame: (callback) => callback() });
  const workspace = new vm.SourceTextModule(workspaceSource, { context });
  const manager = new vm.SourceTextModule(managerSource, { context });
  const markdown = new vm.SyntheticModule(["attachMarkdownToggle", "renderMarkdown"], function () {
    this.setExport("renderMarkdown", (value, target) => { target.textContent = value; });
    this.setExport("attachMarkdownToggle", (toolbar, target, getText) => ({ refresh: () => { target.textContent = getText(); } }));
  }, { context });
  const platform = new vm.SourceTextModule(platformSource, { context });
  await platform.link(() => {}); await platform.evaluate();
  const preview = new vm.SourceTextModule(previewSource, { context });
  await preview.link(() => platform); await preview.evaluate();
  const review = new vm.SourceTextModule(reviewSource, { context });
  await workspace.link(() => {}); await workspace.evaluate();
  const mapping = new vm.SourceTextModule(mappingSource, { context });
  await mapping.link(() => {}); await mapping.evaluate();
  await manager.link(() => mapping); await manager.evaluate();
  await review.link((specifier) => specifier.includes("pluginConfigManager") ? manager : specifier.includes("tablePreview") ? preview : markdown); await review.evaluate();
  const tree = new vm.SourceTextModule(treeSource, { context });
  await tree.link(() => {}); await tree.evaluate();
  const treeAdapter = new vm.SourceTextModule(treeAdapterSource, { context });
  await treeAdapter.link((specifier) => specifier.includes("pluginConfigManager") ? manager : specifier.includes("tablePreview") ? preview : specifier.includes("treeWorkspace") ? tree : markdown); await treeAdapter.evaluate();
  return { tree: tree.namespace, treeAdapter: treeAdapter.namespace, dom, document: dom.window.document, workspace: workspace.namespace, manager: manager.namespace, review: review.namespace, preview: preview.namespace };
}

test("workspace mounts once, changes placement without losing state and keeps table context", async () => {
  const ui = await setup();
  try {
    const plugins = [
      { id: "study.review-table", state: "enabled", contributes: { panels: [{ id: "review", label: "Review", location: "inspector" }] } },
      { id: "official.table-print", state: "enabled", contributes: { panels: [{ id: "print", label: "Print", location: "inspector" }] } },
    ];
    let layout = { revision: 0, groups: { top: [plugins[0].id], bottom: [plugins[1].id], disabled: [] } };
    const mounts = [];
    const host = ui.workspace.createPluginWorkspace({
      api: async () => structuredClone(layout),
      postApi: async (url, payload) => { layout = { ...payload, revision: payload.revision + 1 }; return layout; },
      loadPanel: (panel, id, contribution, context) => { mounts.push(id); panel.textContent = `state:${id}:${context.currentObject().name}`; },
      context: () => ({ currentObject: () => ({ name: "selected_view" }) }),
    });
    await host.update(plugins);
    assert.equal(mounts.length, 2);
    assert.equal(ui.document.querySelectorAll('.wb-plugin-navigation [data-workspace="manager"]').length, 0);
    assert.ok(ui.document.querySelector('[data-workspace="table"] svg'));
    assert.equal(ui.document.querySelectorAll('.wb-plugin-card select,.wb-plugin-card button').length, 0);
    host.show(plugins[0].id);
    assert.equal(ui.document.querySelector(".table-frame").hidden, true);
    const reviewPanel = ui.document.querySelector(".wb-plugin-workspace .wb-plugin-instance");
    host.show("manager");
    assert.ok(ui.document.querySelector("#inspector-plugins.active .wb-plugin-manager"));
    assert.equal(ui.document.querySelector(".table-frame").hidden, true);
    drop(ui, plugins[0].id, '[data-zone="bottom"]');
    await settle();
    assert.equal(mounts.length, 2);
    assert.equal(reviewPanel.parentElement.id, "inspector-plugin-panels");
    assert.match(reviewPanel.textContent, /selected_view/);
    assert.equal(ui.document.querySelectorAll(".wb-plugin-zone").length, 3);
    drop(ui, plugins[0].id, '[data-zone="bottom"] [data-plugin-id="official.table-print"]');
    await settle();
    assert.deepEqual(layout.groups.bottom, [plugins[0].id, plugins[1].id]);
    assert.equal(mounts.length, 2);
    await host.update(plugins);
    assert.equal(mounts.length, 2);
    host.show("table");
    assert.equal(ui.document.querySelector(".table-frame").hidden, false);
  } finally { ui.dom.window.close(); }
});

test("ordinary and official plugins share disabled placement and icon fallback", async () => {
  const ui = await setup();
  try {
    const plugin = { id: "official.sqlite-triggers", state: "enabled", builtin: true, icon: "icon.svg", contributes: { panels: [{ id: "triggers", label: "Triggers", location: "inspector" }] } };
    let layout = { revision: 0, groups: { top: [plugin.id], bottom: [], disabled: [] } };
    const host = ui.workspace.createPluginWorkspace({ api: async () => layout, postApi: async (url, payload) => { layout = { ...payload, revision: 1 }; return layout; }, loadPanel: () => {}, context: () => ({}) });
    await host.update([plugin]);
    const image = ui.document.querySelector(".wb-plugin-navigation img");
    image.dispatchEvent(new ui.dom.window.Event("error"));
    assert.equal(ui.document.querySelector(".wb-plugin-navigation img"), null);
    host.show(plugin.id);
    host.show("manager");
    drop(ui, plugin.id, '[data-zone="disabled"]'); await settle();
    assert.equal(layout.groups.disabled[0], plugin.id);
    host.show("table");
    assert.equal(ui.document.querySelector(".table-frame").hidden, false);
    assert.equal(ui.document.querySelectorAll(".wb-plugin-zone-disabled article").length, 1);
  } finally { ui.dom.window.close(); }
});

test("internal manager returns to the original live panel and keeps dirty edits when cancelled", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section");
    const original = ui.document.createElement("input"); original.value = "running state"; root.append(original);
    ui.document.body.append(root);
    await ui.manager.openConfigManager(root, { api: async () => ({ configs: [] }), postApi: async () => ({}), pluginId: "test", moduleId: "test" });
    const name = root.querySelector('[aria-label="方案名称"]');
    name.value = "unsaved"; name.dispatchEvent(new ui.dom.window.Event("input"));
    ui.dom.window.confirm = () => false;
    [...root.querySelectorAll("button")].find((node) => node.textContent === "返回").click();
    assert.ok(root.querySelector(".wb-config-editor"));
    ui.dom.window.confirm = () => true;
    [...root.querySelectorAll("button")].find((node) => node.textContent === "返回").click();
    assert.equal(root.firstChild, original);
    assert.equal(original.value, "running state");
  } finally { ui.dom.window.close(); }
});

test("layout save failure restores placement and reports the error", async () => {
  const ui = await setup();
  try {
    const plugin = { id: "test.print", state: "enabled", contributes: { panels: [{ id: "print", location: "inspector" }] } };
    const layout = { revision: 0, groups: { top: [], bottom: [plugin.id], disabled: [] } };
    const host = ui.workspace.createPluginWorkspace({ api: async () => structuredClone(layout), postApi: async () => { throw new Error("conflict"); }, loadPanel: () => {}, context: () => ({}) });
    await host.update([plugin]); host.show("manager");
    drop(ui, plugin.id, '[data-zone="top"]'); await settle();
    assert.ok(ui.document.querySelector('[data-zone="bottom"] .wb-plugin-card'));
    assert.match(ui.document.querySelector(".wb-plugin-error").textContent, /conflict/);
    assert.equal(ui.document.querySelectorAll("#inspector-plugin-panels .wb-plugin-instance").length, 1);
  } finally { ui.dom.window.close(); }
});

test("SQL review removes chapter controls, keeps saved parameters and grades after preview", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const calls = [];
    const configuration = { id: "chapters", name: "章节卡片", parameters: { node_id: null } };
    const state = { session_id: "session", config: { view: "章节卡片" }, total: 1, completed: 0, position: 0, card: { front: "Question", back: "Answer" } };
    const api = async (url) => url.endsWith("catalog") ? { nodes: [{ id: "chapter", title: "Chapter" }] } : { configs: [configuration] };
    const postApi = async (url, payload) => {
      calls.push({ url, payload });
      if (url.endsWith("sql-session")) return state;
      if (url.endsWith("session-grade")) return { graded: { due_at: "2030-01-01" }, next: { ...state, card: null, completed: 1 } };
      return { matched: 1, selected: 1, duplicates: 0, missing_schedule: 0, limit: 5000, preview_hash: "verified", columns: ["card_id", "question", "answer"], rows: [{ card_id: "one", question: "Question", answer: "Answer" }] };
    };
    await ui.review.renderReviewTablePanel(root, { api, postApi });
    const button = (label) => [...root.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === label);
    assert.equal(root.querySelector('[aria-label="node_id"]'), null);
    assert.equal(root.querySelector('[aria-label="搜索章节"]'), null);
    root.querySelector('[aria-label="方案设置"]').click();
    button("编辑已有方案").click(); await settle();
    button("返回").click(); await settle();
    assert.doesNotMatch(root.textContent, /章节范围|含后代/);
    button("预览并筛选").click(); await settle();
    assert.equal(calls.length, 1);
    assert.match(root.querySelector("table").textContent, /Answer/);
    root.querySelector('[data-action="confirm-start"]').click(); await settle();
    assert.equal(calls[0].payload.parameters.node_id, null);
    assert.equal(calls[1].payload.preview_hash, "verified");
    assert.equal(calls[1].payload.selected_keys[0], "one");
    assert.equal(root.querySelector(".study-learning-card").hidden, false);
    assert.equal(root.querySelector(".study-learning-card section").hidden, true);
    button("显示答案").click();
    assert.match(root.textContent, /Answer/);
    button("3 · 良好").click(); await settle();
    assert.equal(calls.at(-1).payload.position, 0);
    assert.match(root.textContent, /本轮复习已完成/);
  } finally { ui.dom.window.close(); }
});


test("preview filters the complete collection and paginates using shared column popover", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const rows = Array.from({ length: 75 }, (_, index) => ({ card_id: index, question: `Question ${index}`, chapter: index < 60 ? "A" : "B" }));
    let filtered;
    ui.preview.renderTablePreview(root, { rows, columns: ["question", "chapter"], onChange: (value) => { filtered = value; } });
    assert.equal(filtered.length, 75);
    assert.equal(root.querySelectorAll("tbody tr").length, 50);
    const button = (label) => [...ui.document.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === label);
    button("下一页").click(); assert.equal(root.querySelectorAll("tbody tr").length, 25);
    root.querySelector('[aria-label="筛选 chapter"]').click();
    const option = ui.document.querySelector('.table-filter-popover input[value="B"]'); option.checked = true;
    button("应用").click();
    assert.equal(filtered.length, 15);
    assert.equal(filtered[0].card_id, 60);
    button("清空列筛选").click(); assert.equal(filtered.length, 75);
    root.querySelector('[aria-label="筛选 question"]').click();
    ui.document.querySelector('.table-filter-popover input').value = "absent";
    button("应用").click(); assert.equal(filtered.length, 0);
  } finally { ui.dom.window.close(); }
});

test("shared previews cap long columns and wrap long values", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const longValue = "长内容 ".repeat(120);
    ui.preview.renderTablePreview(root, { rows: [{ id: "1", title: longValue }], columns: ["id", "title"] });
    const table = root.querySelector("table");
    assert.equal(table.style.tableLayout, "fixed");
    assert.match(table.style.getPropertyValue("--table-min-width"), /px$/);
    const longCell = root.querySelector("tbody td.wb-preview-long-text");
    assert.ok(longCell);
    assert.match(longCell.style.width, /px$/);
    assert.match(workspaceCss, /wb-preview-frame td\.wb-preview-long-text/);
  } finally { ui.dom.window.close(); }
});

test("collapsed inspector hides active plugin container despite consumer ID flex rule", async () => {
  const ui = await setup();
  try {
    const style = ui.document.createElement("style");
    style.textContent = '#inspector-plugin-panels { display:flex; } body.inspector-hidden .inspector-pane > :not(.inspector-toggle) { display:none; }\n' + workspaceCss;
    ui.document.head.append(style);
    ui.document.body.classList.add("inspector-hidden");
    const bottom = ui.document.querySelector("#inspector-plugin-panels");
    bottom.innerHTML = '<section class="wb-plugin-instance"><h3>打印当前表格</h3></section>';
    assert.equal(ui.dom.window.getComputedStyle(bottom).display, "none");
    ui.document.body.classList.remove("inspector-hidden");
    assert.equal(ui.dom.window.getComputedStyle(bottom).display, "flex");
  } finally { ui.dom.window.close(); }
});


test("plan cards expose only selected actions, edit current plan, create new and require preview", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const entries = [{ id: "first", name: "First", sql: "SELECT 1", parameters: {} }, { id: "second", name: "Second", sql: "SELECT 2", parameters: {} }];
    const calls = [];
    ui.dom.window.localStorage.setItem("study.review.session.v1", JSON.stringify("previous"));
    const api = async (url) => {
      calls.push(url);
      return url.endsWith("catalog") ? { nodes: [] } : { configs: entries, definition: { contract: "review-cards/v1" } };
    };
    await ui.review.renderReviewTablePanel(root, { api, postApi: async () => ({ rows: [], columns: ["card_id", "question"], limit: 5000, preview_hash: "empty", duplicates: 0, missing_schedule: 0 }) });
    const button = (label) => [...root.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === label);
    assert.equal(root.querySelectorAll(".study-plan-card").length, 2);
    assert.equal(button("导入旧方案"), undefined);
    assert.doesNotMatch(reviewSource, /import-legacy|study\.review\.profiles\.v1/);
    assert.equal(root.querySelectorAll(".study-plan-card .wb-config-actions").length, 1);
    assert.equal(root.querySelector(".study-learning-card").hidden, true);
    assert.equal(calls.some((url) => url.includes("/session/")), false);
    assert.equal(calls.some((url) => url.endsWith("catalog")), false);
    assert.equal(button("继续上次复习").hidden, false);
    assert.equal(button("继续上次复习").nextElementSibling, root.querySelector('[aria-label="方案设置"]'));
    assert.ok(button("继续上次复习").closest(".study-review-header"));
    const management = root.querySelector(".study-plan-management");
    assert.equal(management.hidden, true);
    assert.equal(management, root.querySelector(".study-plan-grid").firstElementChild);
    assert.equal(management.children.length, 2);
    assert.equal(button("编辑已有方案").querySelector("b").textContent, "⚙");
    assert.equal(button("新增方案").querySelector("b").textContent, "+");
    assert.ok(button("开始一轮学习").classList.contains("primary"));
    assert.ok(!button("预览并筛选").classList.contains("primary"));
    root.querySelector('[aria-label="方案设置"]').click();
    assert.equal(management.hidden, false);
    root.querySelector('[aria-label="方案设置"]').click();
    assert.equal(management.hidden, true);
    button("Second").click();
    assert.equal(root.querySelector(".is-selected").dataset.configId, "second");
    root.querySelector('[aria-label="方案设置"]').click();
    button("编辑已有方案").click(); await settle();
    assert.equal(root.querySelector('[aria-label="方案名称"]').value, "Second");
    button("返回").click(); await settle();
    button("新增方案").click(); await settle();
    assert.equal(root.querySelector('[aria-label="方案名称"]').value, "");
    assert.match(root.querySelector("textarea").value, /card_id/);
    button("返回").click(); await settle();
    button("开始一轮学习").click(); await settle();
    assert.equal(root.querySelector('[data-action="confirm-start"]').disabled, true);
    assert.match(root.textContent, /筛选 0 条/);
  } finally { ui.dom.window.close(); }
});

test("review plan cards expose edit and delete controls in management mode", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let entries = [{ id: "first", revision: 3, name: "First", sql: "SELECT 1", parameters: {} }];
    const posts = [];
    const api = async () => ({ configs: entries, definition: { contract: "review-cards/v1" } });
    const postApi = async (url, payload) => {
      posts.push({ url, payload });
      if (url.endsWith("/delete")) entries = [];
      return {};
    };
    await ui.review.renderReviewTablePanel(root, { api, postApi });
    root.querySelector('[aria-label="方案设置"]').click();
    assert.ok(root.querySelector('[aria-label="编辑方案 First"]'));
    root.querySelector('[aria-label="删除方案 First"]').click();
    const dialog = ui.document.querySelector(".wb-confirm-dialog");
    assert.match(dialog.textContent, /复习轮次与评分记录保留/);
    dialog.returnValue = "confirm";
    dialog.dispatchEvent(new ui.dom.window.Event("close"));
    await settle();
    assert.equal(posts[0].url, "/api/plugin/config/delete");
    assert.equal(JSON.stringify(posts[0].payload), JSON.stringify({ plugin_id: "study.review-table", module_id: "reviews", id: "first", revision: 3 }));
    assert.equal(root.querySelectorAll(".study-plan-card").length, 0);
  } finally { ui.dom.window.close(); }
});


test("tree browser replaces graph with outline and returns from nested details without losing root or mode", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const child = { id: "child", title: "<img src=x onerror=alert(1)>", data: { answer: "**Detail**", note: "Source" }, children: [] };
    const roots = [{ id: "root", title: "Root", data: {}, children: [child] }];
    const filtered = ui.tree.filterTree(roots, ["child"]);
    assert.equal(filtered.addedAncestors, 1);
    const host = ui.tree.createTreeWorkspace(root, { roots, detailFields: [{ column: "answer", format: "markdown" }, { column: "note", format: "text" }], renderMarkdown: (value, target) => { target.textContent = value; }, onRefresh: async () => { throw new Error("offline"); } });
    const button = (label) => [...root.querySelectorAll("button")].find((node) => node.textContent === label);
    root.querySelector('[aria-label="展开或收起子树 Root"]').dispatchEvent(new ui.dom.window.Event("click"));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    assert.equal(root.querySelector("img"), null);
    button("大纲").click();
    assert.equal(root.querySelector(".wb-tree-canvas").hidden, true);
    assert.equal(root.querySelector(".wb-tree-outline").hidden, false);
    root.querySelector('.wb-tree-outline [data-node-id="child"]').click();
    assert.equal(root.querySelector(".wb-tree-browser").hidden, true);
    assert.equal(root.querySelectorAll(".wb-tree-detail-module").length, 2);
    button("返回树页面").click();
    assert.equal(host.getState().mode, "outline");
    root.querySelector('.wb-tree-outline [data-node-id="child"]').click();
    button("以此节点为根").click();
    assert.equal(host.getState().root, "child");
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 1);
    button("恢复全图").click();
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 2);
    button("树图").click();
    button("刷新").click(); await settle();
    assert.match(root.textContent, /刷新失败：offline/);
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    host.dispose();
  } finally { ui.dom.window.close(); }
});


test("tree editor saves canonical content and retries refresh without duplicate writes", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let content = "Original", saves = 0, failRefresh = false;
    const payload = () => ({ roots: [{ id: "node:root", title: "Root", data: { content_md: content }, children: [] }], rows: [{ node_id: "node:root", parent_id: null, title: "Root", content_md: content }], columns: ["node_id", "parent_id", "title", "content_md"], detail_fields: [{ column: "content_md", format: "markdown" }], editing: { provider: "study-knowledge/v1" }, validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] });
    const requests = [];
    await ui.treeAdapter.renderNodeTreePanel(root, { api: async (url) => {
      if (url.includes("/configs?")) return { configs: [] };
      if (failRefresh) { failRefresh = false; throw new Error("refresh offline"); }
      return payload();
    }, postApi: async (url, values) => {
      requests.push([url, values]);
      if (url.endsWith("/read")) return { node: { node_id: "node:root", title: "Root", content_md: content }, version: "version-1" };
      saves++; content = values.content_md; failRefresh = true;
      return { node: { node_id: "node:root", title: "Root", content_md: content }, version: "version-2" };
    } });
    const button = (label) => [...root.querySelectorAll("button")].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    const input = root.querySelector('[aria-label="编辑节点 Markdown"]');
    assert.equal(input.value, "Original");
    input.value = "**Changed**";
    input.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(saves, 0);
    button("保存").click(); button("保存").click(); await settle(); await settle();
    assert.equal(saves, 1);
    assert.match(root.querySelector(".study-tree-editor").textContent, /已保存，但树图刷新失败/);
    button("重新加载树").click(); await settle(); await settle();
    assert.equal(saves, 1);
    assert.equal(root.querySelector(".study-tree-editor"), null);
    assert.match(root.querySelector(".wb-tree-inline-content").textContent, /Changed/);
    assert.equal(requests[1][1].version, "version-1");
    root.dispose();
  } finally { ui.dom.window.close(); }
});


test("editable tree shortcuts are scoped and content background reaches rounded edge", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const operations = [];
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", data: { back: "Answer" }, children: [] }], detailFields: [{ column: "back" }], onEdit: async (operation, node) => { operations.push([operation, node.id]); } });
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    const send = async (key, shiftKey = false, target = root.querySelector(".wb-tree-graph-node")) => {
      const event = new ui.dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
      target.dispatchEvent(event); await settle(); return event;
    };
    assert.equal((await send("Tab")).defaultPrevented, true);
    await send("Enter"); await send("Enter", true);
    assert.equal(JSON.stringify(operations), JSON.stringify([["child", "root"], ["sibling", "root"], ["content", "root"]]));
    assert.equal((await send("Tab", true)).defaultPrevented, false);
    const toggle = root.querySelector('[aria-label="展开或收起内容 Root"]');
    await send("Enter", false, toggle);
    assert.equal(operations.length, 3);
    const body = root.querySelector(".wb-tree-inline-content");
    assert.equal((await send("Enter", true, body)).defaultPrevented, false);
    const foreign = root.querySelector("foreignObject");
    assert.equal(foreign.getAttribute("x"), "0");
    assert.equal(foreign.getAttribute("width"), root.querySelector(".wb-tree-node-frame").getAttribute("width"));
    assert.match(workspaceCss, /\.wb-tree-inline-content \{[^}]*background:transparent/);
    const state = host.getState(); host.dispose();
    const readonly = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", children: [] }], initialState: state });
    assert.equal((await send("Tab")).defaultPrevented, false);
    readonly.dispose();
  } finally { ui.dom.window.close(); }
});


test("node controls share the rounded surface and retain accessible keyboard focus", async () => {
  const ui = await setup();
  try {
    const roots = [{ id: "root", title: "Root", data: { back: "Answer" }, children: [{ id: "child", title: "Child", children: [] }] }];
    const containers = [ui.document.createElement("section"), ui.document.createElement("section")];
    containers.forEach((container) => ui.document.body.append(container));
    const hosts = containers.map((container) => ui.tree.createTreeWorkspace(container, { roots, detailFields: [{ column: "back" }] }));
    assert.notEqual(containers[0].querySelector("clipPath").id, containers[1].querySelector("clipPath").id);
    const root = containers[0];
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    let card = root.querySelector('[data-node-id="root"]');
    const frame = card.querySelector(".wb-tree-node-frame");
    const clip = card.querySelector("clipPath rect");
    for (const attribute of ["width", "height", "rx"]) assert.equal(frame.getAttribute(attribute), clip.getAttribute(attribute));
    assert.equal(card.lastElementChild, frame);
    assert.ok(card.querySelector(".wb-tree-node-surface").getAttribute("clip-path").includes(card.querySelector("clipPath").id));
    assert.equal(card.querySelectorAll(".wb-tree-node-surface .wb-tree-node-control").length, 2);
    assert.equal(card.querySelectorAll(".wb-tree-control-focus").length, 2);
    const toggle = card.querySelector('[aria-label="展开或收起内容 Root"]');
    toggle.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    card = root.querySelector('[data-node-id="root"]');
    assert.equal(ui.document.activeElement, card.querySelector('[aria-label="展开或收起内容 Root"]'));
    assert.ok(card.querySelector(".wb-tree-inline-content"));
    assert.equal(card.querySelector("clipPath rect").getAttribute("height"), card.querySelector(".wb-tree-node-frame").getAttribute("height"));
    assert.match(workspaceCss, /\.wb-tree-node-control:focus-visible \.wb-tree-control-focus/);
    assert.doesNotMatch(workspaceCss, /\.wb-tree-graph-node:hover rect/);
    hosts.forEach((host) => host.dispose());
  } finally { ui.dom.window.close(); }
});

test("child toggle remains clickable when move support is enabled", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const operations = [];
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", children: [{ id: "child", title: "Child", children: [] }] }], onMove: async (...args) => operations.push(args), onDelete: async () => {} });
    const toggle = root.querySelector('[aria-label="展开或收起子树 Root"]');
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true }));
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("pointerup", { button: 0, bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    assert.equal(operations.length, 0);
    assert.equal([...root.querySelectorAll("button")].find((button) => button.textContent === "删除节点")?.hidden, false);
    host.dispose();
  } finally { ui.dom.window.close(); }
});


test("canvas prevents drag selection and wheel zoom keeps the pointer anchored", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", data: { back: "Answer" }, children: [] }], detailFields: [{ column: "back" }] });
    const canvas = root.querySelector(".wb-tree-canvas");
    const svg = canvas.querySelector("svg");
    svg.getBoundingClientRect = () => {
      const position = svg.style.transform.match(/translate\(([-+.\deE]+)px, ([-+.\deE]+)px\)/);
      const width = parseFloat(svg.style.width);
      return { left: (800 - width) / 2 + Number(position[1]), top: Number(position[2]), width, height: parseFloat(svg.style.height) };
    };
    const down = new ui.dom.window.MouseEvent("pointerdown", { button: 0, cancelable: true });
    canvas.dispatchEvent(down); assert.equal(down.defaultPrevented, true);
    canvas.dispatchEvent(new ui.dom.window.Event("lostpointercapture"));
    const selection = new ui.dom.window.Event("selectstart", { bubbles: true, cancelable: true });
    svg.dispatchEvent(selection); assert.equal(selection.defaultPrevented, true);
    const before = svg.getBoundingClientRect();
    const wheel = new ui.dom.window.WheelEvent("wheel", { deltaY: -120, clientX: 420, clientY: 40, bubbles: true, cancelable: true });
    svg.dispatchEvent(wheel);
    const after = svg.getBoundingClientRect();
    assert.equal(wheel.defaultPrevented, true);
    assert.ok(after.width > before.width);
    assert.ok(Math.abs((420 - before.left) / before.width - (420 - after.left) / after.width) < 1e-8);
    assert.ok(Math.abs((40 - before.top) / before.height - (40 - after.top) / after.height) < 1e-8);
    svg.dispatchEvent(new ui.dom.window.WheelEvent("wheel", { deltaY: 120, clientX: 420, clientY: 40, bubbles: true, cancelable: true }));
    assert.ok(Math.abs(svg.getBoundingClientRect().width - before.width) < 1e-8);
    root.querySelector('.wb-tree-graph-node[data-node-id="root"]').dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector('[aria-label="展开或收起内容 Root"]').dispatchEvent(new ui.dom.window.Event("click"));
    const body = root.querySelector(".wb-tree-inline-content");
    const contentWheel = new ui.dom.window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    body.dispatchEvent(contentWheel); assert.equal(contentWheel.defaultPrevented, false);
    const contentSelection = new ui.dom.window.Event("selectstart", { bubbles: true, cancelable: true });
    body.dispatchEvent(contentSelection); assert.equal(contentSelection.defaultPrevented, false);
    assert.match(workspaceCss, /user-select:none/);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree plan preview retains ancestors and allows a selected browsing root", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const child = { id: "leaf", title: "Leaf", answer_md: "Answer", cards: [{ front: "Card", back: "Card answer" }], children: [] };
    const tree = { roots: [{ id: "root", title: "Root", children: [child] }], scopes: [{ id: "scope", label: "Book" }] };
    await ui.treeAdapter.renderNodeTreePanel(root, { api: async (url) => url.includes("/configs?") ? { configs: [] } : tree, postApi: async () => ({}) });
    const button = (label) => [...root.querySelectorAll("button")].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle();
    assert.match(root.textContent, /校验通过/);
    root.querySelector('[aria-label="筛选 节点标题"]').click();
    ui.document.querySelector('.table-filter-popover input[value="Leaf"]').checked = true;
    [...ui.document.querySelectorAll("button")].find((node) => node.textContent === "应用").click();
    assert.match(root.textContent, /自动保留 1 个祖先/);
    root.querySelector('[aria-label="根节点"]').value = "leaf";
    button("打开树图").click();
    assert.ok(root.classList.contains("is-browsing-tree"));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    root.querySelector('.wb-tree-graph-node[data-node-id="leaf"]').dispatchEvent(new ui.dom.window.Event("click"));
    button("节点详情").click();
    assert.match(root.querySelector(".wb-tree-detail").textContent, /Card answer/);
    button("返回树页面").click();
    button("返回方案").click();
    root.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree mapping editor synchronizes relation fields and multiple detail modules", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    await ui.manager.openConfigManager(root, { api: async () => ({ configs: [], definition: { contract: "tree-nodes/v1" } }), postApi: async () => ({}), pluginId: "tree", moduleId: "trees" });
    const mapping = root.querySelector('[aria-label="节点 ID 列"]');
    mapping.value = "code"; mapping.dispatchEvent(new ui.dom.window.Event("change"));
    const button = (label) => [...root.querySelectorAll("button")].find((node) => node.textContent === label);
    button("新增详情模块").click();
    const columns = root.querySelectorAll('[aria-label="详情来源列"]');
    columns[1].value = "notes"; columns[1].dispatchEvent(new ui.dom.window.Event("input"));
    const settings = JSON.parse(root.querySelector('[aria-label="模块设置（JSON 对象）"]').value);
    assert.equal(settings.tree.id, "code");
    assert.equal(settings.tree.details.length, 2);
    assert.equal(settings.tree.details[1].column, "notes");
    button("删除模块").click();
    assert.equal(JSON.parse(root.querySelector('[aria-label="模块设置（JSON 对象）"]').value).tree.details.length, 1);
  } finally { ui.dom.window.close(); }
});


test("tree workspace handles deep titles without Markdown heading limits and stable sibling order", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const tree = { id: "0", title: "root", children: [] };
    let current = tree;
    for (let index = 1; index < 12; index++) {
      const child = { id: String(index), title: `depth ${index}`, children: [] };
      current.children.push(child); current = child;
    }
    const second = { id: "second", title: "Second root", children: [] };
    const host = ui.tree.createTreeWorkspace(root, { roots: [tree, second] });
    for (let depth = 0; depth < 11; depth++) {
      const parent = root.querySelector(`[data-node-id="${depth}"]`);
      parent.querySelector(".wb-tree-node-control").dispatchEvent(new ui.dom.window.Event("click"));
    }
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 13);
    assert.ok(root.querySelector('[data-node-id="11"]'));
    const firstPosition = root.querySelector('[data-node-id="11"]').getAttribute("transform");
    const secondPosition = root.querySelector('[data-node-id="second"]').getAttribute("transform");
    assert.ok(Number(firstPosition.split(",")[1].replace(")", "")) < Number(secondPosition.split(",")[1].replace(")", "")));
    host.dispose();
    const cycle = { id: "cycle", title: "Cycle", children: [] }; cycle.children.push(cycle);
    assert.throws(() => ui.tree.indexTree([cycle]), /重复节点/);
  } finally { ui.dom.window.close(); }
});


test("unified tree content toggles independently from descendants and supports free pan", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const trees = [{ id: "node:chapter", title: "Chapter", data: { content_md: "" }, children: [
      { id: "card:question", title: "Question", data: { content_md: "**Answer**" }, children: [] },
      { id: "node:empty", title: "Empty", data: { content_md: "" }, children: [] },
    ] }];
    const host = ui.tree.createTreeWorkspace(root, { roots: trees, detailFields: [{ column: "content_md", format: "markdown" }], renderMarkdown: (value, body) => { body.textContent = value; } });
    const click = (label) => root.querySelector(`[aria-label="${label}"]`).dispatchEvent(new ui.dom.window.Event("click", { bubbles: true }));
    click("展开或收起子树 Chapter");
    click("Question");
    click("展开或收起内容 Question");
    assert.equal(root.querySelector(".wb-tree-inline-content").textContent, "content_md**Answer**");
    assert.equal(root.querySelector(".wb-tree-detail").hidden, true);
    click("Empty");
    assert.equal(root.querySelector('[aria-label="展开或收起内容 Empty"]').getAttribute("aria-disabled"), "true");
    click("展开或收起子树 Chapter");
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    click("展开或收起子树 Chapter");
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 3);
    assert.ok(root.querySelector(".wb-tree-inline-content"));
    const canvas = root.querySelector(".wb-tree-canvas");
    canvas.dispatchEvent(new ui.dom.window.MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(new ui.dom.window.MouseEvent("pointermove", { clientX: 1210, clientY: -790 }));
    canvas.dispatchEvent(new ui.dom.window.MouseEvent("pointerup"));
    assert.equal(canvas.querySelector("svg").style.transform, "translate(1200px, -800px)");
    [...root.querySelectorAll("button")].find((button) => button.textContent === "适应画布").click();
    assert.equal(canvas.querySelector("svg").style.transform, "translate(0px, 0px)");
    const selected = ui.tree.filterTree(trees, ["card:question"]);
    assert.equal(selected.addedAncestors, 1);
    assert.equal(ui.tree.indexTree(selected.roots).size, 2);
    host.dispose();
  } finally { ui.dom.window.close(); }
});


test("node cards keep controls inside and wrap full titles without truncation", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const title = "很长的知识问题标题：如何理解软件体系结构的设计与实现？".repeat(5);
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title, data: { back: "Answer" }, children: [{ id: "child", title: "Child", children: [] }] }], detailFields: [{ column: "back" }] });
    let card = root.querySelector('[data-node-id="root"]');
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    assert.equal(card.querySelector(".wb-tree-node-control text").textContent, "+");
    assert.equal(card.querySelector(".wb-tree-node-title").textContent, title);
    assert.ok(card.querySelectorAll("tspan").length > 1);
    assert.ok(Number(card.querySelector(".wb-tree-node-frame").getAttribute("height")) > 64);
    assert.equal(card.querySelectorAll(".wb-tree-node-control").length, 1);
    card.dispatchEvent(new ui.dom.window.Event("click"));
    card = root.querySelector('[data-node-id="root"]');
    assert.equal(root.querySelector(".wb-tree-detail").hidden, true);
    assert.equal(card.querySelectorAll(".wb-tree-node-control").length, 2);
    const frame = card.querySelector(".wb-tree-node-frame");
    for (const control of card.querySelectorAll(".wb-tree-node-control")) {
      const position = control.getAttribute("transform").match(/translate\((\d+),(\d+)\)/);
      const rect = control.querySelector("rect");
      assert.ok(Number(position[1]) + Number(rect.getAttribute("width")) <= Number(frame.getAttribute("width")));
      assert.ok(Number(position[2]) + Number(rect.getAttribute("height")) <= Number(frame.getAttribute("height")));
    }
    card.querySelector(".wb-tree-node-control").dispatchEvent(new ui.dom.window.Event("click"));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    assert.equal(root.querySelector("svg").firstElementChild.classList.contains("wb-tree-edges"), true);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree drag preview distinguishes parent drop from sibling insertion", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const moves = []; const reorders = [];
    const host = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "parent", title: "Parent", children: [{ id: "first", title: "First", children: [] }, { id: "second", title: "Second", children: [] }] }],
      onMove: async (...args) => moves.push(args),
      onReorder: async (...args) => reorders.push(args),
    });
    const first = root.querySelector('[data-node-id="first"]');
    const second = root.querySelector('[data-node-id="second"]');
    second.getBoundingClientRect = () => ({ top: 100, bottom: 200, height: 100, left: 0, right: 300, width: 300 });
    ui.document.elementsFromPoint = () => [second];
    first.setPointerCapture = () => {}; first.releasePointerCapture = () => {};
    const pointer = (type, x, y) => { const event = new ui.dom.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } }); first.dispatchEvent(event); };
    pointer("pointerdown", 10, 10); pointer("pointermove", 30, 150);
    assert.ok(second.classList.contains("is-drop-parent"));
    pointer("pointerup", 30, 150); await settle();
    assert.equal(moves.length, 1);
    pointer("pointerdown", 10, 10); pointer("pointermove", 30, 105);
    assert.ok(second.classList.contains("is-drop-before"));
    assert.ok(second.classList.contains("wb-tree-drop-shift"));
    pointer("pointerup", 30, 105); await settle();
    assert.equal(reorders.length, 1);
    assert.deepEqual(reorders[0], ["first", "second", "before"]);
    host.dispose();
  } finally { ui.dom.window.close(); }
});
