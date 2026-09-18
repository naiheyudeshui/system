import {
  applyIconButtons,
  describeColumnFilter,
  openTableFilterPopover,
  installNavigatorControls,
  renderSidebarSections,
  renderPluginManagerPanel,
  setupLanguageSelect,
  setupEdgeToggle,
  setupSidebarCollapse,
  setupThemeToggle,
  setupWorkbenchSplitters,
  pluginPanelContributions,
  pluginPanelDomId,
  t,
} from "/3dworkbench/workbenchPlatform.mjs";
import { renderNodeTreePanel, renderReviewTablePanel } from "./studyPlugins.mjs";
const layoutStorageKey = "study-workbench-layout";
const sidebarStorageKey = "study-sidebar-collapsed";
const favoritesStorageKey = "study-sidebar-favorites";
const dashboardStorageKey = "study-workbench-dashboard";
const languageStorageKey = "study-language";
const STUDIO_I18N = {
  zh: {
    "app.subtitle": "章节树、知识卡片与 FSRS 复习调度",
    "search.label": "搜索",
    "search.placeholder": "卡片 / 章节 / 主题 / 来源",
    "button.refresh": "刷新",
    "button.clearFilters": "清除筛选",
    "button.addRecord": "新增记录",
    "nav.favorites": "常用",
    "nav.views": "外观视图",
    "nav.tables": "原始基本表",
    "nav.favoriteHint": "从下方可拖拽至此",
    "nav.createView": "+ 新建外观视图",
    "tab.fields": "字段说明",
    "tab.sql": "SQL",
    "tab.plugins": "插件",
    "tab.actions": "操作",
    "tab.command": "CLI",
    "metric.add": "新增指标",
    "metric.editBuiltins": "编辑内置指标",
    "metric.manage": "管理指标",
    "metric.done": "完成指标管理",
  },
  en: {
    "app.subtitle": "Study workbench for chapters, cards, and FSRS review scheduling",
    "search.label": "Search",
    "search.placeholder": "Card / chapter / topic / source",
    "button.refresh": "Refresh",
    "button.clearFilters": "Clear Filters",
    "button.addRecord": "Add Record",
    "nav.favorites": "Favorites",
    "nav.views": "Visual Views",
    "nav.tables": "Base Tables",
    "nav.favoriteHint": "Drag tables or views here",
    "nav.createView": "+ New Visual View",
    "tab.fields": "Fields",
    "tab.sql": "SQL",
    "tab.plugins": "Plugins",
    "tab.actions": "Actions",
    "tab.command": "CLI",
    "metric.add": "Add Metric",
    "metric.editBuiltins": "Edit Built-ins",
    "metric.manage": "Manage Metrics",
    "metric.done": "Finish Metric Management",
  },
};
const DEFAULT_DASHBOARD = { metricsVisible: true, inspectorVisible: true, enabledMetrics: ["due_cards", "active_cards", "study_nodes", "review_today"], customMetrics: [] };

const state = {
  schema: null,
  active: null,
  activeResult: null,
  selectedRow: null,
  query: "",
  theme: localStorage.getItem("study-theme") || "dark",
  sidebarCollapsed: false,
  editLocked: localStorage.getItem("studio-edit-locked") !== "0",
  columnFilters: {},
  recordContract: null,
  dashboard: loadDashboardPreferences(),
  metricDefinitions: [],
  plugins: [],
};

function activeColumnFilters() {
  const name = state.active?.name;
  if (!name) return {};
  if (!state.columnFilters[name]) state.columnFilters[name] = {};
  return state.columnFilters[name];
}

function clearAllColumnFilters() {
  state.columnFilters = {};
}

const BUILTIN_METRICS = [
  { id: "metric-due", label: "今日到期", title: "due_cards", sql: "SELECT COUNT(*) FROM v_study_due_cards" },
  { id: "metric-active", label: "活跃卡片", title: "active_cards", sql: "SELECT COUNT(*) FROM study_card WHERE status = 'active'" },
  { id: "metric-nodes", label: "章节节点", title: "study_nodes", sql: "SELECT COUNT(*) FROM study_node" },
  { id: "metric-review", label: "今日复习", title: "review_today", sql: "SELECT COUNT(*) FROM study_review_log WHERE date(reviewed_at) = date('now', 'localtime')" },
];

function metricDefinitions() {
  if (state.metricDefinitions?.length) {
    return state.metricDefinitions.map((metric) => ({
      id: `metric-${metric.id}`,
      title: metric.id,
      label: metric.label,
      sql: metric.sql,
      format: metric.format || "number",
      builtin: true,
      system: Boolean(metric.system),
    }));
  }
  return BUILTIN_METRICS.map((metric) => ({ ...metric, builtin: true, format: metric.format || "number" }));
}

function metricByTitle(title) {
  return metricDefinitions().find((metric) => metric.title === title) || null;
}
let managingViews = false;
let managingFavorites = false;
let managingMetrics = false;
let latestMetrics = {};
let editingMetric = null;
let viewSearchOpen = false;
let tableSearchOpen = false;
let viewSearch = "";
let tableSearch = "";
let editingViewName = "";
let editingManagedView = false;
let pendingViewDeletion = null;
let viewSqlPreview = null;
let metricEdgeControl = null;
let inspectorEdgeControl = null;
let triggerEditorName = "";
let triggerEditorPreview = null;
let triggerPanelReload = null;

const $ = (selector) => document.querySelector(selector);
const grid = $("#data-grid");

function ensureLanguageSelect() {
  const existing = $("#language-select");
  if (existing) return existing;
  const control = document.createElement("label");
  control.className = "language-control";
  control.innerHTML = '<span data-i18n="language.label">语言</span><select id="language-select"></select>';
  $("#theme-toggle")?.after(control);
  return control.querySelector("select");
}

function applyStudioLanguage() {
  const subtitle = document.querySelector(".brand-block p");
  if (subtitle) subtitle.textContent = t("app.subtitle");
  const searchLabel = document.querySelector(".search-box span");
  if (searchLabel) searchLabel.textContent = t("search.label");
  const globalSearch = $("#global-search");
  if (globalSearch) globalSearch.placeholder = t("search.placeholder");
  const clearFilter = $("#clear-filter");
  if (clearFilter) clearFilter.textContent = t("button.clearFilters");
  const addRecord = $("#add-record");
  if (addRecord) {
    addRecord.title = t("button.addRecord");
    addRecord.setAttribute("aria-label", addRecord.title);
  }
  const refresh = $("#refresh");
  if (refresh) {
    refresh.title = t("button.refresh");
    refresh.setAttribute("aria-label", refresh.title);
  }
  document.querySelector('.tab[data-tab="fields"]')?.replaceChildren(document.createTextNode(t("tab.fields")));
  document.querySelector('.tab[data-tab="sql"]')?.replaceChildren(document.createTextNode(t("tab.sql")));
  document.querySelector('.tab[data-tab="plugins"]')?.replaceChildren(document.createTextNode(t("tab.plugins")));
  document.querySelector('.tab[data-tab="actions"]')?.replaceChildren(document.createTextNode(t("tab.actions")));
  document.querySelector('.tab[data-tab="command"]')?.replaceChildren(document.createTextNode(t("tab.command")));
}

function loadDashboardPreferences() {
  const fallback = { ...DEFAULT_DASHBOARD, metricLabels: {}, builtinMetricSql: {}, pluginOrder: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(dashboardStorageKey) || "{}");
    return { ...fallback, ...saved, customMetrics: saved.customMetrics || [], metricLabels: saved.metricLabels || {}, builtinMetricSql: saved.builtinMetricSql || {}, pluginOrder: saved.pluginOrder || [] };
  }
  catch { return fallback; }
}

function saveDashboardPreferences() {
  localStorage.setItem(dashboardStorageKey, JSON.stringify(state.dashboard));
  document.body.classList.toggle("metrics-hidden", !state.dashboard.metricsVisible);
  document.body.classList.toggle("inspector-hidden", !state.dashboard.inspectorVisible);
  metricEdgeControl?.setCollapsed(!state.dashboard.metricsVisible, { persist: false });
  inspectorEdgeControl?.setCollapsed(!state.dashboard.inspectorVisible, { persist: false });
}

