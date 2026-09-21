import { openConfigManager } from "/3dworkbench/pluginConfigManager.mjs";
import { renderTablePreview } from "/3dworkbench/tablePreview.mjs";
import { createTreeWorkspace, filterTree, indexTree } from "/3dworkbench/treeWorkspace.mjs";
import { renderMarkdown } from "./studyMarkdown.mjs";

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  if (tag === "button") node.type = "button";
  return node;
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
  const rootSearch = make("input"); rootSearch.placeholder = "搜索根节点标题"; rootSearch.setAttribute("aria-label", "搜索根节点");
  const rootPicker = make("select"); rootPicker.setAttribute("aria-label", "根节点");
  const open = make("button", "打开树图", "primary");
  const selection = make("p");
  rootTools.append(rootSearch, rootPicker, open);
  preview.append(previewHeader, report, table, selection, rootTools);
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
      node.data = { answer_md: node.answer_md || "", source_ref: node.source_ref || "" };
      node.children = [];
    }
    const normalized = [];
    for (const node of index.values()) (index.get(node.parent_id)?.children || normalized).push(node);
    return { roots: normalized, rows: [...index.values()].map((node) => ({ node_id: node.id, parent_id: node.parent_id, title: node.title, detail_1: node.answer_md || "", detail_2: node.source_ref || "" })), columns: ["node_id", "parent_id", "title", "detail_1", "detail_2"], detail_fields: [{ column: "answer_md", label: "知识详情", format: "markdown" }, { column: "source_ref", label: "来源", format: "text" }], validation: { kind: normalized.length === 1 ? "tree" : normalized.length ? "forest" : "empty", root_count: normalized.length, max_depth: Math.max(0, ...[...index.values()].map((node) => node.depth)), warnings: [] } };
  };
  const fetchData = async (request) => request.config_id
    ? api(`/api/study/tree?config_id=${encodeURIComponent(request.config_id)}`)
    : normalizeLegacy(await api(`/api/study/tree?model=knowledge${request.scope ? `&scope=${encodeURIComponent(request.scope)}` : ""}`));
  const fillRoots = () => {
    const previous = rootPicker.value;
    const tree = filterTree(data?.roots || [], filtered.map((row) => row.node_id));
    const options = [...indexTree(tree.roots).values()];
    rootPicker.replaceChildren(new Option("全部根节点", ""), ...options.filter((node) => node.id === previous || node.title.toLocaleLowerCase().includes(rootSearch.value.toLocaleLowerCase())).map((node) => new Option(`${node.title} · ${node.id}`, node.id)));
    rootPicker.value = options.some((node) => node.id === previous) ? previous : "";
    selection.textContent = `命中 ${filtered.length} 个节点 · 自动保留 ${tree.addedAncestors} 个祖先以维持关系；可选择任一节点作为浏览根。`;
    open.disabled = busy || !filtered.length;
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
    rootSearch.value = ""; rootPicker.replaceChildren();
    previewState = renderTablePreview(table, { rows: next.rows, columns: next.columns.filter((column) => {
      const detailIndex = /^detail_(\d+)$/.exec(column);
      if (detailIndex && next.columns.includes(next.detail_fields[Number(detailIndex[1]) - 1]?.column)) return false;
      return !(column === "answer_md" && next.columns.includes("content_md"));
    }), initialFilters, ariaLabel: "树节点候选表格",
      labels: { node_id: "节点 ID", parent_id: "父节点 ID", title: "节点标题", content_md: "节点内容", source_type: "来源类型", source_id: "原始 ID", owner_node_id: "归属章节", ...Object.fromEntries(next.detail_fields.map((field, index) => [`detail_${index + 1}`, field.label])) },
      onChange: (rows) => { filtered = rows; fillRoots(); },
    });
  };
  const renderCards = () => {
    grid.replaceChildren(management);
    for (const entry of [{ id: "", name: "学习知识树" }, ...entries]) {
      const card = make("article", null, `metric-card study-plan-card${entry.id === selectedId ? " is-selected" : ""}`);
      const choose = make("button", entry.name, "study-plan-select"); choose.setAttribute("aria-pressed", String(entry.id === selectedId));
      choose.addEventListener("click", () => { if (!busy) { selectedId = entry.id; renderCards(); } });
      card.append(choose, make("small", entry.id ? "SQL 数据源 · 自定义关系与详情模块" : "统一节点 · 章节与卡片均可筛选"));
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
  let editorGeneration = 0;
  const editNode = async (operation, node) => {
    const generation = ++editorGeneration;
    const originalSession = session;
    const state = session.getState();
    const editor = make("section", null, "study-tree-editor");
    const editorHeader = make("header", null, "wb-tree-header");
    const cancel = make("button", "取消并返回");
    const save = make("button", "保存", "primary"); save.disabled = true;
    editorHeader.append(make("h3", operation === "content" ? "编辑节点内容" : operation === "child" ? "新增子主题" : "新增同级主题"), cancel, save);
    const hint = make("p", "保存后写入当前数据库。新增主题不会自动生成复习卡；已有卡片只修改正文，不改变复习进度。");
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
      const changed = baseline && (contentInput.value !== (operation === "content" ? baseline.node.content_md : "") || (operation !== "content" && titleInput.value));
      if ((payload || changed) && !window.confirm(saved ? "修改已保存，返回旧画面后请刷新。继续返回？" : "放弃当前草稿并返回？若刚才网络中断，保存可能已完成，可重试确认。")) return;
      ++editorGeneration; editor.remove();
      const browser = viewer.querySelector(".wb-tree-browser"); if (browser) browser.hidden = false;
      [...viewer.querySelectorAll(".wb-tree-graph-node")].find((element) => element.dataset.nodeId === node.id)?.focus();
    };
    cancel.addEventListener("click", close);
    editor.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); close(); } });
    save.addEventListener("click", async () => {
      if (saving || !baseline) return;
      if (operation !== "content" && !titleInput.value.trim()) { notice.textContent = "请填写主题标题。"; titleInput.focus(); return; }
      saving = true; save.disabled = true; cancel.disabled = true;
      titleInput.readOnly = true; contentInput.readOnly = true;
      payload ||= { operation, node_id: baseline.node.node_id, version: baseline.version, request_id: window.crypto.randomUUID(), title: titleInput.value, content_md: contentInput.value };
      try {
        saved ||= await postApi("/api/study/knowledge/save", payload);
        notice.textContent = "已保存，正在刷新树图…";
        const next = await fetchData({ ...source });
        if (!valid()) return;
        data = next; renderPreview(next, previewState?.filters() || []);
        const target = saved.node.node_id;
        const newTree = filterTree(next.roots, [...filtered.map((row) => row.node_id), target]);
        const newIndex = indexTree(newTree.roots);
        const ancestors = new Set();
        let parent = newIndex.get(target);
        while (parent) { ancestors.add(parent.id); parent = newIndex.get(parent.parent_id); }
        state.selectedId = target;
        state.collapsed = state.collapsed.filter((key) => !ancestors.has(key));
        if (operation === "content") state.expandedContent = [...new Set([...state.expandedContent, target])];
        if (state.root && !ancestors.has(state.root)) state.root = "";
        ++editorGeneration;
        showTree(newTree.roots, state.root, state);
        message.textContent = filtered.some((row) => row.node_id === target) ? "已保存。" : "已保存，并临时显示修改的节点及其祖先；原预览筛选条件未改变。";
      } catch (error) {
        notice.textContent = `${saved ? "已保存，但树图刷新失败" : "保存未确认，草稿已保留"}：${error.message}`;
        save.textContent = saved ? "重新加载树" : "重试保存";
      } finally { saving = false; save.disabled = false; cancel.disabled = false; }
    });
    try {
      baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
      if (!valid()) return;
      titleInput.value = operation === "content" ? baseline.node.title : "";
      titleInput.readOnly = operation === "content";
      contentInput.value = operation === "content" ? baseline.node.content_md : "";
      notice.textContent = `当前节点：${baseline.node.title}；${operation === "child" ? "新增在此节点下" : operation === "sibling" ? "新增到此节点的真实父级下（不是临时浏览根）" : "保存正文，允许空内容"}。`;
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
        const payload = { operation: "move", node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: window.crypto.randomUUID(), content_md: "" };
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
        await postApi("/api/study/knowledge/save", { operation: "reorder", position, node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: window.crypto.randomUUID(), content_md: "" });
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
        const baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
        await postApi("/api/study/knowledge/save", { operation: "delete", delete_mode: choice, node_id: node.id, version: baseline.version, request_id: window.crypto.randomUUID(), content_md: "" });
        const next = await fetchData({ ...source });
        data = next; renderPreview(next, previewState?.filters() || []);
        page(preview);
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
    showTree(result.roots, rootPicker.value);
  });
  rootSearch.addEventListener("input", fillRoots);
  returnHome.addEventListener("click", () => page(home));
  settings.addEventListener("click", () => { management.hidden = !management.hidden; settings.setAttribute("aria-pressed", String(!management.hidden)); });
  edit.addEventListener("click", () => { void run(() => openConfigManager(panel, { api, postApi, pluginId: "study.node-tree", moduleId: "trees", initialId: selectedId, onBack: () => { void run(reload); } })); });
  add.addEventListener("click", () => { void run(() => openConfigManager(panel, { api, postApi, pluginId: "study.node-tree", moduleId: "trees", onBack: () => { void run(reload); } })); });
  refresh.addEventListener("click", () => { void run(reload); });
  panel.dispose = () => { ++editorGeneration; session?.dispose(); };
  await run(async () => {
    await reload();
    const payload = await api("/api/study/tree");
    scopes.append(...(payload.scopes || []).map((scope) => new Option(scope.label, scope.id)));
  });
}
