import { attachInlineCellEditor } from "/3dworkbench/inlineCellEditor.mjs";
import { createPluginIcon, resolvePluginIcon } from "/3dworkbench/icons.mjs";

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  if (tag === "button") element.type = "button";
  return element;
}

// A small, accessible picker used where the native select popup is difficult
// to style consistently across desktop browsers and mobile WebViews.
function makeChoiceDropdown({ label, className = "" } = {}) {
  const root = make("div", null, `study-time-choice ${className}`.trim());
  const trigger = make("button", "", "study-time-choice-trigger");
  trigger.setAttribute("type", "button");
  trigger.setAttribute("aria-label", label || "选择");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = make("div", null, "study-time-choice-menu");
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  root.append(trigger, menu);
  let options = [];
  let selected = "";
  let disabled = false;
  const close = () => {
    menu.hidden = true;
    root.append(menu);
    trigger.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    if (disabled) return;
    // A body-level overlay escapes BSP pane clipping. Only the overlay uses
    // viewport bounds; the timer's presentation remains pane-selected.
    const bounds = trigger.getBoundingClientRect();
    const view = root.ownerDocument.defaultView;
    const viewportHeight = root.ownerDocument.documentElement.clientHeight || view.innerHeight;
    const viewportWidth = root.ownerDocument.documentElement.clientWidth || view.innerWidth;
    const below = viewportHeight - bounds.bottom - 10;
    const above = bounds.top - 10;
    const upwards = below < 140 && above > below;
    Object.assign(menu.style, {
      position: "fixed", margin: "0", top: upwards ? "auto" : `${bounds.bottom + 5}px`,
      bottom: upwards ? `${viewportHeight - bounds.top + 5}px` : "auto",
      left: `${Math.max(5, Math.min(bounds.left, viewportWidth - bounds.width - 5))}px`,
      width: `${Math.min(bounds.width, viewportWidth - 10)}px`,
      maxHeight: `${Math.max(36, Math.min(320, upwards ? above : below))}px`,
      overflowY: "auto",
    });
    root.ownerDocument.body.append(menu);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };
  const render = () => {
    const current = options.find((item) => item.value === selected) || options[0] || { value: "", label: "" };
    if (!options.some((item) => item.value === selected)) selected = current.value;
    trigger.textContent = current.label;
    menu.replaceChildren();
    for (const item of options) {
      const option = make("button", item.label, "study-time-choice-option");
      option.setAttribute("type", "button");
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(item.value === selected));
      option.classList.toggle("active", item.value === selected);
      option.addEventListener("click", () => {
        selected = item.value;
        render();
        close();
        root.dispatchEvent(new root.ownerDocument.defaultView.Event("change", { bubbles: true }));
      });
      menu.append(option);
    }
  };
  trigger.addEventListener("click", () => {
    if (disabled) return;
    if (menu.hidden) open(); else close();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowDown") {
      event.preventDefault(); open();
      menu.querySelector('[aria-selected="true"]')?.focus();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); trigger.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const items = [...menu.querySelectorAll('[role="option"]')];
      const index = items.indexOf(document.activeElement);
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  });
  root._outsideHandler = (event) => { if (!root.contains(event.target) && !menu.contains(event.target)) close(); };
  document.addEventListener("click", root._outsideHandler);
  window.addEventListener("resize", close);
  const onScroll = (event) => { if (!menu.contains(event.target)) close(); };
  document.addEventListener("scroll", onScroll, true);
  root.setOptions = (next) => { options = Array.isArray(next) ? next : []; render(); };
  root.setDisabled = (next) => { disabled = Boolean(next); trigger.disabled = disabled; root.classList.toggle("is-disabled", disabled); if (disabled) close(); };
  root.dispose = () => { close(); menu.remove(); document.removeEventListener("click", root._outsideHandler); document.removeEventListener("scroll", onScroll, true); window.removeEventListener("resize", close); };
  Object.defineProperty(root, "value", { get: () => selected, set: (next) => { selected = next == null ? "" : String(next); render(); } });
  root.setOptions([]);
  return root;
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
  panel.refreshContext = () => { void sync(); };
  panel.dispose = () => { if (interval) window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisibilityChange); };
  await sync();
}