async function api(path, { attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, { headers: { Accept: "application/json" }, signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload.detail || "HTTP " + response.status);
        error.retryable = Boolean(payload.retryable) || response.status === 503 || response.status === 429;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") lastError = new Error("读取数据超过 30 秒，请检查服务或缩小数据范围后重试。");
      else lastError = error;
      if (!lastError.retryable || attempt === attempts) throw lastError;
      setLoadState?.(12, "数据库正在完成上一项操作，正在重试读取…");
      await new Promise((resolve) => window.setTimeout(resolve, 400 * attempt));
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError || new Error("服务未返回可用数据");
}

async function postApi(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
  return data;
}

function objectSummary(item) {
  const parts = [item.name, item.name_zh].filter(Boolean);
  return parts.join(" / ");
}

function addPaneSearch(list, itemClass, value, onChange) {
  const panel = document.createElement("div");
  panel.className = "pane-search";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "搜索此栏目";
  input.value = value;
  const apply = () => {
    const needle = input.value.trim().toLocaleLowerCase();
    for (const item of list.querySelectorAll("." + itemClass)) {
      item.hidden = Boolean(needle) && !item.textContent.toLocaleLowerCase().includes(needle);
    }
  };
  input.addEventListener("input", () => { onChange(input.value); apply(); });
  panel.append(input);
  list.prepend(panel);
  apply();
  requestAnimationFrame(() => input.focus());
}

function renderNav() {
  const objects = state.schema?.objects || [];
  const views = objects.filter((item) => item.kind === "view");
  const tables = objects.filter((item) => item.kind === "table");
  const toItem = (item) => ({
    id: item.name,
    label: item.name_zh || item.name,
    detail: item.name,
    kind: item.kind === "view" ? "VIEW" : "TABLE",
    active: state.active?.name === item.name,
    payload: item,
  });
  renderSidebarSections($("#left-column"), [
    { id: "favorites", title: t("nav.favorites"), className: "favorite-pane", itemClass: "favorite-item", kind: "PIN", items: [], size: "23%", collapsedWhenEmpty: true },
    { id: "views", title: t("nav.views"), className: "derived-pane", itemClass: "view-item", items: views.map(toItem), size: "39%" },
    { id: "tables", title: t("nav.tables"), className: "source-pane", itemClass: "table-item", items: tables.map(toItem), size: "1fr" },
  ], {
    storageKey: favoritesStorageKey,
    onSelect: (_section, item) => selectObject(item.payload),
    onRender: (root) => installNavigatorControls(root, [
      { id: "favorites", search: true, settings: true, hint: t("nav.favoriteHint"), remove: { canRemove: () => true, onRemove: (id) => { localStorage.setItem(favoritesStorageKey, JSON.stringify(JSON.parse(localStorage.getItem(favoritesStorageKey) || "[]").filter((value) => value !== id))); renderNav(); } }, edit: { canEdit: (id) => Boolean(views.find((item) => item.name === id)), onEdit: editStudioView } },
      { id: "views", search: true, settings: true, create: { label: t("nav.createView"), onClick: openViewDialog }, remove: { canRemove: (id) => views.find((item) => item.name === id)?.can_delete === true, onRemove: removeStudioView }, edit: { canEdit: (id) => Boolean(views.find((item) => item.name === id)), onEdit: editStudioView } },
      { id: "tables", search: true },
    ], { storageKey: favoritesStorageKey, rerender: renderNav }),
  });
}

async function removeStudioView(name) {
  try {
    pendingViewDeletion = await postApi("/api/view/delete-preview", { name });
    const dependencies = pendingViewDeletion.dependencies || [];
    $("#view-delete-message").textContent = dependencies.length
      ? `删除“${name}”会使以下 ${dependencies.length} 个引用失效。确认后仍会删除视图。`
      : `将删除“${name}”的视图定义与编辑配置，原始基础表数据不会被删除。`;
    $("#view-delete-dependencies").replaceChildren(...dependencies.map((item) => {
      const row = document.createElement("li");
      row.textContent = `${item.kind}: ${item.name}（${item.reason}）`;
      return row;
    }));
    $("#confirm-view-delete").textContent = dependencies.length ? "仍然删除视图" : "删除视图";
    $("#view-delete-dialog").showModal();
  } catch (error) {
    $("#inspector-command").textContent = error.message;
  }
}

function editStudioView(name) {
  const view = (state.schema?.objects || []).find((item) => item.kind === "view" && item.name === name);
  if (view) openViewEditor(view);
}

function decorateNavigator() {
  const views = (state.schema?.objects || []).filter((item) => item.kind === "view");
  const addControls = (selector, { settings, search }) => {
    const pane = $(selector); const title = pane?.querySelector(".pane-title"); const list = pane?.querySelector(".nav-list");
    if (!pane || !title || !list) return null;
    const controls = document.createElement("div"); controls.className = "pane-controls";
    if (search) { const button = document.createElement("button"); button.className = "pane-control" + (search.active ? " active" : ""); button.type = "button"; button.textContent = "⌕"; button.title = "搜索本栏目"; button.addEventListener("click", search.action); controls.append(button); }
    if (settings) { const button = document.createElement("button"); button.className = "pane-control" + (settings.active ? " active" : ""); button.type = "button"; button.textContent = "⚙"; button.title = "栏目设置"; button.addEventListener("click", settings.action); controls.append(button); }
    title.insertBefore(controls, title.querySelector("span")); return { pane, list };
  };
  const favoritesPane = addControls(".favorite-pane", { settings: { active: managingFavorites, action: () => { managingFavorites = !managingFavorites; renderNav(); } } });
  if (favoritesPane?.pane) {
    favoritesPane.pane.classList.toggle("manage-favorites", managingFavorites);
    if (managingFavorites) { const hint = document.createElement("div"); hint.className = "favorite-drop-hint"; hint.textContent = "从下方可拖拽至此"; favoritesPane.list.prepend(hint); }
  }
  const viewPane = addControls(".derived-pane", { settings: { active: managingViews, action: () => { managingViews = !managingViews; renderNav(); } }, search: { active: viewSearchOpen, action: () => { viewSearchOpen = !viewSearchOpen; renderNav(); } } });
  const tablePane = addControls(".source-pane", { search: { active: tableSearchOpen, action: () => { tableSearchOpen = !tableSearchOpen; renderNav(); } } });
  const pane = viewPane?.pane;
  const list = viewPane?.list;
  if (!pane || !list) return;
  pane.classList.toggle("manage-views", managingViews);
  if (managingViews) {
    const create = document.createElement("button");
    create.type = "button";
    create.className = "create-view-card";
    create.textContent = "+ 新建外观视图";
    create.addEventListener("click", openViewDialog);
    list.prepend(create);
  }
  if (viewSearchOpen) addPaneSearch(list, "view-item", viewSearch, (value) => { viewSearch = value; });
  if (tableSearchOpen && tablePane?.list) addPaneSearch(tablePane.list, "table-item", tableSearch, (value) => { tableSearch = value; });
  for (const item of views.filter((view) => view.name.startsWith("v_user_"))) {
    const button = [...list.querySelectorAll(".nav-item")].find((node) => node.textContent.includes(item.name));
    if (!button) continue;
    button.classList.add("custom-view");
    const remove = document.createElement("button");
    remove.className = "view-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "删除此视图";
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await postApi("/api/view/delete", { name: item.name });
        if (state.active?.name === item.name) state.active = null;
        await refresh();
      } catch (error) {
        $("#inspector-command").textContent = error.message;
      }
    });
    button.append(remove);
  }
}

function renderMetrics(payload) {
  latestMetrics = payload || {};
  const labels = state.dashboard.metricLabels || {};
  const enabled = new Set(state.dashboard.enabledMetrics);
  const items = [
    ...metricDefinitions().filter((metric) => enabled.has(metric.title)).map((metric) => ({ ...metric, label: labels[metric.title] || metric.label, value: payload[metric.title] ?? 0, builtin: true })),
    ...(state.dashboard.customMetrics || []).filter((metric) => metric.enabled).map((metric) => ({ id: `metric-custom-${metric.id}`, label: metric.label, value: payload[`custom_${metric.id}`] ?? 0, title: metric.id, format: metric.format, custom: true })),
  ];
  const strip = $("#metric-strip");
  strip.style.setProperty("--metric-count", String(Math.max(1, items.length + (managingMetrics ? 2 : 0))));
  strip.replaceChildren(...items.map(metricCard));
  if (managingMetrics) {
    const add = document.createElement("button");
    add.type = "button"; add.className = "metric-card metric-management-card"; add.innerHTML = `<b aria-hidden="true">+</b><span>${t("metric.add")}</span>`; add.title = t("metric.add");
    add.addEventListener("click", () => openMetricDialog());
    strip.append(add);
    const editBuiltins = document.createElement("button");
    editBuiltins.type = "button"; editBuiltins.className = "metric-card metric-management-card";
    editBuiltins.innerHTML = `<b aria-hidden="true">⚙</b><span>${t("metric.editBuiltins")}</span>`; editBuiltins.title = t("metric.editBuiltins");
    editBuiltins.addEventListener("click", () => openBuiltinMetricDialog());
    strip.append(editBuiltins);
  }
  const settings = document.createElement("button");
  settings.type = "button"; settings.className = "metric-strip-settings" + (managingMetrics ? " active" : "");
  settings.textContent = "⚙"; settings.title = managingMetrics ? t("metric.done") : t("metric.manage"); settings.setAttribute("aria-label", settings.title);
  settings.addEventListener("click", () => { managingMetrics = !managingMetrics; renderMetrics(latestMetrics); });
  strip.append(settings);
  positionMetricToggle();
}

function positionMetricToggle() {
  const storageKey = "studio-metrics-collapsed:handleOffset";
  if (localStorage.getItem(storageKey)) return;
  window.requestAnimationFrame(() => {
    const strip = $("#metric-strip");
    const card = strip.querySelector(".metric-card:last-of-type");
    const toggle = $("#metric-strip-toggle");
    if (!card || !toggle || document.body.classList.contains("metrics-hidden")) return;
    const inset = 10;
    const left = Math.max(inset, card.offsetLeft + card.offsetWidth - toggle.offsetWidth - inset);
    toggle.style.setProperty("--metric-toggle-left", Math.round(left) + "px");
  });
}

function metricCard(metric) {
  const card = document.createElement("article");
  card.className = "metric-card";
  card.id = metric.id;
  const value = document.createElement("span");
  value.textContent = metric.value;
  const label = document.createElement("small");
  label.textContent = metric.label;
  card.append(value, label);
  if (managingMetrics) {
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "metric-card-edit"; edit.textContent = "⚙"; edit.title = "配置指标";
    edit.addEventListener("click", () => metric.builtin ? openBuiltinMetricDialog(metric.title) : openMetricDialog(metric));
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "metric-card-remove"; remove.textContent = "×"; remove.title = "从指标栏移除";
    remove.addEventListener("click", () => {
      if (metric.builtin) {
        state.dashboard.enabledMetrics = state.dashboard.enabledMetrics.filter((id) => id !== metric.title);
      } else {
        state.dashboard.customMetrics = state.dashboard.customMetrics.filter((item) => item.id !== metric.title);
      }
      void persistDashboard();
    });
    card.append(edit, remove);
  }
  return card;
}

function metricFormSourceChanged() {
  const form = $("#metric-form");
  const custom = form.elements.source.value === "custom";
  $("#metric-custom-fields").hidden = !custom;
  form.elements.id.required = custom; form.elements.sql.required = custom;
  if (!custom) {
    const metric = metricByTitle(form.elements.source.value);
    if (metric && !form.elements.label.value) form.elements.label.value = state.dashboard.metricLabels?.[metric.title] || metric.label;
  }
}

function openMetricDialog(metric = null) {
  editingMetric = metric;
  const form = $("#metric-form");
  form.reset();
  const source = form.elements.source;
  source.replaceChildren();
  if (metric?.builtin) {
    source.append(new Option(metricByTitle(metric.title)?.label || metric.label, metric.title));
    source.value = metric.title; source.disabled = true; form.elements.label.value = metric.label;
  } else if (metric?.custom) {
    source.append(new Option("自定义 SQL 指标", "custom"));
    source.value = "custom"; source.disabled = true;
    form.elements.label.value = metric.label; form.elements.id.value = metric.title; form.elements.id.readOnly = true;
    const saved = state.dashboard.customMetrics.find((item) => item.id === metric.title);
    form.elements.sql.value = saved?.sql || ""; form.elements.format.value = saved?.format || "number";
  } else {
    const hidden = metricDefinitions().filter((item) => !state.dashboard.enabledMetrics.includes(item.title));
    hidden.forEach((item) => source.append(new Option(item.label, item.title)));
    source.append(new Option("自定义 SQL 指标", "custom"));
    source.disabled = false; form.elements.id.readOnly = false;
  }
  $("#metric-dialog-title").textContent = metric ? "配置指标" : "新增指标";
  $("#metric-dialog-message").textContent = "";
  metricFormSourceChanged();
  $("#metric-dialog").showModal();
}

function loadBuiltinMetricForm(title) {
  const definitions = metricDefinitions();
  const metric = metricByTitle(title) || definitions[0];
  const form = $("#builtin-metric-form");
  if (!metric) return;
  form.elements.source.value = metric.title;
  form.elements.label.value = state.dashboard.metricLabels?.[metric.title] || metric.label;
  form.elements.sql.value = state.dashboard.builtinMetricSql?.[metric.title] || metric.sql;
  form.elements.format.value = metric.format || "number";
  form.elements.enabled.checked = state.dashboard.enabledMetrics.includes(metric.title);
}

function openBuiltinMetricDialog(title = "open_orders") {
  const form = $("#builtin-metric-form");
  const source = form.elements.source;
  const definitions = metricDefinitions();
  source.replaceChildren(...definitions.map((metric) => new Option(metric.label, metric.title)));
  loadBuiltinMetricForm(definitions.some((metric) => metric.title === title) ? title : definitions[0]?.title);
  $("#builtin-metric-dialog-message").textContent = "这里编辑的是内置定义，和当前是否展示相互独立。";
  $("#builtin-metric-dialog").showModal();
}

async function persistDashboard() {
  saveDashboardPreferences();
  try {
    const saved = await postApi("/api/dashboard", { metrics_visible: state.dashboard.metricsVisible, inspector_visible: state.dashboard.inspectorVisible, enabled_metrics: state.dashboard.enabledMetrics, custom_metrics: state.dashboard.customMetrics, metric_labels: state.dashboard.metricLabels || {}, builtin_metric_sql: state.dashboard.builtinMetricSql || {}, plugin_order: state.dashboard.pluginOrder || [] });
    state.dashboard = { metricsVisible: saved.metrics_visible, inspectorVisible: saved.inspector_visible, enabledMetrics: saved.enabled_metrics, customMetrics: saved.custom_metrics || [], metricLabels: saved.metric_labels || {}, builtinMetricSql: saved.builtin_metric_sql || {}, pluginOrder: saved.plugin_order || [] };
    saveDashboardPreferences();
    renderMetrics(await api("/api/metrics"));
  } catch (error) {
    $("#inspector-command").textContent = error.message;
    throw error;
  }
}

