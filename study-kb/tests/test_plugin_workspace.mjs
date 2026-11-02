import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const shared = new URL("../../3dStudio/3dworkbench/web/", import.meta.url);
// Reproduce pre-existing failures without resetting either dirty worktree.
const readUiSource = async (url) => {
  if (process.env.WB_TEST_SOURCE !== "HEAD") return readFile(url, "utf8");
  const isShared = url.href.startsWith(shared.href);
  const root = fileURLToPath(isShared ? new URL("../../", shared) : new URL("../../", import.meta.url));
  const path = relative(root, fileURLToPath(url)).replaceAll("\\", "/");
  return execFileSync("git", ["-C", root, "show", "HEAD:" + path], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
};
const workspaceSource = await readUiSource(new URL("pluginWorkspace.mjs", shared));
const mappingSource = await readUiSource(new URL("treeMapping.mjs", shared));
const managerSource = await readUiSource(new URL("pluginConfigManager.mjs", shared));
const reviewSource = await readUiSource(new URL("../web/studySqlReview.mjs", import.meta.url));
const previewSource = await readUiSource(new URL("tablePreview.mjs", shared));
const platformSource = await readUiSource(new URL("workbenchPlatform.mjs", shared));
const treeSource = await readUiSource(new URL("treeWorkspace.mjs", shared));
const searchableComboboxSource = await readUiSource(new URL("searchableCombobox.mjs", shared));
const treeAdapterSource = await readUiSource(new URL("../web/studyTreeWorkspace.mjs", import.meta.url));
const workspaceCss = await readUiSource(new URL("pluginWorkspace.css", shared));
const studyCss = await readUiSource(new URL("../web/styles.css", import.meta.url));
const workbenchCss = await readUiSource(new URL("workbench.css", shared));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const visibleButtons = root => [...root.querySelectorAll("button")].filter(node => !node.closest("[hidden]"));

function drop(ui, id, target) {
  const event = new ui.dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { getData: () => id } });
  ui.document.querySelector(target).dispatchEvent(event);
}

async function setup() {
  const dom = new JSDOM('<header class="topbar"><div class="topbar-primary"><div class="brand-block"><span class="brand-mark">KB</span></div><div class="toolbar"><button id="refresh">Refresh</button></div></div></header><main id="workbench"></main>', { url: "http://localhost" });
  dom.window.confirm = () => true;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function (value = "") { this.returnValue = value; this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  const resizeObservers = [];
  dom.window.ResizeObserver = class { constructor(callback) { this.callback = callback; resizeObservers.push(this); } observe(target) { this.target = target; } disconnect() { this.disconnected = true; } emit(width, height) { this.callback([{ target: this.target, contentRect: { width, height }, borderBoxSize: [{ inlineSize: width, blockSize: height }] }]); } };
  const context = vm.createContext({ document: dom.window.document, window: dom.window, CustomEvent: dom.window.CustomEvent, ResizeObserver: dom.window.ResizeObserver, CSS: dom.window.CSS, crypto: dom.window.crypto, AbortController: dom.window.AbortController, fetch: (...args) => dom.window.fetch(...args), localStorage: dom.window.localStorage, Event: dom.window.Event, Option: dom.window.Option, structuredClone, console, requestAnimationFrame: (callback) => callback() });
  // Generic linker: "/3dworkbench/x.mjs?v=..." resolves to the shared web
  // directory, "./x.mjs" relative to the importer; one module per file.
  const studyWeb = new URL("../web/", import.meta.url);
  const modules = new Map();
  const stubs = {
    studyMarkdown: () => new vm.SyntheticModule(["attachMarkdownToggle", "renderMarkdown"], function () {
      this.setExport("renderMarkdown", (value, target) => { target.textContent = value; });
      this.setExport("attachMarkdownToggle", (toolbar, target, getText) => ({ refresh: () => { target.textContent = getText(); } }));
    }, { context }),
  };
  const resolve = (specifier, parent) => {
    const bare = specifier.split("?")[0];
    if (bare.startsWith("/3dworkbench/")) return new URL(bare.slice("/3dworkbench/".length), shared);
    return new URL(bare, parent);
  };
  const load = async (url) => {
    const key = url.href;
    if (modules.has(key)) return modules.get(key);
    // Reserve before awaiting the read: sibling imports must share stateful
    // modules such as dragGesture, just as they do in the browser.
    const pending = (async () => {
      const stub = Object.entries(stubs).find(([name]) => key.includes(name));
      const module = stub ? stub[1]() : new vm.SourceTextModule(await readUiSource(url), { context, identifier: key });
      if (stub) Object.defineProperty(module, "identifier", { value: key });
      return module;
    })();
    modules.set(key, pending);
    return pending;
  };
  const link = async (url) => {
    const module = await load(url);
    if (module.status === "unlinked") await module.link((specifier, referrer) => load(resolve(specifier, new URL(referrer.identifier))));
    if (module.status === "linked") await module.evaluate();
    return module.namespace;
  };
  const workspace = { namespace: await link(new URL("pluginWorkspace.mjs", shared)) };
  const manager = { namespace: await link(new URL("pluginConfigManager.mjs", shared)) };
  const review = { namespace: await link(new URL("studySqlReview.mjs", studyWeb)) };
  const preview = { namespace: await link(new URL("tablePreview.mjs", shared)) };
  const tree = { namespace: await link(new URL("treeWorkspace.mjs", shared)) };
  const treeAdapter = { namespace: await link(new URL("studyTreeWorkspace.mjs", studyWeb)) };
  return { tree: tree.namespace, treeAdapter: treeAdapter.namespace, dom, document: dom.window.document, workspace: workspace.namespace, manager: manager.namespace, review: review.namespace, preview: preview.namespace, resizeObservers };
}

test("outline long content grows naturally and delegates scrolling to the outer list", () => {
  const dom = new JSDOM('<style>' + studyCss + '</style><style>' + workspaceCss + '</style><div class="wb-tree-browser"><div class="wb-tree-outline"><div class="wb-tree-inline-content">Long content</div></div></div>', { url: "http://localhost" });
  try {
    const content = dom.window.document.querySelector(".wb-tree-inline-content");
    const style = dom.window.getComputedStyle(content);
    assert.equal(style.height, "auto");
    assert.equal(style.maxHeight, "none");
    assert.equal(style.overflow, "visible");
    assert.notEqual(style.overflowY, "auto");
    assert.equal(style.overscrollBehavior, "auto");
    const outer = dom.window.getComputedStyle(content.parentElement);
    assert.equal(outer.overflow, "auto");
  } finally { dom.window.close(); }
});

test("tree history toolbar and shortcuts do not hijack text editing", { skip: process.env.WB_TEST_SOURCE === "HEAD" }, async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let undone = 0, redone = 0;
    const host = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "root", title: "Root", children: [] }], canUndo: true, canRedo: true,
      onUndo: async () => { undone++; }, onRedo: async () => { redone++; },
    });
    root.querySelector('[aria-label="撤销 Ctrl+Z"]').click(); await settle();
    const canvas = root.querySelector(".wb-tree-canvas");
    canvas.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    assert.equal(undone, 1); assert.equal(redone, 1);
    const input = root.querySelector('input[type="search"]');
    const event = new ui.dom.window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event); await settle();
    assert.equal(event.defaultPrevented, false); assert.equal(undone, 1);
    assert.ok(root.querySelector('[aria-label="上一个匹配"] svg'));
    assert.ok(root.querySelector('[aria-label="下一个匹配"] svg'));
    assert.ok(root.querySelector('[aria-label="执行搜索"] svg'));
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("empty content drops restored expansion without collapsing children", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("div");
    ui.document.body.append(root);
    const tree = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "parent", title: "Parent", data: { content_md: " \n " }, children: [{ id: "child", title: "Child", data: {}, children: [] }] }],
      detailFields: [{ column: "content_md", format: "markdown" }],
      initialState: { expandedContent: ["parent", "missing"] },
    });
    assert.equal(tree.getState().expandedContent.length, 0);
    assert.equal(root.querySelectorAll("foreignObject").length, 0);
    assert.ok(root.querySelector('[data-node-id="child"]'));
    tree.dispose();
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

const visualTreeTemplate = { id: "tree-basic/v1", contract: "tree-nodes/v1", fields: [
  { name: "node_id", label: "节点 ID", key: true, required: true }, { name: "parent_id", label: "父节点 ID" },
  { name: "title", label: "标题", required: true }, { name: "content_md", label: "正文", multiline: true },
] };
const inputValue = (ui, label, value) => { const input = ui.document.querySelector(`[aria-label="${label}"]`); assert.ok(input, label); input.value = value; input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); return input; };
const clickText = (root, text) => { const button = [...root.querySelectorAll("button")].find(n => n.textContent === text); assert.ok(button, text); button.click(); };

