import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../web/studyReview.mjs", import.meta.url), "utf8");
const catalog = {
  views: [
    { name: "v_study_node_cards", columns: ["card_id", "front", "back", "hint", "node_id", "due_at"] },
    { name: "v_study_due_cards", columns: ["card_id", "front", "back", "node_id", "due_at"] },
    { name: "custom_view", columns: ["identity", "question", "answer"] },
  ],
  nodes: [{ id: "book", title: "测试书籍", parent_id: null }, { id: "chapter", title: "第一章", parent_id: "book" }],
  targets: [{ table: "custom_schedule", keys: ["id"], time_columns: ["next_review"] }],
};
const defaultConfig = {
  view: "v_study_node_cards", mapping: { key: "card_id", front: "front", back: "back", node: "node_id" },
  mode: "all", limit: 100, scheduler: { kind: "fsrs" },
};
const session = (config = defaultConfig, completed = 0) => ({
  session_id: "session-one", config, total: 2, completed, position: completed < 2 ? completed : null,
  card: completed < 2 ? { key: `card-${completed}`, front: `Question ${completed}`, back: `Answer ${completed}`, due_at: "2099-01-01" } : null,
});

async function harness({ storage = {}, post, resume = session() } = {}) {
  const dom = new JSDOM("<!doctype html><div id='panel'></div>", { url: "http://localhost/" });
  const { window } = dom;
  window.confirm = () => true;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, JSON.stringify(value));
  const context = vm.createContext({ document: window.document, window, localStorage: window.localStorage, Option: window.Option, console });
  const markdown = new vm.SyntheticModule(["attachMarkdownToggle"], function () {
    this.setExport("attachMarkdownToggle", (toolbar, target, getText) => {
      toolbar.append(window.document.createElement("button"));
      return { refresh: () => { target.textContent = getText(); } };
    });
  }, { context });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => markdown);
  await module.evaluate();
  const calls = [];
  const api = async (url) => url.endsWith("catalog") ? catalog : resume;
  const postApi = async (url, payload) => {
    calls.push({ url, payload });
    if (post) return post(url, payload);
    if (url.endsWith("preview")) return { matched: 2, selected: 2, sample: [{ front: "Question" }] };
    if (url.endsWith("session-grade")) return { graded: { due_at: "2030-01-01" }, next: session(defaultConfig, payload.position + 1) };
    return session(payload.config);
  };
  const panel = window.document.querySelector("#panel");
  await module.namespace.renderReviewTablePanel(panel, { api, postApi, getCurrentView: () => ({ name: "not_a_review_view" }) });
  const field = (label) => panel.querySelector(`[aria-label="${label}"]`);
  const button = (text) => [...panel.querySelectorAll("button")].find((entry) => entry.textContent === text);
  const change = (node, value) => { node.value = value; node.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { window, panel, calls, field, button, change, settle, close: () => window.close() };
}

test("configuration builds node/all collection, filters and ordered rules", async () => {
  const ui = await harness();
  try {
    assert.equal(ui.field("来源视图").value, "v_study_node_cards");
    ui.change(ui.field("集合模式"), "all");
    const search = ui.field("搜索学习节点（标题或路径）");
    search.value = "第一章";
    search.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    assert.equal(ui.field("节点范围（含全部后代）").options.length, 2);
    ui.change(ui.field("节点范围（含全部后代）"), "chapter");
    ui.button("+ 筛选条件").click();
    ui.change(ui.field("筛选字段"), "front");
    ui.change(ui.field("筛选运算"), "contains");
    ui.field("筛选值").value = "协议";
    ui.button("预览集合").click();
    await ui.settle();
    const config = ui.calls[0].payload.config;
    assert.equal(config.mode, "all");
    assert.equal(config.root_id, "chapter");
    assert.equal(config.filters[0].value, "协议");
    assert.equal(config.order[0].field, "due_at");
    assert.match(ui.panel.textContent, /匹配 2 条/);
    assert.equal(ui.button("显示答案").disabled, true);
  } finally { ui.close(); }
});

test("reveal, grade, complete and context change preserve the collection", async () => {
  const ui = await harness();
  try {
    ui.button("开始新一轮").click();
    await ui.settle();
    assert.equal(ui.panel.querySelector(".study-review-ratings").hidden, true);
    assert.doesNotMatch(ui.panel.textContent, /Answer 0/);
    const before = ui.calls.length;
    ui.panel.refreshContext();
    assert.equal(ui.calls.length, before);
    ui.button("显示答案").click();
    assert.match(ui.panel.textContent, /Answer 0/);
    assert.equal(ui.panel.querySelector(".study-review-ratings").hidden, false);
    ui.button("3 · 良好").click();
    await ui.settle();
    assert.equal(ui.calls.at(-1).payload.position, 0);
    assert.match(ui.panel.textContent, /已完成 1 \/ 2/);
    assert.equal(ui.panel.querySelector(".study-review-ratings").hidden, true);
    ui.button("显示答案").click();
    ui.button("4 · 简单").click();
    await ui.settle();
    assert.match(ui.panel.textContent, /本轮复习已完成/);
    assert.equal(ui.button("显示答案").disabled, true);
  } finally { ui.close(); }
});

