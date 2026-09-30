import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../web/studyTimers.mjs", import.meta.url), "utf8");

async function setup() {
  const dom = new JSDOM("<main id='panel'></main>", { url: "http://localhost" });
  let intervalCallback = null;
  let cleared = false;
  dom.window.setInterval = (callback) => { intervalCallback = callback; return 7; };
  dom.window.clearInterval = (id) => { if (id === 7) cleared = true; };
  const context = vm.createContext({ document: dom.window.document, window: dom.window, console });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => {});
  await module.evaluate();
  return { dom, panel: dom.window.document.querySelector("#panel"), timers: module.namespace, tick: () => intervalCallback?.(), cleared: () => cleared };
}

test("stopwatch panel starts, pauses, resumes and disposes its refresh loop", async () => {
  const ui = await setup();
  try {
    let current = null;
    const actions = [];
    const state = () => ({ current, history: [] });
    const postApi = async (_path, payload) => {
      actions.push(payload.action);
      if (payload.action === "start") current = { status: "running", task_text: payload.task_text, elapsed_seconds: 0, last_resumed_at: new Date().toISOString() };
      if (payload.action === "pause") current = { ...current, status: "paused", elapsed_seconds: 4, last_resumed_at: null };
      if (payload.action === "resume") current = { ...current, status: "running", last_resumed_at: new Date().toISOString() };
      return state();
    };
    await ui.timers.renderTimerPanel(ui.panel, { api: async () => state(), postApi, kind: "stopwatch" });
    const input = ui.panel.querySelector("input");
    input.value = "整理卡片";
    ui.panel.querySelector(".primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(input.disabled, true);
    assert.equal(ui.panel.querySelector(".study-time-state").textContent, "进行中");
    ui.panel.querySelectorAll("button")[1].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.panel.querySelector(".primary").textContent, "继续");
    ui.panel.querySelector(".primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(actions, ["start", "pause", "resume"]);
    ui.tick();
    ui.panel.dispose();
    assert.equal(ui.cleared(), true);
  } finally { ui.dom.window.close(); }
});

test("pomodoro panel renders remaining time and requires a task", async () => {
  const ui = await setup();
  try {
    const requests = [];
    await ui.timers.renderTimerPanel(ui.panel, {
      api: async () => ({ current: null, history: [] }),
      postApi: async (_path, payload) => { requests.push(payload); throw new Error("所做事宜必填"); },
      kind: "pomodoro",
    });
    const inputs = ui.panel.querySelectorAll("input");
    inputs[1].value = "30";
    inputs[1].dispatchEvent(new ui.dom.window.Event("input"));
    assert.equal(ui.panel.querySelector(".study-time-clock").textContent, "30:00");
    ui.panel.querySelector(".primary").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0].planned_seconds, 1800);
    assert.match(ui.panel.querySelector(".study-time-message").textContent, /必填/);
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
    assert.equal(ui.panel.querySelector(".study-time-clock").textContent, "00:10");
    ui.tick();
    assert.match(ui.panel.querySelector(".study-time-clock").textContent, /^00:1[01]$/);
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
      summary: { today: { seconds: 3600, completed: 2, abandoned: 1 }, days: [{ day: "2026-09-30", seconds: 3600 }], projects: [{ id: "project_1", name: "考试复习", color: "#336699", seconds: 3600 }] },
      history: [{ task_text: "复习需求工程", project_name: "考试复习", status: "completed", elapsed_seconds: 1800, started_at: "2026-09-30T10:00:00+08:00" }],
    };
    await ui.timers.renderTimerPanel(ui.panel, { api: async () => payload, postApi: async (path, body) => { requests.push([path, body]); return payload; }, kind: "pomodoro", mode: "full" });
    assert.match(ui.panel.querySelector(".study-time-summary").textContent, /今日专注.*01:00:00/);
    assert.match(ui.panel.querySelector(".study-time-project-list").textContent, /考试复习.*01:00:00/);
    assert.match(ui.panel.querySelector(".study-time-history").textContent, /复习需求工程/);
    const form = ui.panel.querySelector(".study-time-project-form");
    form.querySelector("input").value = "论文写作";
    form.dispatchEvent(new ui.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests[0][0], "/api/study/time/project");
    assert.equal(requests[0][1].name, "论文写作");
    ui.panel.dispose();
  } finally { ui.dom.window.close(); }
});