test("visual authoring previews without writes, explicitly creates once, and reloads owned data", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const posts = []; let saved;
    await ui.manager.openConfigManager(root, { pluginId: "fixture.tree", moduleId: "nodes",
      api: async () => ({ definition: { contract: "tree-nodes/v1", dataAuthoring: visualTreeTemplate }, configs: saved ? [saved] : [] }),
      postApi: async (url, payload) => {
        posts.push({ url, payload });
        if (url.endsWith("validate-data")) return { rows: payload.rows, columns: ["node_id", "parent_id", "title", "content_md"] };
        if (url.endsWith("create-data")) { saved = { id: "owned", revision: 1, name: payload.name, sql: "SELECT * FROM owned", parameters: {}, settings: { dataSource: { mode: "owned", collectionId: "collection1" } } }; return { config: saved, revision: 1 }; }
        if (url.endsWith("read-data")) return { rows: [{ node_id: "n1", title: "Root" }], revision: 1 };
        throw new Error("Unexpected request " + url);
      },
    });
    inputValue(ui, "方案名称", "My own tree"); inputValue(ui, "标题 · 第1行", "Root");
    assert.equal(root.querySelector('.wb-data-modes [aria-pressed="true"]').dataset.mode, "owned");
    clickText(root, "校验 / 预览"); await settle();
    assert.deepEqual(posts.map(p => p.url), ["/api/plugin/config/validate-data"]);
    clickText(root, "保存"); clickText(root, "保存"); await settle();
    assert.equal(posts.length, 1, "confirmation is required before a collection write");
    clickText(ui.document.querySelector("dialog"), "确认保存");
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.filter(p => p.url.endsWith("create-data")).length, 1);
    assert.equal(posts[1].payload.rows[0].title, "Root"); assert.ok(posts[1].payload.request_id);
    assert.equal(root.querySelector('[aria-label="标题 · 第1行"]').value, "Root");
    assert.match(root.textContent, /已保存/);
  } finally { ui.dom.window.close(); }
});

test("review editor submits second filters and ordered rules without storing card order", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root); const posts = [];
    const spec = { id: "review-basic/v1", contract: "review-cards/v1", fields: [{ name: "card_id", label: "卡片 ID", key: true }, { name: "question", label: "问题" }, { name: "answer", label: "答案" }, { name: "hint", label: "提示" }] };
    await ui.manager.openConfigManager(root, { pluginId: "study.review-table", moduleId: "reviews", api: async () => ({ configs: [], definition: { contract: spec.contract, dataAuthoring: spec } }), postApi: async (url, payload) => { posts.push({ url, payload }); return { rows: [], columns: [] }; } });
    inputValue(ui, "方案名称", "Weak cards"); inputValue(ui, "问题 · 第1行", "Question");
    inputValue(ui, "掌握程度上限", "50"); inputValue(ui, "本轮最多卡片数", "12");
    clickText(root, "＋ 多级排序条件"); clickText(root, "＋ 多级排序条件");
    const fields = root.querySelectorAll('[aria-label="多级排序字段"]'); fields[1].value = "due_at";
    clickText(root, "移除此排序");
    clickText(root, "校验 / 预览"); await settle();
    const policy = posts[0].payload.settings.selectionPolicy;
    assert.equal(policy.limit, 12); assert.equal(policy.filters[0].field, "mastery_score"); assert.equal(policy.filters[0].value, 50);
    assert.equal(policy.rules.length, 1); assert.equal(policy.rules[0].field, "due_at");
    assert.equal(posts[0].payload.rows[0].learning_enabled, true); assert.equal("sort_order" in posts[0].payload.rows[0], false);
  } finally { ui.dom.window.close(); }
});

test("unloaded owned data cannot be previewed or overwritten; failed draft stays available", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root); const posts = [];
    await ui.manager.openConfigManager(root, { pluginId: "fixture.tree", moduleId: "nodes", initialId: "owned",
      api: async () => ({ definition: { contract: "tree-nodes/v1", dataAuthoring: visualTreeTemplate }, configs: [{ id: "owned", name: "Preserve me", sql: "SELECT * FROM owned", settings: { dataSource: { mode: "owned", collectionId: "collection" } } }] }),
      postApi: async (url) => { posts.push(url); throw new Error("offline"); },
    });
    assert.match(root.textContent, /保存已阻止/); clickText(root, "校验 / 预览"); await settle();
    assert.match(root.textContent, /尚未载入成功/); assert.deepEqual(posts, ["/api/plugin/config/read-data"]);
    assert.equal(root.querySelector('[aria-label="方案名称"]').value, "Preserve me");
  } finally { ui.dom.window.close(); }
});

test("SQL editor numbers lines and indents; field help emits no data calls or draft changes", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root); let posts = 0, help;
    ui.document.addEventListener("workbench:help", event => { help = event.detail; });
    await ui.manager.openConfigManager(root, { pluginId: "fixture", moduleId: "nodes", api: async () => ({ configs: [] }), postApi: async () => { posts++; } });
    const sql = inputValue(ui, "SQL（查询模块只允许只读语句）", "SELECT\n  1 AS value");
    assert.equal(root.querySelector(".wb-sql-lines").textContent, "1\n2");
    sql.selectionStart = sql.selectionEnd = 0;
    sql.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.match(sql.value, /^  SELECT/);
    root.querySelector('[data-help-action="sql"] .wb-field-help').click();
    assert.equal(help.title, "高级 SQL"); assert.match(help.body, /只读/); assert.equal(posts, 0);
    assert.match(sql.value, /^  SELECT/);
    inputValue(ui, "默认参数（JSON 对象）", "[]");
    clickText(root, "校验 / 预览"); await settle();
    assert.match(root.textContent, /默认参数必须是 JSON 对象/); assert.equal(posts, 0);
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
    assert.equal(root.querySelector('[aria-label="搜索或选择根节点"]'), null);
    root.querySelector('[aria-label="方案设置"]').click();
    button("编辑已有方案").click(); await settle();
    button("返回").click(); await settle();
    button("预览并筛选").click(); await settle();
    const rootSearch = root.querySelector('[aria-label="搜索或选择根节点"]');
    const start = root.querySelector('[data-action="confirm-start"]');
    assert.ok(rootSearch);
    assert.equal(start.parentElement, rootSearch.closest(".wb-tree-root-tools"));
    assert.ok(start.compareDocumentPosition(root.querySelector("table")) & 4);
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


test("mobile preview toolbar keeps search width and icon pagination", { skip: process.env.WB_TEST_SOURCE === "HEAD" }, async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    ui.preview.renderTablePreview(root, { rows: Array.from({ length: 75 }, (_, n) => ({ title: String(n) })), columns: ["title"] });
    const next = root.querySelector('[aria-label="下一页"]');
    assert.ok(next.querySelector("svg"));
    next.click(); assert.equal(root.querySelectorAll("tbody tr").length, 25);
    root.querySelector('[aria-label="上一页"]').click();
    assert.equal(root.querySelectorAll("tbody tr").length, 50);
    assert.ok(root.querySelector(".wb-preview-actions"));
    assert.match(workspaceCss, /\.wb-preview-actions\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(workspaceCss, /\.wb-preview-actions \.wb-tree-root-picker\s*\{[^}]*min-width:\s*240px/s);
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

test("plan cards keep actions available, edit current plan, create new and require preview", async () => {
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
    assert.equal(root.querySelectorAll(".study-plan-card .study-plan-actions").length, 2);
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
    assert.ok(button("编辑已有方案").querySelector('svg[data-ui-icon="settings"]'));
    assert.ok(button("新增方案").querySelector('svg[data-ui-icon="plus"]'));
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
    button("预览并筛选").click(); await settle();
    assert.equal(root.querySelector('[data-action="confirm-start"]').disabled, true);
    assert.match(root.textContent, /筛选 0 条/);
  } finally { ui.dom.window.close(); }
});

test("review and tree select the whole card without rebuilding it, and actions use their own plan", async () => {
  const ui = await setup();
  try {
    for (const [kind, render] of [["review", ui.review.renderReviewTablePanel], ["tree", ui.treeAdapter.renderNodeTreePanel]]) {
      const root = ui.document.createElement("section"); ui.document.body.append(root);
      const calls = [];
      const entries = [{ id: "a", name: "A", parameters: {} }, { id: "b", name: "B", parameters: {} }];
      const tree = { roots: [{ id: "root", title: "Root", data: {}, children: [] }],
        rows: [{ node_id: "root", parent_id: null, title: "Root" }], columns: ["node_id", "parent_id", "title"], detail_fields: [],
        validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] } };
      await render(root, {
        api: async url => { calls.push(url); return url.includes("configs") ? { configs: entries } : tree; },
        postApi: async (url, payload) => { calls.push({ url, payload }); return { rows: [], columns: [], limit: 10, preview_hash: "empty", duplicates: 0, missing_schedule: 0 }; },
      });
      const before = [...root.querySelectorAll(".study-plan-card")];
      assert.ok(before.every(card => card.querySelectorAll(".study-plan-actions button").length === 2));
      assert.ok(before.every(card => !card.querySelector("small")));
      const last = before.at(-1); last.click();
      assert.equal(last.getAttribute("aria-current"), "true");
      assert.equal(root.querySelector('.study-plan-select[aria-pressed="true"]').textContent, "B");
      assert.ok(before.every((card, index) => root.querySelectorAll(".study-plan-card")[index] === card));
      before[0].dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      assert.equal(before[0].getAttribute("aria-current"), "true");
      // An action on an unselected card must select that card before loading it.
      last.querySelector(kind === "tree" ? ".study-plan-actions .primary" : ".study-plan-actions button").click();
      await settle(); await settle();
      if (kind === "review") assert.equal(calls.find(call => call.url?.endsWith("sql-preview")).payload.config_id, "b");
      else { assert.ok(root.classList.contains("is-browsing-tree")); assert.ok(calls.some(call => typeof call === "string" && call.includes("config_id=b"))); }
      root.dispose(); root.remove();
    }
  } finally { ui.dom.window.close(); }
});

