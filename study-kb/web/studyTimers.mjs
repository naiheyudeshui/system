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

export async function renderTimerPanel(panel, { api, postApi, kind, mode = "compact" }) {
  const pomodoro = kind === "pomodoro";
  const detailed = mode === "full" || mode === "phone";
  panel.classList.add("study-time-panel", `study-time-${kind}`, `study-time-${mode}`);
  const controller = make("section", null, "study-time-controller");
  const icon = make("span", pomodoro ? "🍅" : "⏱", "study-time-icon");
  const task = make("input"); task.maxLength = 500; task.placeholder = "所做事宜"; task.setAttribute("aria-label", "所做事宜");
  const project = make("select"); project.setAttribute("aria-label", "计时项目");
  const minutes = make("input"); minutes.type = "number"; minutes.min = "1"; minutes.max = "720"; minutes.value = "25"; minutes.setAttribute("aria-label", "番茄钟分钟数");
  const clock = make("strong", pomodoro ? "25:00" : "00:00", "study-time-clock");
  const state = make("span", "准备开始", "study-time-state");
  const progress = make("i"); const progressTrack = make("span", null, "study-time-progress"); progressTrack.append(progress);
  const actions = make("div", null, "study-time-actions");
  const start = make("button", "开始", "primary");
  const pause = make("button", "暂停");
  const finish = make("button", "完成");
  const abandon = make("button", "放弃", "study-time-abandon");
  actions.append(start, pause, finish, abandon);
  const message = make("span", null, "study-time-message");
  controller.append(icon, task, project, ...(pomodoro ? [minutes] : []), clock, state, progressTrack, actions, message);
  const dashboard = make("section", null, "study-time-dashboard");
  panel.replaceChildren(controller, ...(detailed ? [dashboard] : []));
  let payload = null; let interval = null; let syncing = false; let editingProjectId = null; let snapshotTick = 0;
  const monotonicNow = () => window.performance?.now?.() ?? Date.now();
  const acceptPayload = (next) => { payload = next; snapshotTick = monotonicNow(); };
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
    const chart = make("section", null, "study-time-chart"); chart.append(make("h3", "最近七日"));
    const bars = make("div", null, "study-time-bars");
    const maximum = Math.max(1, ...(summary.days || []).map((item) => Number(item.seconds || 0)));
    for (const item of summary.days || []) { const bar = make("span"); bar.title = `${item.day} · ${secondsLabel(item.seconds)}`; bar.style.setProperty("--bar", `${Math.max(3, Number(item.seconds || 0) / maximum * 100)}%`); bar.append(make("i"), make("small", item.day.slice(5))); bars.append(bar); }
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
    const tableWrap = make("div", null, "study-time-table-wrap"); const table = make("table"); table.innerHTML = "<thead><tr><th>事宜</th><th>项目</th><th>状态</th><th>时长</th><th>开始</th></tr></thead>"; const body = make("tbody");
    for (const item of payload?.history || []) { const row = make("tr"); for (const value of [item.task_text, item.project_name || "—", item.status === "completed" ? "完成" : "放弃", secondsLabel(item.elapsed_seconds), String(item.started_at || "").replace("T", " ")]) row.append(make("td", value)); body.append(row); } table.append(body); tableWrap.append(table); history.append(tableWrap);
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
      clock.textContent = pomodoro ? secondsLabel(Number(minutes.value || 25) * 60) : "00:00";
      state.textContent = "准备开始"; task.disabled = false; project.disabled = false; minutes.disabled = false; start.textContent = "开始"; start.disabled = false; pause.hidden = finish.hidden = abandon.hidden = true; progress.style.width = "0%"; renderProjects(); return;
    }
    const used = elapsed(); const planned = Number(current.planned_seconds || 0);
    const shown = pomodoro ? Math.max(0, planned - used) : used;
    clock.textContent = secondsLabel(shown); state.textContent = current.status === "paused" ? "已暂停" : "进行中";
    task.value = current.task_text; task.disabled = true; project.disabled = true; minutes.disabled = true; renderProjects();
    start.textContent = current.status === "paused" ? "继续" : "进行中"; start.disabled = current.status === "running";
    pause.hidden = current.status !== "running"; finish.hidden = abandon.hidden = false;
    progress.style.width = pomodoro && planned ? `${Math.min(100, used / planned * 100)}%` : "100%";
    if (pomodoro && shown === 0 && current.status === "running" && !syncing) void sync();
  };
  const refresh = () => { paint(); renderDashboard(); };
  const sync = async () => { syncing = true; try { acceptPayload(await api(`/api/study/time?kind=${kind}`)); refresh(); } finally { syncing = false; } };
  const act = async (action) => {
    if (syncing) return; syncing = true; message.textContent = "";
    try {
      acceptPayload(await postApi("/api/study/time", { action, kind, task_text: task.value, project_id: project.value || null, planned_seconds: pomodoro ? Number(minutes.value || 25) * 60 : null }));
      refresh();
    } catch (error) { message.textContent = error.message; } finally { syncing = false; }
  };
  start.addEventListener("click", () => void act(payload?.current?.status === "paused" ? "resume" : "start"));
  pause.addEventListener("click", () => void act("pause"));
  finish.addEventListener("click", () => void act("complete"));
  abandon.addEventListener("click", () => void act("abandon"));
  minutes.addEventListener("input", paint);
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