function openSchemaDocDialog() {
  const item = state.active;
  if (!item) return;
  const form = $("#schema-doc-form");
  form.name_zh.value = item.name_zh || item.name;
  form.description_zh.value = item.description_zh || "";
  form.sort_order.value = Number.isInteger(item.sort_order) ? item.sort_order : 9999;
  $("#schema-doc-dialog").showModal();
}

function renderGrid(result) {
  const head = grid.querySelector("thead");
  const body = grid.querySelector("tbody");
  head.replaceChildren();
  body.replaceChildren();
  const columns = result.columns || [];
  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    cell.className = "table-filterable" + (activeColumnFilters()[column] ? " filter-active" : "");
    cell.tabIndex = 0;
    cell.title = `筛选 ${column}`;
    const openFilter = () => openHeaderFilter(cell, column);
    cell.addEventListener("click", openFilter);
    cell.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFilter(); } });
    headerRow.append(cell);
  }
  head.append(headerRow);
  const rows = applyColumnFilter(result.rows || []);
  document.querySelectorAll(".print-panel, .study-review-panel").forEach((panel) => panel.refreshContext?.());
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = Math.max(columns.length, 1);
    cell.className = "empty";
    cell.textContent = "没有匹配当前筛选的数据";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const payload of rows) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.className = state.selectedRow === payload ? "selected" : "";
    row.addEventListener("click", () => {
      state.selectedRow = payload;
      body.querySelectorAll("tr.selected").forEach((item) => item.classList.remove("selected"));
      row.classList.add("selected");
      renderInspector();
    });
    for (const column of columns) {
      const cell = document.createElement("td");
      const value = payload[column];
      cell.textContent = value === null || value === undefined ? "" : String(value);
      if (typeof value === "string" && (value.length > 36 || value.includes("\n"))) cell.className = "cell-long-text";
      cell.addEventListener("dblclick", () => openCellEditor(cell, payload, column));
      row.append(cell);
    }
    body.append(row);
  }
}

function recordEditContext(row, viewColumn) {
  const contract = objectEditContract();
  const columnTarget = contract.targets?.[viewColumn];
  if (columnTarget) {
    const recordTable = (state.recordContract?.tables || []).find((table) => table.name === columnTarget.table);
    if (!recordTable) return null;
    const key = Object.fromEntries(Object.entries(columnTarget.key || {}).map(([outputColumn, baseName]) => [baseName, row[outputColumn]]));
    return { contract, recordTable, baseColumn: columnTarget.column, key, viewColumn, values: columnTarget.values || {}, crossTable: true };
  }
  const recordTable = (state.recordContract?.tables || []).find((table) => table.name === contract.table);
  if (!recordTable) return null;
  const mapped = contract.columns || Object.fromEntries(recordTable.columns.map((column) => [column.name, column.name]));
  const baseColumn = mapped[viewColumn];
  const keyMap = contract.key || Object.fromEntries(recordTable.primary_key.map((column) => [column, column]));
  const key = Object.fromEntries(Object.entries(keyMap).map(([outputColumn, baseName]) => [baseName, row[outputColumn]]));
  return { contract, recordTable, baseColumn, key, viewColumn, values: (contract.values || {})[viewColumn] || {}, crossTable: false };
}

function showEditBlocked(message) {
  showRecordDialog("当前单元格不可编辑", message);
}

const JOB_STATUS_OPTIONS = ["pending", "in_progress", "blocked", "done", "rework"];
const ORDER_STATUS_OPTIONS = ["open", "done"];

function statusOptionsFor(table, column) {
  if (column !== "status") return null;
  if (table === "job") return JOB_STATUS_OPTIONS;
  if (table === "sales_order") return ORDER_STATUS_OPTIONS;
  return null;
}

function displayChoices(mapping) {
  if (!mapping || typeof mapping !== "object") return null;
  const labels = Object.entries(mapping)
    .filter(([display, stored]) => String(display) !== String(stored))
    .map(([display]) => display);
  if (labels.length) return labels;
  const unique = [...new Set(Object.values(mapping).map((item) => String(item)))];
  return unique.length ? unique : null;
}

async function openCellEditor(cell, row, viewColumn) {
  if (cell.classList.contains("cell-editing")) return;
  if (state.editLocked) {
    showEditBlocked("当前处于锁定模式。请点击表格右上角的锁图标，解锁后再修改单元格。");
    return;
  }
  const context = recordEditContext(row, viewColumn);
  if (!context?.contract.operations?.includes("update") || !context.baseColumn || context.recordTable.primary_key.includes(context.baseColumn)) {
    showEditBlocked("该字段没有可写入原始表的有效映射，因此只能查看，不能修改。");
    return;
  }
  const column = context.recordTable.columns.find((item) => item.name === context.baseColumn);
  const original = row[viewColumn] == null ? "" : String(row[viewColumn]);
  const mappedChoices = displayChoices(context.values);
  const statusOptions = mappedChoices || statusOptionsFor(context.contract.table, context.baseColumn);
  const numeric = /int|real|float|double|numeric|decimal/i.test(column?.type || "");
  const input = statusOptions
    ? document.createElement("select")
    : numeric ? document.createElement("input") : document.createElement("textarea");
  input.className = "cell-editor";
  if (statusOptions) {
    for (const option of statusOptions) {
      input.append(new Option(option, option));
    }
    input.value = statusOptions.includes(original) ? original : "";
  } else {
    if (numeric) input.type = "number";
    else { input.rows = 2; input.wrap = "soft"; }
    input.value = original;
    if (numeric) input.step = "any";
  }
  cell.classList.add("cell-editing");
  cell.replaceChildren(input);
  input.focus();
  if (input.select) input.select();
  let finished = false;
  const cancel = () => { if (finished) return; finished = true; cell.classList.remove("cell-editing"); cell.textContent = original; };
  const commit = async () => {
    if (finished) return;
    const next = input.value;
    if (next === original) { cancel(); return; }
    finished = true; cell.classList.add("cell-saving"); input.disabled = true;
    const request = context.crossTable
      ? { view: state.active.name, row, column: viewColumn, value: next }
      : { operation: "update", table: context.contract.table, key: context.key, values: { [context.baseColumn]: next } };
    try {
      const preview = await postApi(context.crossTable ? "/api/view-cell/preview" : "/api/record/preview", request);
      $("#inspector-command").textContent = JSON.stringify(preview, null, 2);
      await postApi(context.crossTable ? "/api/view-cell/apply" : "/api/record/apply", { ...request, client_id: "studio-workbench", idempotency_key: crypto.randomUUID() });
      await selectObject(state.active);
    } catch (error) {
      cell.classList.remove("cell-editing", "cell-saving"); cell.textContent = original;
      $("#inspector-command").textContent = error.message;
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (input.tagName !== "TEXTAREA" || event.ctrlKey || event.metaKey)) { event.preventDefault(); void commit(); }
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", () => { void commit(); }, { once: true });
}

function rowMatchesFilter(row, filter) {
  if (filter.kind === "choices") {
    return !filter.values?.length || filter.values.includes(String(row[filter.column] ?? ""));
  }
  if (filter.kind === "range") {
    const value = Number(row[filter.column]);
    return Number.isFinite(value) && (filter.min === "" || value >= Number(filter.min)) && (filter.max === "" || value <= Number(filter.max));
  }
  return !filter.value || String(row[filter.column] ?? "").toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
}

function applyColumnFilter(rows) {
  const filters = Object.values(activeColumnFilters());
  return filters.length ? rows.filter((row) => filters.every((filter) => rowMatchesFilter(row, filter))) : rows;
}

function hasFilterValue(filter) {
  return Boolean(filter?.value || filter?.values?.length || filter?.min || filter?.max);
}

function openHeaderFilter(anchor, columnName) {
  const descriptor = describeColumnFilter(activeFilterColumns(), state.activeResult?.rows || [], columnName);
  openTableFilterPopover({
    anchor, descriptor, current: activeColumnFilters()[columnName],
    labels: { clear: t("filter.clear"), apply: t("filter.apply"), search: t("filter.search"), minimum: t("filter.minimum"), maximum: t("filter.maximum") },
    onApply: (filter) => {
      const filters = activeColumnFilters();
      if (hasFilterValue(filter)) filters[columnName] = filter;
      else delete filters[columnName];
      renderGrid(state.activeResult);
    },
    onClear: () => { delete activeColumnFilters()[columnName]; renderGrid(state.activeResult); },
  });
}

function updateEditLock() {
  const button = $("#edit-lock");
  button.textContent = state.editLocked ? "🔒" : "🔓";
  button.title = state.editLocked ? "编辑已锁定" : "编辑已解锁";
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("active", !state.editLocked);
  localStorage.setItem("studio-edit-locked", state.editLocked ? "1" : "0");
}

function objectEditContract() {
  return state.active?.edit_contract || {};
}

function activeFilterColumns() {
  const contract = (state.recordContract?.tables || []).find((table) => table.name === state.active?.name);
  if (!contract) return state.active?.columns || [];
  const schemaColumns = new Map((state.active?.columns || []).map((column) => [column.name, column]));
  return contract.columns.map((column) => ({ ...schemaColumns.get(column.name), ...column }));
}

function showRecordDialog(title, message) {
  $("#record-dialog-title").textContent = title;
  $("#record-dialog-message").textContent = message;
  $("#record-dialog-fields").replaceChildren();
  $("#record-dialog-preview").textContent = "";
  $("#record-preview").hidden = true;
  $("#record-apply").textContent = "Apply";
  $("#record-apply").hidden = true;
  $("#record-dialog").showModal();
}

function isNumericColumn(column) {
  return /int|real|float|double|numeric|decimal/i.test(column?.type || "");
}

function createRecordInput(column) {
  const input = document.createElement("input");
  input.name = column.name;
  input.required = Boolean(column.not_null && column.default === null);
  if (isNumericColumn(column)) { input.type = "number"; input.step = "any"; }
  else input.type = "text";
  return input;
}

async function addForeignKeyChoices(select, column) {
  const foreign = column.foreign_key;
  if (!foreign) return;
  select.replaceChildren(new Option("请选择", ""));
  try {
    const payload = await api(`/api/records?table=${encodeURIComponent(foreign.table)}&limit=500`);
    const rows = payload.rows || payload;
    for (const row of rows) {
      const value = row[foreign.column];
      if (value === null || value === undefined) continue;
      const label = row.name_zh || row.name || row.code || row.title || value;
      select.append(new Option(`${label} (${value})`, String(value)));
    }
  } catch (error) {
    select.append(new Option(`无法读取可选项: ${error.message}`, ""));
  }
}

async function openCreateRecordDialog() {
  const contract = objectEditContract();
  if (state.editLocked) {
    showRecordDialog("当前处于锁定模式", "请点击表格右上角的锁图标，解锁后再新增记录。");
    return;
  }
  if (!contract.table || !contract.operations?.includes("create")) {
    showRecordDialog("当前视图不允许新增", "外观视图仅能修改已映射的原始数据。请切换到允许新增的原始基本表。");
    return;
  }
  const recordTable = (state.recordContract?.tables || []).find((table) => table.name === contract.table);
  if (!recordTable) { showRecordDialog("缺少数据契约", "无法读取当前表的数据定义，请刷新后重试。"); return; }
  $("#record-dialog-title").textContent = `新增 ${contract.table} 记录`;
  $("#record-dialog-message").textContent = "外键字段只能从现有记录中选择。先预览，再确认写入。";
  const root = $("#record-dialog-fields"); root.replaceChildren();
  const fields = recordTable.columns.filter((column) => column.writable && !(recordTable.primary_key.includes(column.name) && /int/i.test(column.type || "")));
  for (const column of fields) {
    const label = document.createElement("label"); label.textContent = column.name;
    const input = column.foreign_key ? document.createElement("select") : createRecordInput(column);
    input.name = column.name; input.required = Boolean(column.not_null && column.default === null);
    label.append(input); root.append(label);
    if (column.foreign_key) void addForeignKeyChoices(input, column);
  }
  const values = () => Object.fromEntries([...root.querySelectorAll("input, select")].filter((input) => input.value !== "").map((input) => [input.name, input.value]));
  const request = () => ({ operation: "create", table: contract.table, values: values() });
  const preview = $("#record-preview"); const apply = $("#record-apply");
  preview.hidden = false; apply.hidden = false; apply.disabled = true; apply.textContent = "确认新增"; $("#record-dialog-preview").textContent = "";
  preview.onclick = async () => {
    try { const result = await postApi("/api/record/preview", request()); $("#record-dialog-preview").textContent = JSON.stringify(result, null, 2); apply.disabled = false; }
    catch (error) { $("#record-dialog-preview").textContent = error.message; apply.disabled = true; }
  };
  apply.onclick = async () => {
    try { await postApi("/api/record/apply", { ...request(), client_id: "studio-workbench", idempotency_key: crypto.randomUUID() }); await refresh(); $("#record-dialog").close(); }
    catch (error) { $("#record-dialog-preview").textContent = error.message; }
  };
  $("#record-dialog").showModal();
}

async function openRowEditor(row) {
  const contract = objectEditContract();
  if (state.editLocked) {
    showRecordDialog("当前处于锁定模式", "请点击表格右上角的锁图标，解锁后再修改记录。");
    return;
  }
  if (!contract.table || !contract.operations?.includes("update")) {
    showRecordDialog("当前视图不可编辑", "该外观视图没有已批准的字段到原始表映射，因此只能查看。");
    return;
  }
  const recordTable = (state.recordContract?.tables || []).find((table) => table.name === contract.table);
  if (!recordTable) {
    showRecordDialog("缺少编辑契约", "无法读取当前表的数据定义，请刷新后重试。");
    return;
  }
  const mapped = contract.columns || Object.fromEntries(recordTable.columns.map((column) => [column.name, column.name]));
  const keyMap = contract.key || Object.fromEntries(recordTable.primary_key.map((column) => [column, column]));
  const key = Object.fromEntries(Object.entries(keyMap).map(([viewColumn, baseColumn]) => [baseColumn, row[viewColumn]]));
  const fields = recordTable.columns.filter((column) => mapped[column.name] || Object.values(mapped).includes(column.name)).filter((column) => !recordTable.primary_key.includes(column.name));
  $("#record-dialog-title").textContent = `Edit ${contract.table}`;
  $("#record-dialog-message").textContent = "Preview changes before applying them.";
  const root = $("#record-dialog-fields"); root.replaceChildren();
  for (const column of fields) {
    const viewColumn = Object.entries(mapped).find(([, base]) => base === column.name)?.[0] || column.name;
    const label = document.createElement("label"); label.textContent = column.name;
    const input = document.createElement("input"); input.name = column.name; input.value = row[viewColumn] ?? "";
    label.append(input); root.append(label);
  }
  const preview = $("#record-preview"); const apply = $("#record-apply");
  preview.hidden = false; apply.hidden = false; apply.disabled = true; $("#record-dialog-preview").textContent = "";
  const payload = () => ({ operation: "update", table: contract.table, key, values: Object.fromEntries([...root.querySelectorAll("input")].map((input) => [input.name, input.value])) });
  preview.onclick = async () => { const result = await postApi("/api/record/preview", payload()); $("#record-dialog-preview").textContent = JSON.stringify(result, null, 2); apply.disabled = false; };
  apply.onclick = async () => { const result = await postApi("/api/record/apply", { ...payload(), client_id: "studio-workbench", idempotency_key: crypto.randomUUID() }); $("#record-dialog-preview").textContent = JSON.stringify(result, null, 2); await refresh(); $("#record-dialog").close(); };
  $("#record-dialog").showModal();
}

function renderInspector() {
  const item = state.active;
  if (!item) return;
  const editDocumentation = document.createElement("button");
  editDocumentation.type = "button";
  editDocumentation.className = "inspector-edit-doc";
  editDocumentation.textContent = "编辑表格说明";
  editDocumentation.addEventListener("click", openSchemaDocDialog);
  const inspectorControls = [editDocumentation];
  if (item.kind === "view" && item.name !== "v_schema_doc") {
    const editView = document.createElement("button");
    editView.type = "button";
    editView.className = "inspector-edit-doc";
    editView.textContent = "编辑外观视图";
    editView.addEventListener("click", () => openViewEditor(item));
    inspectorControls.push(editView);
  }
  const columns = item.columns.filter((column) => !column.hidden);
  const fieldTable = document.createElement("div");
  fieldTable.className = "field-table" + (state.selectedRow ? " has-selected-row" : "");
  fieldTable.setAttribute("role", "table");

  const header = document.createElement("div");
  header.className = "field-table-row field-table-header";
  header.setAttribute("role", "row");
  const appendHeader = (label) => {
    const cell = document.createElement("span");
    cell.className = "field-table-cell";
    cell.setAttribute("role", "columnheader");
    cell.textContent = label;
    header.append(cell);
  };
  appendHeader("字段");
  appendHeader("类别");
  if (state.selectedRow) appendHeader("选中行数据");
  fieldTable.append(header);

  const valueText = (value) => value === null || value === undefined ? "空值" : String(value);
  for (const column of columns) {
    const row = document.createElement("div");
    row.className = "field-table-row";
    row.setAttribute("role", "row");

    const name = document.createElement("strong");
    name.className = "field-table-cell field-name";
    name.setAttribute("role", "cell");
    name.textContent = column.name;

    const category = document.createElement("span");
    category.className = "field-table-cell field-category";
    category.setAttribute("role", "cell");
    category.textContent = `${column.type || "TEXT"}${column.primary_key ? " / PK" : ""}${column.not_null ? " / NOT NULL" : ""}`;

    row.append(name, category);
    if (state.selectedRow) {
      const value = document.createElement("span");
      value.className = "field-table-cell field-value";
      value.setAttribute("role", "cell");
      value.textContent = valueText(state.selectedRow[column.name]);
      row.append(value);
    }
    fieldTable.append(row);
  }
  $("#inspector-fields").replaceChildren(...inspectorControls, fieldTable);
  $("#inspector-sql").textContent = item.sql || `SELECT * FROM ${item.name}`;
  const q = state.query ? ` --q ${JSON.stringify(state.query)}` : "";
  $("#inspector-command").textContent = item.kind === "view"
    ? `python tools/ops.py view query ${item.name}${q} --json`
    : `python tools/ops.py view query ${item.name}${q} --json`;
  renderPluginInspector();
}

function setInspectorMessage(message, state = "") {
  const target = $("#inspector-message");
  if (!target) return;
  target.textContent = message || "";
  target.dataset.state = state;
}

function activateInspectorTab(tabName) {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === tabName));
  document.querySelectorAll(".inspector-panel").forEach((item) => item.classList.remove("active"));
  const panel = $(`#inspector-${CSS.escape(tabName)}`);
  if (panel) panel.classList.add("active");
}