test("plan ordering previews displacement, commits only on drop and restores per pane", async () => {
  const ui = await setup();
  try {
    for (const [kind, render] of [["review", ui.review.renderReviewTablePanel], ["tree", ui.treeAdapter.renderNodeTreePanel]]) {
      const entries = [{ id: "a", name: "A", parameters: {} }, { id: "b", name: "B", parameters: {} }];
      const mount = async instanceId => {
        const root = ui.document.createElement("section"); ui.document.body.append(root);
        await render(root, { api: async () => ({ configs: entries }), postApi: async () => ({}), instanceId });
        return root;
      };
      let root = await mount("sort-pane");
      const grid = root.querySelector(".study-plan-grid"), cards = [...root.querySelectorAll(".study-plan-card")];
      grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500 });
      cards.forEach((card, index) => { card.getBoundingClientRect = () => ({ left: 0, top: index * 130, width: 240, height: 118 }); });
      const fire = (target, type, y = 30) => {
        const event = new ui.dom.window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { clientX: 50, clientY: y, dataTransfer: { setData() {} } }); target.dispatchEvent(event);
      };
      const key = `study.plan-order:${kind}:sort-pane`;
      fire(cards[0], "dragstart"); fire(grid, "dragover", (cards.length - 1) * 130 + 50);
      assert.ok(cards.at(-1).style.transform.includes("-130px"));
      assert.ok(grid.querySelector(".wb-sortable-slot"));
      assert.equal(ui.dom.window.localStorage.getItem(key), null);
      ui.document.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.equal(grid.querySelector(".wb-sortable-slot"), null);
      assert.equal(ui.dom.window.localStorage.getItem(key), null);
      fire(cards[0], "dragstart"); fire(grid, "drop", (cards.length - 1) * 130 + 50); fire(cards[0], "dragend");
      const expected = [...cards.slice(1), cards[0]].map(card => card.dataset.configId);
      assert.deepEqual(JSON.parse(ui.dom.window.localStorage.getItem(key)), expected);
      root.dispose(); root.remove(); root = await mount("sort-pane");
      assert.deepEqual([...root.querySelectorAll(".study-plan-card")].map(card => card.dataset.configId), expected);
      root.dispose(); root.remove(); root = await mount("other-pane");
      assert.equal(root.querySelector(".study-plan-card").dataset.configId, cards[0].dataset.configId);
      root.dispose(); root.remove();
    }
  } finally { ui.dom.window.close(); }
});

test("tree and review pane leases follow selected plans and release on disposal", async () => {
  const ui = await setup();
  try {
    for (const [kind, render] of [["tree", ui.treeAdapter.renderNodeTreePanel], ["review", ui.review.renderReviewTablePanel]]) {
      const root = ui.document.createElement("section"); ui.document.body.append(root);
      const posts = [];
      const entries = [{ id: "first", name: "First", parameters: {} }, { id: "second", name: "Second", parameters: {} }];
      const api = async (url) => url.includes("configs") ? { configs: entries } : { rows: [] };
      await render(root, { api, postApi: async (url, payload) => { posts.push({ url, payload }); return {}; }, instanceId: kind + "-pane" });
      const choose = name => [...root.querySelectorAll(".study-plan-select")].find(button => button.textContent === name).click();
      choose("First"); await settle(); choose("Second"); await settle();
      root.dispose(); await settle();
      const leases = posts.filter(post => post.url.endsWith("/lease")).map(post => [post.payload.id, !!post.payload.release, post.payload.instance_id]);
      assert.equal(JSON.stringify(leases.slice(-4)), JSON.stringify([["first", false, kind + "-pane"], ["first", true, kind + "-pane"], ["second", false, kind + "-pane"], ["second", true, kind + "-pane"]]));
      root.remove();
    }
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
    const host = ui.tree.createTreeWorkspace(root, { roots, initialState: { collapsed: ["root"] }, detailFields: [{ column: "answer", format: "markdown" }, { column: "note", format: "text" }], renderMarkdown: (value, target) => { target.textContent = value; }, onRefresh: async () => { throw new Error("offline"); } });
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label);
    root.querySelector('[aria-label="展开或收起子树 Root"]').dispatchEvent(new ui.dom.window.Event("click"));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    assert.equal(root.querySelector("img"), null);
    root.querySelector('[aria-label="切换到大纲"]').click();
    assert.equal(root.querySelector(".wb-tree-canvas").hidden, true);
    assert.equal(root.querySelector(".wb-tree-outline").hidden, false);
    assert.equal(root.querySelector('[aria-label="切换到大纲"]').getAttribute("aria-pressed"), "true");
    assert.equal(root.querySelector('[aria-label="切换到树图"]').getAttribute("aria-pressed"), "false");
    const outlineTitle = root.querySelector('.wb-tree-outline [data-node-id="child"]');
    outlineTitle.click();
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 2);
    assert.equal(root.querySelectorAll(".wb-tree-outline-row button").length, 4);
    assert.equal(root.querySelector(".wb-tree-radial-menu"), null);
    assert.match(root.querySelector(".wb-tree-inline-content").textContent, /Detail/);
    root.querySelector('[aria-label="切换到树图"]').click();
    root.querySelector('.wb-tree-graph-node[data-node-id="child"]').dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector('.wb-tree-radial-item[aria-label="节点详情"]').click(); await settle();
    assert.equal(root.querySelector(".wb-tree-browser").hidden, true);
    assert.equal(root.querySelectorAll(".wb-tree-detail-module").length, 2);
    button("返回树页面").click();
    assert.equal(host.getState().mode, "graph");
    root.querySelector('.wb-tree-graph-node[data-node-id="child"]').dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector('.wb-tree-radial-item[aria-label="节点详情"]').click(); await settle();
    button("以此节点为根").click();
    assert.equal(host.getState().root, "child");
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    root.querySelector('[aria-label="切换到大纲"]').click();
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 1);
    root.querySelector('[aria-label="恢复全图"]').click();
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 2);
    root.querySelector('[aria-label="切换到树图"]').click();
    root.querySelector('[aria-label="刷新"]').click(); await settle();
    assert.match(root.textContent, /刷新失败：offline/);
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    host.dispose();
  } finally { ui.dom.window.close(); }
});


test("tree editor saves canonical content and retries shared refresh without duplicate writes", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let content = "Original", title = "Root", saves = 0, failRefresh = false;
    const payload = () => ({ roots: [{ id: "node:root", title, data: { content_md: content }, children: [] }], rows: [{ node_id: "node:root", parent_id: null, title, content_md: content }], columns: ["node_id", "parent_id", "title", "content_md"], detail_fields: [{ column: "content_md", format: "markdown" }], editing: { provider: "study-knowledge/v1" }, validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] });
    const requests = [];
    ui.dom.window.fetch = async (url, options) => {
      const values = JSON.parse(options.body);
      requests.push([url, values]);
      saves++; content = values.content_md; title = values.title; failRefresh = true;
      return { ok: true, json: async () => ({ node: { node_id: "node:root", title, content_md: content }, version: "version-2" }) };
    };
    await ui.treeAdapter.renderNodeTreePanel(root, { api: async (url) => {
      if (url.includes("/configs?")) return { configs: [] };
      if (failRefresh) { failRefresh = false; throw new Error("refresh offline"); }
      return payload();
    }, postApi: async (url, values) => {
      requests.push([url, values]);
      if (url.endsWith("/read")) return { node: { node_id: "node:root", title, content_md: content }, version: "version-1" };
      saves++; content = values.content_md; title = values.title; failRefresh = true;
      return { node: { node_id: "node:root", title, content_md: content }, version: "version-2" };
    } });
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await settle();
    const input = root.querySelector('[aria-label="编辑节点 Markdown"]');
    const titleInput = root.querySelector('[aria-label="编辑节点标题"]');
    assert.equal(root.querySelector(".study-tree-note").hidden, true);
    assert.equal(root.querySelector(".study-tree-editor-preview").hidden, false);
    button("预览 Markdown").click();
    assert.equal(titleInput.getAttribute("contenteditable"), "true");
    assert.equal(titleInput.textContent, "Root");
    titleInput.textContent = "Renamed";
    assert.equal(input.textContent, "Original");
    input.textContent = "**Changed**";
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    input.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(saves, 0);
    const saveButton = button("保存");
    saveButton.click(); saveButton.click(); await settle(); await settle();
    assert.equal(saves, 1);
    assert.equal(root.querySelector(".study-tree-editor"), null);
    assert.match(root.textContent, /后台校验失败/);
    await root.refresh(); await settle();
    assert.equal(saves, 1);
    assert.equal(root.querySelector(".study-tree-editor"), null);
    assert.equal(root.querySelector('[aria-label="展开或收起内容 Renamed"]').getAttribute("aria-expanded"), "true");
    assert.match(root.querySelector(".wb-tree-inline-content").textContent, /Changed/);
    assert.equal(requests[1][1].version, "version-1");
    assert.equal(requests[1][1].title, "Renamed");
    assert.equal(root.querySelector(".wb-tree-graph-node").getAttribute("aria-label"), "Renamed");
    root.dispose();
  } finally { ui.dom.window.close(); }
});