export async function renderTimerPanel(panel, { api, postApi, kind, mode = "compact" }) {
  if (kind === "stopwatch") return renderStopwatchPanel(panel, { api, postApi, mode });
  const pomodoro = kind === "pomodoro";
  const detailed = mode === "full" || mode === "phone";
  panel.classList.add("study-time-panel", `study-time-${kind}`, `study-time-${mode}`);
  const controller = make("section", null, "study-time-controller");
  const icon = make("span", null, "study-time-icon");
  icon.append(createPluginIcon(panel.ownerDocument, resolvePluginIcon({
    id: pomodoro ? "study.pomodoro" : "study.stopwatch", icon: "icon.svg",
    iconPresentation: pomodoro ? {mode:"layered", accent:"icon-accent.svg"} : {mode:"template"},
  })));
  const task = make("input"); task.maxLength = 500; task.placeholder = "所做事宜"; task.className = "study-time-field"; task.setAttribute("aria-label", "所做事宜");
  const project = makeChoiceDropdown({ label: "计时项目", className: "study-time-project-picker" });
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
    const options = [{ label: "无项目", value: "" }];
    for (const item of payload?.projects || []) if (item.status === "active" || item.id === selected) options.push({ label: item.name, value: item.id });
    project.setOptions(options);
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
      state.textContent = "准备开始"; task.disabled = false; project.setDisabled(false); clock.disabled = !pomodoro; start.textContent = "开始"; start.disabled = false; start.hidden = false; pause.hidden = finish.hidden = abandon.hidden = true; progress.style.width = "0%"; renderProjects(); return;
    }
    const used = elapsed(); const planned = Number(current.planned_seconds || 0);
    const shown = pomodoro ? Math.max(0, planned - used) : used;
    clock.value = secondsLabel(shown); state.textContent = current.status === "paused" ? "已暂停" : "进行中";
    task.value = current.task_text; task.disabled = true; project.setDisabled(true); clock.disabled = true; renderProjects();
    start.textContent = "继续"; start.disabled = false; start.hidden = current.status === "running";
    pause.hidden = current.status !== "running"; finish.hidden = abandon.hidden = false;
    progress.style.width = pomodoro && planned ? `${Math.min(100, used / planned * 100)}%` : "100%";
    // Persist natural completion explicitly.  The server also reconciles an
    // expired running session, but this covers a normal foreground countdown
    // immediately and avoids leaving the last task as `running` when the page
    // is closed right after zero.
    if (pomodoro && shown === 0 && current.status === "running" && !syncing) void act("complete");
  };
  const refresh = () => { paint(); renderDashboard(); };
  const sync = async () => { syncing = true; message.textContent = ""; try { acceptPayload(await api(`/api/study/time?kind=${kind}`)); refresh(); } finally { syncing = false; } };
  const act = async (action) => {
    if (syncing) return; syncing = true; message.textContent = "";
    try {
      acceptPayload(await postApi("/api/study/time", { action, kind, task_text: task.value, project_id: project.value || null, planned_seconds: pomodoro ? idleMinutes() * 60 : null }));
      refresh();
    } catch (error) {
      // 归零 complete 与服务端自动结账竞态时，拉一次状态即可恢复空闲界面，避免红字卡死。
      if (action === "complete" && /没有进行中的计时/.test(error.message || "")) {
        try { acceptPayload(await api(`/api/study/time?kind=${kind}`)); refresh(); }
        catch { message.textContent = error.message; }
      } else message.textContent = error.message;
    } finally { syncing = false; }
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
  panel.refreshContext = () => { void sync(); };
  panel.dispose = () => {
    if (interval) window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    project.dispose();
  };
  await sync();
}
