import { rowMatchesFilter } from "/3dworkbench/tablePreview.mjs";
import { describeColumnFilter, installNavigatorControls, openTableFilterPopover, renderSidebarSections, t } from "/3dworkbench/workbenchPlatform.mjs?v=20261026-sidebar3";

const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  if (tag === "button") element.type = "button";
  return element;
};

function objectSummary(item) {
  return [item?.name, item?.name_zh].filter(Boolean).join(" / ");
}

function hasFilterValue(filter) {
  return Boolean(filter?.value || filter?.values?.length || filter?.min || filter?.max);
}

function visibleRows(rows, filters) {
  const active = Object.values(filters || {});
  return active.length ? rows.filter((row) => active.every((filter) => rowMatchesFilter(row, filter))) : rows;
}

export function transferKindForSection(sectionId) {
  if (sectionId === "favorites") return "common";
  if (sectionId === "views") return "appearance";
  return "base";
}

export function renderObjectNavigator(root, options) {
  const objects = options.objects || [];
  const views = objects.filter((item) => item.kind === "view");
  const tables = objects.filter((item) => item.kind === "table");
  const toItem = (item) => ({
    id: item.name,
    label: item.name_zh || item.name,
    detail: item.name,
    kind: item.kind === "view" ? "VIEW" : "TABLE",
    active: options.activeName === item.name,
    payload: item,
  });
  root.classList.add("left-column");
  const redraw = () => renderObjectNavigator(root, options);
  renderSidebarSections(root, [
    { id: "favorites", title: t("nav.favorites"), className: "favorite-pane", itemClass: "favorite-item", kind: "PIN", items: [], size: "23%", collapsedWhenEmpty: true },
    { id: "views", title: t("nav.views"), className: "derived-pane", itemClass: "view-item", items: views.map(toItem), size: "39%" },
    { id: "tables", title: t("nav.tables"), className: "source-pane", itemClass: "table-item", items: tables.map(toItem), size: "1fr" },
  ], {
    storageKey: options.storageKey,
    onSelect: (section, item) => options.onSelect?.(item.payload, section.id),
    onRender: (rendered) => {
      installNavigatorControls(rendered, [
        {
          id: "favorites",
          search: true,
          settings: true,
          hint: t("nav.favoriteHint"),
          remove: {
            canRemove: () => true,
            onRemove: (id) => {
              const next = JSON.parse(localStorage.getItem(options.storageKey) || "[]").filter((value) => value !== id);
              localStorage.setItem(options.storageKey, JSON.stringify(next));
              redraw();
            },
          },
          edit: options.onEditView ? { canEdit: (id) => views.some((item) => item.name === id), onEdit: options.onEditView } : undefined,
        },
        {
          id: "views",
          search: true,
          settings: true,
          create: options.onCreateView ? { label: t("nav.createView"), onClick: options.onCreateView } : undefined,
          remove: options.onRemoveView ? { canRemove: (id) => views.find((item) => item.name === id)?.can_delete === true, onRemove: options.onRemoveView } : undefined,
          edit: options.onEditView ? { canEdit: (id) => views.some((item) => item.name === id), onEdit: options.onEditView } : undefined,
        },
        { id: "tables", search: true },
      ], { storageKey: options.storageKey, rerender: redraw });
      if (!options.onItemDragStart) return;
      rendered.querySelectorAll(".nav-item").forEach((button) => {
        button.addEventListener("dragstart", (event) => {
          const sectionId = button.closest("[data-section-id]")?.dataset.sectionId || "";
          const object = objects.find((item) => item.name === button.dataset.itemId);
          if (object) options.onItemDragStart(event, object, sectionId);
        });
      });
    },
  });
}

function paintLock(button, editLocked) {
  button.textContent = editLocked ? "🔒" : "🔓";
  button.title = editLocked ? "编辑已锁定" : "编辑已解锁";
  button.setAttribute("aria-label", button.title);
  button.classList.toggle("active", !editLocked);
}