test("tree editor retries the same write and replays undo and redo through the history API", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let title = "Before", attempts = 0, failRefresh = false;
    const writes = [], history = [];
    const payload = () => ({ roots: [{ id: "node:root", title, data: { content_md: "Body" }, children: [] }], rows: [{ node_id: "node:root", parent_id: null, title, content_md: "Body" }], columns: ["node_id", "parent_id", "title", "content_md"], detail_fields: [{ column: "content_md", format: "markdown" }], editing: { provider: "study-knowledge/v1" }, validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] });
    ui.dom.window.fetch = async (url, options) => {
      const values = JSON.parse(options.body); writes.push(values);
      if (++attempts === 1) throw new Error("response lost");
      title = values.title;
      return { ok: true, json: async () => ({ node: { node_id: "node:root", title, content_md: "Body" }, version: "v2", history_available: true }) };
    };
    await ui.treeAdapter.renderNodeTreePanel(root, {
      api: async (url) => {
        if (url.includes("/configs?")) return { configs: [] };
        if (failRefresh) { failRefresh = false; throw new Error("refresh offline"); }
        return payload();
      },
      postApi: async (url, values) => {
        if (url.endsWith("/read")) return { node: { node_id: "node:root", title, content_md: "Body" }, version: "v1" };
        assert.equal(values.operation, "history"); history.push(values);
        title = history.length === 1 ? "Before" : "After";
        failRefresh = history.length === 1;
        return { node: { node_id: "node:root" }, history_available: true };
      },
    });
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    assert.equal(root.querySelector('[aria-label="撤销 Ctrl+Z"]').disabled, true);
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await settle(); button("预览 Markdown").click();
    root.querySelector('[aria-label="编辑节点标题"]').textContent = "After";
    button("保存").click(); await settle();
    assert.match(root.textContent, /保存未确认/);
    button("重试保存").click(); await settle(); await settle();
    assert.deepEqual(writes[1], writes[0]);
    assert.equal(root.querySelector('[aria-label="撤销 Ctrl+Z"]').disabled, false);
    root.querySelector('[aria-label="撤销 Ctrl+Z"]').click(); await settle(); await settle();
    assert.equal(history[0].target_request_id, writes[0].request_id);
    assert.match(root.textContent, /操作已完成，但视图刷新失败/);
    assert.equal(root.querySelector('[aria-label="撤销 Ctrl+Z"]').disabled, true);
    assert.equal(root.querySelector('[aria-label="重做 Ctrl+Y"]').disabled, false);
    root.querySelector('[aria-label="重做 Ctrl+Y"]').click(); await settle(); await settle();
    assert.equal(history[1].target_request_id, history[0].request_id);
    assert.notEqual(history[1].request_id, history[0].request_id);
    assert.equal(root.querySelector('[aria-label="重做 Ctrl+Y"]').disabled, true);
    assert.equal(root.querySelector('[aria-label="撤销 Ctrl+Z"]').disabled, false);
    assert.equal(root.querySelector(".wb-tree-graph-node").getAttribute("aria-label"), "After");
    root.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree outline presentation remains pane-selected and disposal cancels its delete dialog", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let writes = 0;
    const payload = { roots: [{ id: "node:root", title: "Root", children: [] }], rows: [{ node_id: "node:root", title: "Root" }], columns: ["node_id", "title"], detail_fields: [], validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] };
    await ui.treeAdapter.renderNodeTreePanel(root, { presentationMode: "outline", api: async (url) => url.includes("/configs?") ? { configs: [] } : payload, postApi: async () => { writes++; return {}; } });
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    assert.equal(root.querySelector(".wb-tree-outline").hidden, false);
    root.querySelector('[aria-label="切换到树图"]').click();
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle(); assert.ok(ui.document.querySelector(".study-tree-delete-dialog"));
    root.dispose(); await settle();
    assert.equal(ui.document.querySelector(".study-tree-delete-dialog"), null);
    assert.equal(writes, 0);
  } finally { ui.dom.window.close(); }
});

test("deleting a tree node stays on the tree and removes only that node", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let rows = [
      { node_id: "node:a", parent_id: null, title: "Keep", content_md: "" },
      { node_id: "node:b", parent_id: null, title: "Remove", content_md: "" },
    ];
    const payload = () => ({
      roots: rows.map((row) => ({ id: row.node_id, title: row.title, data: { content_md: "" }, children: [] })),
      rows, columns: ["node_id", "parent_id", "title", "content_md"],
      detail_fields: [{ column: "content_md", format: "markdown" }],
      editing: { provider: "study-knowledge/v1" },
      validation: { kind: rows.length > 1 ? "forest" : "tree", root_count: rows.length, max_depth: 1, warnings: [] },
      scopes: [],
    });
    await ui.treeAdapter.renderNodeTreePanel(root, {
      api: async (url) => url.includes("/configs?") ? { configs: [] } : payload(),
      postApi: async (url, values) => {
        if (url.endsWith("/read")) return { node: { node_id: values.node_id, title: "Remove", content_md: "" }, version: "v1" };
        rows = rows.filter((row) => row.node_id !== values.node_id);
        return { node: { node_id: values.node_id, deleted: true } };
      },
    });
    const button = (label) => [...visibleButtons(ui.document)].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    assert.equal(root.classList.contains("is-browsing-tree"), true);
    root.querySelector('.wb-tree-graph-node[data-node-id="node:b"]').dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector('.wb-tree-graph-node[data-node-id="node:b"]').dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle();
    button("删除该节点").click(); await settle(); await settle();
    assert.equal(root.classList.contains("is-browsing-tree"), true);
    assert.equal(root.querySelector(".study-tree-viewer").hidden, false);
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    assert.equal(root.querySelector(".wb-tree-graph-node").dataset.nodeId, "node:a");
    assert.match(root.textContent, /树数据已完成后台校验/);
    root.dispose();
  } finally { ui.dom.window.close(); }
});


test("late tree validation cannot replace a disposed plugin panel", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    let deleted = false, finishValidation;
    const validation = new Promise((resolve) => { finishValidation = resolve; });
    const payload = { roots: [{ id: "node:root", title: "Root", children: [] }], rows: [{ node_id: "node:root", title: "Root" }], columns: ["node_id", "title"], detail_fields: [], validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] };
    await ui.treeAdapter.renderNodeTreePanel(root, {
      api: async (url) => url.includes("/configs?") ? { configs: [] } : deleted ? validation : structuredClone(payload),
      postApi: async (url) => {
        if (url.endsWith("/read")) return { node: { node_id: "node:root" }, version: "v1" };
        deleted = true; return { node: { node_id: "node:root", deleted: true } };
      },
    });
    const button = (label) => [...visibleButtons(ui.document)].find((node) => node.textContent === label);
    button("预览并筛选").click(); await settle(); button("打开树图").click();
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.Event("click"));
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await settle(); button("删除该节点").click(); await settle();
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 0);
    assert.match(root.textContent, /正在后台校验/);
    root.dispose(); root.replaceChildren(ui.document.createTextNode("Replacement plugin"));
    finishValidation(structuredClone(payload)); await settle(); await settle();
    assert.equal(root.textContent, "Replacement plugin");
    assert.equal(root.querySelector(".wb-tree-browser"), null);
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
    assert.equal(frame.previousElementSibling.tagName.toLowerCase(), "title");
    assert.ok(frame.nextElementSibling.classList.contains("wb-tree-insert-marker"));
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
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", children: [{ id: "child", title: "Child", children: [] }] }], initialState: { collapsed: ["root"] }, onMove: async (...args) => operations.push(args), onDelete: async () => {} });
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    root.querySelector(".wb-tree-graph-node").dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true }));
    const toggle = root.querySelector('[aria-label="展开或收起子树 Root"]');
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("pointerup", { button: 0, bubbles: true, cancelable: true }));
    toggle.dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    assert.equal(operations.length, 0);
    assert.equal(root.querySelector(".wb-tree-radial-menu"), null);
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

test("two touch pointers pinch-zoom the tree", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title: "Root", children: [] }] });
    const canvas = root.querySelector(".wb-tree-canvas");
    const svg = canvas.querySelector("svg");
    svg.getBoundingClientRect = () => {
      const position = svg.style.transform.match(/translate\(([-+.\deE]+)px, ([-+.\deE]+)px\)/);
      const width = parseFloat(svg.style.width);
      return { left: (800 - width) / 2 + Number(position?.[1] || 0), top: Number(position?.[2] || 0), width, height: parseFloat(svg.style.height) };
    };
    const pointer = (type, pointerId, clientX, clientY) => {
      const event = new ui.dom.window.MouseEvent(type, { button: 0, clientX, clientY, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      canvas.dispatchEvent(event);
    };
    const before = svg.getBoundingClientRect().width;
    pointer("pointerdown", 1, 200, 200);
    pointer("pointerdown", 2, 280, 200);
    pointer("pointermove", 1, 120, 200);
    pointer("pointermove", 2, 360, 200);
    assert.ok(svg.getBoundingClientRect().width > before * 2);
    pointer("pointerup", 1, 120, 200);
    pointer("pointerup", 2, 360, 200);
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
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
    button("预览并筛选").click(); await settle();
    assert.match(root.textContent, /校验通过/);
    [...root.querySelectorAll("button")].find((node) => node.textContent.startsWith("节点标题")).click();
    ui.document.querySelector('.table-filter-popover input[value="Leaf"]').checked = true;
    [...ui.document.querySelectorAll("button")].find((node) => node.textContent === "应用").click();
    assert.match(root.textContent, /自动保留 1 个祖先/);
    root.querySelector('[aria-label="搜索或选择根节点"]').value = "leaf";
    button("打开树图").click();
    assert.ok(root.classList.contains("is-browsing-tree"));
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    root.querySelector('.wb-tree-graph-node[data-node-id="leaf"]').dispatchEvent(new ui.dom.window.Event("click"));
    button("节点详情").click(); await settle();
    assert.match(root.querySelector(".wb-tree-detail").textContent, /Card answer/);
    button("返回树页面").click();
    root.querySelector('[aria-label="返回方案"]').click();
    root.dispose();
  } finally { ui.dom.window.close(); }
});