test("custom mapping and interval scheduling are submitted without hardcoded card fields", async () => {
  const ui = await harness();
  try {
    ui.change(ui.field("来源视图"), "custom_view");
    ui.change(ui.field("记录关联键（对应回写表唯一键）"), "identity");
    ui.change(ui.field("问题字段"), "question");
    ui.change(ui.field("答案字段"), "answer");
    ui.change(ui.field("评分后的回写策略"), "interval");
    ui.field("评分 1 / 2 / 3 / 4 的间隔天数").value = "0.1, 1, 3, 7";
    ui.button("预览集合").click();
    await ui.settle();
    const config = ui.calls[0].payload.config;
    assert.equal(config.mapping.front, "question");
    assert.equal(config.scheduler.table, "custom_schedule");
    assert.equal(config.scheduler.due, "next_review");
    assert.equal(config.scheduler.days[0], 0.1);
    assert.equal(config.order.length, 0);
  } finally { ui.close(); }
});

test("named configurations can be saved, loaded and removed", async () => {
  const ui = await harness();
  try {
    ui.field("方案名称").value = "全章复习";
    ui.change(ui.field("集合模式"), "all");
    ui.button("保存方案").click();
    ui.change(ui.field("集合模式"), "due");
    ui.change(ui.field("已保存的复习方案"), "user:全章复习");
    assert.equal(ui.field("集合模式").value, "all");
    ui.button("删除方案").click();
    assert.equal(ui.field("已保存的复习方案").options.length, 3);
  } finally { ui.close(); }
});

test("built-in profiles are available without storage and cannot be deleted or overwritten", async () => {
  const ui = await harness();
  try {
    const picker = ui.field("已保存的复习方案");
    assert.equal(picker.querySelector('optgroup[label="内置方案"]').children.length, 2);
    ui.change(picker, "builtin:chapters");
    assert.equal(ui.field("来源视图").value, "v_study_node_cards");
    assert.equal(ui.field("集合模式").value, "all");
    assert.equal(ui.field("本轮最多记录数（1–5000）").value, "5000");
    assert.equal(ui.button("删除方案").disabled, true);
    ui.button("+ 筛选条件").click();
    ui.change(ui.field("节点范围（含全部后代）"), "chapter");
    ui.change(picker, "builtin:due");
    assert.equal(ui.field("来源视图").value, "v_study_due_cards");
    assert.equal(ui.field("集合模式").value, "due");
    assert.equal(ui.field("节点范围（含全部后代）").value, "");
    assert.equal(ui.field("筛选字段"), null);
    assert.equal(ui.field("排序字段").value, "due_at");
    ui.field("方案名称").value = "今日到期";
    ui.change(ui.field("集合模式"), "all");
    ui.button("保存方案").click();
    assert.equal(picker.value, "user:今日到期");
    ui.change(picker, "builtin:due");
    assert.equal(ui.field("集合模式").value, "due");
    ui.button("删除方案").click();
    assert.equal(picker.querySelector('optgroup[label="内置方案"]').children.length, 2);
    assert.equal(ui.calls.length, 0);
  } finally { ui.close(); }
});

test("existing saved profiles remain visible alongside built-ins", async () => {
  const ui = await harness({ storage: { "study.review.profiles.v1": { "旧方案": defaultConfig } } });
  try {
    ui.change(ui.field("已保存的复习方案"), "user:旧方案");
    assert.equal(ui.field("集合模式").value, "all");
    assert.equal(ui.field("方案名称").value, "旧方案");
    assert.equal(ui.button("删除方案").disabled, false);
  } finally { ui.close(); }
});

test("reload resumes position and restores saved field mapping", async () => {
  const ui = await harness({ storage: { "study.review.session.v1": "session-one" }, resume: session(defaultConfig, 1) });
  try {
    assert.match(ui.panel.textContent, /已完成 1 \/ 2/);
    assert.match(ui.panel.textContent, /Question 1/);
    assert.equal(ui.field("集合模式").value, "all");
    assert.equal(ui.panel.querySelector("details").open, false);
  } finally { ui.close(); }
});

test("grade errors retain the card and allow retry; double clicks are locked", async () => {
  let rejectRequest;
  const ui = await harness({
    storage: { "study.review.session.v1": "session-one" },
    post: () => new Promise((resolve, reject) => { rejectRequest = reject; }),
  });
  try {
    ui.button("显示答案").click();
    ui.button("3 · 良好").click();
    ui.button("3 · 良好").click();
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.button("开始新一轮").disabled, true);
    rejectRequest(new Error("network unavailable"));
    await ui.settle();
    assert.match(ui.panel.textContent, /操作失败/);
    assert.match(ui.panel.textContent, /Question 0/);
    assert.equal(ui.button("3 · 良好").disabled, false);
  } finally { ui.close(); }
});