function pluginManagementPanel(plugin) {
  return (plugin.contributes?.panels || []).find((panel) => panel.location === "management" && panel.id) || null;
}

function orderedPlugins() {
  const rank = new Map((state.dashboard.pluginOrder || []).map((id, index) => [id, index]));
  return [...(state.plugins || [])].sort((left, right) => {
    const leftRank = rank.has(left.id) ? rank.get(left.id) : Number.MAX_SAFE_INTEGER;
    const rightRank = rank.has(right.id) ? rank.get(right.id) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
}

async function persistPluginOrder() {
  await persistDashboard();
  renderPluginInspector();
  activateInspectorTab("plugins");
}

async function reloadPlugins({ keepManager = false } = {}) {
  const payload = await api("/api/plugins");
  state.plugins = payload.plugins || [];
  renderPluginInspector();
  if (keepManager) activateInspectorTab("plugins");
}

function renderPluginManager() {
  const root = $("#inspector-plugins");
  if (!root) return;
  renderPluginManagerPanel(root, {
    plugins: orderedPlugins(),
    title: "插件管理",
    subtitle: "拖拽方框可调整上方插件标签的顺序。",
    onToggle: async (plugin) => {
      await postApi("/api/plugin/state", { plugin_id: plugin.id, state: plugin.state === "disabled" ? "enabled" : "disabled" });
      await reloadPlugins({ keepManager: true });
    },
    onReorder: async (ids) => {
      state.dashboard.pluginOrder = ids;
      saveDashboardPreferences();
      try { await persistPluginOrder(); } catch (error) { setInspectorMessage(`保存插件顺序失败：${error.message}`, "error"); }
    },
  });
  const header = root.querySelector(".plugin-manager-header");
  if (!header) return;
  const sync = document.createElement("button");
  sync.type = "button";
  sync.textContent = "同步插件";
  sync.addEventListener("click", async () => {
    sync.disabled = true;
    try {
      await postApi("/api/plugin/sync", {});
      await reloadPlugins({ keepManager: true });
      setInspectorMessage("插件清单已同步。", "success");
    } catch (error) {
      setInspectorMessage(`插件同步失败：${error.message}`, "error");
    } finally { sync.disabled = false; }
  });
  header.append(sync);
}

function openPluginManagement(pluginId, contributionId) {
  const root = $("#inspector-plugins");
  const plugin = (state.plugins || []).find((item) => item.id === pluginId);
  if (!root || !plugin) return;
  activateInspectorTab("plugins");
  const header = document.createElement("div");
  header.className = "plugin-manager-header";
  const heading = document.createElement("div");
  heading.innerHTML = `<h3>${pluginId}</h3><p class="action-hint">${contributionId} 管理页由插件贡献，宿主负责加载和隔离错误。</p>`;
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "返回插件列表";
  back.addEventListener("click", renderPluginManager);
  header.append(heading, back);
  const panel = document.createElement("section");
  panel.className = "plugin-management-page";
  panel.textContent = "插件管理页正在载入…";
  root.replaceChildren(header, panel);
  void loadPluginPanel(panel, pluginId, contributionId, createPluginContext());
}

function createPluginContext() {
  return {
    currentObject: () => state.active,
    currentResult: () => state.activeResult,
    columnFilters: () => ({ ...activeColumnFilters() }),
    filteredRows: () => applyColumnFilter(state.activeResult?.rows || []),
  };
}

function openPrintableTable(context = createPluginContext()) {
  const item = context.currentObject();
  const result = context.currentResult();
  if (!item || !result) {
    setInspectorMessage("当前没有可打印的表格数据。", "error");
    return;
  }
  const columns = result.columns || [];
  const rows = context.filteredRows();
  const filterCount = Object.keys(context.columnFilters()).length;
  const popup = window.open("", "_blank");
  if (!popup) {
    setInspectorMessage("浏览器阻止了打印窗口，请允许本站点打开新窗口后重试。", "error");
    return;
  }
  const title = objectSummary(item) || item.name;
  const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] == null ? "" : String(row[column]))}</td>`).join("")}</tr>`).join("");
  popup.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)} - 打印</title><style>
    @page { margin: 14mm; }
    :root { color-scheme: light; font-family: "Segoe UI", Arial, sans-serif; color: #172033; background: #fff; }
    body { margin: 0; font-size: 11px; }
    header { display: flex; justify-content: space-between; gap: 20px; align-items: end; margin-bottom: 14px; border-bottom: 2px solid #bd7a2d; padding-bottom: 8px; }
    h1 { margin: 0; font-size: 18px; } p { margin: 2px 0 0; color: #64748b; }
    .meta { text-align: right; color: #64748b; white-space: nowrap; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #cbd5e1; padding: 6px 7px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
    th { background: #f1f5f9; color: #334155; font-weight: 700; }
    tr:nth-child(even) td { background: #f8fafc; }
    .empty { padding: 26px; text-align: center; color: #64748b; }
  </style></head><body><header><div><h1>${escapeHtml(title)}</h1><p>3dStudio 当前表格${filterCount ? ` · 已应用 ${filterCount} 个筛选条件` : ""}</p></div><div class="meta">${rows.length} 行<br>${escapeHtml(new Date().toLocaleString())}</div></header><table><thead><tr>${header}</tr></thead><tbody>${body || `<tr><td class="empty" colspan="${Math.max(columns.length, 1)}">当前筛选没有匹配记录</td></tr>`}</tbody></table></body></html>`);
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 220);
}

function renderPrintPanel(panel, context = createPluginContext()) {
  panel.classList.add("print-panel");
  const heading = document.createElement("h3");
  heading.textContent = "打印当前表格";
  const intro = document.createElement("p");
  intro.className = "action-hint";
  intro.textContent = "打印右上方当前对象的可见列和已应用筛选结果，不创建新视图，也不会修改数据库。";
  const summary = document.createElement("div");
  summary.className = "print-summary";
  const print = document.createElement("button");
  print.type = "button";
  print.className = "primary";
  print.textContent = "打印当前表格";
  const updateSummary = () => {
    const currentItem = context.currentObject();
    const currentResult = context.currentResult();
    const currentRows = currentResult ? context.filteredRows() : [];
    summary.textContent = currentItem && currentResult ? `${objectSummary(currentItem)} · ${currentRows.length} 行 · ${currentResult.columns?.length || 0} 列` : "当前没有已加载的表格";
    print.disabled = !currentItem || !currentResult || !(currentResult.columns || []).length;
  };
  updateSummary();
  print.addEventListener("click", () => openPrintableTable(context));
  panel.refreshContext = updateSummary;
  panel.replaceChildren(heading, intro, summary, print);
}

function renderPluginInspector() {
  const tabs = document.querySelector(".inspector-pane .tabs");
  const panels = $("#inspector-plugin-panels");
  if (!tabs || !panels) return;
  tabs.querySelectorAll("[data-plugin-tab]").forEach((tab) => tab.remove());
  panels.replaceChildren();
  renderPluginManager();
  const context = createPluginContext();
  for (const contribution of pluginPanelContributions(orderedPlugins())) {
      const plugin = contribution.plugin;
      const tabId = pluginPanelDomId(plugin.id, contribution.id);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.dataset.tab = tabId;
      tab.dataset.pluginTab = "1";
      tab.textContent = contribution.label || plugin.id;
      tab.title = `${plugin.id} · ${contribution.id}`;
      tabs.append(tab);
      const panel = document.createElement("section");
      panel.id = `inspector-${tabId}`;
      panel.className = "inspector-panel plugin-panel";
      panel.textContent = "插件面板正在载入…";
      panels.append(panel);
      void loadPluginPanel(panel, plugin.id, contribution.id, context);
  }
}

async function loadPluginPanel(panel, pluginId, contributionId, context = createPluginContext()) {
  try {
    if (pluginId === "study.node-tree") {
      await renderNodeTreePanel(panel, { api });
      return;
    }
    if (pluginId === "study.review-table") {
      await renderReviewTablePanel(panel, {
        api,
        postApi,
        getCurrentView: () => state.active,
      });
      return;
    }
    if (pluginId === "official.table-print") {
      renderPrintPanel(panel, context);
      return;
    }
    if (pluginId === "official.sqlite-triggers") {
      await renderTriggerPanel(panel);
      return;
    }
    if (pluginId === "legacy.sqlite-triggers") {
      const payload = await api("/api/triggers");
      const intro = Object.assign(document.createElement("p"), { className: "action-hint", textContent: `当前 ${payload.triggers.length} 个 SQLite 触发器。保存前会先在事务中校验。` });
      const form = document.createElement("form");
      form.className = "plugin-trigger-editor";
      form.innerHTML = `<label>触发器 SQL<textarea name="sql" rows="5" placeholder="CREATE TRIGGER ..."></textarea></label><div class="action-group"><button type="button" data-trigger-preview>校验</button><button type="button" class="primary" data-trigger-save disabled>保存</button><span class="action-hint" data-trigger-message></span></div>`;
      const sql = form.elements.sql;
      const message = form.querySelector("[data-trigger-message]");
      let preview = null;
      form.querySelector("[data-trigger-preview]").addEventListener("click", async () => {
        try {
          preview = await postApi("/api/trigger/preview", { sql: sql.value });
          message.textContent = `校验通过：${preview.name}${preview.protected ? "（系统触发器）" : ""}`;
          form.querySelector("[data-trigger-save]").disabled = false;
        } catch (error) { preview = null; message.textContent = `校验失败：${error.message}`; form.querySelector("[data-trigger-save]").disabled = true; }
      });
      form.querySelector("[data-trigger-save]").addEventListener("click", async () => {
        if (!preview) return;
        try { await postApi("/api/trigger/apply", { sql: sql.value, replace_name: preview.name }); message.textContent = "已保存，触发器列表将在刷新后更新。"; }
        catch (error) { message.textContent = `保存失败：${error.message}`; }
      });
      panel.replaceChildren(intro, form);
      payload.triggers.forEach((trigger) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${trigger.name} · ${trigger.timing} ${trigger.event} · ${trigger.table}${trigger.protected ? " · 系统" : ""}`;
        const code = document.createElement("pre");
        code.className = "code-panel";
        code.textContent = trigger.sql;
        const controls = document.createElement("div");
        controls.className = "action-group";
        const edit = Object.assign(document.createElement("button"), { type: "button", textContent: "载入编辑器" });
        edit.addEventListener("click", () => { sql.value = trigger.sql; preview = null; form.querySelector("[data-trigger-save]").disabled = true; message.textContent = `已载入 ${trigger.name}`; });
        const remove = Object.assign(document.createElement("button"), { type: "button", className: "danger", textContent: "删除" });
        remove.addEventListener("click", async () => { if (!window.confirm(`删除触发器 ${trigger.name}？`)) return; try { await postApi("/api/trigger/delete", { name: trigger.name }); details.remove(); message.textContent = `已删除 ${trigger.name}`; } catch (error) { message.textContent = `删除失败：${error.message}`; } });
        controls.append(edit, remove);
        details.append(summary, controls, code);
        panel.append(details);
      });
      return;
    }
    if (pluginId === "official.order-qr-label") {
      const payload = await api("/api/qr/bindings");
      const intro = Object.assign(document.createElement("p"), { className: "action-hint", textContent: `已绑定 ${payload.bindings.length} 个二维码。选择一个表或视图，再选择具体记录，系统会自动生成绑定键。扫码时读取当前数据。` });
      const form = document.createElement("form");
      form.className = "plugin-qr-editor";
      form.innerHTML = `<div class="qr-picker-grid"><label>数据对象<select name="object"></select></label><label>选择记录<select name="row" disabled><option value="">先选择数据对象</option></select></label></div><div class="qr-selection-summary" data-qr-summary>请选择一个表或视图。</div><label>自动绑定键<code class="qr-key-preview" data-qr-key>{}</code></label><label>二维码标题<input name="title" placeholder="例如：订单流程"></label><div class="qr-form-actions"><button type="submit" class="primary" disabled>生成 SVG 二维码</button><span class="action-hint" data-qr-message></span></div>`;
      const objectSelect = form.elements.object;
      const rowSelect = form.elements.row;
      const submit = form.querySelector("button[type=submit]");
      const summary = form.querySelector("[data-qr-summary]");
      const keyPreview = form.querySelector("[data-qr-key]");
      const message = form.querySelector("[data-qr-message]");
      const titleInput = form.elements.title;
      let objectResult = null;
      let selectedCandidate = null;
      let selectedRow = null;
      const objects = (state.schema?.objects || []).filter((item) => item.kind === "view" || item.kind === "table");
      const grouped = new Map([["view", document.createElement("optgroup")], ["table", document.createElement("optgroup")]]);
      grouped.get("view").label = "视图";
      grouped.get("table").label = "原始表";
      objects.sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)).forEach((item) => {
        const label = item.name_zh ? `${item.name_zh} · ${item.name}` : item.name;
        grouped.get(item.kind).append(new Option(label, item.name));
      });
      for (const group of [grouped.get("view"), grouped.get("table")]) if (group.children.length) objectSelect.append(group);
      const rowLabel = (row, index, candidate) => {
        const displayColumn = ["code", "order_code", "name", "title", "id"].find((column) => row[column] !== null && row[column] !== undefined && row[column] !== "");
        const display = displayColumn ? `${displayColumn}: ${row[displayColumn]}` : `记录 ${index + 1}`;
        const key = candidate.columns.map((column) => `${column}=${row[column]}`).join(", ");
        return `${display} · ${key}`;
      };
      const setPickerMessage = (text, stateName = "") => { message.textContent = text; message.dataset.state = stateName; };
      const renderRows = () => {
        const rows = objectResult?.rows || [];
        const candidates = objectResult?.key_candidates || [];
        selectedCandidate = candidates[0] || null;
        selectedRow = null;
        rowSelect.replaceChildren();
        keyPreview.textContent = "{}";
        summary.textContent = objectResult ? `${objectResult.object?.name_zh || objectResult.object?.name || objectSelect.value} · 已加载 ${rows.length} 条记录` : "请选择一个表或视图。";
        if (!objectResult) { rowSelect.disabled = true; submit.disabled = true; return; }
        if (!selectedCandidate) {
          rowSelect.append(new Option("没有可唯一定位的记录", ""));
          rowSelect.disabled = true;
          submit.disabled = true;
          summary.textContent += "；该对象没有可自动推导的唯一键";
          setPickerMessage("请为该表/视图配置主键或唯一标识列后再生成二维码。", "error");
          return;
        }
        rowSelect.append(new Option("请选择一行记录", ""));
        rows.forEach((row, index) => rowSelect.append(new Option(rowLabel(row, index, selectedCandidate), String(index))));
        rowSelect.disabled = rows.length === 0;
        submit.disabled = rows.length === 0;
        summary.textContent += `；绑定依据：${selectedCandidate.label}（${selectedCandidate.reason}）`;
        setPickerMessage(rows.length ? "选择记录后即可生成 SVG 二维码。" : "该对象当前没有记录。", rows.length ? "" : "error");
      };
      const loadObject = async () => {
        objectResult = null;
        renderRows();
        const name = objectSelect.value;
        if (!name) return;
        objectSelect.disabled = true;
        setPickerMessage("正在加载记录…");
        try {
          objectResult = await api(`/api/object?name=${encodeURIComponent(name)}&limit=300`);
          renderRows();
        } catch (error) {
          summary.textContent = "记录加载失败。";
          setPickerMessage(`加载失败：${error.message}`, "error");
        } finally { objectSelect.disabled = false; }
      };
      objectSelect.addEventListener("change", () => { void loadObject(); });
      rowSelect.addEventListener("change", () => {
        selectedRow = objectResult?.rows?.[Number(rowSelect.value)] || null;
        if (!selectedRow || !selectedCandidate) { keyPreview.textContent = "{}"; submit.disabled = true; return; }
        const key = Object.fromEntries(selectedCandidate.columns.map((column) => [column, selectedRow[column]]));
        keyPreview.textContent = JSON.stringify(key, null, 2);
        if (!titleInput.value.trim()) titleInput.value = selectedRow.code || selectedRow.order_code || `${objectSelect.value} 记录`;
        submit.disabled = false;
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          if (!selectedRow || !selectedCandidate) throw new Error("请先选择可以唯一定位的记录");
          const key = Object.fromEntries(selectedCandidate.columns.map((column) => [column, selectedRow[column]]));
          const result = await postApi("/api/qr/bind", { view: objectSelect.value, key, title: titleInput.value || `${objectSelect.value} 记录` });
          message.textContent = `已生成：${result.qr_url || "SVG 二维码"}`;
          await loadPluginPanel(panel, pluginId, contributionId);
        } catch (error) { message.textContent = `生成失败：${error.message}`; }
      });
      const list = document.createElement("div");
      list.className = "qr-binding-list";
      panel.replaceChildren(intro, form, list);
      payload.bindings.forEach((binding) => {
        const row = document.createElement("article");
        row.className = "field-row";
        row.innerHTML = `<strong>${escapeHtml(binding.title || binding.view_name)}</strong><span>${escapeHtml(binding.view_name)} · <a href="/api/qr/svg?token=${encodeURIComponent(binding.token)}" target="_blank" rel="noreferrer">打开 SVG</a> · <a href="/qr/${encodeURIComponent(binding.token)}" target="_blank" rel="noreferrer">打开视图</a></span>`;
        list.append(row);
      });
      if (!objects.length) setPickerMessage("当前没有可用的表或视图。", "error");
      else { objectSelect.value = objects[0].name; void loadObject(); }
      return;
    }
    panel.textContent = `${pluginId} · ${contributionId}`;
  } catch (error) {
    panel.replaceChildren(Object.assign(document.createElement("p"), { className: "action-hint error", textContent: `插件载入失败：${error.message}` }));
  }
}