test("builtin tree plan opens an editable copy and selects the saved custom plan", async () => {
  const ui = await setup();
  const root = ui.document.createElement("section"); ui.document.body.append(root);
  const entries = []; const writes = [];
  try {
    await ui.treeAdapter.renderNodeTreePanel(root, {
      api: async url => url.includes("/configs?") ? { configs: structuredClone(entries), definition: { contract: "tree-nodes/v1" } } : { roots: [], scopes: [] },
      postApi: async (url, draft) => {
        writes.push({ url, draft: structuredClone(draft) });
        const saved = { ...draft, id: "custom-tree", revision: 1 };
        entries.push(saved); return saved;
      },
    });
    root.querySelector('[aria-label="树方案设置"]').click();
    assert.equal(root.querySelector('[data-help-action="manage-edit"]').disabled, false);
    assert.ok(root.querySelector('[aria-label="编辑方案 学习知识树"]'));
    assert.equal(root.querySelector('[aria-label="删除方案 学习知识树"]'), null);
    root.querySelector('[aria-label="编辑方案 学习知识树"]').click(); await settle(); await settle();
    assert.equal(writes.length, 0);
    assert.equal(root.querySelector('[aria-label="方案名称"]').value, "学习知识树（自定义）");
    assert.match(root.querySelector('[aria-label="SQL（查询模块只允许只读语句）"]').value, /v_study_knowledge_nodes/);
    await assert.rejects(root.refresh(), /编辑/);
    root.querySelector('[data-help-action="save"]').click(); await settle(); await settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "/api/plugin/config/save");
    assert.equal(writes[0].draft.id, undefined);
    [...root.querySelectorAll("button")].find(node => node.textContent === "返回").click(); await settle(); await settle();
    assert.equal(root.querySelector('.study-plan-select[aria-pressed="true"]').textContent, "学习知识树（自定义）");
    root.querySelector('[aria-label="编辑方案 学习知识树（自定义）"]').click(); await settle(); await settle();
    assert.equal(root.querySelector('[aria-label="管理已有方案"]').value, "custom-tree");
  } finally { root.dispose?.(); ui.dom.window.close(); }
});

test("tree plans omit browsing scope, order actions and preserve filters and view on shared refresh", async () => {
  const ui = await setup();
  const root = ui.document.createElement("section"); ui.document.body.append(root);
  const requests = []; let answer = "Before"; let unavailable = false;
  const payload = () => ({ roots: [{ id: "root", title: "Book", children: [{ id: "leaf", title: "Leaf", answer_md: answer, children: [] }] }], scopes: [{ id: "book", label: "Book" }] });
  try {
    await ui.treeAdapter.renderNodeTreePanel(root, { api: async url => {
      requests.push(url);
      if (url.includes("/configs?")) return { configs: [] };
      if (unavailable) throw new Error("offline");
      return payload();
    }, postApi: async () => ({}) });
    const button = label => [...visibleButtons(root)].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
    assert.equal(button("刷新"), undefined);
    assert.equal(root.querySelector('[aria-label="浏览范围"]'), null);
    await root.refresh();
    button("预览并筛选").click(); await settle();
    assert.equal(requests.at(-1), "/api/study/tree?model=knowledge");
    const actions = root.querySelector(".wb-preview-actions");
    assert.ok(actions.firstElementChild.matches(".wb-tree-root-tools"));
    assert.equal(actions.children[1].textContent, "清空列筛选");
    const back = root.querySelector('.study-tree-preview-header [aria-label="返回方案"]');
    assert.equal(back.textContent, ""); assert.ok(back.querySelector("svg"));
    button("筛选 节点标题").click();
    ui.document.querySelector('.table-filter-popover input[value="Leaf"]').checked = true;
    [...ui.document.querySelectorAll("button")].find(node => node.textContent === "应用").click();
    root.querySelector('[aria-label="搜索或选择根节点"]').value = "leaf";
    await root.refresh();
    assert.equal(root.querySelector('[aria-label="搜索或选择根节点"]').value, "leaf");
    assert.match(root.textContent, /筛选后 1 条/);
    button("打开树图").click();
    assert.equal(button("刷新"), undefined);
    button("大纲").click();
    answer = "After";
    await root.refresh();
    assert.equal(root.querySelector('.wb-tree-view-switch button[aria-pressed="true"]').textContent, "大纲");
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 1);
    assert.match(root.textContent, /筛选后 1 条/);
    unavailable = true;
    await assert.rejects(root.refresh(), /offline/);
    assert.match(root.querySelector(".study-tree-status").textContent, /offline/);
    assert.ok(root.classList.contains("is-browsing-tree"));
    assert.equal(root.querySelector('.wb-tree-view-switch button[aria-pressed="true"]').textContent, "大纲");
    back.click();
    assert.equal(root.querySelector('[data-help-page="plans"]').hidden, false);
  } finally { root.dispose?.(); ui.dom.window.close(); }
});

test("tree mapping editor synchronizes relation fields and multiple detail modules", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    await ui.manager.openConfigManager(root, { api: async () => ({ configs: [], definition: { contract: "tree-nodes/v1" } }), postApi: async () => ({}), pluginId: "tree", moduleId: "trees" });
    const mapping = root.querySelector('[aria-label="节点 ID 列"]');
    mapping.value = "code"; mapping.dispatchEvent(new ui.dom.window.Event("change"));
    const button = (label) => [...visibleButtons(root)].find((node) => node.textContent === label);
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
    // New trees are fully expanded by default, including deep hierarchies.
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
    const host = ui.tree.createTreeWorkspace(root, { roots: trees, initialState: { collapsed: ["node:chapter"] }, detailFields: [{ column: "content_md", format: "markdown" }], renderMarkdown: (value, body) => { body.textContent = value; } });
    const click = (label) => root.querySelector(`[aria-label="${label}"]`).dispatchEvent(new ui.dom.window.Event("click", { bubbles: true }));
    click("展开或收起子树 Chapter");
    click("Question");
    click("展开或收起内容 Question");
    assert.equal(root.querySelector(".wb-tree-inline-content").textContent, "**Answer**");
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
    root.querySelector('[aria-label="适应画布"]').click();
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
    const host = ui.tree.createTreeWorkspace(root, { roots: [{ id: "root", title, data: { back: "Answer" }, children: [{ id: "child", title: "Child", children: [] }] }], initialState: { collapsed: ["root"] }, detailFields: [{ column: "back" }] });
    let card = root.querySelector('[data-node-id="root"]');
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 1);
    assert.equal(card.querySelector(".wb-tree-node-control text").textContent, "+");
    assert.equal(card.querySelector(".wb-tree-node-title").textContent, title);
    assert.ok(card.querySelectorAll("tspan").length > 1);
    assert.ok(Number(card.querySelector(".wb-tree-node-frame").getAttribute("height")) > 64);
    assert.equal(card.querySelectorAll(".wb-tree-node-control").length, 2);
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
    assert.equal(root.querySelector(".wb-tree-canvas svg").firstElementChild.classList.contains("wb-tree-edges"), true);
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

