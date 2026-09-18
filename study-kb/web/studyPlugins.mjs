import { attachMarkdownToggle, renderMarkdown } from "./studyMarkdown.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function kindLabel(kind) {
  const map = { book: "书", chapter: "章", section: "节", topic: "题", group: "组" };
  return map[kind] || kind || "节点";
}

function roleLabel(role) {
  return role === "topic" ? "知识点" : "目录";
}

function parseMarkmapMeta(content) {
  const text = String(content ?? "");
  const nodeMatch = text.match(/<!--\s*node:([^\s]+)/);
  const cardMatch = text.match(/\bcard:([^\s]+)/);
  return {
    nodeId: nodeMatch ? nodeMatch[1] : null,
    cardId: cardMatch ? cardMatch[1] : null,
  };
}

function findNodeInTree(roots, nodeId) {
  for (const node of roots || []) {
    if (node.id === nodeId) return node;
    const found = findNodeInTree(node.children, nodeId);
    if (found) return found;
  }
  return null;
}

function buildMarkmapMarkdownFromTree(roots, depth = 1) {
  const lines = [];
  const walk = (nodes, level) => {
    for (const node of nodes || []) {
      const heading = Math.max(1, Math.min(6, level));
      const role = node.role === "topic" ? "topic" : "outline";
      lines.push(`${"#".repeat(heading)} ${node.title || node.id} <!-- node:${node.id} ${role} -->`);
      if (node.children?.length) {
        walk(node.children, level + 1);
      } else if (node.role === "topic" && node.cards?.length) {
        const cardLevel = Math.max(1, Math.min(6, level + 1));
        const prefix = "#".repeat(cardLevel);
        for (const card of node.cards) {
          const title = String(card.front || "卡片").trim().split("\n")[0].slice(0, 160);
          lines.push(`${prefix} ${title} <!-- node:${node.id} card:${card.card_id || card.id} topic -->`);
        }
      }
    }
  };
  walk(roots, depth);
  return lines.length ? `${lines.join("\n")}\n` : "# 空树\n";
}

async function fetchStudyJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const contentType = response.headers.get("content-type") || "";
  const snippet = (await response.clone().text()).slice(0, 80);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (!contentType.includes("json") && snippet.trimStart().startsWith("<")) {
    throw new Error("Study API 返回了 HTML 而非 JSON，请重启 workbench 后重试。");
  }
  return response.json();
}

function renderTreeNode(node, depth = 0) {
  const li = document.createElement("li");
  li.className = "study-tree-node";
  li.dataset.nodeId = node.id;

  const row = document.createElement("div");
  row.className = "study-tree-row";
  row.style.paddingLeft = `${depth * 14 + 4}px`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "study-tree-toggle";
  toggle.textContent = node.children?.length ? "▾" : "·";
  toggle.disabled = !node.children?.length;

  const label = document.createElement("span");
  label.className = "study-tree-label";
  const role = node.role === "topic" ? " · 知识点" : "";
  label.innerHTML = `<strong>${escapeHtml(kindLabel(node.kind))}</strong> ${escapeHtml(node.title || node.id)}${role}`;

  const meta = document.createElement("span");
  meta.className = "study-tree-meta";
  const cards = Number(node.card_count || 0);
  const due = Number(node.due_count || 0);
  meta.textContent = due > 0 ? `${cards} 卡 · ${due} 到期` : `${cards} 卡`;

  row.append(toggle, label, meta);
  li.append(row);

  const childList = document.createElement("ul");
  childList.className = "study-tree-children";
  for (const child of node.children || []) {
    childList.append(renderTreeNode(child, depth + 1));
  }
  if (childList.children.length) {
    li.append(childList);
    toggle.addEventListener("click", () => {
      const collapsed = childList.hidden;
      childList.hidden = !collapsed;
      toggle.textContent = collapsed ? "▾" : "▸";
    });
  }
  row.addEventListener("click", (event) => {
    if (event.target === toggle) return;
    li.dispatchEvent(new CustomEvent("study-node-select", { bubbles: true, detail: { nodeId: node.id } }));
  });
  return li;
}