async function renderTriggerPanel(panel) {
  panel.classList.add("trigger-panel");
  const payload = await api("/api/triggers");
  let managing = false;
  const render = () => {
    panel.classList.toggle("manage-triggers", managing);
    panel.replaceChildren();
    const header = document.createElement("div");
    header.className = "trigger-panel-header";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = "SQLite \u89e6\u53d1\u5668";
    const hint = document.createElement("p");
    hint.className = "action-hint";
    hint.textContent = managing ? "\u7ba1\u7406\u6a21\u5f0f\uff1a\u53ef\u7f16\u8f91\u6216\u5220\u9664\u89e6\u53d1\u5668" : `\u5f53\u524d ${payload.triggers.length} \u4e2a\uff0c\u70b9\u51fb\u8bbe\u7f6e\u8fdb\u5165\u7ba1\u7406\u6a21\u5f0f`;
    heading.append(title, hint);
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = `trigger-settings${managing ? " active" : ""}`;
    settings.textContent = "\u2699";
    settings.title = managing ? "\u5b8c\u6210\u7ba1\u7406" : "\u7ba1\u7406\u89e6\u53d1\u5668";
    settings.setAttribute("aria-label", settings.title);
    settings.addEventListener("click", () => { managing = !managing; render(); });
    header.append(heading, settings);
    const grid = document.createElement("div");
    grid.className = "trigger-card-grid";
    if (!payload.triggers.length) {
      const empty = document.createElement("div");
      empty.className = "trigger-empty";
      empty.textContent = "\u6682\u65e0 SQLite \u89e6\u53d1\u5668";
      grid.append(empty);
    }
    payload.triggers.forEach((trigger) => {
      const card = document.createElement("article");
      card.className = "trigger-card";
      const name = document.createElement("strong");
      name.textContent = trigger.name;
      name.title = trigger.name;
      const metadata = document.createElement("small");
      metadata.textContent = [trigger.timing, trigger.event, trigger.table, trigger.protected ? "\u7cfb\u7edf" : ""].filter(Boolean).join(" \u00b7 ");
      const description = document.createElement("p");
      description.className = "trigger-card-description";
      description.textContent = trigger.description_zh || "\u6682\u65e0\u8bf4\u660e";
      description.classList.toggle("is-empty", !trigger.description_zh);
      const sql = document.createElement("code");
      sql.textContent = trigger.sql;
      sql.title = trigger.sql;
      const controls = document.createElement("div");
      controls.className = "trigger-card-controls";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "\u7f16\u8f91";
      edit.addEventListener("click", () => openTriggerDialog(trigger, () => void renderTriggerPanel(panel)));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "\u5220\u9664";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await postApi("/api/trigger/delete", { name: trigger.name });
          await renderTriggerPanel(panel);
        } catch (error) {
          remove.disabled = false;
          setInspectorMessage(`\u5220\u9664\u89e6\u53d1\u5668\u5931\u8d25\uff1a${error.message}`, "error");
        }
      });
      controls.append(edit, remove);
      card.append(name, metadata, description, sql, controls);
      grid.append(card);
    });
    if (managing) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "trigger-card-add";
      add.textContent = "+ \u65b0\u5efa\u89e6\u53d1\u5668";
      add.addEventListener("click", () => openTriggerDialog(null, () => void renderTriggerPanel(panel)));
      grid.append(add);
    }
    panel.append(header, grid);
  };
  render();
}