test("tree accepts sibling whitespace and end zones with live guides", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const reorders = [];
    const host = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "parent", title: "Parent", children: ["source", "a", "b"].map((id) => ({ id, title: id, children: [] })) }],
      onMove: async () => assert.fail("whitespace must not change parent"),
      onReorder: async (...args) => reorders.push(args),
    });
    const source = root.querySelector('[data-node-id="source"]');
    for (const [id, top] of [["a", 100], ["b", 240]]) {
      root.querySelector('[data-node-id="' + id + '"]').getBoundingClientRect = () => ({ top, bottom: top + 100, height: 100, left: 100, right: 300, width: 200 });
    }
    ui.document.elementsFromPoint = () => [];
    const pointer = (type, x, y) => {
      const event = new ui.dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } });
      source.dispatchEvent(event);
    };
    for (const [y, target, placement] of [[80, "a", "before"], [210, "a", "after"], [230, "b", "before"], [360, "b", "after"]]) {
      pointer("pointerdown", 150, 10); pointer("pointermove", 150, y);
      assert.equal(root.querySelectorAll(".wb-tree-drag-connection").length, 1);
      const connection = root.querySelector(".wb-tree-drag-connection");
      const ghost = root.querySelector(".wb-tree-drag-ghost");
      const translation = ghost.getAttribute("transform").match(/translate\(([^,]+),([^)]+)\)/);
      const titleBox = ghost.querySelector(".wb-tree-node-control rect");
      const height = Number(titleBox.getAttribute("height"));
      assert.ok(connection.getAttribute("d").endsWith(
        Number(translation[1]) + "," + (Number(translation[2]) + height / 2)));
      assert.equal(connection.getAttribute("stroke"), "var(--accent)");
      assert.equal(root.querySelectorAll(".wb-tree-insertion-line").length, 1);
      pointer("pointerup", 150, y); await settle();
      assert.deepEqual(reorders.at(-1), ["source", target, placement]);
      assert.equal(root.querySelectorAll(".wb-tree-drop-guide").length, 0);
    }
    for (const [x, y] of [[150, 500], [700, 210]]) {
      pointer("pointerdown", 150, 10); pointer("pointermove", x, y); pointer("pointerup", x, y);
    }
    assert.equal(reorders.length, 4);
    pointer("pointerdown", 150, 10); pointer("pointermove", 150, 210); pointer("pointercancel", 150, 210);
    assert.equal(root.querySelectorAll(".wb-tree-drop-guide,.wb-tree-drag-ghost").length, 0);
    assert.equal(reorders.length, 4);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree node actions use an accessible radial menu instead of header buttons", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const edits = []; const deletions = [];
    const host = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "root", title: "Root", data: { back: "Answer" }, children: [{ id: "child", title: "Child", children: [] }] }, { id: "second", title: "Second", children: [] }],
      detailFields: [{ column: "back" }],
      onEdit: async (operation) => edits.push(operation),
      onDelete: async (node) => deletions.push(node.id),
    });
    const headerText = root.querySelector(".wb-tree-header").textContent;
    for (const label of ["新增子主题", "新增同级主题", "编辑内容", "节点详情", "以此节点为根", "删除节点"]) assert.equal(headerText.includes(label), false);
    let card = root.querySelector('[data-node-id="root"]');
    root.querySelector(".wb-tree-canvas").getBoundingClientRect = () => ({ left: 0, right: 900, top: 0, bottom: 600, width: 900, height: 600 });
    card.getBoundingClientRect = () => ({ left: 120, right: 420, top: 180, bottom: 260, width: 300, height: 80 });
    card.dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true }));
    let menu = root.querySelector('.wb-tree-radial-menu[role="menu"]');
    assert.ok(menu);
    assert.equal(menu.dataset.side, "right");
    assert.equal(card.getAttribute("aria-haspopup"), "menu");
    assert.equal(root.querySelectorAll('.wb-tree-radial-item[role="menuitem"]').length, 6);
    assert.ok([...menu.querySelectorAll(".wb-tree-radial-item")].every((item) => item.style.clipPath.startsWith("polygon(")));
    assert.ok(menu.querySelector(".wb-tree-radial-item.is-danger .wb-tree-radial-item-icon"));
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    items[0].focus();
    assert.match(menu.querySelector(".wb-tree-radial-center-label").textContent, /新增子主题/);
    items[0].dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    assert.equal(ui.document.activeElement, items[1]);
    items[1].dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(root.querySelector(".wb-tree-radial-menu"), null);
    card = root.querySelector('[data-node-id="root"]');
    card.dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true }));
    root.querySelector('.wb-tree-radial-item[aria-label="以此节点为根"]').click(); await settle();
    assert.equal(host.getState().root, "root");
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 2);
    root.querySelector('[aria-label="恢复全图"]').click();
    assert.equal(host.getState().root, "");
    assert.equal(root.querySelectorAll(".wb-tree-graph-node").length, 3);
    card = root.querySelector('[data-node-id="root"]');
    card.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    menu = root.querySelector(".wb-tree-radial-menu");
    menu.querySelector('[aria-label^="新增子主题"]').click(); await settle();
    assert.deepEqual(edits, ["child"]);
    card = root.querySelector('[data-node-id="root"]');
    card.dispatchEvent(new ui.dom.window.MouseEvent("click", { bubbles: true }));
    root.querySelector('.wb-tree-radial-item[aria-label^="删除节点"]').click(); await settle();
    assert.deepEqual(deletions, ["root"]);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("outline rows use child toggle and title content toggle with themed view state", async () => {
  const ui = await setup();
  try {
    const root = ui.document.createElement("section"); ui.document.body.append(root);
    const host = ui.tree.createTreeWorkspace(root, {
      roots: [{ id: "root", title: "Root", data: { back: "Root answer" }, children: [{ id: "child", title: "Child", data: { back: "Child answer" }, children: [] }] }],
      detailFields: [{ column: "back", format: "text" }],
      initialMode: "outline",
    });
    const graphButton = root.querySelector('[aria-label="切换到树图"]');
    const outlineButton = root.querySelector('[aria-label="切换到大纲"]');
    assert.equal(graphButton.getAttribute("aria-pressed"), "false");
    assert.equal(outlineButton.getAttribute("aria-pressed"), "true");
    assert.equal(root.querySelectorAll(".wb-tree-outline-row").length, 2);
    assert.equal(root.querySelectorAll(".wb-tree-outline-row button").length, 4);
    const title = root.querySelector('.wb-tree-outline-title[data-node-id="child"]');
    title.click();
    assert.equal(root.querySelector(".wb-tree-radial-menu"), null);
    assert.equal(title.getAttribute("aria-expanded"), "false");
    assert.match(root.querySelector(".wb-tree-inline-content").textContent, /Child answer/);
    assert.ok(root.querySelector(".wb-tree-outline > .wb-tree-inline-content"));
    assert.match(studyCss, /\.wb-tree-browser \.wb-tree-outline > \.wb-tree-inline-content \{[^}]*height:auto;[^}]*max-height:none;[^}]*overflow-y:visible/);
    assert.equal(root.querySelector('.wb-tree-outline-title[data-node-id="child"]').getAttribute("aria-expanded"), "true");
    graphButton.click();
    assert.equal(root.querySelector('[aria-label="切换到树图"]').getAttribute("aria-pressed"), "true");
    assert.equal(root.querySelector('[aria-label="切换到大纲"]').getAttribute("aria-pressed"), "false");
    host.dispose();
  } finally { ui.dom.window.close(); }
});

// ---- BSP plugin workspace ---------------------------------------------------

const leaf = (pluginId, instanceId = `${pluginId}#1`) => ({ kind: "leaf", id: `leaf-${instanceId}`, pluginId, instanceId });
const split = (first, second, ratio = 0.5) => ({ kind: "split", id: `split-${first.id}-${second.id}`, orientation: "vertical", ratio, first, second });
const sized = (id, extra = {}) => ({
  id,
  state: "enabled",
  contributes: { presentations: [
    { id: "compact", label: id, mode: "compact", when: { maxCols: 5 }, priority: 10 },
    { id: "default", label: id, default: true },
  ] },
  ...extra,
});
// Renderers run asynchronously after a presentation switch; wait for them.
const emitPane = async (ui, instance, width, height) => {
  const observer = ui.resizeObservers.find((item) => item.target === instance && !item.disconnected);
  observer.callback([{ target: instance, borderBoxSize: [{ inlineSize: width, blockSize: height }] }]);
  await settle();
};

function bspWorkspace(ui, { tree, renderers, postApi } = {}) {
  let layout = { schema: "workbench.layout.bsp/v1", revision: 3, tree };
  const posts = [];
  const host = ui.workspace.createPluginWorkspace({
    api: async () => structuredClone(layout),
    postApi: postApi ? (url, payload) => postApi(url, payload, posts, (next) => { layout = next; }) : async (url, payload) => {
      posts.push(payload);
      layout = { ...payload, revision: payload.revision + 1 };
      return structuredClone(layout);
    },
    container: ui.document.querySelector("#workbench"),
    topbar: ui.document.querySelector(".topbar"),
    renderers,
  });
  return { host, posts, layout: () => layout };
}

test("trash closes the targeted pane in both directions and protects the last pane", async () => {
  const ui = await setup();
  try {
    const { host, posts, layout } = bspWorkspace(ui, {
      tree: split(leaf("demo.a", "a"), split(leaf("demo.b", "b"), leaf("demo.c", "c"))), renderers: {},
    });
    await host.update(["demo.a", "demo.b", "demo.c"].map(id => sized(id)));
    const button = ui.document.querySelector(".wb-layout-clear-button");
    const dataTransfer = { setData() {}, getData() { return ""; }, types: [] };
    const fire = (target, type) => {
      const event = new ui.dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { dataTransfer, clientX: 50, clientY: 50 }); target.dispatchEvent(event);
    };
    fire(button, "dragstart");
    const b = ui.document.querySelector('[data-leaf-id="leaf-b"]');
    fire(b, "dragover"); assert.ok(b.querySelector(".wb-pane-delete-preview"));
    fire(b, "drop"); fire(b, "drop"); fire(button, "dragend");
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 1); assert.equal(posts[0].revision, 3);
    assert.equal(JSON.stringify(layout().tree).includes('"instanceId":"b"'), false);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 2);

    fire(ui.document.querySelector('[data-leaf-id="leaf-c"] .wb-bsp-move-handle'), "dragstart");
    assert.equal(ui.document.documentElement.dataset.wbDrag, "layout", "pane handle starts a layout drag");
    fire(button, "dragover"); assert.equal(button.dataset.deleteTarget, "leaf-c");
    fire(button, "drop"); fire(button, "dragend");
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 2); assert.equal(layout().tree.instanceId, "a");

    fire(button, "dragstart"); fire(ui.document.querySelector(".wb-bsp-leaf"), "dragover");
    assert.ok(ui.document.querySelector(".wb-pane-delete-preview.is-blocked"));
    fire(ui.document.querySelector(".wb-bsp-leaf"), "drop"); fire(button, "dragend");
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 2, "last-pane refusal never writes the layout");
    assert.equal(layout().tree.instanceId, "a");
    host.dispose();
    assert.equal(ui.document.querySelector(".wb-pane-delete-preview,.wb-trash-drag-ghost,.wb-layout-clear-button"), null);
  } finally { ui.dom.window.close(); }
});

test("workspace mounts every leaf through the renderer registry without host DOM", async () => {
  const ui = await setup();
  try {
    const mounts = [];
    const render = (panel, context) => {
      assert.equal(typeof context.api, "function", "panes always receive the host api");
      assert.equal(typeof context.postApi, "function");
      mounts.push(`${context.pluginId}:${context.presentationId}:${context.pane.width}`);
      panel.textContent = context.instanceId;
    };
    const { host } = bspWorkspace(ui, {
      tree: split(leaf("demo.catalog"), leaf("demo.grid")),
      renderers: { "demo.catalog": render, "demo.grid": render },
    });
    await host.update([sized("demo.catalog"), sized("demo.grid")]);
    const instances = [...ui.document.querySelectorAll(".wb-bsp-leaf > .wb-plugin-instance")];
    assert.equal(instances.length, 2);
    assert.equal(mounts.length, 0, "panes render once their size is observed");
    await emitPane(ui, instances[0], 300, 600);
    await emitPane(ui, instances[1], 900, 600);
    assert.deepEqual(mounts, ["demo.catalog:compact:narrow", "demo.grid:default:wide"]);
    assert.equal(instances[0].dataset.presentation, "compact");
    assert.equal(instances[0].dataset.paneWidth, "narrow");
    assert.equal(instances[1].dataset.paneWidth, "wide");
    assert.equal(instances[0].textContent, "demo.catalog#1");
    assert.equal(ui.document.querySelectorAll("#left-column,.data-pane,.inspector-pane").length, 0);
  } finally { ui.dom.window.close(); }
});

