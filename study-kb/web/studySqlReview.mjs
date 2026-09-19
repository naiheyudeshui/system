import { openConfigManager } from "/3dworkbench/pluginConfigManager.mjs";
import { renderTablePreview } from "/3dworkbench/tablePreview.mjs";
import { attachMarkdownToggle } from "./studyMarkdown.mjs";

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  if (tag === "button") node.type = "button";
  return node;
}

export async function renderReviewTablePanel(panel, { api, postApi }) {
  panel.classList.add("study-review-panel", "study-sql-review");
  const home = make("section");
  const header = make("header", null, "study-review-header");
  const settings = make("button", "⚙", "trigger-settings");
  settings.setAttribute("aria-label", "方案设置");
  settings.title = "方案设置";
  const headerActions = make("div", null, "wb-config-actions study-review-header-actions");
  header.append(make("h3", "表格复习"), headerActions);
  const cards = make("div", null, "study-plan-grid");
  const management = make("div", null, "metric-card study-plan-management");
  management.hidden = true;
  const edit = make("button", "编辑已有方案", "metric-card metric-management-card");
  const add = make("button", "新增方案", "metric-card metric-management-card");
  for (const [button, icon, label] of [[edit, "⚙", "编辑已有方案"], [add, "+", "新增方案"]]) {
    const symbol = make("b", icon);
    symbol.setAttribute("aria-hidden", "true");
    button.setAttribute("aria-label", label);
    button.replaceChildren(symbol, make("span", label));
  }
  management.append(edit, add);
  const parameters = make("div", null, "study-review-config");
  const resume = make("button", "继续上次复习");
  resume.hidden = true;
  headerActions.append(resume, settings);
  home.append(header, make("p", "选择方案卡片，再预览、筛选并确认本轮集合。", "action-hint"), cards, parameters);
  const preparation = make("section");
  preparation.hidden = true;
  const previewHeader = make("header", null, "study-review-header");
  const previewTitle = make("h3");
  const returnHome = make("button", "返回方案");
  previewHeader.append(previewTitle, returnHome);
  const previewTable = make("div");
  const previewSummary = make("p");
  const confirmStart = make("button", "开始一轮学习", "primary");
  confirmStart.dataset.action = "confirm-start";
  preparation.append(previewHeader, make("p", "点击列标题搜索或选择条件后应用；筛选作用于全部候选，不只是当前页。", "action-hint"), previewTable, previewSummary, confirmStart);
  const learning = make("section", null, "study-learning-card");
  learning.hidden = true;
  const learningHeader = make("header", null, "study-review-header");
  const meta = make("p");
  const leave = make("button", "返回方案（保留进度）");
  learningHeader.append(meta, leave);
  const frontTools = make("div");
  const front = make("div", null, "study-review-question");
  const backSection = make("section");
  const backTools = make("div");
  const back = make("div");
  backSection.append(backTools, back);
  const reveal = make("button", "显示答案");
  const ratings = make("div", null, "study-review-ratings");
  learning.append(learningHeader, frontTools, front, backSection, reveal, ratings);
  const message = make("p");
  message.setAttribute("role", "status");
  panel.replaceChildren(home, preparation, learning, message);
  let entries = [], selectedId = "", state = null, busy = false, started = 0, revealed = false, backToggle;
  let parameterInputs = {}, previewResult = null, previewPayload = null, filtered = [];
  const selected = () => entries.find((entry) => entry.id === selectedId);
  const page = (target) => {
    for (const section of [home, preparation, learning]) section.hidden = section !== target;
    document.querySelector(".table-filter-popover")?.remove();
    message.textContent = "";
  };
  const renderParameters = () => {
    parameters.replaceChildren(); parameterInputs = {};
    for (const [key, value] of Object.entries(selected()?.parameters || {})) {
      if (key === "node_id") continue;
      const label = make("label", key, "study-review-field");
      const input = make("input");
      input.value = value == null ? "" : String(value);
      input.dataset.valueType = typeof value;
      input.setAttribute("aria-label", key); parameterInputs[key] = input; label.append(input); parameters.append(label);
    }
    parameters.hidden = !parameters.childElementCount;
  };
  const payload = () => ({ config_id: selectedId, parameters: { ...selected()?.parameters, ...Object.fromEntries(Object.entries(parameterInputs).map(([key, input]) => [key, input.value === "" ? null : input.dataset.valueType === "number" ? Number(input.value) : input.value])) } });
  const refreshControls = () => {
    edit.disabled = busy || !selected();
    confirmStart.disabled = busy || !filtered.length || !previewResult;
    reveal.disabled = busy || !state?.card;
    ratings.querySelectorAll("button").forEach((button) => { button.disabled = busy || !revealed; });
  };
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    const controls = [...panel.querySelectorAll("button,input,select")];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try { await operation(); } catch (error) { message.textContent = `操作失败：${error.message}；原进度保留。`; }
    finally {
      busy = false;
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      refreshControls();
    }
  };
  const prepare = () => run(async () => {
    if (!selected()) throw new Error("请先选择方案");
    const request = payload();
    const result = await postApi("/api/study/review/sql-preview", request);
    if (!Array.isArray(result.rows) || !result.preview_hash) throw new Error("服务尚未更新，请重启学习库后刷新");
    previewPayload = request; previewResult = result;
    previewTitle.textContent = `${selected().name} · 预览与筛选`;
    page(preparation);
    renderTablePreview(previewTable, { rows: result.rows, columns: result.columns,
      labels: { card_id: "卡片 ID", question: "问题", answer: "答案", hint: "提示", node_id: "章节 ID", node_path: "章节路径", due_at: "到期时间" },
      onChange: (rows) => {
        filtered = rows;
        previewSummary.textContent = `筛选 ${rows.length} 条 · 本轮最多 ${Math.min(rows.length, result.limit)} 条 · 重复 ${result.duplicates} · 缺少调度 ${result.missing_schedule}。开始后集合固定，评分才更新时间。`;
        refreshControls();
      },
    });
  });
  const renderCards = () => {
    cards.replaceChildren(management);
    for (const entry of entries) {
      const card = make("article", null, `metric-card study-plan-card${entry.id === selectedId ? " is-selected" : ""}`);
      card.dataset.configId = entry.id;
      const choose = make("button", entry.name, "study-plan-select");
      choose.setAttribute("aria-pressed", String(entry.id === selectedId));
      choose.addEventListener("click", () => {
        if (busy || selectedId === entry.id) return;
        selectedId = entry.id; renderParameters(); renderCards(); refreshControls();
      });
      card.append(choose, make("small", "已保存的 SQL 复习方案"));
      if (entry.id === selectedId) {
        const actions = make("div", null, "wb-config-actions");
        for (const label of ["预览并筛选", "开始一轮学习"]) {
          const button = make("button", label, label === "开始一轮学习" ? "primary" : "study-preview-button");
          button.addEventListener("click", () => { void prepare(); });
          actions.append(button);
        }
        card.append(actions);
      }
      cards.append(card);
    }
    if (!entries.length) cards.append(make("p", "暂无方案，点击设置 → 新增方案。"));
  };
  const reload = async () => {
    const previous = selectedId;
    const previousParameters = Object.fromEntries(Object.entries(parameterInputs).map(([key, input]) => [key, input.value]));
    entries = (await api("/api/plugin/configs?plugin_id=study.review-table&module_id=reviews")).configs;
    selectedId = entries.some((entry) => entry.id === previous) ? previous : entries[0]?.id || "";
    renderParameters(); renderCards();
    if (selectedId === previous) for (const [key, value] of Object.entries(previousParameters)) if (parameterInputs[key]) parameterInputs[key].value = value;
    refreshControls();
  };
  const render = (next) => {
    state = next; revealed = false; started = Date.now();
    try { localStorage.setItem("study.review.session.v1", JSON.stringify(state.session_id)); } catch {}
    resume.hidden = false;
    page(learning);
    meta.textContent = `${state.config.view} · 已完成 ${state.completed} / ${state.total}`;
    frontTools.replaceChildren(); backTools.replaceChildren(); front.replaceChildren(); back.replaceChildren();
    backSection.hidden = true; ratings.hidden = true; reveal.hidden = !state.card;
    if (state.card) {
      attachMarkdownToggle(frontTools, front, () => String(state.card.front ?? "")).refresh();
      backToggle = attachMarkdownToggle(backTools, back, () => String(state.card.back ?? ""));
    } else front.textContent = "本轮复习已完成";
    refreshControls();
  };
  settings.addEventListener("click", () => {
    management.hidden = !management.hidden;
    settings.setAttribute("aria-pressed", String(!management.hidden));
    settings.classList.toggle("active", !management.hidden);
  });
  const openManager = (initialId) => run(() => openConfigManager(panel, { api, postApi, pluginId: "study.review-table", moduleId: "reviews", initialId, onBack: () => { void run(reload); } }));
  edit.addEventListener("click", () => { void openManager(selectedId); });
  add.addEventListener("click", () => { void openManager(""); });
  returnHome.addEventListener("click", () => page(home));
  leave.addEventListener("click", () => page(home));
  resume.addEventListener("click", () => { void run(async () => {
    const id = state?.session_id || JSON.parse(localStorage.getItem("study.review.session.v1"));
    render(await api(`/api/study/review/session/${encodeURIComponent(id)}`));
  }); });
  confirmStart.addEventListener("click", () => { void run(async () => {
    if (!filtered.length || !previewResult) return;
    if (state?.card && !window.confirm("开始一轮学习？旧会话保留，未评分记录不会更新时间。")) return;
    render(await postApi("/api/study/review/sql-session", { ...previewPayload, selected_keys: filtered.map((row) => row.card_id), preview_hash: previewResult.preview_hash }));
    message.textContent = "集合已固定；评分才更新当前记录时间。";
  }); });
  reveal.addEventListener("click", () => {
    if (!state?.card || busy) return;
    revealed = true; backSection.hidden = false; ratings.hidden = false; backToggle.refresh(); refreshControls();
  });
  ["重来", "困难", "良好", "简单"].forEach((label, index) => {
    const button = make("button", `${index + 1} · ${label}`);
    button.addEventListener("click", () => {
      if (!revealed || !state?.card) return;
      void run(async () => {
        const result = await postApi("/api/study/review/session-grade", { session_id: state.session_id, position: state.position, rating: index + 1, elapsed_ms: Date.now() - started });
        render(result.next); message.textContent = `下次复习：${result.graded.due_at}`;
      });
    });
    ratings.append(button);
  });
  panel.refreshContext = () => {};
  await run(async () => {
    await reload();
    try { resume.hidden = !JSON.parse(localStorage.getItem("study.review.session.v1")); } catch {}
    message.textContent = "请选择方案。上次进度通过“继续上次复习”进入，不与当前方案混在一起。";
  });
}