function ensureGridChrome(root) {
  let title = root.querySelector(":scope > .data-title");
  let frame = root.querySelector(":scope > .table-frame");
  if (!title || !frame) {
    title = make("div", null, "pane-title data-title");
    const text = document.createElement("div");
    text.append(make("h2", "表格"), make("p", ""));
    const actions = make("div", null, "action-group");
    const add = make("button", "＋", "symbol-button study-grid-add");
    const lock = make("button", "🔒", "symbol-button study-grid-lock");
    const clear = make("button", t("button.clearFilters"), "study-grid-clear");
    actions.append(add, lock, clear);
    title.append(text, actions);
    frame = make("div", null, "table-frame");
    const table = document.createElement("table");
    table.append(document.createElement("thead"), document.createElement("tbody"));
    frame.append(table);
    root.append(title, frame);
  }
  return {
    title,
    frame,
    heading: title.querySelector("h2"),
    summary: title.querySelector("p"),
    add: title.querySelector("#add-record, .study-grid-add"),
    lock: title.querySelector("#edit-lock, .study-grid-lock"),
    clear: title.querySelector("#clear-filter, .study-grid-clear"),
    table: frame.querySelector("table"),
  };
}

export function renderObjectGrid(root, model) {
  const chrome = ensureGridChrome(root);
  const object = model.object;
  const result = model.result || { columns: [], rows: [] };
  const filters = model.filters || {};
  chrome.heading.textContent = object ? objectSummary(object) : "表格";
  chrome.summary.textContent = object ? (object.description_zh || `${object.kind}: ${object.name}`) : (model.emptyText || "");
  if (chrome.add) {
    chrome.add.title = t("button.addRecord");
    chrome.add.setAttribute("aria-label", chrome.add.title);
    chrome.add.onclick = () => model.onAdd?.();
  }
  if (chrome.clear) {
    chrome.clear.textContent = t("button.clearFilters");
    chrome.clear.onclick = () => model.onClearFilters?.();
  }
  if (chrome.lock) {
    paintLock(chrome.lock, model.editLocked);
    chrome.lock.onclick = () => model.onToggleLock?.();
  }
  const columns = result.columns || [];
  const schemaColumns = new Map((object?.columns || []).map((column) => [column.name, column]));
  const descriptors = columns.map((name) => schemaColumns.get(name) || { name });
  const columnWidth = (column) => {
    const samples = (result.rows || []).slice(0, 80).map((row) => String(row[column] ?? "").replace(/\s+/g, " ").length);
    const usefulLength = Math.max(String(column).length, ...samples.filter((length) => length > 0).slice(0, 12));
    return Math.max(112, Math.min(320, 28 + usefulLength * 8));
  };
  chrome.table.style.setProperty("--table-min-width", `${Math.max(840, columns.reduce((sum, column) => sum + columnWidth(column), 0))}px`);
  const head = chrome.table.querySelector("thead");
  const body = chrome.table.querySelector("tbody");
  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.style.width = `${columnWidth(column)}px`;
    cell.textContent = column;
    cell.className = "table-filterable" + (filters[column] ? " filter-active" : "");
    cell.tabIndex = 0;
    cell.title = `筛选 ${column}`;
    const openFilter = () => {
      const descriptor = describeColumnFilter(descriptors, result.rows || [], column);
      openTableFilterPopover({
        anchor: cell,
        descriptor,
        current: filters[column],
        labels: { clear: t("filter.clear"), apply: t("filter.apply"), search: t("filter.search"), minimum: t("filter.minimum"), maximum: t("filter.maximum") },
        onApply: (filter) => model.onFilter?.(column, hasFilterValue(filter) ? filter : null),
        onClear: () => model.onFilter?.(column, null),
      });
    };
    cell.addEventListener("click", openFilter);
    cell.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFilter(); }
    });
    headerRow.append(cell);
  }
  head.replaceChildren(headerRow);
  const rows = visibleRows(result.rows || [], filters);
  if (!rows.length) {
    const line = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = Math.max(columns.length, 1);
    cell.className = "empty";
    cell.textContent = columns.length ? "没有匹配当前筛选的数据" : (model.emptyText || "把表或视图拖到这里，或在目录中点击它。");
    line.append(cell);
    body.replaceChildren(line);
    return;
  }
  const rendered = [];
  for (const payload of rows) {
    const line = document.createElement("tr");
    line.tabIndex = 0;
    if (model.selectedRow === payload) line.className = "selected";
    line.addEventListener("click", () => {
      body.querySelectorAll("tr.selected").forEach((item) => item.classList.remove("selected"));
      line.classList.add("selected");
      model.onSelectRow?.(payload);
    });
    for (const column of columns) {
      const cell = document.createElement("td");
      cell.style.width = `${columnWidth(column)}px`;
      const value = payload[column];
      cell.textContent = value == null ? "" : String(value);
      if (typeof value === "string" && (value.length > 36 || value.includes("\n"))) cell.className = "cell-long-text";
      cell.addEventListener("dblclick", () => model.onEditCell?.(cell, payload, column));
      line.append(cell);
    }
    rendered.push(line);
  }
  body.replaceChildren(...rendered);
}