test("same-renderer presentation boundaries retain the live panel and notify its shape", async () => {
  const ui = await setup();
  try {
    const modes = [];
    const { host } = bspWorkspace(ui, {
      tree: leaf("demo.timer"),
      renderers: { "demo.timer": (panel, context) => {
        modes.push(context.presentationMode);
        panel.updatePresentation = next => modes.push(next.presentationMode);
        panel.innerHTML = '<input value="unsaved draft">';
      } },
    });
    await host.update([sized("demo.timer")]);
    const instance = ui.document.querySelector(".wb-plugin-instance");
    await emitPane(ui, instance, 300, 400);
    const input = instance.querySelector('input'); input.value = 'retained draft';
    await emitPane(ui, instance, 420, 400);
    await emitPane(ui, instance, 600, 400);
    await emitPane(ui, instance, 700, 400);
    await emitPane(ui, instance, 431, 400);
    assert.deepEqual(modes, ["compact", "default", "compact"]);
    assert.equal(instance.dataset.paneHeight, "tall");
    await emitPane(ui, instance, 431, 200);
    assert.equal(instance.dataset.paneHeight, "short");
    assert.deepEqual(modes, ["compact", "default", "compact"], "a class change alone does not remount");
    assert.equal(instance.querySelector('input'), input);
    assert.equal(input.value, 'retained draft');
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("tree detail survives size boundaries and layout rebuild without reloading its plan", async () => {
  const ui = await setup();
  let host;
  try {
    let reads = 0;
    const payload = { roots: [{ id: 'root', title: 'Root', data: {content_md:'Keep this detail'}, children: [] }], rows: [{node_id:'root',title:'Root',content_md:'Keep this detail'}], columns:['node_id','title','content_md'], detail_fields:[{column:'content_md',format:'markdown'}], validation:{kind:'tree',root_count:1,max_depth:1,warnings:[]},scopes:[] };
    ({host} = bspWorkspace(ui, {tree:leaf('study.node-tree'), renderers:{'study.node-tree':(panel,context)=>ui.treeAdapter.renderNodeTreePanel(panel,{...context,api:async url=>{reads++;return url.includes('/configs?')?{configs:[]}:payload;},postApi:async()=>({})})}}));
    const plugin = sized('study.node-tree'); plugin.contributes.presentations[0].mode='outline';
    await host.update([plugin]);
    const instance=ui.document.querySelector('.wb-plugin-instance');
    await emitPane(ui,instance,700,600); await settle();
    visibleButtons(instance).find(b=>b.textContent==='预览并筛选').click(); await settle();
    visibleButtons(instance).find(b=>b.textContent==='打开树图').click(); await settle();
    instance.querySelector('.wb-tree-graph-node').dispatchEvent(new ui.dom.window.Event('click'));
    instance.querySelector('[aria-label="节点详情"].wb-tree-radial-item').click();
    const detail=instance.querySelector('.wb-tree-detail'), count=reads;
    for(const width of [300,700,300]){
      await emitPane(ui,instance,width,600); host.show();
      assert.equal(instance.querySelector('.wb-tree-detail'),detail);
      assert.equal(detail.hidden,false); assert.match(detail.textContent,/Keep this detail/);
      assert.equal(instance.querySelector('.study-tree-viewer').hidden,false);
    }
    assert.equal(reads,count,'changing pane geometry never reloads the selected tree');
  } finally { host?.dispose(); ui.dom.window.close(); }
});

test("revealed review card survives pane changes without another session request or score", async () => {
  const ui=await setup(); let host;
  try {
    const reads=[],writes=[];
    ui.dom.window.localStorage.setItem('study.review.session.v1',JSON.stringify('existing'));
    ({host}=bspWorkspace(ui,{tree:leaf('study.review-table'),renderers:{'study.review-table':(panel,context)=>ui.review.renderReviewTablePanel(panel,{...context,api:async url=>{reads.push(url);return url.includes('/session/')?{session_id:'existing',config:{view:'test'},completed:0,total:2,position:0,card:{front:'Question',back:'Answer'}}:{configs:[],definition:{}};},postApi:async(url,payload)=>{writes.push(url);return {};}})}}));
    await host.update([sized('study.review-table')]);
    const instance=ui.document.querySelector('.wb-plugin-instance');
    await emitPane(ui,instance,700,600);
    clickText(instance,'继续上次复习'); await settle(); clickText(instance,'显示答案');
    const card=instance.querySelector('.study-learning-card'),front=instance.querySelector('.study-review-question');
    const count=reads.length;
    for(const width of [300,700,300]) { await emitPane(ui,instance,width,500); host.show(); assert.equal(card.hidden,false);assert.equal(instance.querySelector('.study-review-question'),front);assert.equal(instance.querySelector('.study-review-ratings').hidden,false); }
    assert.equal(reads.length,count); assert.ok(writes.every(url=>url.includes('/unit-lease/')));
    assert.match(front.textContent,/Question/); assert.match(card.textContent,/Answer/);
  } finally {host?.dispose();ui.dom.window.close();}
});

test("async mounting receives the latest presentation without starting a second mount", async () => {
  const ui=await setup();let host,finish;
  try {
    let mounts=0;const shapes=[];
    ({host}=bspWorkspace(ui,{tree:leaf('slow'),renderers:{slow:async panel=>{mounts++;await new Promise(resolve=>{finish=resolve;});panel.updatePresentation=next=>shapes.push(next.presentationMode);}}}));
    await host.update([sized('slow')]);const instance=ui.document.querySelector('.wb-plugin-instance');
    await emitPane(ui,instance,700,500);await emitPane(ui,instance,300,500);
    finish();await settle();await settle();
    assert.equal(mounts,1);assert.deepEqual(shapes,['compact']);
  } finally {host?.dispose();ui.dom.window.close();}
});

test("switching to a distinct renderer still disposes the old view", async () => {
  const ui=await setup();let host;
  try {
    let mounts=0,disposals=0;
    ({host}=bspWorkspace(ui,{tree:leaf('different'),renderers:{different:panel=>{mounts++;panel.dispose=()=>{disposals++;};}}}));
    const plugin=sized('different');for(const p of plugin.contributes.presentations)p.renderer=p.id;
    await host.update([plugin]);const instance=ui.document.querySelector('.wb-plugin-instance');
    await emitPane(ui,instance,700,500);await emitPane(ui,instance,300,500);
    assert.equal(mounts,2);assert.equal(disposals,1);
  } finally {host?.dispose();ui.dom.window.close();}
});

test("a renderer failure is marked on its panel instead of failing silently", async () => {
  const ui = await setup();
  try {
    const { host } = bspWorkspace(ui, { tree: leaf("demo.broken"), renderers: { "demo.broken": () => { throw new Error("boom"); } } });
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      await host.update([sized("demo.broken")]);
      await emitPane(ui, ui.document.querySelector(".wb-plugin-instance"), 600, 400);
      await settle();
    } finally { console.error = original; }
    const panel = ui.document.querySelector(".wb-plugin-content");
    assert.equal(panel.dataset.failed, "true");
    assert.equal(panel.textContent, "boom");
    assert.ok(errors.some((line) => line.includes("demo.broken")));
  } finally { ui.dom.window.close(); }
});

test("dock offers enabled plugins only and drops a broken icon", async () => {
  const ui = await setup();
  try {
    const { host } = bspWorkspace(ui, { tree: leaf("demo.a"), renderers: { "demo.a": () => {} } });
    await host.update([sized("demo.a", { icon: "icon.svg" }), sized("demo.off", { state: "disabled" })]);
    const items = [...ui.document.querySelectorAll(".wb-bsp-dock-item")];
    assert.deepEqual(items.map((item) => item.dataset.pluginId), ["demo.a"]);
    const icon = items[0].querySelector("img");
    icon.dispatchEvent(new ui.dom.window.Event("error"));
    assert.equal(items[0].querySelector("img"), null);
    assert.equal(items[0].getAttribute("aria-label"), "demo.a");
    assert.equal(items[0].querySelector(".wb-launcher-fallback").hidden, false);
    assert.notEqual(items[0].textContent, "demo.a", "shortcut remains icon-only after icon failure");
  } finally { ui.dom.window.close(); }
});

test("default system plugin opens as a normal pane from All apps and stays unpinned", async () => {
  const ui = await setup();
  try {
    let mounted = 0;
    const id = "official.plugin-manager", manager = sized(id);
    manager.contributes.launcher = { label: { zh: "插件安装和管理", en: "Plugin manager" }, defaultPinned: false, searchTerms: ["安装"] };
    const { host, posts } = bspWorkspace(ui, { tree: null, renderers: { [id]: () => { mounted++; } } });
    await host.update([manager]);
    assert.equal(ui.document.querySelector(".wb-plugin-install-link"), null);
    assert.equal(ui.document.querySelector(".wb-bsp-dock-item"), null);
    const menu = ui.document.querySelector(".wb-app-menu");
    assert.equal(menu.hidden, true);
    ui.document.querySelector(".app-launcher-button").click();
    const entry = menu.querySelector('button[data-application-id="official.plugin-manager"][data-action="activate"]');
    assert.equal(entry.getAttribute("href"), null);
    assert.equal(entry.querySelector(".wb-launcher-app-name").textContent, "插件安装和管理");
    assert.ok(entry.closest(".wb-launcher-row").querySelector(".wb-launcher-pin"));
    assert.equal(menu.querySelector('input[type="search"]').hidden, true);
    menu.querySelector(".wb-launcher-search-toggle").click();
    const input = menu.querySelector('input[type="search"]');
    input.value = "安装";
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    assert.equal(menu.querySelectorAll(".wb-launcher-result").length, 1);
    ui.document.documentElement.dataset.language = "en";
    ui.document.dispatchEvent(new ui.dom.window.CustomEvent("workbench:languagechange"));
    assert.equal(menu.querySelector('[data-action="activate"] .wb-launcher-app-name').textContent, "Plugin manager");
    assert.equal(posts.length, 0, "opening/searching the manager entry never changes the workspace");
    menu.querySelector('[data-action="activate"]').click();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 1);
    assert.equal(ui.document.querySelector(".wb-bsp-leaf").dataset.pluginId, id);
    await emitPane(ui, ui.document.querySelector(".wb-plugin-instance"), 700, 500);
    assert.equal(mounted, 1);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("launcher focuses the most recent existing instance without writing layout", async () => {
  const ui = await setup();
  try {
    const { host, posts } = bspWorkspace(ui, { tree: split(leaf("demo.a", "a1"), leaf("demo.a", "a2")), renderers: {} });
    await host.update([sized("demo.a")]);
    const second = ui.document.querySelector('[data-leaf-id="leaf-a2"]');
    second.dispatchEvent(new ui.dom.window.Event("pointerdown", { bubbles: true }));
    ui.document.querySelector(".wb-bsp-dock-item").click();
    await settle(); await settle();
    assert.equal(posts.length, 0);
    assert.equal(ui.document.activeElement, second);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 2);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("launcher creates only one first pane on rapid clicks and safely splits a large pane", async () => {
  const ui = await setup();
  try {
    const { host, posts } = bspWorkspace(ui, { tree: null, renderers: {} });
    await host.update([sized("demo.a"), sized("demo.b")]);
    const a = ui.document.querySelector('[data-plugin-id="demo.a"].wb-bsp-dock-item');
    a.click(); a.click();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 1);
    const first = ui.document.querySelector(".wb-bsp-leaf");
    const originalId = first.dataset.leafId;
    first.getBoundingClientRect = () => ({ width: 900, height: 600 });
    ui.document.querySelector('[data-plugin-id="demo.b"].wb-bsp-dock-item').click();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 2);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 2);
    assert.ok(ui.document.querySelector(`[data-leaf-id="${originalId}"]`), "original pane is preserved");
    assert.equal(ui.document.activeElement.dataset.pluginId, "demo.b");
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("launcher refuses insufficient pane space without replacing existing content", async () => {
  const ui = await setup();
  try {
    const { host, posts, layout } = bspWorkspace(ui, { tree: leaf("demo.a"), renderers: {} });
    await host.update([sized("demo.a"), sized("demo.b")]);
    const before = JSON.stringify(layout());
    ui.document.querySelector(".wb-bsp-leaf").getBoundingClientRect = () => ({ width: 300, height: 300 });
    ui.document.querySelector(".app-launcher-button").click();
    ui.document.querySelector('[data-plugin-id="demo.b"].wb-launcher-result').click();
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(posts.length, 0);
    assert.equal(JSON.stringify(layout()), before);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 1);
    assert.equal(ui.document.querySelector(".wb-app-menu").hidden, false);
    assert.match(ui.document.querySelector(".wb-launcher-status").textContent, /空间不足/);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("launcher borrows whole-host space when individual phone panes cannot split", async () => {
  const ui = await setup();
  try {
    const tree = split(leaf("demo.a", "a"), leaf("demo.b", "b"));
    tree.orientation = "horizontal";
    const { host, posts } = bspWorkspace(ui, { tree, renderers: {} });
    await host.update([sized("demo.a"), sized("demo.b"), sized("demo.c")]);
    ui.document.querySelector(".wb-bsp-host").getBoundingClientRect = () => ({ width:393, height:730 });
    for (const pane of ui.document.querySelectorAll(".wb-bsp-leaf")) pane.getBoundingClientRect = () => ({ width:393, height:362 });
    ui.document.querySelector('.wb-launcher-shortcut[data-plugin-id="demo.c"]').click();
    for (let i=0;i<5;i++) await settle();
    assert.equal(posts.length,1);assert.equal(ui.document.querySelectorAll('.wb-bsp-leaf').length,3);
    assert.ok(ui.document.querySelector('[data-leaf-id="leaf-a"]'));assert.ok(ui.document.querySelector('[data-leaf-id="leaf-b"]'));
    assert.equal(ui.document.querySelector('.wb-app-menu').hidden,true);
    host.dispose();
  } finally { ui.dom.window.close(); }
});

test("an empty workspace shows one drop target instead of panes", async () => {
  const ui = await setup();
  try {
    const { host } = bspWorkspace(ui, { tree: null, renderers: {} });
    await host.update([sized("demo.a")]);
    assert.ok(ui.document.querySelector(".wb-bsp-host > .wb-bsp-empty"));
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 0);
  } finally { ui.dom.window.close(); }
});

test("a stale layout revision is retried once against the fresh revision", async () => {
  const ui = await setup();
  try {
    const { host, posts } = bspWorkspace(ui, {
      tree: null,
      renderers: {},
      postApi: async (url, payload, posts, store) => {
        posts.push(payload);
        if (posts.length === 1) throw new Error("插件布局已被其他窗口修改，请刷新后重试");
        const next = { ...payload, revision: payload.revision + 1 };
        store(next);
        return structuredClone(next);
      },
    });
    await host.update([sized("demo.a")]);
    // Drag a Dock plugin onto the empty workspace: the first pane is saved.
    const data = new Map();
    const dataTransfer = { setData: (key, value) => data.set(key, value), getData: (key) => data.get(key) || "", types: [] };
    const dragstart = new ui.dom.window.Event("dragstart", { bubbles: true });
    Object.defineProperty(dragstart, "dataTransfer", { value: dataTransfer });
    ui.document.querySelector('.wb-bsp-dock-item[data-plugin-id="demo.a"]').dispatchEvent(dragstart);
    const drop = new ui.dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
    ui.document.querySelector(".wb-bsp-empty").dispatchEvent(drop);
    for (let i = 0; i < 5; i += 1) await settle();
    assert.equal(posts.length, 2, "the stale save is retried once");
    assert.equal(posts[1].revision, 3);
    assert.equal(posts[1].tree.pluginId, "demo.a");
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 1);
  } finally { ui.dom.window.close(); }
});

test("a persisted layout is shown as stored and never rewritten", async () => {
  const ui = await setup();
  try {
    const nested = split(leaf("demo.a"), split(leaf("demo.b"), split(leaf("demo.c"), leaf("demo.d"))));
    const { host, posts } = bspWorkspace(ui, { tree: nested, renderers: {} });
    await host.update(["demo.a", "demo.b", "demo.c", "demo.d"].map((id) => sized(id)));
    assert.equal(posts.length, 0);
    assert.equal(ui.document.querySelectorAll(".wb-bsp-leaf").length, 4);
  } finally { ui.dom.window.close(); }
});

test("refreshVisible refreshes mounted panels and dispose removes the chrome", async () => {
  const ui = await setup();
  try {
    let refreshed = 0;
    const { host } = bspWorkspace(ui, {
      tree: leaf("demo.a"),
      renderers: { "demo.a": (panel) => { panel.refresh = async () => { refreshed += 1; }; } },
    });
    await host.update([sized("demo.a")]);
    await emitPane(ui, ui.document.querySelector(".wb-plugin-instance"), 600, 400);
    await host.refreshVisible({ reason: "global" });
    assert.equal(refreshed, 1);
    host.dispose();
    assert.equal(ui.document.querySelector(".wb-bsp-dock"), null);
    assert.equal(ui.document.querySelector(".wb-app-menu"), null);
    assert.ok(ui.resizeObservers.every((observer) => observer.disconnected || observer.target === undefined));
  } finally { ui.dom.window.close(); }
});

test("catalogue changes dispose disabled panes and remount changed approved package content", async () => {
  const ui = await setup();
  try {
    let mounts = 0, disposals = 0;
    const first = sized("demo.a"); first.package = { contentHash: "first", permissions: [], trusted: true };
    const { host } = bspWorkspace(ui, { tree: leaf("demo.a"), renderers: { "demo.a": (panel) => { mounts++; panel.dispose = () => { disposals++; }; } } });
    await host.update([first]);
    await emitPane(ui, ui.document.querySelector(".wb-plugin-instance"), 600, 400);
    await host.update([first]);
    assert.equal(mounts, 1); assert.equal(disposals, 0);
    await host.update([{ ...first, package: { ...first.package, contentHash: "second" } }]);
    await emitPane(ui, ui.document.querySelector(".wb-plugin-instance"), 600, 400);
    assert.equal(mounts, 2); assert.equal(disposals, 1);
    await host.update([{ ...first, state: "disabled" }]);
    assert.equal(disposals, 2);
    assert.equal(ui.document.querySelector(".wb-plugin-instance"), null);
    host.dispose();
  } finally { ui.dom.window.close(); }
});
