import { attachInlineCellEditor } from "/3dworkbench/inlineCellEditor.mjs";

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  if (tag === "button") element.type = "button";
  return element;
}

function secondsLabel(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const tail = seconds % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(tail).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(tail).padStart(2, "0")}`;
}

async function renderStopwatchPanel(panel, { api, postApi, mode }) {
  panel.classList.add("study-stopwatch-panel", `study-stopwatch-${mode}`);
  const face = make("section", null, "study-stopwatch-face");
  const clock = make("strong", "00:00", "study-stopwatch-clock");
  const status = make("span", "秒表", "study-stopwatch-state");
  const actions = make("div", null, "study-stopwatch-actions");
  const secondary = make("button", "计次", "study-stopwatch-secondary");
  const primary = make("button", "开始", "primary study-stopwatch-primary");
  const message = make("p", null, "study-time-message");
  actions.append(secondary, primary);
  const laps = make("section", null, "study-stopwatch-laps");
  face.append(status, clock, actions, message);
  panel.replaceChildren(face, laps);
  let payload = null; let syncing = false; let interval = null; let snapshotTick = 0;
  const monotonicNow = () => window.performance?.now?.() ?? Date.now();
  const accept = (next) => { payload = next; snapshotTick = monotonicNow(); };
  const elapsed = () => {
    const current = payload?.current;
    if (!current) return 0;
    return Number(current.elapsed_seconds || 0) + (current.status === "running" ? Math.max(0, Math.floor((monotonicNow() - snapshotTick) / 1000)) : 0);
  };
  const paintLaps = () => {
    laps.replaceChildren();
    if (!(payload?.laps || []).length) { laps.hidden = true; return; }
    laps.hidden = false;
    for (const item of payload.laps) {
      const card = make("article");
      card.setAttribute("aria-label", `计次 ${item.lap_number}，本次 ${secondsLabel(item.split_seconds)}，累计 ${secondsLabel(item.total_seconds)}`);
      card.append(make("b", `#${item.lap_number}`), make("span", secondsLabel(item.split_seconds)), make("small", `累计 ${secondsLabel(item.total_seconds)}`));
      laps.append(card);
    }
  };
  const paint = () => {
    const current = payload?.current;
    clock.textContent = secondsLabel(elapsed());
    if (!current) { status.textContent = "秒表"; primary.textContent = "开始"; secondary.textContent = "计次"; secondary.disabled = true; }
    else if (current.status === "running") { status.textContent = "计时中"; primary.textContent = "暂停"; secondary.textContent = "计次"; secondary.disabled = false; }
    else { status.textContent = "已暂停"; primary.textContent = "继续"; secondary.textContent = "重置"; secondary.disabled = false; }
  };
  const refresh = () => { paint(); paintLaps(); };
  const sync = async () => { syncing = true; try { accept(await api("/api/study/time?kind=stopwatch")); refresh(); } finally { syncing = false; } };
  const act = async (action) => {
    if (syncing) return; syncing = true; message.textContent = "";
    try { accept(await postApi("/api/study/time", { kind: "stopwatch", action })); refresh(); }
    catch (error) { message.textContent = error.message; } finally { syncing = false; }
  };
  primary.addEventListener("click", () => void act(!payload?.current ? "start" : payload.current.status === "running" ? "pause" : "resume"));
  secondary.addEventListener("click", () => void act(payload?.current?.status === "paused" ? "reset" : "lap"));
  const onVisibilityChange = () => { if (document.visibilityState === "visible") void sync(); };
  document.addEventListener("visibilitychange", onVisibilityChange);
  interval = window.setInterval(paint, 1000);
  panel.dispose = () => { if (interval) window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange); };
  await sync();
}