function openTriggerDialog(trigger = null, onSaved = null) {
  const form = $("#trigger-form");
  triggerEditorName = trigger?.name || "";
  triggerEditorPreview = null;
  triggerPanelReload = onSaved;
  $("#trigger-dialog-title").textContent = triggerEditorName ? "\u7f16\u8f91 SQLite \u89e6\u53d1\u5668" : "\u65b0\u5efa SQLite \u89e6\u53d1\u5668";
  $("#trigger-dialog-message").textContent = "\u8bf7\u5148\u6821\u9a8c SQL\uff0c\u6821\u9a8c\u901a\u8fc7\u540e\u624d\u80fd\u4fdd\u5b58\u3002";
  form.elements.description_zh.value = trigger?.description_zh || "";
  form.elements.sql.value = trigger?.sql || "CREATE TRIGGER trigger_name AFTER INSERT ON table_name BEGIN\n  SELECT 1;\nEND";
  $("#trigger-apply").disabled = true;
  $("#trigger-dialog").showModal();
}

$("#close-trigger-dialog").addEventListener("click", () => $("#trigger-dialog").close());
$("#trigger-preview").addEventListener("click", async () => {
  const form = $("#trigger-form");
  const message = $("#trigger-dialog-message");
  const sql = form.elements.sql.value.trim();
  triggerEditorPreview = null;
  $("#trigger-apply").disabled = true;
  try {
    message.textContent = "\u6b63\u5728\u6821\u9a8c SQL...";
    triggerEditorPreview = await postApi("/api/trigger/preview", { sql, replace_name: triggerEditorName || undefined });
    message.textContent = `\u6821\u9a8c\u901a\u8fc7\uff1a${triggerEditorPreview.name}`;
    $("#trigger-apply").disabled = false;
  } catch (error) {
    message.textContent = `\u6821\u9a8c\u5931\u8d25\uff1a${error.message}`;
  }
});
$("#trigger-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#trigger-dialog").close(); return; }
  if (!triggerEditorPreview) return;
  const save = $("#trigger-apply");
  try {
    save.disabled = true;
    await postApi("/api/trigger/apply", {
      sql: $("#trigger-form").elements.sql.value.trim(),
      replace_name: triggerEditorName || undefined,
      description_zh: $("#trigger-form").elements.description_zh.value.trim(),
    });
    $("#trigger-dialog-message").textContent = "\u5df2\u4fdd\u5b58\u89e6\u53d1\u5668\u3002";
    triggerPanelReload?.();
    window.setTimeout(() => { if ($("#trigger-dialog").open) $("#trigger-dialog").close(); }, 300);
  } catch (error) {
    save.disabled = false;
    $("#trigger-dialog-message").textContent = `\u4fdd\u5b58\u5931\u8d25\uff1a${error.message}`;
  }
});

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function selectedOrderCode() {
  const row = state.selectedRow || {};
  return row["单号"] || row.order_code || row.code || "";
}

function rowValue(row, ...names) {
  for (const name of names) {
    if (row?.[name] != null && row[name] !== "") return row[name];
  }
  return "";
}

function fieldValue(form, name) {
  const value = new FormData(form).get(name);
  return value === null ? "" : String(value).trim();
}

