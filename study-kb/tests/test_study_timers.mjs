import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../web/studyTimers.mjs", import.meta.url), "utf8");
const inlineEditorSource = await readFile(new URL("../../3dStudio/3dworkbench/web/inlineCellEditor.mjs", import.meta.url), "utf8");

async function setup() {
  const dom = new JSDOM("<main id='panel'></main>", { url: "http://localhost" });
  let intervalCallback = null;
  let cleared = false;
  dom.window.setInterval = (callback) => { intervalCallback = callback; return 7; };
  dom.window.clearInterval = (id) => { if (id === 7) cleared = true; };
  const context = vm.createContext({ document: dom.window.document, window: dom.window, console });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async (specifier) => {
    assert.equal(specifier, "/3dworkbench/inlineCellEditor.mjs");
    return new vm.SourceTextModule(inlineEditorSource, { context });
  });
  await module.evaluate();
  return { dom, panel: dom.window.document.querySelector("#panel"), timers: module.namespace, tick: () => intervalCallback?.(), cleared: () => cleared };
}

test("stopwatch panel uses lap pause resume and reset controls without task fields", async () => {
  const ui = await setup();
  try {
    let current = null;
    const actions = [];
    let laps = [];
    const state = () => ({ current, laps });
    const postApi = async (_path, payload) => {
      actions.push(payload.action);
      if (payload.action === "start") current = { status: "running", elapsed_seconds: 0, last_resumed_at: new Date().toISOString() };
      if (payload.action === "lap") laps = [{ lap_number: 1, split_seconds: 4, total_seconds: 4 }];
      if (payload.action === "pause") current = { ...current, status: "paused", elapsed_seconds: 4, last_resumed_at: null };
      if (payload.action === "resume") current = { ...current, status: "running", last_resumed_at: new Date().toISOString() };
      if (payload.action === "reset") { current = null; laps = []; }
      return state();
    };
    await ui.timers.renderTimerPanel(ui.panel, { api: async () => state(), postApi, kind: "stopwatch" });
    assert.equal(ui.panel.querySelector("input"), null);
    assert.equal(ui.panel.querySelector("select"), null);
    ui.panel.querySelector(".study-stopwatch-primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.panel.querySelector(".study-stopwatch-state").textContent, "计时中");
    ui.panel.querySelector(".study-stopwatch-secondary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(ui.panel.querySelector(".study-stopwatch-laps").textContent, /#1/);
    assert.equal(ui.panel.firstElementChild.className, "study-stopwatch-face");
    assert.match(ui.panel.querySelector(".study-stopwatch-laps article").getAttribute("aria-label"), /本次 00:04，累计 00:04/);
    ui.panel.querySelector(".study-stopwatch-primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.panel.querySelector(".study-stopwatch-primary").textContent, "继续");
    assert.equal(ui.panel.querySelector(".study-stopwatch-secondary").textContent, "重置");
    ui.panel.querySelector(".study-stopwatch-secondary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(actions, ["start", "lap", "pause", "reset"]);
    assert.equal(ui.panel.querySelector(".study-stopwatch-clock").textContent, "00:00");
    ui.tick();
    ui.panel.dispose();
    assert.equal(ui.cleared(), true);
  } finally { ui.dom.window.close(); }
});

test("pomodoro panel allows an empty task and sends the selected duration", async () => {
  const ui = await setup();
  try {
    const requests = [];
    await ui.timers.renderTimerPanel(ui.panel, {
      api: async () => ({ current: null, history: [], preferences: { planned_seconds: 1800 } }),
      postApi: async (_path, payload) => { requests.push(payload); return { current: { status: "running", task_text: "番茄钟 · 09-30 17:20", elapsed_seconds: 0, planned_seconds: payload.planned_seconds, last_resumed_at: new Date().toISOString() }, history: [], projects: [] }; },
      kind: "pomodoro",
    });
    const duration = ui.panel.querySelector(".study-time-clock");
    assert.equal(duration.value, "30");
    assert.equal(ui.panel.querySelectorAll('[aria-label="番茄钟分钟数"]').length, 1);
    ui.panel.querySelector(".primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0].planned_seconds, 1800);
    assert.equal(requests[0].task_text, "");
    assert.equal(ui.panel.querySelector(".study-time-actions .primary").hidden, true);
    ui.panel.dispose();
  } finally { ui.dom.window.close(); }
});

test("running timer continues from the server snapshot without double counting", async () => {
  const ui = await setup();
  try {
    const oldResume = new Date(Date.now() - 45_000).toISOString();
    await ui.timers.renderTimerPanel(ui.panel, {
      api: async () => ({ current: { status: "running", task_text: "实时计时", elapsed_seconds: 10, last_resumed_at: oldResume }, history: [], projects: [] }),
      postApi: async () => ({}),
      kind: "stopwatch",
    });
    assert.equal(ui.panel.querySelector(".study-stopwatch-clock").textContent, "00:10");
    ui.tick();
    assert.match(ui.panel.querySelector(".study-stopwatch-clock").textContent, /^00:1[01]$/);
    ui.panel.dispose();
  } finally { ui.dom.window.close(); }
});

test("full timer presentation renders statistics projects and history", async () => {
  const ui = await setup();
  try {
    const requests = [];
    const payload = {
      current: null,
      projects: [{ id: "project_1", name: "考试复习", color: "#336699", status: "active" }],
      summary: { today: { seconds: 3600, completed: 2, abandoned: 1 }, days: [{ day: "2026-09-30", seconds: 3600 }], projects: [{ id: "project_1", name: "考试复习", color: "#336699", seconds: 3600 }], charts: { days: [{ day: "2026-09-30", seconds: 3600 }], todayHours: [{ label: "10:00", seconds: 1800 }], todayProjects: [], weekProjects: [] } },
      history: [{ id: "time_1", task_text: "复习需求工程", note_text: "", project_id: "project_1", project_name: "考试复习", status: "completed", elapsed_seconds: 1800, started_at: "2026-09-30T10:00:00+08:00" }],
    };
    await ui.timers.renderTimerPanel(ui.panel, { api: async () => payload, postApi: async (path, body) => { requests.push([path, body]); return payload; }, kind: "pomodoro", mode: "full" });
    assert.match(ui.panel.querySelector(".study-time-summary").textContent, /今日专注.*01:00:00/);
    assert.match(ui.panel.querySelector(".study-time-project-list").textContent, /考试复习.*01:00:00/);
    const historyRow = ui.panel.querySelector(".study-time-history-row");
    assert.equal(historyRow.children[0].textContent, "复习需求工程");
    assert.equal(historyRow.children[1].textContent, "考试复习");
    assert.equal(ui.panel.querySelector(".study-time-history-table-wrap") != null, true);
    assert.match(ui.panel.querySelector(".study-time-bar-value").textContent, /01:00:00/);
    const chartTrigger = ui.panel.querySelector('[aria-label="选择统计图表"]');
    assert.equal(chartTrigger.textContent, "最近七日总时长");
    chartTrigger.click();
    assert.equal(ui.panel.querySelectorAll('.study-time-chart-menu [role="menuitemradio"]').length, 4);
    [...ui.panel.querySelectorAll('.study-time-chart-menu button')].find((button) => button.textContent === "今日时间分布").click();
    assert.equal(ui.panel.querySelector('[aria-label="选择统计图表"]').textContent, "今日时间分布");
    assert.match(ui.panel.querySelector(".study-time-bar-value").textContent, /30:00/);
    const form = ui.panel.querySelector(".study-time-project-form");
    form.querySelector("input").value = "论文写作";
    form.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0][0], "/api/study/time/project");
    assert.equal(requests[0][1].name, "论文写作");
    historyRow.children[0].click();
    const taskEditor = historyRow.children[0].querySelector("input");
    taskEditor.value = "复习架构演化";
    taskEditor.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[1][1].action, "update");
    assert.equal(requests[1][1].task_text, "复习架构演化");
    assert.equal(requests[1][1].project_id, "project_1");
    assert.equal(requests[1][1].note_text, "");
    ui.panel.dispose();
  } finally { ui.dom.window.close(); }
});

test("pomodoro history edits projects and notes inline with cancel and rollback", async () => {
  const ui = await setup();
  try {
    const requests = [];
    let failNext = false;
    const payload = {
      current: null,
      projects: [{ id: "project_1", name: "考试复习", color: "#336699", status: "active" }, { id: "project_2", name: "论文", color: "#663399", status: "active" }],
      summary: { today: {}, days: [], projects: [], charts: { days: [] } },
      history: [{ id: "time_1", task_text: "复习需求工程", note_text: "旧备注", project_id: "project_1", project_name: "考试复习", status: "completed", elapsed_seconds: 1800, started_at: "2026-09-30T10:00:00+08:00" }],
    };
    await ui.timers.renderTimerPanel(ui.panel, {
      api: async () => payload,
      postApi: async (_path, body) => { requests.push(body); if (failNext) throw new Error("保存失败"); return payload; },
      kind: "pomodoro", mode: "full",
    });
    let row = ui.panel.querySelector(".study-time-history-row");
    row.children[1].click();
    const projectEditor = row.children[1].querySelector("select");
    assert.equal(projectEditor.value, "project_1");
    projectEditor.value = "project_2";
    projectEditor.dispatchEvent(new ui.dom.window.Event("blur"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0].action, "update");
    assert.equal(requests[0].kind, "pomodoro");
    assert.equal(requests[0].id, "time_1");
    assert.equal(requests[0].task_text, "复习需求工程");
    assert.equal(requests[0].project_id, "project_2");
    assert.equal(requests[0].note_text, "旧备注");

    row = ui.panel.querySelector(".study-time-history-row");
    row.children[2].click();
    let noteEditor = row.children[2].querySelector("textarea");
    noteEditor.value = "不应保存";
    noteEditor.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(row.children[2].textContent, "旧备注");
    assert.equal(requests.length, 1);

    failNext = true;
    row.children[2].click();
    noteEditor = row.children[2].querySelector("textarea");
    noteEditor.value = "失败备注";
    noteEditor.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(row.children[2].textContent, "旧备注");
    assert.match(ui.panel.querySelector(".study-time-message").textContent, /保存失败/);
    ui.panel.dispose();
  } finally { ui.dom.window.close(); }
});
