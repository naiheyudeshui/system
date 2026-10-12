import { addConfigCardControls, confirmWorkbenchAction, openConfigManager } from "/3dworkbench/pluginConfigManager.mjs";
import { renderTablePreview } from "/3dworkbench/tablePreview.mjs";
import { createTreeWorkspace, filterTree, indexTree } from "/3dworkbench/treeWorkspace.mjs?v=20261005-toolbar";
import { renderMarkdown } from "./studyMarkdown.mjs";
import { createSearchableCombobox } from "/3dworkbench/searchableCombobox.mjs";

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  if (tag === "button") node.type = "button";
  return node;
}

function requestId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function renderNodeTreePanel(panel, { api, postApi }) {
  panel.classList.add("study-tree-panel", "study-tree-workspace");
  const home = make("section");
  const header = make("header", null, "study-review-header");
  const tools = make("div", null, "wb-config-actions");
  const refresh = make("button", "刷新");
  const settings = make("button", "⚙", "trigger-settings"); settings.setAttribute("aria-label", "树方案设置");
  tools.append(refresh, settings); header.append(make("h3", "章节树图"), tools);
  const grid = make("div", null, "study-plan-grid");
  const management = make("div", null, "metric-card study-plan-management"); management.hidden = true;
  const edit = make("button", "编辑已有方案", "metric-card metric-management-card");
  const add = make("button", "新增方案", "metric-card metric-management-card");
  management.append(edit, add);
  const scopeLabel = make("label", "学习视角", "study-review-field");
  const scopes = make("select"); scopes.setAttribute("aria-label", "学习视角"); scopes.append(new Option("全部节点", "")); scopeLabel.append(scopes);
  const info = make("p", "选择数据方案，先校验、预览筛选，再打开整页树图。", "action-hint");
  home.append(header, info, grid, scopeLabel);
  const preview = make("section"); preview.hidden = true;
  const previewHeader = make("header", null, "study-review-header");
  const previewTitle = make("h3", "树数据预览");
  const returnHome = make("button", "返回方案"); previewHeader.append(previewTitle, returnHome);
  const report = make("p"); report.setAttribute("role", "status");
  const table = make("div");
  const rootTools = make("div", null, "wb-tree-root-tools");
  const rootPicker = createSearchableCombobox({ placeholder: "搜索或选择根节点", ariaLabel: "搜索或选择根节点", className: "wb-tree-root-picker" });
  const open = make("button", "打开树图", "primary");
  const selection = make("p");
  rootTools.append(rootPicker, open);
  preview.append(previewHeader, report, table, selection);
  const viewer = make("section", null, "study-tree-viewer"); viewer.hidden = true;
  const message = make("p"); message.setAttribute("role", "status");
  panel.replaceChildren(home, preview, viewer, message);
  let entries = [], selectedId = "", data = null, filtered = [], session = null, source = null, busy = false, previewState = null;
  const selected = () => entries.find((entry) => entry.id === selectedId);
  const page = (target) => {
    for (const section of [home, preview, viewer]) section.hidden = section !== target;
    panel.classList.toggle("is-browsing-tree", target === viewer);
    message.textContent = "";
    window.dispatchEvent(new Event("resize"));
  };
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    const controls = [...panel.querySelectorAll("button,select,input")];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try { await operation(); } catch (error) { message.textContent = `操作失败：${error.message}`; }
    finally {
      busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; });
      edit.disabled = !selectedId;
      open.disabled = !filtered.length;
    }
  };
  const normalizeLegacy = (payload) => {
    if (payload.rows && payload.detail_fields) return payload;
    const roots = payload.roots || [];
    const index = indexTree(roots);
    for (const node of index.values()) {
      node.data = { answer_md: node.answer_md || "" };
      node.children = [];
    }
    const normalized = [];
    for (const node of index.values()) (index.get(node.parent_id)?.children || normalized).push(node);
    return { roots: normalized, rows: [...index.values()].map((node) => ({ node_id: node.id, parent_id: node.parent_id, title: node.title, detail_1: node.answer_md || "" })), columns: ["node_id", "parent_id", "title", "detail_1"], detail_fields: [{ column: "answer_md", label: "知识详情", format: "markdown" }], validation: { kind: normalized.length === 1 ? "tree" : normalized.length ? "forest" : "empty", root_count: normalized.length, max_depth: Math.max(0, ...[...index.values()].map((node) => node.depth)), warnings: [] } };
  };
  const fetchData = async (request) => request.config_id
    ? api(`/api/study/tree?config_id=${encodeURIComponent(request.config_id)}`)
    : normalizeLegacy(await api(`/api/study/tree?model=knowledge${request.scope ? `&scope=${encodeURIComponent(request.scope)}` : ""}`));
  const fillRoots = () => {
    const tree = filterTree(data?.roots || [], filtered.map((row) => row.node_id));
    const options = [...indexTree(tree.roots).values()];
    rootPicker.setOptions(options.map((node) => ({ value: node.id, label: `${node.title} · ${node.id}`, node })));
    selection.textContent = `命中 ${filtered.length} 个节点 · 自动保留 ${tree.addedAncestors} 个祖先以维持关系；可选择任一节点作为浏览根。`;
    open.disabled = busy || !filtered.length;
  };
  const selectedRootId = () => {
    const value = rootPicker.getValue();
    if (!value) return "";
    const tree = filterTree(data?.roots || [], filtered.map((row) => row.node_id));
    const options = [...indexTree(tree.roots).values()];
    return options.find((node) => node.id === value || node.title === value)?.id || value;
  };
  const prepare = () => run(async () => {
    const request = { config_id: selectedId, scope: scopes.value };
    const next = await fetchData(request);
    indexTree(next.roots);
    data = next; source = request;
    previewTitle.textContent = `${selected()?.name || "学习知识树"} · 预览与筛选`;
    renderPreview(next);
    page(preview);
  });
  const renderPreview = (next, initialFilters = []) => {
    const validation = next.validation;
    report.textContent = `校验通过 · ${validation.kind === "forest" ? "多棵树（森林）" : validation.kind === "tree" ? "单棵树" : "空结果"} · ${validation.root_count} 个根 · 最大深度 ${validation.max_depth}${validation.warnings.length ? " · " + validation.warnings.join("；") : " · 无断开的父引用"}`;
    rootPicker.setValue(""); rootPicker.close();
    previewState = renderTablePreview(table, { rows: next.rows, columns: next.columns.filter((column) => {
      if (["source_ref", "source_type", "source_id"].includes(column)) return false;
      const detailIndex = /^detail_(\d+)$/.exec(column);
      if (detailIndex && next.columns.includes(next.detail_fields[Number(detailIndex[1]) - 1]?.column)) return false;
      return !(column === "answer_md" && next.columns.includes("content_md"));
    }), initialFilters, ariaLabel: "树节点候选表格",
      labels: { node_id: "节点 ID", parent_id: "父节点 ID", title: "节点标题", content_md: "节点内容", source_type: "来源类型", source_id: "原始 ID", owner_node_id: "归属章节", ...Object.fromEntries(next.detail_fields.map((field, index) => [`detail_${index + 1}`, field.label])) },
      onChange: (rows) => { filtered = rows; fillRoots(); },
      extraActions: [rootTools],
    });
  };
  const renderCards = () => {
    grid.replaceChildren(management);
    for (const entry of [{ id: "", name: "学习知识树" }, ...entries]) {
      const card = make("article", null, `metric-card study-plan-card${entry.id === selectedId ? " is-selected" : ""}`);
      const choose = make("button", entry.name, "study-plan-select"); choose.setAttribute("aria-pressed", String(entry.id === selectedId));
      choose.addEventListener("click", () => { if (!busy) { selectedId = entry.id; renderCards(); } });
      card.append(choose, make("small", entry.id ? "SQL 数据源 · 自定义关系与详情模块" : "统一节点 · 章节与卡片均可筛选"));
      if (entry.id && !management.hidden) addConfigCardControls(card, {
        name: entry.name,
        onEdit: () => { void openManager(entry.id); },
        onDelete: () => { void deletePlan(entry); },
      });
      if (entry.id === selectedId) {
        const previewButton = make("button", "预览并筛选"); previewButton.addEventListener("click", () => { void prepare(); });
        card.append(previewButton);
      }
      grid.append(card);
    }
    scopeLabel.hidden = Boolean(selectedId); edit.disabled = !selectedId;
  };
  const reload = async () => {
    const payload = await api("/api/plugin/configs?plugin_id=study.node-tree&module_id=trees");
    entries = payload.configs;
    if (!entries.some((entry) => entry.id === selectedId)) selectedId = "";
    renderCards();
  };
  const deletePlan = async (entry) => run(async () => {
    const accepted = await confirmWorkbenchAction({
      title: `删除章节树方案“${entry.name}”？`,
      message: "只删除这份 SQL 与字段映射方案。知识节点、卡片、父子关系和排序数据都不会删除。",
    });
    if (!accepted) return;
    await postApi("/api/plugin/config/delete", { plugin_id: "study.node-tree", module_id: "trees", id: entry.id, revision: entry.revision });
    await reload();
    message.textContent = "章节树方案已删除。";
  });
  let editorGeneration = 0;
  const editNode = async (operation, node) => {
    const generation = ++editorGeneration;
    const originalSession = session;
    const state = session.getState();
    const editor = make("form", null, "study-tree-editor");
    const editorHeader = make("header", null, "wb-tree-header");
    const cancel = make("button", "取消并返回");
    cancel.type = "button";
    const save = make("button", "保存", "primary"); save.type = "submit"; save.disabled = true;
    const editorActions = make("div", null, "wb-config-actions study-tree-editor-actions");
    editorActions.append(cancel, save);
    editorHeader.append(make("h3", operation === "content" ? "编辑节点内容" : operation === "child" ? "新增子主题" : "新增同级主题"), editorActions);
    const hint = make("p", "保存后写入当前数据库。新增主题不会自动生成复习卡；已有卡片会同步标题和正文，不改变复习进度。");
    const titleLabel = make("label", "节点标题");
    const titleInput = make("input"); titleInput.maxLength = 500; titleInput.setAttribute("aria-label", "编辑节点标题");
    titleLabel.append(titleInput);
    const contentLabel = make("label", "节点内容（Markdown，可留空）");
    const contentInput = make("textarea"); contentInput.maxLength = 200000; contentInput.setAttribute("aria-label", "编辑节点 Markdown");
    contentLabel.append(contentInput);
    const previewButton = make("button", "预览 Markdown");
    const rendered = make("div", null, "study-tree-editor-preview"); rendered.hidden = true;
    previewButton.addEventListener("click", () => { rendered.hidden = !rendered.hidden; renderMarkdown(contentInput.value, rendered); });
    const notice = make("p", "正在加载节点…"); notice.setAttribute("role", "status");
    editor.append(editorHeader, hint, titleLabel, contentLabel, previewButton, rendered, notice);
    const oldSections = [...viewer.children]; oldSections.forEach((section) => { section.hidden = true; });
    viewer.append(editor);
    let baseline = null, saving = false, payload = null, saved = null;
    const valid = () => generation === editorGeneration && originalSession === session && !viewer.hidden;
    const close = () => {
      if (saving) return;
      const changed = baseline && (contentInput.value !== (operation === "content" ? baseline.node.content_md : "") || titleInput.value !== (operation === "content" ? baseline.node.title : ""));
      if ((payload || changed) && !window.confirm(saved ? "修改已保存，返回旧画面后请刷新。继续返回？" : "放弃当前草稿并返回？若刚才网络中断，保存可能已完成，可重试确认。")) return;
      ++editorGeneration; editor.remove();
      const browser = viewer.querySelector(".wb-tree-browser"); if (browser) browser.hidden = false;
      [...viewer.querySelectorAll(".wb-tree-graph-node")].find((element) => element.dataset.nodeId === node.id)?.focus();
    };
    const postWithTimeout = async (path, body, ms = 45000) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), ms);
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
        return data;
      } catch (error) {
        if (error.name === "AbortError") throw new Error("请求超过 45 秒，请检查网络或稍后重试。");
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
    };
    const finishEditor = () => {
      ++editorGeneration;
      editor.remove();
      const browser = viewer.querySelector(".wb-tree-browser");
      if (browser) browser.hidden = false;
    };
    const refreshTreeAfterSave = async (target) => {
      const next = await fetchData({ ...source });
      data = next;
      renderPreview(next, previewState?.filters() || []);
      const newTree = filterTree(next.roots, [...filtered.map((row) => row.node_id), target]);
      const newIndex = indexTree(newTree.roots);
      const ancestors = new Set();
      let parent = newIndex.get(target);
      while (parent) { ancestors.add(parent.id); parent = newIndex.get(parent.parent_id); }
      state.selectedId = target;
      state.collapsed = state.collapsed.filter((key) => !ancestors.has(key));
      if (operation === "content") state.expandedContent = [...new Set([...state.expandedContent, target])];
      if (state.root && !ancestors.has(state.root)) state.root = "";
      showTree(newTree.roots, state.root, state);
      message.textContent = filtered.some((row) => row.node_id === target) ? "已保存。" : "已保存，并临时显示新节点及其祖先；原预览筛选条件未改变。";
    };
    cancel.addEventListener("click", close);
    editor.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); close(); } });
    const runSave = async () => {
      if (saving || !baseline) return;
      if (!titleInput.value.trim()) { notice.textContent = "请填写主题标题。"; titleInput.focus(); return; }
      if (saved) {
        notice.textContent = "正在刷新树图…";
        saving = true; save.disabled = true; cancel.disabled = true;
        try {
          await refreshTreeAfterSave(saved.node.node_id);
          finishEditor();
        } catch (error) {
          notice.textContent = `已保存，但树图刷新失败：${error.message}`;
          save.textContent = "重新加载树";
        } finally {
          saving = false; save.disabled = false; cancel.disabled = false;
          titleInput.readOnly = false; contentInput.readOnly = false;
        }
        return;
      }
      saving = true; save.disabled = true; cancel.disabled = true;
      titleInput.readOnly = true; contentInput.readOnly = true;
      try {
        payload ||= { operation, node_id: baseline.node.node_id, version: baseline.version, request_id: requestId(), title: titleInput.value.trim(), content_md: contentInput.value };
        saved = await postWithTimeout("/api/study/knowledge/save", payload);
        const target = saved.node.node_id;
        notice.textContent = "已保存，正在返回树图…";
        finishEditor();
        try {
          await refreshTreeAfterSave(target);
        } catch (error) {
          message.textContent = `节点已保存，但树图刷新失败：${error.message}。请点工具栏「刷新」。`;
        }
      } catch (error) {
        notice.textContent = `保存未确认，草稿已保留：${error.message}`;
        save.textContent = "重试保存";
      } finally {
        saving = false; save.disabled = false; cancel.disabled = false;
        titleInput.readOnly = false; contentInput.readOnly = false;
      }
    };
    save.addEventListener("click", () => { void runSave(); });
    editor.addEventListener("submit", (event) => { event.preventDefault(); void runSave(); });
    try {
      baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
      if (!valid()) return;
      titleInput.value = operation === "content" ? baseline.node.title : "";
      contentInput.value = operation === "content" ? baseline.node.content_md : "";
      notice.textContent = `当前节点：${baseline.node.title}；${operation === "child" ? "新增在此节点下" : operation === "sibling" ? "新增到此节点的真实父级下（不是临时浏览根）" : "保存标题和正文，允许空内容"}。`;
      save.disabled = false;
      (operation === "content" ? contentInput : titleInput).focus();
    } catch (error) { if (valid()) notice.textContent = `读取失败：${error.message}`; }
  };
  const showTree = (roots, initialRoot = "", state = null) => {
    session?.dispose();
    page(viewer);
    const canEditKnowledge = !source?.config_id || data.editing?.provider === "study-knowledge/v1";
    session = createTreeWorkspace(viewer, { roots, detailFields: data.detail_fields, renderMarkdown, initialRoot, initialMode: state?.mode, initialState: state,
      onEdit: canEditKnowledge ? editNode : null,
      onMove: canEditKnowledge ? async (sourceId, targetId) => {
        if (String(sourceId) === String(targetId)) throw new Error("不能移动到自身");
        const sourceNode = await postApi("/api/study/knowledge/read", { node_id: sourceId });
        const payload = { operation: "move", node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: requestId(), content_md: "" };
        await postApi("/api/study/knowledge/save", payload);
        const next = await fetchData({ ...source });
        data = next; renderPreview(next, previewState?.filters() || []);
        const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
        const current = session?.getState?.() || { mode: "graph", collapsed: [], expandedContent: [], zoom: 1, pan: { x: 0, y: 0 } };
        const refreshedIndex = indexTree(refreshed.roots);
        const ancestors = new Set();
        let cursor = refreshedIndex.get(String(targetId));
        while (cursor) { ancestors.add(cursor.id); cursor = refreshedIndex.get(cursor.parent_id); }
        current.collapsed = (current.collapsed || []).filter((id) => !ancestors.has(String(id)));
        current.selectedId = String(sourceId);
        showTree(refreshed.roots, current.root || "", current);
      } : null,
      onReorder: canEditKnowledge ? async (sourceId, targetId, position) => {
        const sourceNode = await postApi("/api/study/knowledge/read", { node_id: sourceId });
        await postApi("/api/study/knowledge/save", { operation: "reorder", position, node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: requestId(), content_md: "" });
        const next = await fetchData({ ...source });
        data = next; renderPreview(next, previewState?.filters() || []);
        const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
        const current = session?.getState?.() || state;
        current.selectedId = String(sourceId);
        showTree(refreshed.roots, current?.root || "", current);
      } : null,
      onDelete: canEditKnowledge ? async (node) => {
        const dialog = make("section", null, "study-tree-delete-dialog");
        dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
        dialog.append(make("h3", "删除知识节点"), make("p", `“${node.title}” 的复习历史会保留。请选择处理方式。`));
        const actions = make("div", null, "study-tree-delete-actions");
        const cancel = make("button", "取消");
        const self = make("button", "删除该节点");
        const recursive = make("button", "递归删除", "danger");
        actions.append(cancel, self, recursive); dialog.append(actions); document.body.append(dialog);
        const choice = await new Promise((resolve) => { cancel.addEventListener("click", () => resolve(null)); self.addEventListener("click", () => resolve("self")); recursive.addEventListener("click", () => resolve("recursive")); });
        dialog.remove(); if (!choice) return;
        try {
          const baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
          await postApi("/api/study/knowledge/save", { operation: "delete", delete_mode: choice, node_id: node.id, version: baseline.version, request_id: requestId(), content_md: "" });
          const next = await fetchData({ ...source });
          data = next; renderPreview(next, previewState?.filters() || []);
          const current = session?.getState?.() || { mode: "graph", collapsed: [], expandedContent: [], zoom: 1, pan: { x: 0, y: 0 } };
          const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
          const refreshedIndex = indexTree(refreshed.roots);
          const parentId = node.parent_id && refreshedIndex.has(String(node.parent_id)) ? String(node.parent_id) : "";
          if (current.root && !refreshedIndex.has(String(current.root))) current.root = parentId;
          current.selectedId = parentId;
          current.collapsed = (current.collapsed || []).map(String).filter((id) => refreshedIndex.has(id));
          current.expandedContent = (current.expandedContent || []).map(String).filter((id) => refreshedIndex.has(id));
          showTree(refreshed.roots, current.root || "", current);
          message.textContent = "节点已删除。";
        } catch (error) {
          message.textContent = `删除未完成：${error.message}`;
        }
      } : null,
      onBack: () => page(preview),
      onRefresh: async () => {
        const previousSession = session;
        const request = { ...source };
        const next = await fetchData(request);
        if (session !== previousSession || viewer.hidden) return;
        indexTree(next.roots);
        const current = session.getState();
        data = next;
        renderPreview(next, previewState?.filters() || []);
        const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
        showTree(refreshed.roots, current.root, current);
      },
    });
    if (state?.selectedId) [...viewer.querySelectorAll(".wb-tree-graph-node")].find((element) => element.dataset.nodeId === state.selectedId)?.focus();
  };
  open.addEventListener("click", () => {
    if (busy || !filtered.length) return;
    const result = filterTree(data.roots, filtered.map((row) => row.node_id));
    showTree(result.roots, selectedRootId());
  });
  returnHome.addEventListener("click", () => page(home));
  const openManager = (initialId) => run(() => openConfigManager(panel, { api, postApi, pluginId: "study.node-tree", moduleId: "trees", initialId, onBack: () => { void run(reload); } }));
  settings.addEventListener("click", () => {
    management.hidden = !management.hidden;
    settings.setAttribute("aria-pressed", String(!management.hidden));
    settings.classList.toggle("active", !management.hidden);
    renderCards();
  });
  edit.addEventListener("click", () => { void openManager(selectedId); });
  add.addEventListener("click", () => { void openManager(""); });
  refresh.addEventListener("click", () => { void run(reload); });
  panel.dispose = () => { ++editorGeneration; session?.dispose(); rootPicker.dispose?.(); };
  await run(async () => {
    await reload();
    const payload = await api("/api/study/tree?model=knowledge");
    scopes.append(...(payload.scopes || []).map((scope) => new Option(scope.label, scope.id)));
  });
}