function optionalNumber(value) {
  return value === "" ? null : Number(value);
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function previewCommand(command, payload) {
  const preview = await postApi("/api/command/preview", { command, payload });
  $("#inspector-command").textContent = `${preview.cli}\n\n${JSON.stringify(preview.targets, null, 2)}`;
  return preview;
}

async function applyCommand(command, payload) {
  const result = await postApi("/api/command/apply", { command, payload });
  $("#inspector-command").textContent = `${result.cli}\n\n已应用，正在刷新。`;
  await refresh();
}

function actionHint(text) {
  const p = document.createElement("p");
  p.className = "action-hint";
  p.textContent = text;
  return p;
}

function renderActions() {
  const root = $("#inspector-actions");
  root.replaceChildren();
  if (!state.selectedRow) {
    root.append(actionHint("先在右上表格选中一行，再预览可执行操作。"));
    return;
  }
  const objectName = state.active?.name;
  const orderCode = selectedOrderCode();
  if (!orderCode) {
    root.append(actionHint("当前行没有可识别的订单号，暂不提供写操作。"));
    return;
  }
  if (objectName === "v_task_list" || objectName === "job") {
    renderJobForm(root, orderCode);
    return;
  }
  if (objectName === "v_order_board" || objectName === "sales_order") {
    renderPaymentForm(root, orderCode);
    renderShipmentForm(root, orderCode);
    return;
  }
  root.append(actionHint("这个表/视图当前只读。写操作会逐步补齐到明确的 CLI 命令。"));
}

function renderJobForm(root, orderCode) {
  const row = state.selectedRow;
  const form = document.createElement("form");
  form.className = "action-form";
  form.innerHTML = `
    <h3>工序更新</h3>
    <label>状态
      <select name="status">
      <option value="">不改</option>
      <option value="pending">未开始</option>
      <option value="in_progress">进行中</option>
      <option value="blocked">阻塞</option>
      <option value="done">已完成</option>
      <option value="rework">返工</option>
      </select>
    </label>
    <label>预计分钟<input name="estimate_minutes" type="number" min="0" step="1" value="${escapeAttribute(rowValue(row, "预估分钟", "estimate_minutes"))}"></label>
    <label>实际分钟<input name="actual_minutes" type="number" min="0" step="0.1" value="${escapeAttribute(rowValue(row, "实际分钟", "actual_minutes"))}"></label>
    <label class="wide">备注<input name="note" type="text"></label>
    <footer><button type="button" data-action="preview">预览 CLI</button><button class="primary" type="button" data-action="apply">应用</button></footer>
  `;
  const statusNow = String(rowValue(row, "工序状态", "status"));
  const statusMap = {
    未开始: "pending", pending: "pending",
    进行中: "in_progress", in_progress: "in_progress",
    阻塞: "blocked", blocked: "blocked",
    已完成: "done", done: "done",
    返工: "rework", rework: "rework",
  };
  form.querySelector("select").value = statusMap[statusNow] || "";
  const payload = () => ({
    order_code: orderCode,
    job_id: row.job_id || row.id || null,
    process: row.process_code || "",
    status: fieldValue(form, "status") || null,
    estimate_minutes: optionalNumber(fieldValue(form, "estimate_minutes")),
    actual_minutes: optionalNumber(fieldValue(form, "actual_minutes")),
    note: fieldValue(form, "note") || null,
  });
  wireActionForm(form, "job.patch", payload);
  root.append(form);
}

function renderPaymentForm(root, orderCode) {
  const row = state.selectedRow;
  const form = document.createElement("form");
  form.className = "action-form";
  form.innerHTML = `
    <h3>收款金额</h3>
    <label>全款<input name="total_yuan" type="number" min="0" step="0.01" value="${escapeAttribute(rowValue(row, "报价_元", "total_yuan"))}"></label>
    <label>已付<input name="paid_yuan" type="number" min="0" step="0.01" value="${escapeAttribute(rowValue(row, "已收_元", "paid_yuan"))}"></label>
    <label>退款<input name="refund_yuan" type="number" min="0" step="0.01" value="${escapeAttribute(rowValue(row, "退款_元", "refund_yuan"))}"></label>
    <footer><button type="button" data-action="preview">预览 CLI</button><button class="primary" type="button" data-action="apply">应用</button></footer>
  `;
  const payload = () => ({
    order_code: orderCode,
    total_yuan: optionalNumber(fieldValue(form, "total_yuan")),
    paid_yuan: optionalNumber(fieldValue(form, "paid_yuan")),
    refund_yuan: optionalNumber(fieldValue(form, "refund_yuan")),
  });
  wireActionForm(form, "payment.patch", payload);
  root.append(form);
}

function renderShipmentForm(root, orderCode) {
  const form = document.createElement("form");
  form.className = "action-form";
  form.innerHTML = `
    <h3>物流信息</h3>
    <label>快递
      <select name="carrier">
        <option value="">不改</option><option value="sf">顺丰</option><option value="yto">圆通</option><option value="zto">中通</option><option value="sto">申通</option><option value="yunda">韵达</option><option value="jd">京东</option><option value="ems">邮政</option><option value="other">其他</option>
      </select>
    </label>
    <label>运单号<input name="tracking" type="text"></label>
    <label>状态
      <select name="shipment_status">
        <option value="">不改</option><option value="unfilled">unfilled</option><option value="pending">pending</option><option value="in_transit">in_transit</option><option value="delivered">delivered</option><option value="returned">returned</option><option value="exception">exception</option>
      </select>
    </label>
    <footer><button type="button" data-action="preview">预览 CLI</button><button class="primary" type="button" data-action="apply">应用</button></footer>
  `;
  const payload = () => ({
    order_code: orderCode,
    carrier: fieldValue(form, "carrier") || null,
    tracking: fieldValue(form, "tracking") || null,
    shipment_status: fieldValue(form, "shipment_status") || null,
  });
  wireActionForm(form, "shipment.patch", payload);
  root.append(form);
}

function wireActionForm(form, command, payloadFactory) {
  form.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    event.preventDefault();
    button.disabled = true;
    try {
      const payload = payloadFactory();
      if (button.dataset.action === "preview") await previewCommand(command, payload);
      if (button.dataset.action === "apply") await applyCommand(command, payload);
    } catch (error) {
      $("#inspector-command").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

async function selectObject(item) {
  state.active = item;
  state.selectedRow = null;
  renderNav();
  $("#active-title").textContent = objectSummary(item);
  $("#active-summary").textContent = item.description_zh || `${item.kind}: ${item.name}`;
  const params = new URLSearchParams({ name: item.name, limit: "300" });
  if (state.query) params.set("q", state.query);
  state.activeResult = await api(`/api/object?${params.toString()}`);
  renderGrid(state.activeResult);
  renderInspector();
}

function setLoadState(percent, detail, { failed = false } = {}) {
  const overlay = $("#load-state");
  overlay.hidden = false;
  overlay.classList.toggle("failed", failed);
  $("#load-state-title").textContent = failed ? "载入失败" : "正在载入工作台";
  $("#load-state-detail").textContent = detail;
  $("#load-progress-value").style.width = Math.max(0, Math.min(100, percent)) + "%";
  $("#retry-load").hidden = !failed;
}

function hideLoadState() {
  $("#load-state").hidden = true;
}

async function refresh() {
  setLoadState(8, "正在读取表结构");
  const schema = await api("/api/schema");
  setLoadState(30, "正在读取指标定义");
  const metricDefinitionsPayload = await api("/api/metric-definitions");
  setLoadState(42, "正在读取指标与数据操作约束");
  const metrics = await api("/api/metrics");
  const recordContract = await api("/api/record-contract");
  setLoadState(58, "正在读取插件栏目");
  const plugins = await api("/api/plugins");
  const dashboard = await api("/api/dashboard");
  state.schema = schema;
  state.recordContract = recordContract;
  state.plugins = plugins.plugins || [];
  state.metricDefinitions = metricDefinitionsPayload.definitions || [];
  state.dashboard = { metricsVisible: dashboard.metrics_visible, inspectorVisible: dashboard.inspector_visible, enabledMetrics: dashboard.enabled_metrics, customMetrics: dashboard.custom_metrics || [], metricLabels: dashboard.metric_labels || {}, builtinMetricSql: dashboard.builtin_metric_sql || {}, pluginOrder: dashboard.plugin_order || [] };
  saveDashboardPreferences();
  renderMetrics(metrics);
  const objects = schema.objects || [];
  const next = state.active ? objects.find((item) => item.name === state.active.name) : objects.find((item) => item.name === "v_study_due_cards") || objects[0];
  setLoadState(76, "正在装载当前数据视图");
  if (next) await selectObject(next);
  setLoadState(100, "工作台已就绪");
  window.setTimeout(hideLoadState, 220);
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".inspector-panel").forEach((item) => item.classList.remove("active"));
  $(`#inspector-${tab.dataset.tab}`).classList.add("active");
});

document.querySelectorAll('.inspector-pane .tab[data-tab="actions"], .inspector-pane .tab[data-tab="command"]').forEach((tab) => tab.remove());

$("#refresh").addEventListener("click", refresh);
$("#retry-load").addEventListener("click", () => { void refresh().catch(handleLoadFailure); });
function openViewDialog() {
  editingViewName = "";
  editingManagedView = false;
  const form = $("#view-form");
  form.reset();
  form.name.readOnly = false;
  form.sql.readOnly = false;
  viewSqlPreview = null;
  $("#view-mappings").replaceChildren();
  setViewDialogMessage("");
  $("#view-dialog-title").textContent = "新建外观视图";
  $("#view-dialog").showModal();
}

function mappingColumns() {
  return viewSqlPreview?.columns || (state.active?.columns || []).map((column) => column.name);
}

function addViewMapping(target = {}, sourceColumns = mappingColumns()) {
  const root = $("#view-mappings");
  const tables = state.recordContract?.tables || [];
  const row = document.createElement("div");
  row.className = "view-mapping-row";
  const column = document.createElement("label");
  column.textContent = "视图列";
  const columnInput = document.createElement("select");
  columnInput.name = "view_column";
  columnInput.append(new Option("选择 SQL 输出列", ""));
  sourceColumns.filter((name) => !name.startsWith("_wb_")).forEach((name) => columnInput.append(new Option(name, name)));
  if (target.viewColumn && !sourceColumns.includes(target.viewColumn)) columnInput.append(new Option(target.viewColumn, target.viewColumn));
  columnInput.value = target.viewColumn || "";
  column.append(columnInput);
  const tableLabel = document.createElement("label");
  tableLabel.textContent = "目标表";
  const table = document.createElement("select");
  table.name = "target_table";
  table.append(new Option("选择表", ""));
  tables.forEach((item) => table.append(new Option(item.name, item.name)));
  table.value = target.table || "";
  tableLabel.append(table);
  const keyLabel = document.createElement("label");
  keyLabel.textContent = "视图关联键";
  const key = document.createElement("select");
  key.name = "source_key";
  key.append(new Option("选择视图列", ""));
  sourceColumns.forEach((name) => key.append(new Option(name, name)));
  if (target.sourceKey && !sourceColumns.includes(target.sourceKey)) key.append(new Option(target.sourceKey, target.sourceKey));
  key.value = target.sourceKey || "";
  keyLabel.append(key);
  const targetKeyLabel = document.createElement("label");
  targetKeyLabel.textContent = "目标表主键";
  const targetKey = document.createElement("select");
  targetKey.name = "target_key";
  targetKeyLabel.append(targetKey);
  const fieldLabel = document.createElement("label");
  fieldLabel.textContent = "写回字段";
  const field = document.createElement("select");
  field.name = "target_column";
  fieldLabel.append(field);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "view-mapping-remove symbol-button";
  remove.textContent = "×";
  remove.title = "移除此列映射";
  remove.addEventListener("click", () => row.remove());
  const syncFields = () => {
    const targetTable = tables.find((item) => item.name === table.value);
    const keyCandidates = viewSqlPreview?.key_candidates?.[table.value] || [];
    targetKey.replaceChildren(new Option("选择主键", ""));
    (targetTable?.primary_key || []).forEach((name) => targetKey.append(new Option(name, name)));
    const suggested = keyCandidates.find((item) => !target.sourceKey || item.source === target.sourceKey);
    targetKey.value = target.targetKey || suggested?.target || targetTable?.primary_key?.[0] || "";
    if (!target.sourceKey && suggested?.source && sourceColumns.includes(suggested.source)) key.value = suggested.source;
    field.replaceChildren(new Option("选择字段", ""));
    (targetTable?.columns || []).filter((item) => !targetTable.primary_key.includes(item.name)).forEach((item) => field.append(new Option(item.name, item.name)));
    field.value = target.column || "";
  };
  table.addEventListener("change", syncFields);
  row.append(column, tableLabel, keyLabel, targetKeyLabel, fieldLabel, remove);
  root.append(row);
  syncFields();
}

function editTargets(contract = {}) {
  if (contract.targets) return Object.entries(contract.targets).map(([viewColumn, target]) => ({ viewColumn, table: target.table, sourceKey: Object.keys(target.key || {})[0] || "", targetKey: Object.values(target.key || {})[0] || "", column: target.column }));
  return [];
}

function currentMappingDrafts() {
  return [...$("#view-mappings").querySelectorAll(".view-mapping-row")].map((row) => ({
    viewColumn: row.querySelector("[name=view_column]").value, table: row.querySelector("[name=target_table]").value,
    sourceKey: row.querySelector("[name=source_key]").value, targetKey: row.querySelector("[name=target_key]").value,
    column: row.querySelector("[name=target_column]").value,
  }));
}

async function parseViewSql() {
  const sql = $("#view-form").sql.value.trim();
  if (!sql) { setViewDialogMessage("请先输入 SQL，再解析输出列。", "error"); return; }
  try {
    setViewDialogMessage("正在解析 SQL 输出列与关联键建议...", "pending");
    const draft = currentMappingDrafts();
    viewSqlPreview = await postApi("/api/view/sql-preview", { sql });
    $("#view-mappings").replaceChildren();
    draft.forEach((target) => addViewMapping(target));
    setViewDialogMessage(`已解析 ${viewSqlPreview.columns.length} 个输出列；关联键下拉已按目标表主键给出建议。`, "success");
  } catch (error) { setViewDialogMessage(`SQL 解析失败：${error.message}`, "error"); }
}

function editableViewSql(sql) {
  return String(sql || "").replace(/^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|\S+)\s+AS\s+/i, "");
}

function setViewDialogMessage(message, state = "") {
  const element = $("#view-dialog-message");
  element.textContent = message;
  element.dataset.state = state;
}