export async function renderNodeTreePanel(panel, { api }) {
  panel.classList.add("study-tree-panel");
  panel.replaceChildren(Object.assign(document.createElement("p"), {
    className: "action-hint",
    textContent: "正在加载思维导图…",
  }));

  const header = document.createElement("div");
  header.className = "study-plugin-header";
  const title = document.createElement("h3");
  title.textContent = "章节树图";
  const hint = document.createElement("p");
  hint.className = "action-hint";
  hint.textContent = "径向思维导图展示标题层级；点击节点在右侧查看 Markdown 答案。";

  const scopeLabel = document.createElement("label");
  scopeLabel.className = "study-plugin-control";
  scopeLabel.textContent = "学习视角";
  const scopeSelect = document.createElement("select");
  scopeSelect.append(new Option("全部节点", ""));

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新";

  const toggleOutline = document.createElement("button");
  toggleOutline.type = "button";
  toggleOutline.textContent = "大纲";

  const message = document.createElement("p");
  message.className = "study-plugin-message action-hint";

  const layout = document.createElement("div");
  layout.className = "study-markmap-layout";

  const markmapHost = document.createElement("div");
  markmapHost.className = "study-markmap-host";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.classList.add("study-markmap-svg");
  markmapHost.append(svg);

  const detail = document.createElement("aside");
  detail.className = "study-node-detail";
  const detailTitle = document.createElement("h4");
  detailTitle.className = "study-node-detail-title";
  detailTitle.textContent = "选择节点";
  const detailMeta = document.createElement("p");
  detailMeta.className = "study-node-detail-meta action-hint";
  detailMeta.textContent = "点击径向图或左侧大纲中的节点。";
  const detailToolbar = document.createElement("div");
  detailToolbar.className = "study-node-detail-toolbar";
  const detailBody = document.createElement("div");
  detailBody.className = "study-node-detail-body study-md";
  detail.append(detailTitle, detailMeta, detailToolbar, detailBody);

  const outlineWrap = document.createElement("div");
  outlineWrap.className = "study-tree-outline hidden";
  const treeRoot = document.createElement("ul");
  treeRoot.className = "study-tree-root";
  outlineWrap.append(treeRoot);

  layout.append(markmapHost, detail);
  header.append(title, hint, scopeLabel, scopeSelect, refresh, toggleOutline);
  panel.replaceChildren(header, message, layout, outlineWrap);

  let markmapInstance = null;
  let detailToggle = null;
  let selectedNodeId = null;
  let cachedTreePayload = null;
  let usedApiFallback = false;

  const showCardDetail = async (cardId) => {
    selectedNodeId = cardId;
    detailTitle.textContent = "加载中…";
    detailMeta.textContent = "";
    detailBody.replaceChildren();
    detailToolbar.replaceChildren();
    try {
      const payload = await fetchStudyJson(`/api/study/card/${encodeURIComponent(cardId)}`);
      const card = payload.card || {};
      detailTitle.textContent = card.front || cardId;
      detailMeta.textContent = `复习卡 · ${card.node_title || "—"}${card.due_at ? ` · 到期 ${card.due_at}` : ""}`;
      detailToggle = attachMarkdownToggle(detailToolbar, detailBody, () => card.answer_md || card.back || "");
      detailToggle.refresh();
    } catch (error) {
      detailTitle.textContent = "加载失败";
      detailMeta.textContent = error.message;
      detailBody.textContent = "";
    }
  };

  const showNodeDetail = async (nodeId) => {
    if (!nodeId) return;
    selectedNodeId = nodeId;
    detailTitle.textContent = "加载中…";
    detailMeta.textContent = "";
    detailBody.replaceChildren();
    try {
      let node;
      let cardDue = "";
      let cards = [];
      try {
        const payload = await fetchStudyJson(`/api/study/node/${encodeURIComponent(nodeId)}`);
        node = payload.node || {};
        cards = payload.cards || [];
        cardDue = payload.card?.due_at ? ` · 到期 ${payload.card.due_at}` : "";
      } catch (error) {
        usedApiFallback = true;
        node = findNodeInTree(cachedTreePayload?.roots, nodeId);
        if (!node) throw error;
        cards = node.cards || [];
      }
      detailTitle.textContent = node.title || nodeId;
      const cardHint = cards.length ? ` · ${cards.length} 张复习卡` : "";
      detailMeta.textContent = `${roleLabel(node.role)} · ${kindLabel(node.kind)}${cardDue}${cardHint}`;
      detailToolbar.replaceChildren();
      if (node.role === "topic" && node.answer_md) {
        detailToggle = attachMarkdownToggle(detailToolbar, detailBody, () => node.answer_md);
        detailToggle.refresh();
      } else if (node.role === "topic" && cards.length) {
        detailBody.textContent = "该节点下有多张复习卡，请在径向图中展开并点击具体卡片查看答案。";
      } else if (node.role === "topic") {
        detailBody.textContent = "（暂无答案 Markdown）";
      } else {
        detailBody.textContent = "目录节点，可继续展开子节点。";
      }
      for (const row of outlineWrap.querySelectorAll(".study-tree-row")) {
        row.classList.toggle("is-selected", row.closest("[data-node-id]")?.dataset.nodeId === nodeId);
      }
    } catch (error) {
      detailTitle.textContent = "加载失败";
      detailMeta.textContent = error.message;
      detailBody.textContent = "";
    }
  };

  panel.addEventListener("study-node-select", (event) => {
    void showNodeDetail(event.detail?.nodeId);
  });

  const load = async () => {
    message.textContent = "加载中…";
    treeRoot.replaceChildren();
    usedApiFallback = false;
    try {
      const scope = scopeSelect.value;
      const treeUrl = scope ? `/api/study/tree?scope=${encodeURIComponent(scope)}` : "/api/study/tree";
      const markmapUrl = scope ? `/api/study/markmap?scope=${encodeURIComponent(scope)}` : "/api/study/markmap";
      const treePayload = await api(treeUrl);
      cachedTreePayload = treePayload;
      let markmapPayload;
      try {
        markmapPayload = await fetchStudyJson(markmapUrl);
      } catch (error) {
        usedApiFallback = true;
        markmapPayload = { markdown: buildMarkmapMarkdownFromTree(treePayload.roots) };
      }

      scopeSelect.replaceChildren(new Option("全部节点", ""));
      for (const scopeItem of treePayload.scopes || []) {
        const label = scopeItem.is_default ? `${scopeItem.label}（默认）` : scopeItem.label;
        scopeSelect.append(new Option(label, scopeItem.id));
      }
      if (scope) scopeSelect.value = scope;

      for (const root of treePayload.roots || []) {
        treeRoot.append(renderTreeNode(root));
      }

      const [{ Markmap }, { Transformer }] = await Promise.all([
        import("https://cdn.jsdelivr.net/npm/markmap-view@0.18.12/+esm"),
        import("https://cdn.jsdelivr.net/npm/markmap-lib@0.18.12/+esm"),
      ]);
      const transformer = new Transformer();
      const { root } = transformer.transform(markmapPayload.markdown || "# 空树\n");
      if (!markmapInstance) {
        markmapInstance = Markmap.create(svg, {
          color: (node) => (String(node?.payload?.content || "").includes("topic") ? "#7de38d" : "#60a68a"),
          maxWidth: 280,
        });
        markmapInstance.setOptions({
          autoFit: true,
          zoom: true,
          pan: true,
        });
        svg.addEventListener("click", (event) => {
          const target = event.target.closest?.("g.markmap-node");
          if (!target) return;
          const foreign = target.querySelector("foreignObject");
          const meta = parseMarkmapMeta(foreign?.innerHTML || target.textContent);
          if (meta.cardId) void showCardDetail(meta.cardId);
          else if (meta.nodeId) void showNodeDetail(meta.nodeId);
        });
      }
      markmapInstance.setData(root);
      markmapInstance.fit();

      const fallbackHint = usedApiFallback
        ? " · 部分 Study API 不可用，已用树数据回退（请重启 workbench 加载最新服务）"
        : "";
      message.textContent = treePayload.roots?.length
        ? `共 ${treePayload.node_count} 个节点 · 点击节点查看详情${fallbackHint}`
        : `当前视角下没有节点。${fallbackHint}`;
      if (selectedNodeId) void showNodeDetail(selectedNodeId);
    } catch (error) {
      message.textContent = `加载失败：${error.message}`;
      message.dataset.state = "error";
    }
  };

  scopeSelect.addEventListener("change", () => { void load(); });
  refresh.addEventListener("click", () => { void load(); });
  toggleOutline.addEventListener("click", () => {
    outlineWrap.classList.toggle("hidden");
    toggleOutline.textContent = outlineWrap.classList.contains("hidden") ? "大纲" : "隐藏大纲";
  });
  await load();
}

