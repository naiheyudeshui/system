import { addConfigCardControls, confirmWorkbenchAction, openConfigManager } from "/3dworkbench/pluginConfigManager.mjs";
import { createSearchableCombobox } from "/3dworkbench/searchableCombobox.mjs";
import { renderTablePreview } from "/3dworkbench/tablePreview.mjs";
import { renderMarkdown } from "./studyMarkdown.mjs";

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
  preparation.append(previewHeader, make("p", "点击列标题搜索或选择条件后应用；筛选作用于全部候选，不只是当前页。搜索根节点后，只保留该节点及其后面整棵子树里的卡片。", "action-hint"), previewTable, previewSummary);
  const learning = make("section", null, "study-learning-card");
  learning.hidden = true;
  const learningHeader = make("header", null, "study-review-header");
  const meta = make("p");
  const leave = make("button", "返回方案（保留进度）");
  learningHeader.append(meta, leave);
  const front = make("div", null, "study-review-question");
  const backSection = make("section");
  const back = make("div");
  backSection.append(back);
  const reveal = make("button", "显示答案", "study-answer-toggle is-hidden");
  const ratings = make("div", null, "study-review-ratings");
  learning.append(learningHeader, front, reveal, backSection, ratings);
  const message = make("p");
  message.setAttribute("role", "status");
  panel.replaceChildren(home, preparation, learning, message);
  let entries = [], selectedId = "", state = null, busy = false, started = 0, revealed = false;
  let parameterInputs = {}, previewResult = null, previewPayload = null, previewState = null, filtered = [], reviewOptions = [];
  const rootTools = make("div", null, "wb-tree-root-tools");
  const rootPicker = createSearchableCombobox({
    placeholder: "搜索或选择根节点",
    ariaLabel: "搜索或选择根节点",
    className: "wb-tree-root-picker",
    onSelect: (option) => { rootPicker.setValue(option.label); void prepare({ keepRoot: true }); },
    onInput: (value) => { if (!value.trim()) void prepare({ keepRoot: true }); },
  });
  rootTools.append(rootPicker, confirmStart);
  const selectedRootId = () => {
    const value = rootPicker.getValue().trim();
    if (!value) return null;
    const match = reviewOptions.find((option) => option.value === value || option.label === value);
    if (!match) throw new Error("请从列表里选择一个节点，或清空后复习全部");
    return match.value;
  };
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
  const payload = () => {
    const parameters = { ...selected()?.parameters, ...Object.fromEntries(Object.entries(parameterInputs).map(([key, input]) => [key, input.value === "" ? null : input.dataset.valueType === "number" ? Number(input.value) : input.value])) };
    if (Object.prototype.hasOwnProperty.call(selected()?.parameters || {}, "node_id")) parameters.node_id = selectedRootId();
    return { config_id: selectedId, parameters };
  };
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
  const prepare = ({ keepRoot = false } = {}) => run(async () => {
    if (!selected()) throw new Error("请先选择方案");
    const keptFilters = keepRoot ? (previewState?.filters() || []) : [];
    if (!keepRoot) rootPicker.setValue("");
    const request = payload();
    const result = await postApi("/api/study/review/sql-preview", request);
    if (!Array.isArray(result.rows) || !result.preview_hash) throw new Error("服务尚未更新，请重启学习库后刷新");
    previewPayload = request; previewResult = result;
    previewTitle.textContent = `${selected().name} · 预览与筛选`;
    page(preparation);
    previewState = renderTablePreview(previewTable, { rows: result.rows, columns: result.columns, initialFilters: keptFilters, extraActions: [rootTools],
      labels: { card_id: "卡片 ID", question: "问题", answer: "答案", hint: "提示", node_id: "章节 ID", node_path: "章节路径", due_at: "到期时间" },
      onChange: (rows) => {
        filtered = rows;
        previewSummary.textContent = `筛选 ${rows.length} 条 · 本轮最多 ${Math.min(rows.length, result.limit)} 条 · 重复 ${result.duplicates} · 缺少调度 ${result.missing_schedule}。开始后集合固定，评分才更新时间。`;
        refreshControls();
      },
    });
  });
  const startNewRound = async () => {
    let sessionId = state?.session_id;
    if (!sessionId) {
      try { sessionId = JSON.parse(localStorage.getItem("study.review.session.v1")); } catch {}
    }
    // 无历史会话：进入当前方案预览。
    if (!sessionId) return prepare();
    if (busy) return;
    try {
      const previous = await api(`/api/study/review/session/${encodeURIComponent(sessionId)}`);
      if (!previous?.session_id || !(previous.total > 0)) {
        page(home);
        message.textContent = "请先预览方案，再开始一轮学习。";
        return;
      }
      // 当前选中的方案与上次会话不是同一份时，绝不能复用旧批次（否则会一直打开第一章）。
      const previousConfigId = previous.config?.config_id;
      if (!previousConfigId || previousConfigId !== selectedId) {
        message.textContent = "已切换复习方案，请先预览并确认本轮集合。";
        return prepare();
      }
      const confirmed = await confirmWorkbenchAction({
        title: "开始一轮学习？",
        message: "将用同一批卡片创建新会话；旧会话和已有评分保留。",
        confirmLabel: "开始",
        danger: false,
      });
      if (!confirmed) return;
      await run(async () => {
        const created = await postApi("/api/study/review/sql-session", {
          source_session_id: previous.session_id,
        });
        render(created);
        message.textContent = "已开始一轮新的复习。";
      });
    } catch (error) {
      if (/unknown review session|session.*not found|复习会话不存在/i.test(String(error?.message || error))) {
        try { localStorage.removeItem("study.review.session.v1"); } catch {}
        state = null;
        resume.hidden = true;
        message.textContent = "上次复习会话已不在当前手机主库，请重新预览并开始一轮学习。";
        return prepare();
      }
      message.textContent = `操作失败：${error.message}；原进度保留。`;
    }
  };
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
      if (!management.hidden) addConfigCardControls(card, {
        name: entry.name,
        onEdit: () => { void openManager(entry.id); },
        onDelete: () => { void deletePlan(entry); },
      });
      if (entry.id === selectedId) {
        const actions = make("div", null, "wb-config-actions");
        for (const label of ["预览并筛选", "开始一轮学习"]) {
          const button = make("button", label, label === "开始一轮学习" ? "primary" : "study-preview-button");
          button.addEventListener("click", () => { void (label === "开始一轮学习" ? startNewRound() : prepare()); });
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
  const deletePlan = async (entry) => run(async () => {
    const accepted = await confirmWorkbenchAction({
      title: `删除复习方案“${entry.name}”？`,
      message: "只删除这份 SQL 选卡方案。已经开始的复习轮次与评分记录保留，卡片和复习时间不受影响。",
    });
    if (!accepted) return;
    await postApi("/api/plugin/config/delete", { plugin_id: "study.review-table", module_id: "reviews", id: entry.id, revision: entry.revision });
    await reload();
    message.textContent = "复习方案已删除。";
  });
  const render = (next) => {
    state = next; revealed = false; started = Date.now();
    try { localStorage.setItem("study.review.session.v1", JSON.stringify(state.session_id)); } catch {}
    resume.hidden = false;
    page(learning);
    meta.textContent = `${state.config.view} · 已完成 ${state.completed} / ${state.total}`;
    front.replaceChildren(); back.replaceChildren();
    backSection.hidden = true; ratings.hidden = true; reveal.hidden = !state.card;
    reveal.textContent = "显示答案"; reveal.classList.add("is-hidden"); reveal.classList.remove("is-visible");
    if (state.card) {
      renderMarkdown(String(state.card.front ?? ""), front);
      renderMarkdown(String(state.card.back ?? ""), back);
    } else front.textContent = "本轮复习已完成";
    refreshControls();
  };
  settings.addEventListener("click", () => {
    management.hidden = !management.hidden;
    settings.setAttribute("aria-pressed", String(!management.hidden));
    settings.classList.toggle("active", !management.hidden);
    renderCards();
  });
  const openManager = (initialId) => run(() => openConfigManager(panel, { api, postApi, pluginId: "study.review-table", moduleId: "reviews", initialId, onBack: () => { void run(reload); } }));
  edit.addEventListener("click", () => { void openManager(selectedId); });
  add.addEventListener("click", () => { void openManager(""); });
  returnHome.addEventListener("click", () => page(home));
  leave.addEventListener("click", () => page(home));
  resume.addEventListener("click", () => { void run(async () => {
    const id = state?.session_id || JSON.parse(localStorage.getItem("study.review.session.v1"));
    try {
      render(await api(`/api/study/review/session/${encodeURIComponent(id)}`));
    } catch (error) {
      if (/unknown review session|session.*not found|复习会话不存在/i.test(String(error?.message || error))) {
        try { localStorage.removeItem("study.review.session.v1"); } catch {}
        state = null;
        resume.hidden = true;
        message.textContent = "上次复习会话已不在当前手机主库，请重新预览并开始一轮学习。";
        page(home);
        return;
      }
      throw error;
    }
  }); });
  confirmStart.addEventListener("click", () => { void (async () => {
    if (!filtered.length || !previewResult || busy) return;
    if (state?.card) {
      const accepted = await confirmWorkbenchAction({
        title: "开始一轮学习？",
        message: "旧会话保留，未评分记录不会更新时间。",
        confirmLabel: "开始",
        danger: false,
      });
      if (!accepted) return;
    }
    await run(async () => {
      render(await postApi("/api/study/review/sql-session", { ...previewPayload, selected_keys: filtered.map((row) => row.card_id), preview_hash: previewResult.preview_hash }));
      message.textContent = "集合已固定；评分才更新当前记录时间。";
    });
  })(); });
  reveal.addEventListener("click", () => {
    if (!state?.card || busy) return;
    revealed = !revealed; backSection.hidden = !revealed; ratings.hidden = !revealed;
    reveal.textContent = revealed ? "遮蔽答案" : "显示答案";
    reveal.classList.toggle("is-visible", revealed); reveal.classList.toggle("is-hidden", !revealed); refreshControls();
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
  const nodePath = (rows, node) => {
    const byId = new Map(rows.map((row) => [row.node_id, row]));
    const labels = [];
    const seen = new Set();
    let current = node;
    while (current && !seen.has(current.node_id)) {
      seen.add(current.node_id);
      labels.unshift(current.title || current.node_id);
      current = byId.get(current.parent_id);
    }
    return labels.join(" / ");
  };
  await run(async () => {
    await reload();
    try {
      const tree = await api("/api/study/tree?model=knowledge");
      const rows = Array.isArray(tree.rows) ? tree.rows : [];
      reviewOptions = rows.map((row) => ({ value: row.node_id, label: `${row.title || nodePath(rows, row)} · ${row.node_id}` }));
      rootPicker.setOptions(reviewOptions);
    } catch (error) {
      message.textContent = `节点列表加载失败：${error.message}`;
    }
    try { resume.hidden = !JSON.parse(localStorage.getItem("study.review.session.v1")); } catch {}
    message.textContent = "请选择方案。上次进度通过“继续上次复习”进入，不与当前方案混在一起。";
  });
}