function openViewEditor(item) {
  editingViewName = item.name;
  editingManagedView = item.managed === true;
  const form = $("#view-form");
  form.name.value = item.name;
  form.name.readOnly = true;
  form.name_zh.value = item.name_zh || item.name;
  form.sql.value = editableViewSql(item.sql);
  form.sql.readOnly = false;
  viewSqlPreview = { columns: item.columns.map((column) => column.name), key_candidates: {} };
  $("#view-mappings").replaceChildren();
  editTargets(item.edit_contract).forEach((target) => addViewMapping(target, item.columns.map((column) => column.name)));
  setViewDialogMessage("");
  $("#view-dialog-title").textContent = "编辑外观视图";
  $("#view-dialog").showModal();
  void parseViewSql();
}

function buildViewEditContract() {
  const targets = {};
  for (const row of $("#view-mappings").querySelectorAll(".view-mapping-row")) {
    const viewColumn = row.querySelector("[name=view_column]").value.trim();
    const table = row.querySelector("[name=target_table]").value;
    const sourceKey = row.querySelector("[name=source_key]").value;
    const column = row.querySelector("[name=target_column]").value;
    const tableContract = (state.recordContract?.tables || []).find((item) => item.name === table);
    const targetKey = row.querySelector("[name=target_key]").value || tableContract?.primary_key?.[0];
    if (!viewColumn && !table && !sourceKey && !column) continue;
    if (!viewColumn || !table || !sourceKey || !column || !targetKey) throw new Error("每条可编辑列映射都必须选择视图列、目标表、关联键和写回字段。");
    targets[viewColumn] = { table, key: { [sourceKey]: targetKey }, column };
  }
  return Object.keys(targets).length ? { targets, operations: ["update"] } : null;
}
$("#view-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    $("#view-dialog").close();
    return;
  }
  const form = new FormData(event.currentTarget);
  const saveButton = event.currentTarget.querySelector("button.primary[value=submit]");
  try {
    saveButton.disabled = true;
    saveButton.textContent = "正在校验并保存";
    setViewDialogMessage("正在校验 SQL 与列级写回配置...", "pending");
    const editContract = buildViewEditContract();
    await postApi(editingViewName ? "/api/view/update" : "/api/view/create", { name: form.get("name"), name_zh: form.get("name_zh"), sql: form.get("sql"), edit_contract: editContract });
    await refresh();
    setViewDialogMessage("保存成功，视图已刷新。", "success");
    setTimeout(() => { if ($("#view-dialog").open) $("#view-dialog").close(); }, 850);
  } catch (error) {
    setViewDialogMessage(`保存失败：${error.message}`, "error");
    $("#inspector-command").textContent = error.message;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "校验并保存";
  }
});
$("#close-view-dialog").addEventListener("click", () => $("#view-dialog").close());
$("#parse-view-sql").addEventListener("click", () => { void parseViewSql(); });
document.getElementById("add-view-mapping").addEventListener("click", () => addViewMapping());
$("#close-view-delete-dialog").addEventListener("click", () => $("#view-delete-dialog").close());
$("#view-delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel" || !pendingViewDeletion) { $("#view-delete-dialog").close(); return; }
  try {
    const name = pendingViewDeletion.name;
    await postApi("/api/view/delete", { name, force: (pendingViewDeletion.dependencies || []).length > 0 });
    if (state.active?.name === name) state.active = null;
    pendingViewDeletion = null;
    $("#view-delete-dialog").close();
    await refresh();
  } catch (error) {
    $("#inspector-command").textContent = error.message;
  }
});
$("#clear-filter").addEventListener("click", () => {
  state.query = "";
  clearAllColumnFilters();
  $("#global-search").value = "";
  if (state.active) void selectObject(state.active);
});
$("#edit-lock").addEventListener("click", () => { state.editLocked = !state.editLocked; updateEditLock(); });
document.getElementById("add-record").addEventListener("click", () => { void openCreateRecordDialog(); });
$("#close-record-dialog").addEventListener("click", () => $("#record-dialog").close());
$("#close-metric-dialog").addEventListener("click", () => $("#metric-dialog").close());
$("#close-builtin-metric-dialog").addEventListener("click", () => $("#builtin-metric-dialog").close());
$("#metric-source").addEventListener("change", () => { $("#metric-form").elements.label.value = ""; metricFormSourceChanged(); });
$("#builtin-metric-source").addEventListener("change", (event) => loadBuiltinMetricForm(event.target.value));
$("#preview-builtin-metric-sql").addEventListener("click", async () => {
  const form = $("#builtin-metric-form");
  const message = $("#builtin-metric-dialog-message");
  try {
    message.textContent = "正在校验 SQL...";
    const result = await postApi("/api/metric/preview", { sql: form.elements.sql.value.trim() });
    message.textContent = `校验通过，当前数值：${result.value}`;
  } catch (error) { message.textContent = `校验失败：${error.message}`; }
});
$("#builtin-metric-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#builtin-metric-dialog").close(); return; }
  const form = event.currentTarget;
  const source = form.elements.source.value;
  const message = $("#builtin-metric-dialog-message");
  const save = form.querySelector("button.primary");
  try {
    save.disabled = true; message.textContent = "正在校验并保存内置指标...";
    const preview = await postApi("/api/metric/preview", { sql: form.elements.sql.value.trim() });
    const savedDefinition = await postApi("/api/metric-definition", { id: source, label: form.elements.label.value.trim(), sql: form.elements.sql.value.trim(), format: form.elements.format.value });
    state.metricDefinitions = savedDefinition.definitions || state.metricDefinitions;
    state.dashboard.metricLabels = { ...(state.dashboard.metricLabels || {}), [source]: form.elements.label.value.trim() };
    state.dashboard.builtinMetricSql = { ...(state.dashboard.builtinMetricSql || {}), [source]: form.elements.sql.value.trim() };
    state.dashboard.enabledMetrics = form.elements.enabled.checked
      ? [...new Set([...state.dashboard.enabledMetrics, source])]
      : state.dashboard.enabledMetrics.filter((id) => id !== source);
    await persistDashboard();
    message.textContent = `保存成功，当前数值：${preview.value}`;
    setTimeout(() => { if ($("#builtin-metric-dialog").open) $("#builtin-metric-dialog").close(); }, 500);
  } catch (error) { message.textContent = `保存失败：${error.message}`; } finally { save.disabled = false; }
});
$("#metric-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#metric-dialog").close(); return; }
  const form = event.currentTarget;
  const message = $("#metric-dialog-message");
  const save = event.submitter;
  try {
    save.disabled = true;
    const source = form.elements.source.value;
    const custom = source === "custom";
    const item = custom
      ? { id: form.elements.id.value.trim(), label: form.elements.label.value.trim(), sql: form.elements.sql.value.trim(), format: form.elements.format.value }
      : { id: source, label: form.elements.label.value.trim() || metricByTitle(source)?.label, sql: metricByTitle(source)?.sql, format: metricByTitle(source)?.format || "number" };
    if (!item.id || !item.label || !item.sql) throw new Error("指标需要标识、名称和只读 SQL。");
    if (event.submitter?.value === "save_builtin") {
      message.textContent = "正在保存至内置指标...";
      const savedDefinition = await postApi("/api/metric-definition", item);
      state.metricDefinitions = savedDefinition.definitions || state.metricDefinitions;
      state.dashboard.metricLabels = { ...(state.dashboard.metricLabels || {}), [item.id]: item.label };
      state.dashboard.builtinMetricSql = { ...(state.dashboard.builtinMetricSql || {}), [item.id]: item.sql };
      saveDashboardPreferences();
      message.textContent = "已保存至内置，可在“编辑内置指标”中继续修改。";
      return;
    }
    message.textContent = "正在校验并新增指标...";
    if (source === "custom") {
      const knownDefinition = metricByTitle(item.id);
      if (knownDefinition && !editingMetric?.custom) throw new Error("该标识已是内置指标，请换一个标识或直接从内置指标中选择。");
      const duplicate = state.dashboard.customMetrics.some((existing) => existing.id === item.id && existing.id !== editingMetric?.title);
      if (duplicate) throw new Error("指标标识已存在，请使用另一个标识。");
      await postApi("/api/metric/preview", { sql: item.sql });
      const customItem = { ...item, enabled: true };
      state.dashboard.customMetrics = editingMetric?.custom
        ? state.dashboard.customMetrics.map((existing) => existing.id === editingMetric.title ? customItem : existing)
        : [...state.dashboard.customMetrics, customItem];
    } else {
      state.dashboard.enabledMetrics = [...new Set([...state.dashboard.enabledMetrics, source])];
      state.dashboard.metricLabels = { ...(state.dashboard.metricLabels || {}), [source]: form.elements.label.value.trim() };
    }
    await persistDashboard();
    message.textContent = "保存成功。";
    setTimeout(() => { if ($("#metric-dialog").open) $("#metric-dialog").close(); }, 450);
  } catch (error) {
    message.textContent = `保存失败：${error.message}`;
  } finally { save.disabled = false; }
});
$("#close-schema-doc-dialog").addEventListener("click", () => $("#schema-doc-dialog").close());
$("#schema-doc-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") { $("#schema-doc-dialog").close(); return; }
  if (!state.active) return;
  const form = event.currentTarget;
  try {
    await postApi("/api/schema-doc", { kind: state.active.kind, name: state.active.name, values: { name_zh: form.name_zh.value, description_zh: form.description_zh.value, sort_order: Number(form.sort_order.value) } });
    $("#schema-doc-dialog").close();
    await refresh();
  } catch (error) {
    $("#inspector-command").textContent = error.message;
  }
});
updateEditLock();
$("#global-search").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    if (state.active) void selectObject(state.active);
  }, 250);
});

document.addEventListener("workbench:languagechange", () => {
  applyStudioLanguage();
  renderNav();
  renderMetrics(latestMetrics);
  renderInspector();
});
setupLanguageSelect({ select: ensureLanguageSelect(), storageKey: languageStorageKey, initial: "zh", translations: STUDIO_I18N, onChange: applyStudioLanguage });
applyStudioLanguage();
setupThemeToggle({ button: $("#theme-toggle"), storageKey: "study-theme", initial: state.theme });
applyIconButtons(document);
metricEdgeControl = setupEdgeToggle({
  toggle: $("#metric-strip-toggle"),
  storageKey: "studio-metrics-collapsed",
  collapsedClass: "metrics-hidden",
  offsetProperty: "--metric-toggle-left",
  collapseIcon: "\u25b2",
  expandIcon: "\u25bc",
  collapseTitle: () => t("pane.collapse"),
  expandTitle: () => t("pane.expand"),
  onChange: (collapsed) => { state.dashboard.metricsVisible = !collapsed; void persistDashboard(); },
});
inspectorEdgeControl = setupEdgeToggle({
  toggle: $("#inspector-toggle"),
  storageKey: "studio-inspector-collapsed",
  collapsedClass: "inspector-hidden",
  offsetProperty: "--inspector-toggle-left",
  collapseIcon: "\u25bc",
  expandIcon: "\u25b2",
  collapseTitle: () => t("pane.collapse"),
  expandTitle: () => t("pane.expand"),
  onChange: (collapsed) => { state.dashboard.inspectorVisible = !collapsed; if (!collapsed) activateInspectorTab("fields"); void persistDashboard(); },
});
saveDashboardPreferences();
setupSidebarCollapse({ toggle: $("#sidebar-toggle"), storageKey: sidebarStorageKey });
setupWorkbenchSplitters({ workbench: $("#workbench"), layoutStorageKey });
function handleLoadFailure(error) {
  setLoadState(100, error.message || "服务未返回可用数据，请检查服务后重试。", { failed: true });
  $("#active-title").textContent = "载入失败";
  $("#active-summary").textContent = error.message;
}
refresh().catch(handleLoadFailure);