function fieldTable(object, selectedRow) {
  const columns = (object.columns || []).filter((column) => !column.hidden);
  const table = make("div", null, "field-table" + (selectedRow ? " has-selected-row" : ""));
  table.setAttribute("role", "table");
  const header = make("div", null, "field-table-row field-table-header");
  header.setAttribute("role", "row");
  for (const label of ["字段", "类别", ...(selectedRow ? ["选中行数据"] : [])]) {
    const cell = make("span", label, "field-table-cell");
    cell.setAttribute("role", "columnheader");
    header.append(cell);
  }
  table.append(header);
  const valueText = (value) => value == null ? "空值" : String(value);
  for (const column of columns) {
    const row = make("div", null, "field-table-row");
    row.setAttribute("role", "row");
    const name = make("strong", column.name, "field-table-cell field-name");
    name.setAttribute("role", "cell");
    const category = make("span", `${column.type || "TEXT"}${column.primary_key ? " / PK" : ""}${column.not_null ? " / NOT NULL" : ""}`, "field-table-cell field-category");
    category.setAttribute("role", "cell");
    row.append(name, category);
    if (selectedRow) {
      const value = make("span", valueText(selectedRow[column.name]), "field-table-cell field-value");
      value.setAttribute("role", "cell");
      row.append(value);
    }
    table.append(row);
  }
  return table;
}

function inspectorControls(object, { onEditDocumentation, onEditView }) {
  const controls = [];
  if (onEditDocumentation) {
    const editDocumentation = make("button", "编辑表格说明", "inspector-edit-doc");
    editDocumentation.addEventListener("click", () => onEditDocumentation(object));
    controls.push(editDocumentation);
  }
  if (onEditView && object.kind === "view" && object.name !== "v_schema_doc") {
    const editView = make("button", "编辑外观视图", "inspector-edit-doc");
    editView.addEventListener("click", () => onEditView(object));
    controls.push(editView);
  }
  return controls;
}

export function renderObjectInspector(root, options) {
  const object = options.object;
  if (!object) {
    if (options.fieldsRoot) options.fieldsRoot.replaceChildren();
    if (options.sqlRoot) options.sqlRoot.textContent = "";
    if (root && !options.fieldsRoot) root.replaceChildren();
    return;
  }
  const sql = object.sql || `SELECT * FROM ${object.name}`;
  const controls = inspectorControls(object, options);
  const fields = fieldTable(object, options.selectedRow);
  if (options.fieldsRoot || options.sqlRoot) {
    options.fieldsRoot?.replaceChildren(...controls, fields);
    if (options.sqlRoot) options.sqlRoot.textContent = sql;
    return;
  }
  const tabs = make("div", null, "tabs");
  tabs.setAttribute("role", "tablist");
  const fieldsTab = make("button", t("tab.fields"), "tab active");
  fieldsTab.dataset.tab = "fields";
  const sqlTab = make("button", t("tab.sql"), "tab");
  sqlTab.dataset.tab = "sql";
  tabs.append(fieldsTab, sqlTab);
  const fieldsPanel = make("div", null, "inspector-panel active");
  fieldsPanel.append(...controls, fields);
  const sqlPanel = make("pre", sql, "inspector-panel code-panel");
  const activate = (name) => {
    fieldsTab.classList.toggle("active", name === "fields");
    sqlTab.classList.toggle("active", name === "sql");
    fieldsPanel.classList.toggle("active", name === "fields");
    sqlPanel.classList.toggle("active", name === "sql");
  };
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab && tabs.contains(tab)) activate(tab.dataset.tab);
  });
  root.replaceChildren(tabs, fieldsPanel, sqlPanel);
}
