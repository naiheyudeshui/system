import { attachMarkdownToggle } from "./studyMarkdown.mjs";

const STORAGE = "study.review.config.v1";
const SESSION = "study.review.session.v1";
const PROFILES = "study.review.profiles.v1";
const BUILTIN_PROFILES = [
  { id: "chapters", name: "章节卡片", view: "v_study_node_cards", mode: "all", order: "node_title" },
  { id: "due", name: "今日到期", view: "v_study_due_cards", mode: "due", order: "due_at" },
];

function readSaved(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (tag === "button") node.type = "button";
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function options(select, values, selected, optional = false) {
  select.replaceChildren();
  if (optional) select.append(new Option("不设置", ""));
  for (const value of values) {
    select.append(new Option(typeof value === "string" ? value : value.label, typeof value === "string" ? value : value.value));
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

export async function renderReviewTablePanel(panel, { api, postApi, getCurrentView }) {
  panel.classList.add("study-review-panel");
  const title = element("h3", "通用表格复习");
  const intro = element("p", "选择数据视图和问答字段，定义本轮集合，再按评分回写复习时间。", "action-hint");
  const message = element("p", "正在读取视图与字段…", "study-plugin-message action-hint");
  panel.replaceChildren(title, intro, message);
  let catalog;
  try { catalog = await api("/api/study/review/catalog"); } catch (error) {
    message.textContent = `加载失败：${error.message}`;
    return;
  }
  let state = null;
  let busy = false;
  let revealed = false;
  let startedAt = Date.now();
  const settings = element("details", null, "study-review-settings");
  settings.open = true;
  settings.append(element("summary", "复习方案 · 数据源 / 集合 / 回写"));
  const form = element("fieldset", null, "study-review-config");
  settings.append(form);
  const fields = {};
  const addField = (name, label, tag = "select") => {
    const wrapper = element("label", null, "study-review-field");
    wrapper.append(element("span", label));
    const input = element(tag);
    input.setAttribute("aria-label", label);
    wrapper.append(input);
    form.append(wrapper);
    fields[name] = input;
    return input;
  };
  const profileBar = element("div", null, "study-review-config-wide study-review-actions");
  const profiles = element("select");
  profiles.setAttribute("aria-label", "已保存的复习方案");
  const profileName = element("input");
  profileName.placeholder = "方案名称";
  profileName.setAttribute("aria-label", "方案名称");
  const saveProfile = element("button", "保存方案");
  const deleteProfile = element("button", "删除方案");
  const profileLabel = element("label", "选择复习方案（内置 / 我的方案）", "study-review-field");
  profileLabel.append(profiles);
  profileBar.append(profileLabel, profileName, saveProfile, deleteProfile);
  form.append(profileBar);
  const view = addField("view", "来源视图");
  options(view, catalog.views.map((entry) => entry.name));
  addField("key", "记录关联键（对应回写表唯一键）");
  addField("front", "问题字段");
  addField("back", "答案字段");
  addField("hint", "提示字段（可选）");
  addField("node", "节点关联字段（可选）");
  const mode = addField("mode", "集合模式");
  options(mode, [{ value: "due", label: "仅到期记录" }, { value: "all", label: "全部匹配记录（含未到期）" }]);
  const search = addField("search", "搜索学习节点（标题或路径）", "input");
  const root = addField("root", "节点范围（含全部后代）");
  const byId = new Map(catalog.nodes.map((node) => [node.id, node]));
  const nodePath = (node) => {
    const labels = [node.title];
    const seen = new Set([node.id]);
    let parent = byId.get(node.parent_id);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      labels.unshift(parent.title);
      parent = byId.get(parent.parent_id);
    }
    return labels.join(" / ");
  };
  const nodeOptions = catalog.nodes.map((node) => ({ value: node.id, label: `${nodePath(node)} · ${node.id}` }));
  const filterNodes = () => {
    const selected = root.value;
    const query = search.value.trim().toLocaleLowerCase();
    options(root, nodeOptions.filter((node) => node.value === selected || node.label.toLocaleLowerCase().includes(query)), selected, true);
  };
  search.addEventListener("input", filterNodes);
  filterNodes();
  const limit = addField("limit", "本轮最多记录数（1–5000）", "input");
  limit.type = "number";
  limit.min = "1";
  limit.max = "5000";
  limit.value = "100";
  const random = addField("random", "排列方式");
  options(random, [{ value: "false", label: "按排序规则" }, { value: "true", label: "随机抽取并固定顺序" }]);
  const filters = element("div", null, "study-review-config-wide");
  const sorts = element("div", null, "study-review-config-wide");
  const filterRows = [];
  const sortRows = [];
  const availableFields = () => catalog.views.find((entry) => entry.name === view.value)?.columns || [];
  const addRule = (kind, saved = {}) => {
    const rows = kind === "filter" ? filterRows : sortRows;
    if (rows.length >= (kind === "filter" ? 20 : 5)) return;
    const row = element("div", null, "study-review-rule");
    const field = element("select");
    field.setAttribute("aria-label", kind === "filter" ? "筛选字段" : "排序字段");
    options(field, availableFields(), saved.field);
    const operation = element("select");
    operation.setAttribute("aria-label", kind === "filter" ? "筛选运算" : "排序方向");
    const operations = kind === "filter"
      ? [["eq", "等于"], ["ne", "不等于"], ["contains", "包含"], ["lt", "小于"], ["lte", "小于等于"], ["gt", "大于"], ["gte", "大于等于"], ["empty", "为空"], ["not_empty", "非空"]]
      : [["asc", "升序"], ["desc", "降序"]];
    options(operation, operations.map(([value, label]) => ({ value, label })), saved.op || saved.direction);
    const value = element("input");
    value.setAttribute("aria-label", "筛选值");
    value.value = saved.value ?? "";
    value.hidden = kind !== "filter";
    operation.addEventListener("change", () => { value.disabled = ["empty", "not_empty"].includes(operation.value); });
    value.disabled = ["empty", "not_empty"].includes(operation.value);
    const remove = element("button", "移除");
    const rule = { row, field, operation, value };
    remove.addEventListener("click", () => { row.remove(); rows.splice(rows.indexOf(rule), 1); });
    row.append(field, operation, value, remove);
    rows.push(rule);
    (kind === "filter" ? filters : sorts).append(row);
  };
  const filterHeading = element("div", null, "study-review-config-wide study-review-actions");
  const addFilter = element("button", "+ 筛选条件");
  filterHeading.append(element("span", "条件同时满足（AND）"), addFilter);
  addFilter.addEventListener("click", () => addRule("filter"));
  const sortHeading = element("div", null, "study-review-config-wide study-review-actions");
  const addSort = element("button", "+ 排序规则");
  sortHeading.append(element("span", "排序优先级从上到下；最后按关联键稳定排序"), addSort);
  addSort.addEventListener("click", () => addRule("sort"));
  form.append(filterHeading, filters, sortHeading, sorts);
  const scheduler = addField("scheduler", "评分后的回写策略");
  options(scheduler, [{ value: "fsrs", label: "学习卡 FSRS（共享现有调度）" }, { value: "interval", label: "自定义表 · 评分间隔" }]);
  const target = addField("target", "回写目标表");
  options(target, catalog.targets.map((entry) => entry.table));
  addField("targetKey", "目标唯一键");
  addField("targetDue", "目标复习时间字段");
  const days = addField("days", "评分 1 / 2 / 3 / 4 的间隔天数", "input");
  days.value = "1, 3, 7, 14";
  const targetNote = element("p", null, "action-hint study-review-config-wide");
  form.append(targetNote);
  const syncTarget = (saved = {}) => {
    const definition = catalog.targets.find((entry) => entry.table === target.value);
    options(fields.targetKey, definition?.keys || [], saved.key);
    options(fields.targetDue, definition?.time_columns || [], saved.due);
  };
  const syncScheduler = () => {
    const custom = scheduler.value === "interval";
    for (const name of ["target", "targetKey", "targetDue", "days"]) fields[name].parentElement.hidden = !custom;
    targetNote.textContent = custom
      ? "关联键必须匹配目标表唯一键；仅回写选定时间列，不维护 FSRS。系统表不可作为自定义回写目标。"
      : "按关联键更新 study_card_fsrs.card_id 的完整 FSRS 状态并写复习日志，各模块共享 due_at。";
  };
  target.addEventListener("change", () => syncTarget());
  scheduler.addEventListener("change", syncScheduler);
  const sourceNote = element("p", "全部模式也只能读取视图已有的行；节点全部复习请用 v_study_node_cards，而非到期视图。只纳入有关联调度记录的行；同一关联键去重。", "action-hint study-review-config-wide");
  form.append(sourceNote);
  const resetFields = (mapping = {}) => {
    const names = availableFields();
    for (const role of ["key", "front", "back", "hint", "node"]) {
      const fallback = { key: "card_id", front: "front", back: "back", hint: "hint", node: "node_id" }[role];
      options(fields[role], names, mapping[role] ?? fallback, ["hint", "node"].includes(role));
    }
    filters.replaceChildren();
    sorts.replaceChildren();
    filterRows.length = 0;
    sortRows.length = 0;
  };
  view.addEventListener("change", () => { resetFields(); root.value = ""; });
  const config = () => ({
    view: view.value,
    mapping: Object.fromEntries(["key", "front", "back", "hint", "node"].map((name) => [name, fields[name].value])),
    mode: mode.value, root_id: root.value || null, limit: Number(limit.value), random: random.value === "true",
    filters: filterRows.map((rule) => ({ field: rule.field.value, op: rule.operation.value, value: rule.value.value })),
    order: sortRows.map((rule) => ({ field: rule.field.value, direction: rule.operation.value })),
    scheduler: scheduler.value === "fsrs" ? { kind: "fsrs" } : {
      kind: "interval", table: target.value, key: fields.targetKey.value, due: fields.targetDue.value,
      days: days.value.split(/[,，]/).map((value) => Number(value.trim())),
    },
  });
  const applyConfig = (saved) => {
    if (catalog.views.some((entry) => entry.name === saved.view)) view.value = saved.view;
    resetFields(saved.mapping || {});
    mode.value = saved.mode || "due";
    search.value = "";
    options(root, nodeOptions, saved.root_id || "", true);
    limit.value = saved.limit || 100;
    random.value = String(Boolean(saved.random));
    for (const rule of saved.filters || []) addRule("filter", rule);
    for (const rule of saved.order || []) addRule("sort", rule);
    scheduler.value = saved.scheduler?.kind || "fsrs";
    if (saved.scheduler?.table) target.value = saved.scheduler.table;
    syncTarget(saved.scheduler);
    days.value = (saved.scheduler?.days || [1, 3, 7, 14]).join(", ");
    syncScheduler();
  };
  const refreshProfiles = () => {
    profiles.replaceChildren(new Option("请选择方案", ""));
    const builtins = element("optgroup");
    builtins.label = "内置方案";
    for (const preset of BUILTIN_PROFILES) {
      const option = new Option(preset.name, `builtin:${preset.id}`);
      option.disabled = !catalog.views.some((entry) => entry.name === preset.view);
      builtins.append(option);
    }
    const personal = element("optgroup");
    personal.label = "我的方案（当前浏览器）";
    for (const name of Object.keys(readSaved(PROFILES, {}))) personal.append(new Option(name, `user:${name}`));
    profiles.append(builtins, personal);
    deleteProfile.disabled = true;
  };
  refreshProfiles();
  profiles.addEventListener("change", () => {
    const preset = BUILTIN_PROFILES.find((entry) => profiles.value === `builtin:${entry.id}`);
    deleteProfile.disabled = !profiles.value.startsWith("user:");
    if (preset) {
      const source = catalog.views.find((entry) => entry.name === preset.view);
      if (!source) return;
      applyConfig({
        view: preset.view, mode: preset.mode, limit: 5000, root_id: null,
        mapping: { key: "card_id", front: "front", back: "back", node: "node_id", hint: source.columns.includes("hint") ? "hint" : "" },
        order: [{ field: source.columns.includes(preset.order) ? preset.order : "card_id", direction: "asc" }],
        scheduler: { kind: "fsrs" },
      });
      profileName.value = `${preset.name}（副本）`;
      message.textContent = preset.id === "chapters"
        ? "已加载内置章节卡片：默认全部章节，可搜索并选择节点范围；预览后开始新一轮。"
        : "已加载内置今日到期：包含截至当前已到期的卡片（含逾期），按到期时间排序。";
      return;
    }
    const name = profiles.value.slice(5);
    const saved = profiles.value.startsWith("user:") && readSaved(PROFILES, {})[name];
    if (saved) { applyConfig(saved); profileName.value = name; }
  });
  saveProfile.addEventListener("click", () => {
    const name = profileName.value.trim();
    if (!name) { message.textContent = "请先填写方案名称。"; return; }
    const saved = readSaved(PROFILES, {});
    save(PROFILES, { ...saved, [name]: config() });
    refreshProfiles();
    profiles.value = `user:${name}`;
    deleteProfile.disabled = false;
    message.textContent = "方案已保存在此浏览器。";
  });
  deleteProfile.addEventListener("click", () => {
    if (!profiles.value.startsWith("user:")) return;
    const saved = readSaved(PROFILES, {});
    delete saved[profiles.value.slice(5)];
    save(PROFILES, saved);
    refreshProfiles();
  });
  const currentView = getCurrentView?.()?.name;
  applyConfig(readSaved(STORAGE, {
    view: catalog.views.some((entry) => entry.name === currentView && ["card_id", "front", "back", "due_at"].every((field) => entry.columns.includes(field))) ? currentView : "v_study_node_cards",
    order: [{ field: "due_at", direction: "asc" }],
  }));
  const startActions = element("div", null, "study-review-actions");
  const preview = element("button", "预览集合");
  const start = element("button", "开始新一轮");
  startActions.append(preview, start);
  settings.append(startActions);
  const sample = element("p", null, "action-hint study-review-preview");
  settings.append(sample);
  const meta = element("p", "尚未开始复习", "study-review-meta");
  const cardTitle = element("h4", "配置后预览或开始", "study-review-title");
  const questionTools = element("div", null, "study-review-row-toolbar");
  const question = element("div", null, "study-review-value");
  const answerWrap = element("div");
  const answerTools = element("div", null, "study-review-row-toolbar");
  const answer = element("div", null, "study-review-value");
  const cardHint = element("p", null, "action-hint");
  answerWrap.append(answerTools, answer, cardHint);
  answerWrap.hidden = true;
  const actions = element("div", null, "study-review-actions");
  const reveal = element("button", "显示答案");
  reveal.disabled = true;
  const ratings = element("div", null, "study-review-ratings");
  const ratingButtons = ["重来", "困难", "良好", "简单"].map((label, index) => {
    const button = element("button", `${index + 1} · ${label}`, `study-review-rate rating-${index + 1}`);
    button.dataset.rating = String(index + 1);
    ratings.append(button);
    return button;
  });
  ratings.hidden = true;
  actions.append(reveal, ratings);
  panel.replaceChildren(title, intro, settings, meta, cardTitle, questionTools, question, answerWrap, actions, message);
  let answerToggle;
  const setBusy = (value) => {
    busy = value;
    form.disabled = value;
    start.disabled = value;
    preview.disabled = value;
    reveal.disabled = value || !state?.card;
    for (const button of ratingButtons) button.disabled = value || !revealed;
  };
  const render = (payload) => {
    state = payload;
    revealed = false;
    startedAt = Date.now();
    save(SESSION, payload.session_id);
    const card = payload.card;
    meta.textContent = `${payload.config.view} · 已完成 ${payload.completed} / ${payload.total} · 剩余 ${payload.total - payload.completed}`;
    cardTitle.textContent = card ? `第 ${payload.completed + 1} 张 · 下次复习 ${card.due_at || "未安排"}` : "本轮复习已完成";
    question.replaceChildren();
    answer.replaceChildren();
    questionTools.replaceChildren();
    answerTools.replaceChildren();
    if (card) {
      attachMarkdownToggle(questionTools, question, () => String(card.front ?? "")).refresh();
      answerToggle = attachMarkdownToggle(answerTools, answer, () => String(card.back ?? ""));
      cardHint.textContent = card.hint || "";
    }
    answerWrap.hidden = true;
    ratings.hidden = true;
    reveal.disabled = !card;
    settings.open = !card;
  };
  const run = async (operation) => {
    if (busy) return;
    setBusy(true);
    message.dataset.state = "";
    try { await operation(); } catch (error) {
      message.textContent = `操作失败：${error.message}。原进度保留，可重试。`;
      message.dataset.state = "error";
    } finally { setBusy(false); }
  };
  preview.addEventListener("click", () => run(async () => {
    const result = await postApi("/api/study/review/preview", { config: config() });
    sample.textContent = `匹配 ${result.matched} 条，按上限选取 ${result.selected} 条。示例：${result.sample.map((item) => String(item.front ?? "")).join(" / ") || "无"}`;
    message.textContent = "预览不会修改复习时间；随机模式的正式集合以开始时为准。";
  }));
  start.addEventListener("click", () => run(async () => {
    if (state?.card && !window.confirm("开始新一轮？当前已评分结果保留，未评分记录不会更新。")) return;
    const selected = config();
    const payload = await postApi("/api/study/review/session", { config: selected });
    save(STORAGE, selected);
    render(payload);
    message.textContent = "本轮集合已固定；每条只复习一次，评分才更新其时间。";
  }));
  reveal.addEventListener("click", () => {
    if (!state?.card || busy) return;
    revealed = true;
    answerWrap.hidden = false;
    answerToggle.refresh();
    ratings.hidden = false;
    setBusy(false);
  });
  ratings.addEventListener("click", (event) => {
    const button = event.target.closest("[data-rating]");
    if (!button || !revealed || !state?.card) return;
    void run(async () => {
      const result = await postApi("/api/study/review/session-grade", {
        session_id: state.session_id, position: state.position,
        rating: Number(button.dataset.rating), elapsed_ms: Date.now() - startedAt,
      });
      render(result.next);
      message.textContent = `已更新下次复习时间：${result.graded.due_at}。其他模块重新读取时同步生效。`;
    });
  });
  panel.refreshContext = () => {};
  const previous = readSaved(SESSION, null);
  if (previous) {
    await run(async () => {
      const payload = await api(`/api/study/review/session/${encodeURIComponent(previous)}`);
      render(payload);
      applyConfig(payload.config);
      message.textContent = "已恢复上次集合。切换左侧视图不会改变进行中的复习。";
    });
  } else {
    message.textContent = "请预览并开始；展开配置可保存多个复习方案。";
  }
}