export async function renderTimerPanel(panel, { api, postApi, kind, mode = "compact" }) {
  if (kind === "stopwatch") return renderStopwatchPanel(panel, { api, postApi, mode });
  const pomodoro = kind === "pomodoro";
  const detailed = mode === "full" || mode === "phone";
  panel.classList.add("study-time-panel", `study-time-${kind}`, `study-time-${mode}`);
  const controller = make("section", null, "study-time-controller");
  const icon = make("span", pomodoro ? "🍅" : "⏱", "study-time-icon");
  const task = make("input"); task.maxLength = 500; task.placeholder = "所做事宜"; task.setAttribute("aria-label", "所做事宜");
  const project = make("select"); project.setAttribute("aria-label", "计时项目");
  const clock = make("input"); clock.type = "text"; clock.inputMode = "numeric"; clock.value = pomodoro ? "25" : "00:00"; clock.className = "study-time-clock"; clock.setAttribute("aria-label", pomodoro ? "番茄钟分钟数" : "计时时间");
  const state = make("span", "准备开始", "study-time-state");
  const progress = make("i"); const progressTrack = make("span", null, "study-time-progress"); progressTrack.append(progress);
  const actions = make("div", null, "study-time-actions");
  const start = make("button", "开始", "primary");
  const pause = make("button", "暂停");
  const finish = make("button", "完成");
  const abandon = make("button", "放弃", "study-time-abandon");
  actions.append(start, pause, finish, abandon);
  const message = make("span", null, "study-time-message");
  controller.append(icon, task, project, clock, state, progressTrack, actions, message);
  const dashboard = make("section", null, "study-time-dashboard");
  panel.replaceChildren(controller, ...(detailed ? [dashboard] : []));
  let payload = null; let interval = null; let syncing = false; let editingProjectId = null; let snapshotTick = 0; let chartMode = "days"; let durationEdited = false;
  const monotonicNow = () => window.performance?.now?.() ?? Date.now();
  const acceptPayload = (next) => { payload = next; snapshotTick = monotonicNow(); if (pomodoro && !next?.current && !durationEdited) clock.value = String(Math.round(Number(next?.preferences?.planned_seconds || 1500) / 60)); };
  const idleMinutes = () => Math.max(1, Math.min(720, Number.parseInt(clock.value, 10) || Math.round(Number(payload?.preferences?.planned_seconds || 1500) / 60)));
  const renderProjects = () => {
    const selected = payload?.current?.project_id || project.value;
    const option = (label, value) => { const item = make("option", label); item.value = value; return item; };
    project.replaceChildren(option("无项目", ""));
    for (const item of payload?.projects || []) if (item.status === "active" || item.id === selected) project.append(option(item.name, item.id));
    project.value = selected || "";
  };
  const renderDashboard = () => {
    if (!detailed) return;
    const summary = payload?.summary || { today: {}, days: [], projects: [] };
    const cards = make("div", null, "study-time-summary");
    for (const [label, value] of [["今日专注", secondsLabel(summary.today.seconds)], ["已完成", summary.today.completed || 0], ["已放弃", summary.today.abandoned || 0]]) {
      const card = make("article"); card.append(make("span", label), make("strong", String(value))); cards.append(card);
    }
    const chart = make("section", null, "study-time-chart");
    const chartHeader = make("header", null, "study-time-chart-header");
    const chartOptions = [["days", "最近七日总时长"], ["todayHours", "今日时间分布"], ["todayProjects", "今日项目总时长"], ["weekProjects", "七日项目总时长"]];
    const chartPicker = make("div", null, "study-time-chart-picker");
    const chartTrigger = make("button", chartOptions.find(([value]) => value === chartMode)?.[1] || "最近七日总时长", "study-time-chart-trigger");
    chartTrigger.setAttribute("aria-label", "选择统计图表"); chartTrigger.setAttribute("aria-haspopup", "menu"); chartTrigger.setAttribute("aria-expanded", "false");
    const chartMenu = make("div", null, "study-time-chart-menu"); chartMenu.hidden = true; chartMenu.setAttribute("role", "menu");
    for (const [value, label] of chartOptions) {
      const option = make("button", label); option.setAttribute("role", "menuitemradio"); option.setAttribute("aria-checked", String(value === chartMode)); option.classList.toggle("active", value === chartMode);
      option.addEventListener("click", () => { chartMode = value; renderDashboard(); }); chartMenu.append(option);
    }
    chartTrigger.addEventListener("click", () => { chartMenu.hidden = !chartMenu.hidden; chartTrigger.setAttribute("aria-expanded", String(!chartMenu.hidden)); });
    chartPicker.append(chartTrigger, chartMenu); chartHeader.append(chartPicker); chart.append(chartHeader);
    const bars = make("div", null, "study-time-bars");
    const chartItems = summary.charts?.[chartMode] || (chartMode === "days" ? summary.days : []) || [];
    const maximum = Math.max(1, ...chartItems.map((item) => Number(item.seconds || 0)));
    for (const item of chartItems) {
      const label = item.label || String(item.day || "").slice(5);
      const bar = make("span"); bar.title = `${label} · ${secondsLabel(item.seconds)}`; bar.style.setProperty("--bar", `${Math.max(3, Number(item.seconds || 0) / maximum * 100)}%`);
      if (item.color) bar.style.setProperty("--bar-color", item.color);
      bar.append(make("b", secondsLabel(item.seconds), "study-time-bar-value"), make("i"), make("small", label)); bars.append(bar);
    }
    if (!chartItems.length) bars.append(make("p", "暂无统计数据", "study-time-chart-empty"));
    chart.append(bars);
    const projects = make("section", null, "study-time-projects"); projects.append(make("h3", "项目"));
    const projectSeconds = new Map((summary.projects || []).map((item) => [item.id, item.seconds]));
    const form = make("form", null, "study-time-project-form"); const name = make("input"); name.placeholder = "新项目名称"; name.maxLength = 100; const color = make("input"); color.type = "color"; color.value = "#4f7cac"; const add = make("button", "新增项目", "primary"); add.type = "submit"; form.append(name, color, add);
    if (editingProjectId) { const current = (payload?.projects || []).find((item) => item.id === editingProjectId); if (current) { name.value = current.name; color.value = current.color; add.textContent = "保存修改"; } else editingProjectId = null; }
    form.addEventListener("submit", async (event) => { event.preventDefault(); try { await postApi("/api/study/time/project", { action: "save", id: editingProjectId, name: name.value, color: color.value }); editingProjectId = null; await sync(); } catch (error) { message.textContent = error.message; } });
    projects.append(form);
    const list = make("div", null, "study-time-project-list");
    for (const item of payload?.projects || []) { const row = make("article"); const dot = make("i"); dot.style.background = item.color; row.append(dot, make("span", item.name), make("small", secondsLabel(projectSeconds.get(item.id) || 0))); const edit = make("button", "编辑"); edit.addEventListener("click", () => { editingProjectId = item.id; renderDashboard(); dashboard.querySelector(".study-time-project-form input")?.focus(); }); const toggle = make("button", item.status === "active" ? "归档" : "恢复"); toggle.addEventListener("click", async () => { await postApi("/api/study/time/project", { action: item.status === "active" ? "archive" : "restore", id: item.id }); await sync(); }); row.append(edit, toggle); list.append(row); }
    projects.append(list);
    const history = make("section", null, "study-time-history"); history.append(make("h3", "最近记录"));
    const historyWrap = make("div", null, "study-time-history-table-wrap");
    const historyTable = make("table", null, "study-time-history-table");
    const head = make("thead"); const headingRow = make("tr");
    for (const label of ["事宜", "项目", "备注与反思", "状态", "时长", "开始时间"]) headingRow.append(make("th", label));
    head.append(headingRow);
    const body = make("tbody");
    const projectOptions = [{ value: "", label: "无项目" }, ...(payload?.projects || []).map((projectItem) => ({ value: projectItem.id, label: projectItem.name + (projectItem.status === "archived" ? "（已归档）" : "") }))];
    for (const item of payload?.history || []) {
      const row = make("tr", null, "study-time-history-row");
      const saveField = async (field, nextValue) => {
        const next = { task_text: item.task_text || "", project_id: item.project_id || null, note_text: item.note_text || "", [field]: field === "project_id" ? nextValue || null : nextValue };
        acceptPayload(await postApi("/api/study/time", { action: "update", kind, id: item.id, ...next }));
        refresh();
      };
      const taskCell = make("td", item.task_text || "—", "study-time-history-task");
      attachInlineCellEditor(taskCell, () => ({ value: item.task_text || "", editor: "text", maxLength: 500, save: (value) => saveField("task_text", value), onError: (error) => { message.textContent = error.message; } }), { event: "click" });
      const projectCell = make("td", item.project_name || "无项目", "study-time-history-project");
      attachInlineCellEditor(projectCell, () => ({ value: item.project_id || "", editor: "select", options: projectOptions, format: (value) => projectOptions.find((option) => option.value === value)?.label || "无项目", save: (value) => saveField("project_id", value), onError: (error) => { message.textContent = error.message; } }), { event: "click" });
      const noteCell = make("td", item.note_text || "—", "study-time-history-note");
      attachInlineCellEditor(noteCell, () => ({ value: item.note_text || "", editor: "textarea", rows: 3, maxLength: 4000, save: (value) => saveField("note_text", value), onError: (error) => { message.textContent = error.message; } }), { event: "click" });
      row.append(taskCell, projectCell, noteCell, make("td", item.status === "completed" ? "完成" : "放弃"), make("td", secondsLabel(item.elapsed_seconds)), make("td", String(item.started_at || "").replace("T", " ")));
      body.append(row);
    }
    historyTable.append(head, body); historyWrap.append(historyTable);
    if (body.childElementCount) history.append(historyWrap); else history.append(make("p", "暂无最近记录", "study-time-chart-empty"));
    dashboard.replaceChildren(cards, chart, projects, history);
  };
  const elapsed = () => {
    const current = payload?.current;
    if (!current) return 0;
    let result = Number(current.elapsed_seconds || 0);
    if (current.status === "running") result += Math.max(0, Math.floor((monotonicNow() - snapshotTick) / 1000));
    return result;
  };
  const paint = () => {
    const current = payload?.current;
    if (!current) {
      if (pomodoro && document.activeElement !== clock) clock.value = String(idleMinutes());
      else if (!pomodoro) clock.value = "00:00";
      state.textContent = "准备开始"; task.disabled = false; project.disabled = false; clock.disabled = !pomodoro; start.textContent = "开始"; start.disabled = false; start.hidden = false; pause.hidden = finish.hidden = abandon.hidden = true; progress.style.width = "0%"; renderProjects(); return;
    }
    const used = elapsed(); const planned = Number(current.planned_seconds || 0);
    const shown = pomodoro ? Math.max(0, planned - used) : used;
    clock.value = secondsLabel(shown); state.textContent = current.status === "paused" ? "已暂停" : "进行中";
    task.value = current.task_text; task.disabled = true; project.disabled = true; clock.disabled = true; renderProjects();
    start.textContent = "继续"; start.disabled = false; start.hidden = current.status === "running";
    pause.hidden = current.status !== "running"; finish.hidden = abandon.hidden = false;
    progress.style.width = pomodoro && planned ? `${Math.min(100, used / planned * 100)}%` : "100%";
    if (pomodoro && shown === 0 && current.status === "running" && !syncing) void sync();
  };
  const refresh = () => { paint(); renderDashboard(); };
  const sync = async () => { syncing = true; try { acceptPayload(await api(`/api/study/time?kind=${kind}`)); refresh(); } finally { syncing = false; } };
  const act = async (action) => {
    if (syncing) return; syncing = true; message.textContent = "";
    try {
      acceptPayload(await postApi("/api/study/time", { action, kind, task_text: task.value, project_id: project.value || null, planned_seconds: pomodoro ? idleMinutes() * 60 : null }));
      refresh();
    } catch (error) { message.textContent = error.message; } finally { syncing = false; }
  };
  start.addEventListener("click", () => void act(payload?.current?.status === "paused" ? "resume" : "start"));
  pause.addEventListener("click", () => void act("pause"));
  finish.addEventListener("click", () => void act("complete"));
  abandon.addEventListener("click", () => void act("abandon"));
  clock.addEventListener("input", () => { if (!payload?.current && pomodoro) durationEdited = true; });
  clock.addEventListener("blur", () => { if (!payload?.current && pomodoro) clock.value = String(idleMinutes()); });
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void sync();
    else paint();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  interval = window.setInterval(paint, 1000);
  panel.dispose = () => {
    if (interval) window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  await sync();
}