const RATING_LABELS = {
  1: { label: "Again", hint: "重来" },
  2: { label: "Hard", hint: "困难" },
  3: { label: "Good", hint: "良好" },
  4: { label: "Easy", hint: "简单" },
};

export async function renderReviewTablePanel(panel, { api, postApi, getCurrentView }) {
  panel.classList.add("study-review-panel");
  panel.replaceChildren(Object.assign(document.createElement("p"), {
    className: "action-hint",
    textContent: "正在载入复习队列…",
  }));

  let startedAt = Date.now();
  let currentCard = null;
  let revealed = false;

  const header = document.createElement("div");
  header.className = "study-plugin-header";
  const title = document.createElement("h3");
  title.textContent = "表格复习";
  const hint = document.createElement("p");
  hint.className = "action-hint";
  hint.textContent = "按当前外观视图顺序取第一张到期卡；支持 Markdown 渲染；打分后自动跳下一张。";

  const meta = document.createElement("div");
  meta.className = "study-review-meta";

  const cardTitle = document.createElement("div");
  cardTitle.className = "study-review-title";

  const table = document.createElement("div");
  table.className = "study-review-table";

  const rowFront = document.createElement("div");
  rowFront.className = "study-review-row";
  rowFront.innerHTML = `<span class="study-review-key">标题 / 问题</span><div class="study-review-value" data-front></div>`;
  const frontToolbar = document.createElement("div");
  frontToolbar.className = "study-review-row-toolbar";

  const rowBack = document.createElement("div");
  rowBack.className = "study-review-row hidden";
  rowBack.innerHTML = `<span class="study-review-key">答案</span><div class="study-review-value" data-back></div>`;
  const backToolbar = document.createElement("div");
  backToolbar.className = "study-review-row-toolbar";

  const rowHint = document.createElement("div");
  rowHint.className = "study-review-row hidden";
  rowHint.innerHTML = `<span class="study-review-key">提示</span><div class="study-review-value" data-hint></div>`;

  table.append(rowFront, frontToolbar, rowBack, backToolbar, rowHint);

  const actions = document.createElement("div");
  actions.className = "study-review-actions";

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.textContent = "显示答案";

  const ratingWrap = document.createElement("div");
  ratingWrap.className = "study-review-ratings hidden";
  for (const rating of [1, 2, 3, 4]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `study-review-rate rating-${rating}`;
    btn.dataset.rating = String(rating);
    btn.textContent = `${rating} · ${RATING_LABELS[rating].hint}`;
    btn.title = RATING_LABELS[rating].label;
    ratingWrap.append(btn);
  }

  const message = document.createElement("p");
  message.className = "study-plugin-message action-hint";

  actions.append(revealBtn, ratingWrap);
  header.append(title, hint, meta);
  panel.replaceChildren(header, cardTitle, table, actions, message);

  const frontEl = rowFront.querySelector("[data-front]");
  const backEl = rowBack.querySelector("[data-back]");
  const hintEl = rowHint.querySelector("[data-hint]");
  let frontToggle = null;
  let backToggle = null;

  const renderCard = (payload) => {
    currentCard = payload?.card || null;
    revealed = false;
    startedAt = Date.now();
    const viewName = getCurrentView?.()?.name || payload?.view || "v_study_due_cards";
    meta.textContent = `视图：${viewName} · 队列剩余 ${payload?.due_total ?? 0} 张到期卡`;

    frontToolbar.replaceChildren();
    backToolbar.replaceChildren();

    if (!currentCard) {
      cardTitle.textContent = "今日复习已完成";
      renderMarkdown("", frontEl);
      renderMarkdown("", backEl);
      renderMarkdown("", hintEl);
      rowBack.classList.add("hidden");
      rowHint.classList.add("hidden");
      revealBtn.disabled = true;
      ratingWrap.classList.add("hidden");
      return;
    }

    cardTitle.textContent = currentCard.front || currentCard.node_title || currentCard.card_id;
    frontToggle = attachMarkdownToggle(frontToolbar, frontEl, () => currentCard.front || "");
    frontToggle.refresh();
    backToggle = attachMarkdownToggle(backToolbar, backEl, () => currentCard.back || currentCard.answer_md || "");
    renderMarkdown(currentCard.hint || "", hintEl);
    rowBack.classList.add("hidden");
    rowHint.classList.toggle("hidden", !currentCard.hint);
    revealBtn.disabled = false;
    ratingWrap.classList.add("hidden");
    message.textContent = `到期：${currentCard.due_at || "—"} · 章节：${currentCard.node_title || "—"}`;
  };

  const loadNext = async () => {
    message.textContent = "正在取下一张到期卡…";
    const view = getCurrentView?.()?.name || "v_study_due_cards";
    const payload = await api(`/api/study/review/next?view=${encodeURIComponent(view)}`);
    renderCard(payload);
  };

  revealBtn.addEventListener("click", () => {
    if (!currentCard) return;
    revealed = true;
    rowBack.classList.remove("hidden");
    backToggle?.refresh();
    if (currentCard.hint) rowHint.classList.remove("hidden");
    ratingWrap.classList.remove("hidden");
  });

  ratingWrap.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-rating]");
    if (!button || !currentCard || !revealed) return;
    const rating = Number(button.dataset.rating);
    for (const node of ratingWrap.querySelectorAll("button")) node.disabled = true;
    try {
      const elapsed_ms = Date.now() - startedAt;
      const view = getCurrentView?.()?.name || "v_study_due_cards";
      const result = await postApi("/api/study/review/grade", {
        card_id: currentCard.card_id,
        rating,
        elapsed_ms,
        view,
      });
      message.textContent = `已打分 ${rating}，下次复习：${result.graded?.due_at || "—"}`;
      renderCard(result.next);
    } catch (error) {
      message.textContent = `打分失败：${error.message}`;
      message.dataset.state = "error";
    } finally {
      for (const node of ratingWrap.querySelectorAll("button")) node.disabled = false;
    }
  });

  panel.refreshContext = () => { void loadNext(); };
  await loadNext();
}
