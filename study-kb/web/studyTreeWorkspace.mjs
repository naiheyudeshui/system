import { addConfigCardControls, confirmWorkbenchAction, openConfigManager } from "/3dworkbench/pluginConfigManager.mjs?v=20261029-authoring1";
import { renderTablePreview } from "/3dworkbench/tablePreview.mjs?v=20261019-history-toolbar";
import { createTreeWorkspace, filterTree, indexTree } from "/3dworkbench/treeWorkspace.mjs?v=20261019-history-toolbar";
import { renderMarkdown } from "./studyMarkdown.mjs?v=20261028-main-port1";
import { createSearchableCombobox } from "/3dworkbench/searchableCombobox.mjs?v=20261019-history-toolbar";

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
  if (typeof cryptoApi?.getRandomValues !== "function") {
    bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
  } else cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function renderNodeTreePanel(panel, { api, postApi, presentationMode, instanceId }) {
  const undoStack = [], redoStack = [], recorded = new Set();
  let historyBusy = false, pendingHistory = null;
  const recordEdit = (payload, result) => {
    if (result.history_available && payload.operation !== "history" && !recorded.has(payload.request_id)) {
      recorded.add(payload.request_id);
      undoStack.push(payload.request_id); if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
    }
  };
  const originalPostApi = postApi;
  postApi = async (path, payload) => {
    const result = await originalPostApi(path, payload);
    if (path === "/api/study/knowledge/save") recordEdit(payload, result);
    return result;
  };
  panel.classList.add("study-tree-panel", "study-tree-workspace");
  const home = make("section");
  home.dataset.helpPage = "plans";
  const header = make("header", null, "study-review-header");
  const tools = make("div", null, "wb-config-actions");
  const refresh = make("button", "刷新");
  const settings = make("button", "⚙", "trigger-settings"); settings.setAttribute("aria-label", "树方案设置");
  tools.append(refresh, settings); header.append(make("h3", "章节树图"), tools);
  const grid = make("div", null, "study-plan-grid");
  const management = make("div", null, "metric-card study-plan-management"); management.hidden = true;
  const edit = make("button", "编辑已有方案", "metric-card metric-management-card");
  const add = make("button", "新增方案", "metric-card metric-management-card");
  edit.dataset.helpAction = "manage-edit"; add.dataset.helpAction = "manage-add";
  management.append(edit, add);
  const scopeLabel = make("label", "学习视角", "study-review-field");
  const scopes = make("select"); scopes.setAttribute("aria-label", "学习视角"); scopes.append(new Option("全部节点", "")); scopeLabel.append(scopes);
  const info = make("p", "选择数据方案，先校验、预览筛选，再打开整页树图。", "action-hint");
  home.append(header, info, grid, scopeLabel);
  const preview = make("section"); preview.hidden = true;
  preview.dataset.helpPage = "preview";
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
  const message = make("p", null, "study-tree-status"); message.setAttribute("role", "status");
  panel.replaceChildren(home, preview, viewer, message);
  let entries = [], selectedId = "", data = null, filtered = [], session = null, source = null, busy = false, previewState = null;
  let messageTimer = null, disposed = false, cancelDelete = null;
  const paneId = instanceId || panel.closest("[data-instance-id]")?.dataset.instanceId;
  let leasedConfig = "", leaseChain = Promise.resolve();
  const updateLease = (id = selectedId) => {
    if (!paneId) return;
    const previous = leasedConfig; leasedConfig = id;
    leaseChain = leaseChain.catch(() => {}).then(async () => {
      const scope = { plugin_id: "study.node-tree", module_id: "trees", instance_id: paneId };
      if (previous && previous !== id) await postApi("/api/plugin/config/lease", { ...scope, id: previous, release: true });
      if (id) await postApi("/api/plugin/config/lease", { ...scope, id });
    }).catch(error => { if (!disposed) setMessage(`数据使用登记失败：${error.message}`, "error"); });
  };
  const leaseTimer = paneId ? window.setInterval(() => updateLease(), 30000) : null;
  const setMessage = (text = "", state = "") => {
    if (disposed) return;
    if (messageTimer) { window.clearTimeout(messageTimer); messageTimer = null; }
    message.textContent = text;
    message.dataset.state = state;
    message.classList.toggle("is-visible", Boolean(text));
    if (text && state !== "error") {
      messageTimer = window.setTimeout(() => {
        message.textContent = "";
        message.dataset.state = "";
        message.classList.remove("is-visible");
        messageTimer = null;
      }, 2200);
    }
  };
  const selected = () => entries.find((entry) => entry.id === selectedId);
  const page = (target) => {
    for (const section of [home, preview, viewer]) section.hidden = section !== target;
    panel.classList.toggle("is-browsing-tree", target === viewer);
    setMessage();
    window.dispatchEvent(new Event("resize"));
  };
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    const controls = [...panel.querySelectorAll("button,select,input")];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try { await operation(); } catch (error) { setMessage(`操作失败：${error.message}`, "error"); }
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
  let localMutationRevision = 0;
  const findLocalNode = (id, roots = data?.roots || []) => {
    const wanted = String(id);
    const stack = [...roots].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (String(node.id) === wanted) return node;
      stack.push(...[...(node.children || [])].reverse());
    }
    return null;
  };
  const materializeNode = (raw) => {
    const id = String(raw.node_id || raw.id);
    const node = { ...raw, id, children: [] };
    node.data = { ...raw, node_id: id };
    return node;
  };
  const rowForNode = (raw) => ({
    ...raw,
    node_id: String(raw.node_id || raw.id),
    parent_id: raw.parent_id ?? null,
    detail_1: raw.answer_md || raw.content_md || "",
  });
  const removeLocalNode = (id, recursive) => {
    const wanted = String(id);
    const victim = findLocalNode(wanted);
    if (!victim) return;
    const parent = victim.parent_id ? findLocalNode(victim.parent_id) : null;
    const siblings = parent ? parent.children : data.roots;
    const position = siblings.findIndex((item) => String(item.id) === wanted);
    if (position < 0) return;
    if (!recursive) {
      const children = victim.children || [];
      for (const child of children) {
        child.parent_id = victim.parent_id ?? null;
        if (child.data) child.data.parent_id = child.parent_id;
      }
      const promoted = new Set(children.map((child) => String(child.id)));
      data.rows = data.rows.map((row) => promoted.has(String(row.node_id)) ? { ...row, parent_id: victim.parent_id ?? null } : row);
      siblings.splice(position, 1, ...children);
    }
    else siblings.splice(position, 1);
    const removed = new Set();
    const collect = (node) => { removed.add(String(node.id)); for (const child of node.children || []) collect(child); };
    if (recursive) collect(victim);
    else removed.add(wanted);
    data.rows = data.rows.filter((row) => !removed.has(String(row.node_id)));
  };
  const applyLocalMutation = ({ operation, savedNode, beforeNode, deleteMode }) => {
    if (!data) return false;
    if (operation === "delete") {
      removeLocalNode(beforeNode?.node_id, deleteMode === "recursive");
      return true;
    }
    const raw = savedNode;
    if (!raw?.node_id) return false;
    const id = String(raw.node_id);
    const existing = findLocalNode(id);
    if (existing) {
      const children = existing.children || [];
      Object.assign(existing, materializeNode(raw), { children });
      data.rows = data.rows.map((row) => String(row.node_id) === id ? rowForNode(raw) : row);
      return true;
    }
    const created = materializeNode(raw);
    const parent = raw.parent_id ? findLocalNode(raw.parent_id) : null;
    (parent ? parent.children : data.roots).push(created);
    data.rows.push(rowForNode(raw));
    return true;
  };
  const showLocalMutation = (target, state) => {
    renderPreview(data, previewState?.filters() || []);
    const selectedIds = filtered.map((row) => row.node_id);
    if (target && !selectedIds.includes(target)) selectedIds.push(target);
    const tree = filterTree(data.roots, selectedIds);
    showTree(tree.roots, state?.root || "", state);
  };
  const currentTreeState = () => session?.getState?.() || { mode: "graph", collapsed: [], expandedContent: [], zoom: 1, pan: { x: 0, y: 0 }, outlineScrollTop: 0 };
  const applyLocalPlacement = (sourceId, targetId, placement) => {
    const sourceNode = findLocalNode(sourceId);
    const targetNode = findLocalNode(targetId);
    if (!sourceNode || !targetNode || String(sourceId) === String(targetId)) return false;
    let ancestor = targetNode;
    while (ancestor) {
      if (String(ancestor.id) === String(sourceId)) return false;
      ancestor = ancestor.parent_id ? findLocalNode(ancestor.parent_id) : null;
    }
    const oldParent = sourceNode.parent_id ? findLocalNode(sourceNode.parent_id) : null;
    const oldSiblings = oldParent ? oldParent.children : data.roots;
    const oldIndex = oldSiblings.findIndex((node) => String(node.id) === String(sourceId));
    if (oldIndex < 0) return false;
    oldSiblings.splice(oldIndex, 1);
    if (placement === "inside") {
      targetNode.children ||= [];
      targetNode.children.push(sourceNode);
      sourceNode.parent_id = String(targetNode.id);
    } else {
      const parent = targetNode.parent_id ? findLocalNode(targetNode.parent_id) : null;
      const siblings = parent ? parent.children : data.roots;
      let index = siblings.findIndex((node) => String(node.id) === String(targetId));
      if (placement === "after") index += 1;
      siblings.splice(Math.max(0, index), 0, sourceNode);
      sourceNode.parent_id = parent ? String(parent.id) : null;
    }
    data.rows = data.rows.map((row) => String(row.node_id) === String(sourceId) ? { ...row, parent_id: sourceNode.parent_id } : row);
    return true;
  };
  const revalidateInBackground = (token, state) => {
    void fetchData({ ...source }).then((next) => {
      if (disposed || token !== localMutationRevision || viewer.hidden) return;
      data = next;
      // Use the live viewport state: validation may finish after the user
      // pans, zooms, collapses, or performs another mutation.
      const latestState = session?.getState?.() || state;
      showLocalMutation(latestState?.selectedId || "", latestState);
      setMessage("树数据已完成后台校验", "success");
    }).catch((error) => {
      if (!disposed && token === localMutationRevision) setMessage(`后台校验失败：${error.message}`, "error");
    });
  };
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
      choose.addEventListener("click", () => { if (!busy) { selectedId = entry.id; updateLease(); renderCards(); } });
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
    updateLease();
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
    setMessage("章节树方案已删除。", "success");
  });
  let editorGeneration = 0;
  const editNode = async (operation, node) => {
    const generation = ++editorGeneration;
    const originalSession = session;
    const state = session.getState();
    const editor = make("form", null, "study-tree-editor");
    editor.dataset.helpPage = "node-edit";
    const editorHeader = make("header", null, "wb-tree-header");
    const previewButton = make("button", "预览 Markdown");
    previewButton.type = "button";
    const cancel = make("button", "取消并返回");
    cancel.type = "button";
    const save = make("button", "保存", "primary"); save.type = "submit"; save.disabled = true;
    const editorActions = make("div", null, "wb-config-actions study-tree-editor-actions");
    editorActions.append(previewButton, cancel, save);
    const notice = make("p", "正在读取节点…", "study-tree-editor-hint");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    const setEditorNotice = (text, state = "") => {
      notice.textContent = text;
      notice.title = text;
      if (state) notice.dataset.state = state;
      else delete notice.dataset.state;
    };
    editorHeader.append(make("h3", operation === "content" ? "编辑节点内容" : operation === "child" ? "新增子主题" : "新增同级主题"), notice, editorActions);
    const note = make("div", null, "study-tree-note");
    note.setAttribute("role", "group");
    note.setAttribute("aria-label", "节点笔记");
    const titleEl = make("div", null, "study-tree-note-title is-empty");
    titleEl.setAttribute("contenteditable", "true");
    titleEl.setAttribute("role", "textbox");
    titleEl.setAttribute("aria-multiline", "false");
    titleEl.setAttribute("aria-label", "编辑节点标题");
    titleEl.dataset.placeholder = "标题";
    const bodyEl = make("div", null, "study-tree-note-body is-empty");
    bodyEl.setAttribute("contenteditable", "true");
    bodyEl.setAttribute("role", "textbox");
    bodyEl.setAttribute("aria-multiline", "true");
    bodyEl.setAttribute("aria-label", "编辑节点 Markdown");
    bodyEl.dataset.placeholder = "正文";
    note.append(titleEl, bodyEl);
    const rendered = make("div", null, "study-tree-editor-preview");
    const previewTitle = make("h2", "未填写标题", "study-tree-preview-title is-empty");
    const previewBody = make("div", null, "study-tree-preview-body");
    rendered.append(previewTitle, previewBody);
    editor.append(editorHeader, note, rendered);
    const readMultiline = (el) => {
      const parts = [];
      const ensureBreak = () => { if (parts.length && !parts[parts.length - 1].endsWith("\n")) parts.push("\n"); };
      const walk = (node) => {
        if (node.nodeType === 3) { parts.push(node.textContent.replace(/\u00a0/g, " ")); return; }
        if (node.nodeType !== 1) return;
        if (node.nodeName === "BR") { parts.push("\n"); return; }
        const block = /^(DIV|P|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE)$/.test(node.nodeName);
        if (block) ensureBreak();
        for (const child of node.childNodes) walk(child);
        if (block) ensureBreak();
      };
      for (const child of el.childNodes) walk(child);
      return parts.join("").replace(/\n+$/, "");
    };
    const setMultiline = (el, value) => {
      const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
      el.replaceChildren();
      if (!text) return;
      text.split("\n").forEach((line, index) => {
        if (index) el.append(document.createElement("br"));
        if (line) el.append(document.createTextNode(line));
      });
    };
    const titleText = () => (titleEl.textContent || "").replace(/\u00a0/g, " ");
    const bodyText = () => readMultiline(bodyEl);
    const syncEmpty = () => {
      titleEl.classList.toggle("is-empty", !titleText().trim());
      bodyEl.classList.toggle("is-empty", !bodyText().trim());
    };
    const fillNote = (title, body) => { titleEl.textContent = title || ""; setMultiline(bodyEl, body || ""); syncEmpty(); };
    const placeCaret = (el, atEnd) => {
      el.focus();
      const selection = window.getSelection?.();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(!atEnd);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const paintNotePreview = () => {
      const title = titleText().trim();
      previewTitle.textContent = title || "未填写标题";
      previewTitle.classList.toggle("is-empty", !title);
      const body = bodyText();
      if (!body.trim()) {
        previewBody.className = "study-tree-preview-body";
        previewBody.replaceChildren(make("span", "正文", "study-md-empty"));
      } else renderMarkdown(body, previewBody);
    };
    const setPreviewing = (next) => {
      previewButton.setAttribute("aria-pressed", String(next));
      previewButton.title = next ? "正在预览，点击后编辑" : "预览 Markdown";
      note.hidden = next;
      rendered.hidden = !next;
      if (next) paintNotePreview();
    };
    const lockNote = (locked) => {
      const value = locked ? "false" : "true";
      for (const el of [titleEl, bodyEl]) {
        el.contentEditable = value;
        el.setAttribute("contenteditable", value);
      }
    };
    setPreviewing(true);
    const oldSections = [...viewer.children]; oldSections.forEach((section) => { section.hidden = true; });
    viewer.append(editor);
    let baseline = null, saving = false, payload = null, saved = null;
    const valid = () => !disposed && generation === editorGeneration && originalSession === session && !viewer.hidden;
    const close = () => {
      if (saving) return;
      const originalTitle = operation === "content" ? (baseline?.node.title || "").trim() : "";
      const originalBody = operation === "content" ? String(baseline?.node.content_md || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "") : "";
      const changed = baseline && (bodyText() !== originalBody || titleText().trim() !== originalTitle);
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
      const token = localMutationRevision;
      const next = await fetchData({ ...source });
      if (disposed || token !== localMutationRevision || viewer.hidden) return;
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
      setMessage(filtered.some((row) => row.node_id === target) ? "已保存。" : "已保存，并临时显示新节点及其祖先；原预览筛选条件未改变。", "success");
    };
    const refreshTreeAfterSaveLocal = async (target) => {
      const token = ++localMutationRevision;
      const localState = { ...state, collapsed: [...state.collapsed], expandedContent: [...state.expandedContent] };
      const applied = applyLocalMutation({ operation, savedNode: saved?.node, beforeNode: baseline?.node });
      if (!applied) return refreshTreeAfterSave(target);
      localState.selectedId = target;
      if (operation === "content") localState.expandedContent = [...new Set([...localState.expandedContent, target])];
      showLocalMutation(target, localState);
      setMessage("已保存，本地可见，正在后台校验", "pending");
      revalidateInBackground(token, localState);
    };
    cancel.addEventListener("click", close);
    editor.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); close(); } });
    titleEl.addEventListener("beforeinput", (event) => {
      if (titleEl.getAttribute("contenteditable") === "false") return;
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault();
        placeCaret(bodyEl, false);
      }
    });
    titleEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); placeCaret(bodyEl, false); }
    });
    bodyEl.addEventListener("keydown", (event) => {
      if (event.key !== "Backspace" || event.isComposing || bodyText()) return;
      const selection = window.getSelection?.();
      if (!selection?.rangeCount || !selection.getRangeAt(0).collapsed || !bodyEl.contains(selection.anchorNode)) return;
      const probe = selection.getRangeAt(0).cloneRange();
      probe.selectNodeContents(bodyEl);
      probe.setEnd(selection.getRangeAt(0).startContainer, selection.getRangeAt(0).startOffset);
      if (probe.toString() !== "") return;
      event.preventDefault();
      placeCaret(titleEl, true);
    });
    titleEl.addEventListener("input", (event) => {
      if (!event.isComposing) {
        const raw = readMultiline(titleEl);
        const splitAt = raw.indexOf("\n");
        if (splitAt >= 0) {
          titleEl.textContent = raw.slice(0, splitAt).replace(/\s+$/, "");
          const rest = raw.slice(splitAt + 1).replace(/\s+$/, "");
          if (rest) setMultiline(bodyEl, bodyText() ? `${rest}\n${bodyText()}` : rest);
          placeCaret(bodyEl, false);
        }
      }
      syncEmpty();
    });
    bodyEl.addEventListener("input", syncEmpty);
    note.addEventListener("paste", (event) => {
      if (titleEl.getAttribute("contenteditable") === "false") return;
      const raw = event.clipboardData?.getData("text/plain");
      if (typeof raw !== "string" || raw === "") return;
      event.preventDefault();
      const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const splitAt = text.indexOf("\n");
      const inTitle = titleEl.contains(event.target);
      if (splitAt >= 0 && !titleText().trim() && !bodyText().trim()) {
        titleEl.textContent = text.slice(0, splitAt).trim();
        setMultiline(bodyEl, text.slice(splitAt + 1));
        syncEmpty();
        placeCaret(bodyEl, true);
        return;
      }
      const selection = window.getSelection?.();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const target = inTitle ? titleEl : bodyEl;
      const insert = inTitle ? text.slice(0, splitAt >= 0 ? splitAt : text.length) : text;
      if (range && target.contains(range.startContainer)) {
        range.deleteContents();
        const lines = insert.split("\n");
        const fragment = document.createDocumentFragment();
        let last = null;
        lines.forEach((line, index) => {
          if (index) last = fragment.appendChild(document.createElement("br"));
          if (line) last = fragment.appendChild(document.createTextNode(line));
        });
        range.insertNode(fragment);
        if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
      } else if (inTitle) titleEl.textContent += insert;
      else setMultiline(bodyEl, `${bodyText()}${bodyText() && insert ? "\n" : ""}${insert}`);
      if (inTitle && splitAt >= 0) {
        const rest = text.slice(splitAt + 1).replace(/\s+$/, "");
        if (rest) {
          const existing = bodyText();
          setMultiline(bodyEl, existing ? `${existing}\n${rest}` : rest);
        }
      }
      syncEmpty();
    });
    previewButton.addEventListener("click", () => {
      const showPreview = rendered.hidden;
      setPreviewing(showPreview);
      if (!showPreview) (titleText().trim() ? bodyEl : titleEl).focus();
    });
    rendered.addEventListener("click", (event) => {
      if (titleText().trim() || bodyText().trim() || event.target.closest("a, button")) return;
      const selection = window.getSelection?.();
      if (selection && !selection.isCollapsed) return;
      setPreviewing(false);
      titleEl.focus();
    });
    const runSave = async () => {
      if (saving || !baseline) return;
      const title = titleText().trim();
      if (!title) { setEditorNotice("请填写主题标题。", "error"); setPreviewing(false); titleEl.focus(); return; }
      if (title.length > 500) { setEditorNotice("标题不能超过 500 字。", "error"); setPreviewing(false); titleEl.focus(); return; }
      if (bodyText().length > 200000) { setEditorNotice("正文不能超过 200000 字。", "error"); setPreviewing(false); bodyEl.focus(); return; }
      if (saved) {
        setEditorNotice("正在刷新树图…", "pending");
        saving = true; save.disabled = true; cancel.disabled = true; previewButton.disabled = true;
        try {
          await refreshTreeAfterSaveLocal(saved.node.node_id);
          finishEditor();
        } catch (error) {
          setEditorNotice(`已保存，但树图刷新失败：${error.message}`, "error");
          save.textContent = "重新加载树";
        } finally {
          saving = false; save.disabled = false; cancel.disabled = false; previewButton.disabled = false;
          lockNote(false);
        }
        return;
      }
      saving = true; save.disabled = true; cancel.disabled = true; previewButton.disabled = true;
      lockNote(true);
      try {
        payload ||= { operation, node_id: baseline.node.node_id, version: baseline.version, request_id: requestId(), title, content_md: bodyText() };
        saved = await postWithTimeout("/api/study/knowledge/save", payload);
        if (!valid()) return;
        recordEdit(payload, saved);
        const target = saved.node.node_id;
        setEditorNotice("已保存，正在返回树图…", "success");
        finishEditor();
        try {
          await refreshTreeAfterSaveLocal(target);
        } catch (error) {
          setMessage(`节点已保存，但树图刷新失败：${error.message}。请点工具栏「刷新」。`, "error");
        }
      } catch (error) {
        setEditorNotice(`保存未确认，草稿已保留：${error.message}`, "error");
        save.textContent = "重试保存";
      } finally {
        saving = false; save.disabled = false; cancel.disabled = false; previewButton.disabled = false;
        lockNote(false);
      }
    };
    save.addEventListener("click", () => { void runSave(); });
    editor.addEventListener("submit", (event) => { event.preventDefault(); void runSave(); });
    try {
      baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
      if (!valid()) return;
      fillNote(operation === "content" ? baseline.node.title : "", operation === "content" ? baseline.node.content_md : "");
      const place = operation === "child" ? "新增在此节点下" : operation === "sibling" ? "新增到此节点的真实父级下，不是临时浏览根" : "保存标题和正文，允许空内容";
      setEditorNotice(`当前节点：${baseline.node.title}；${place}。新增主题不会自动生成复习卡；已有卡片只同步标题和正文。打开后先预览，第一行是标题，换行后是正文。`);
      save.disabled = false;
      setPreviewing(true);
    } catch (error) { if (valid()) setEditorNotice(`读取失败：${error.message}`, "error"); }
  };
  const replayHistory = async (from, to) => {
    if (disposed || historyBusy || !from.length) return;
    historyBusy = true;
    const state = currentTreeState();
    const token = ++localMutationRevision;
    try {
      const target = from.at(-1);
      if (pendingHistory?.target !== target) pendingHistory = { target, id: requestId() };
      const id = pendingHistory.id;
      await originalPostApi("/api/study/knowledge/save", {
        operation: "history", target_request_id: target, request_id: id,
      });
      if (disposed) return;
      from.pop(); to.push(id);
      pendingHistory = null;
      const next = await fetchData({ ...source });
      if (disposed || token !== localMutationRevision || viewer.hidden) return;
      data = next; renderPreview(next, previewState?.filters() || []);
      const latest = session?.getState?.() || state;
      const result = filterTree(next.roots, filtered.map((row) => row.node_id));
      if (latest.root && !indexTree(result.roots).has(latest.root)) latest.root = "";
      showTree(result.roots, latest.root || "", latest);
      setMessage("操作已完成。", "success");
    } catch (error) {
      if (!disposed && !pendingHistory) {
        // The history write succeeded; retain the new stack even if loading
        // failed, and refresh only through the toolbar on retry.
        showTree(filterTree(data.roots, filtered.map((row) => row.node_id)).roots, state.root, state);
        setMessage("操作已完成，但视图刷新失败，请刷新树图：" + error.message, "error");
      } else throw error;
    } finally { historyBusy = false; }
  };
  const showTree = (roots, initialRoot = "", state = null) => {
    if (disposed) return;
    session?.dispose();
    page(viewer);
    const canEditKnowledge = !source?.config_id || data.editing?.provider === "study-knowledge/v1";
    session = createTreeWorkspace(viewer, { roots, detailFields: data.detail_fields, renderMarkdown, initialRoot, initialMode: state?.mode || (presentationMode === "outline" ? "outline" : "graph"), initialState: state,
      canUndo: undoStack.length > 0, canRedo: redoStack.length > 0,
      onUndo: canEditKnowledge ? () => replayHistory(undoStack, redoStack) : null,
      onRedo: canEditKnowledge ? () => replayHistory(redoStack, undoStack) : null,
      onEdit: canEditKnowledge ? editNode : null,
      onMove: canEditKnowledge ? async (sourceId, targetId) => {
        const optimisticToken = ++localMutationRevision;
        const optimisticState = currentTreeState();
        if (!applyLocalPlacement(sourceId, targetId, "inside")) throw new Error("不能移动到自身或其子节点");
        optimisticState.selectedId = String(sourceId);
        showLocalMutation(String(sourceId), optimisticState);
        try {
          const sourceNode = await postApi("/api/study/knowledge/read", { node_id: sourceId });
          if (disposed) return;
          await postApi("/api/study/knowledge/save", { operation: "move", node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: requestId(), content_md: "" });
          const next = await fetchData({ ...source });
          if (disposed || optimisticToken !== localMutationRevision || viewer.hidden) return;
          data = next; renderPreview(next, previewState?.filters() || []);
          const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
          showTree(refreshed.roots, optimisticState.root || "", optimisticState);
        } catch (error) {
          if (!disposed && optimisticToken === localMutationRevision && !viewer.hidden) {
            const rollback = await fetchData({ ...source });
            if (disposed || optimisticToken !== localMutationRevision || viewer.hidden) return;
            data = rollback; renderPreview(rollback, previewState?.filters() || []);
            const tree = filterTree(rollback.roots, filtered.map((row) => row.node_id));
            showTree(tree.roots, optimisticState.root || "", optimisticState);
          }
          throw error;
        }
      } : null,
      onReorder: canEditKnowledge ? async (sourceId, targetId, position) => {
        const optimisticToken = ++localMutationRevision;
        const optimisticState = currentTreeState();
        if (!applyLocalPlacement(sourceId, targetId, position)) throw new Error("无法调整该节点的位置");
        optimisticState.selectedId = String(sourceId);
        showLocalMutation(String(sourceId), optimisticState);
        try {
          const sourceNode = await postApi("/api/study/knowledge/read", { node_id: sourceId });
          if (disposed) return;
          await postApi("/api/study/knowledge/save", { operation: "reorder", position, node_id: sourceId, target_node_id: targetId, version: sourceNode.version, request_id: requestId(), content_md: "" });
          const next = await fetchData({ ...source });
          if (disposed || optimisticToken !== localMutationRevision || viewer.hidden) return;
          data = next; renderPreview(next, previewState?.filters() || []);
          const refreshed = filterTree(next.roots, filtered.map((row) => row.node_id));
          showTree(refreshed.roots, optimisticState.root || "", optimisticState);
        } catch (error) {
          if (!disposed && optimisticToken === localMutationRevision && !viewer.hidden) {
            const rollback = await fetchData({ ...source });
            if (disposed || optimisticToken !== localMutationRevision || viewer.hidden) return;
            data = rollback; renderPreview(rollback, previewState?.filters() || []);
            const tree = filterTree(rollback.roots, filtered.map((row) => row.node_id));
            showTree(tree.roots, optimisticState.root || "", optimisticState);
          }
          throw error;
        }
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
        const choice = await new Promise((resolve) => {
          cancelDelete = () => { dialog.remove(); resolve(null); };
          cancel.addEventListener("click", cancelDelete);
          self.addEventListener("click", () => resolve("self"));
          recursive.addEventListener("click", () => resolve("recursive"));
        });
        cancelDelete = null;
        dialog.remove(); if (!choice || disposed) return;
        try {
          const baseline = await postApi("/api/study/knowledge/read", { node_id: node.id });
          if (disposed) return;
          await postApi("/api/study/knowledge/save", { operation: "delete", delete_mode: choice, node_id: node.id, version: baseline.version, request_id: requestId(), content_md: "" });
          if (disposed) return;
          const token = ++localMutationRevision;
          const optimisticCurrent = currentTreeState();
          const optimisticParentId = node.parent_id && findLocalNode(node.parent_id) ? String(node.parent_id) : "";
          removeLocalNode(node.id, choice === "recursive");
          optimisticCurrent.selectedId = optimisticParentId;
          if (optimisticCurrent.root && !findLocalNode(optimisticCurrent.root)) optimisticCurrent.root = optimisticParentId;
          showLocalMutation(optimisticParentId, optimisticCurrent);
          setMessage("节点已删除，本地可见，正在后台校验", "pending");
          revalidateInBackground(token, optimisticCurrent);
        } catch (error) {
          setMessage(`删除未完成：${error.message}`, "error");
        }
      } : null,
      onBack: () => page(preview),
      onRefresh: async () => {
        const previousSession = session;
        const request = { ...source };
        const next = await fetchData(request);
        if (disposed || session !== previousSession || viewer.hidden) return;
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
  panel.dispose = () => { disposed = true; if (leaseTimer) window.clearInterval(leaseTimer); updateLease(""); ++editorGeneration; ++localMutationRevision; cancelDelete?.(); if (messageTimer) window.clearTimeout(messageTimer); session?.dispose(); rootPicker.dispose?.(); };
  await run(async () => {
    await reload();
    const payload = await api("/api/study/tree?model=knowledge");
    scopes.append(...(payload.scopes || []).map((scope) => new Option(scope.label, scope.id)));
  });
}
