const labels = {
  "legacy-workspace-unmapped": "旧方案尚未登记工作区，未自动迁移",
  "unsupported-collection-storage": "旧版或自定义集合尚未覆盖",
  "legacy-history-incomplete": "旧编辑历史格式不完整，保留已有引用",
  "missing-or-unavailable-asset": "附件未登记、已失效或不属于当前资料空间",
  "missing-or-damaged-object": "附件原文件缺失或校验失败",
};

export function renderFileReferenceAudit(panel, { onBusy = () => {} } = {}) {
  const doc = panel.ownerDocument, win = doc.defaultView;
  const section = doc.createElement("section"); section.dataset.fileReferenceAudit = "";
  const hint = doc.createElement("p"); hint.className = "action-hint";
  hint.textContent = "附件索引维护：检查主题、当前自有集合、内置知识和支持的编辑历史。检查只读；确认重建只更新已知引用，保留未知插件索引，不移动或删除原文件。旧工作区归属不会自动修改。";
  const actions = doc.createElement("div"); actions.className = "action-group";
  const inspect = doc.createElement("button"); inspect.type = "button"; inspect.textContent = "检查附件引用";
  const rebuild = doc.createElement("button"); rebuild.type = "button"; rebuild.textContent = "重建已知引用";
  const status = doc.createElement("p"); status.className = "action-hint"; status.setAttribute("role", "status");
  const details = doc.createElement("ul"); details.hidden = true; details.style.overflowWrap = "anywhere";
  actions.append(inspect, rebuild); section.append(hint, actions, status, details); panel.append(section);
  let report = null, pending = false, externalBusy = false, retry = null;
  const update = () => { inspect.disabled = pending || externalBusy; rebuild.disabled = pending || externalBusy || !report?.canRebuild; };
  const request = async (path, options) => {
    const response = await globalThis.fetch("/api/platform/files/references/" + path, { credentials: "same-origin", redirect: "error", ...options });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(value.code === "storage_not_initialized" ? "文件存储尚未启用；首次保存附件或资料库主题后再检查。" : value.error || value.detail || "附件索引操作失败"), { status: response.status });
    return value;
  };
  const run = async action => {
    if (pending || externalBusy) return;
    pending = true; onBusy(true); update();
    try { await action(); } catch (error) { status.textContent = error.message; }
    finally { pending = false; onBusy(false); update(); }
  };
  inspect.addEventListener("click", () => run(async () => {
    report = null; retry = null; details.replaceChildren(); details.hidden = true;
    status.textContent = "正在检查声明字段和附件原文件，较大的文件库可能需要一些时间…";
    report = await request("preview");
    status.textContent = `已检查 ${report.ownersScanned} 个内容/设置/历史记录、${report.assetsChecked} 个附件；待补 ${report.referencesAdded} 条、待清 ${report.referencesRemoved} 条引用。阻断问题 ${report.blockingIssues} 项，未覆盖来源 ${report.unsupportedSources} 项、其他已登记消费者 ${report.unknownOwners} 个。覆盖范围仅限已声明字段，文件清理仍关闭。`;
    for (const issue of report.issues || []) {
      const item = doc.createElement("li");
      item.textContent = `${issue.blocking ? "阻断" : "未覆盖"}：${labels[issue.code] || issue.code}（${issue.source}）`;
      details.append(item);
    }
    if (report.truncated) { const item = doc.createElement("li"); item.textContent = "问题列表超过显示上限；数量未截断。"; details.append(item); }
    details.hidden = !details.children.length;
  }));
  rebuild.addEventListener("click", () => {
    if (!report?.canRebuild || pending || externalBusy) return;
    if (!win.confirm(`将重建已检查的附件索引：补 ${report.referencesAdded} 条、清 ${report.referencesRemoved} 条现态引用。保留未知索引与原文件，不修改正文、工作区或复习记录；检查后引用变化会要求重新检查。是否继续？`)) return;
    return run(async () => {
      retry ||= { token: report.token, requestId: globalThis.crypto?.randomUUID?.() || `refs-${Date.now()}-${Math.random().toString(16).slice(2)}` };
      status.textContent = "正在重新校验并重建附件索引…";
      try {
        const result = await request("rebuild", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retry) });
        report = null; retry = null;
        status.textContent = `${result.replayed ? "已确认上次重建成功" : "已重建已知附件引用"}；未删除文件。未知来源仍需后续适配，文件清理继续关闭。`;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) { report = null; retry = null; }
        status.textContent = `${error.message}${report ? " 可再次点击重建，以同一请求确认结果。" : " 请重新检查。"}`;
      }
    });
  });
  update();
  return { setBusy(value) { externalBusy = value; update(); } };
}
