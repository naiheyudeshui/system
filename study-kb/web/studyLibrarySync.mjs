import { renderFileReferenceAudit } from "./studyFileReferenceAudit.mjs";

export function renderLibrarySyncPanel(panel) {
  panel.classList.add("study-library-sync");
  const heading = document.createElement("h3");
  heading.textContent = "库同步";
  const intro = document.createElement("p");
  intro.className = "action-hint";
  intro.textContent = "完整 ZIP 包含资料、复习记录、计时状态、已保存主题和托管附件；SQLite 仅含数据库，不含图片和 PDF 文件。文件保存于当前连接的资料库宿主。恢复前校验并备份当前库；ZIP 恢复后插件停用并需重新授权。未保存到资料库的浏览器主题不在备份中。";
  const actions = document.createElement("div");
  actions.className = "action-group";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "primary";
  exportButton.textContent = "导出完整 ZIP 备份";
  const sqliteButton = document.createElement("button");
  sqliteButton.type = "button";
  sqliteButton.textContent = "仅导出 SQLite（不含附件）";
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "导入并替换";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".zip,.sqlite,application/zip,application/vnd.sqlite3,application/x-sqlite3";
  file.hidden = true;
  let importMode = "library";
  let pendingImport = null;
  const subtreeSection = document.createElement("div");
  const subtreeHint = document.createElement("p");
  subtreeHint.className = "action-hint";
  subtreeHint.textContent = "单独迁移内置知识树：包含所选根的全部节点、复习进度、评分历史、范围和托管附件。导入创建副本；不含进行中的复习会话、任意 SQL 方案或无关计时数据。逻辑数据上限 8 MiB，超过时请使用整库 ZIP。";
  const subtreeSelect = document.createElement("select");
  subtreeSelect.setAttribute("aria-label", "要导出的知识树");
  const subtreeExport = document.createElement("button");
  subtreeExport.type = "button";
  subtreeExport.textContent = "导出所选知识树 ZIP";
  const subtreeImport = document.createElement("button");
  subtreeImport.type = "button";
  subtreeImport.textContent = "导入知识树为副本";
  subtreeSection.append(subtreeHint, subtreeSelect, subtreeExport, subtreeImport);
  const restoreOptions = document.createElement("label");
  restoreOptions.className = "action-hint";
  const reinstall = document.createElement("input");
  reinstall.type = "checkbox";
  reinstall.setAttribute("aria-label", "导入资料和方案，插件重新安装");
  restoreOptions.append(reinstall, document.createTextNode("导入资料和方案，插件重新安装（保留历史与绑定配置，清除插件启用和授权状态）"));
  const message = document.createElement("p");
  message.className = "action-hint";
  message.setAttribute("role", "status");

  let auditControls;
  const setBusy = (busy) => {
    auditControls?.setBusy(busy);
    exportButton.disabled = busy;
    sqliteButton.disabled = busy;
    importButton.disabled = busy;
    reinstall.disabled = busy;
    subtreeExport.disabled = busy;
    subtreeImport.disabled = busy;
    subtreeSelect.disabled = busy;
  };
  const startDownload = async (bundle, endpoint) => {
    setBusy(true);
    message.textContent = "正在导出当前库…";
    try {
      if (bundle) {
        const status = await fetch("/api/platform/files/status");
        if (!status.ok) throw new Error(await readError(status));
        if (!(await status.json()).initialized) {
          const enabled = await fetch("/api/platform/files/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (!enabled.ok) throw new Error(await readError(enabled));
        }
      }
      const link = document.createElement("a");
      // A real HTTP download streams to the browser/native document picker. Do
      // not turn a multi-GB archive into a JS Blob or an Android blob: URL.
      link.href = endpoint || (bundle ? "/api/platform/files/bundles/export?scope=library" : "/api/study/library/export");
      link.download = bundle ? "study-backup.zip" : "study.sqlite";
      if (typeof globalThis.StudyNative?.downloadFile === "function") {
        globalThis.StudyNative.downloadFile(new URL(link.href, globalThis.location.href).href, link.download, bundle ? "application/zip" : "application/vnd.sqlite3");
      } else link.click();
      message.textContent = "已开始下载；请等待浏览器或系统文件选择器确认保存完成。ZIP 是明文，可能含私人资料；卸载移动应用前请将备份保存到应用外。";
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setBusy(false);
    }
  };
  exportButton.addEventListener("click", () => startDownload(true));
  sqliteButton.addEventListener("click", () => startDownload(false));
  importButton.addEventListener("click", () => { importMode = "library"; file.click(); });
  subtreeExport.addEventListener("click", () => {
    if (!subtreeSelect.value) { message.textContent = "当前没有可导出的知识树"; return; }
    startDownload(true, `/api/platform/files/bundles/export?scope=unit&adapter=study.knowledge-subtree%2Fv1&id=${encodeURIComponent(subtreeSelect.value)}`);
  });
  subtreeImport.addEventListener("click", () => { importMode = "unit"; file.click(); });
  file.addEventListener("change", async () => {
    const chosen = file.files && file.files[0];
    file.value = "";
    if (!chosen) return;
    const scope = importMode;
    const isBundle = /\.zip$/i.test(chosen.name) || chosen.type === "application/zip";
    if (scope === "unit" && !isBundle) { message.textContent = "知识树副本导入需要知识树 ZIP 包"; return; }
    const reinstallPlugins = isBundle || reinstall.checked;
    const mode = reinstallPlugins ? "插件将停用并清除授权，请通过插件管理逐个扫描安装。" : "保留备份中的插件启用及授权状态。";
    const confirmed = window.confirm(scope === "unit" ? `将从“${chosen.name}”创建知识树副本，并导入其进度、历史和托管附件。现有资料不会被覆盖。是否继续？` : `将用“${chosen.name}”替换当前资料库。${isBundle ? "ZIP 将同时恢复声明的托管附件。" : "SQLite 不含附件；若所需文件不在当前文件根，将拒绝恢复。"}${mode}当前库将先自动备份。插件安装包不会自动安装。是否继续？`);
    if (!confirmed) return;
    setBusy(true);
    message.textContent = "正在校验备份并等待数据库空闲，随后恢复当前库…";
    try {
      if (isBundle) {
        const status = await fetch("/api/platform/files/status");
        if (!status.ok) throw new Error(await readError(status));
        if (!(await status.json()).initialized) {
          const enabled = await fetch("/api/platform/files/initialize", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (!enabled.ok) throw new Error(await readError(enabled));
        }
      }
      // Keep the request identity after an ambiguous network failure. A second
      // selection of the same file confirms the first import instead of making
      // another knowledge-tree copy. The server also verifies the actual hash.
      const identity = JSON.stringify([scope, chosen.name, chosen.size, chosen.lastModified]);
      if (pendingImport?.identity !== identity) pendingImport = { identity, requestId: "restore-" + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`) };
      const requestId = pendingImport.requestId;
      const endpoint = isBundle ? `/api/platform/files/bundles/import?scope=${scope}&${scope === "library" ? "replace=1&" : ""}requestId=${encodeURIComponent(requestId)}` : "/api/study/library/import" + (reinstallPlugins ? "?reinstall_plugins=1" : "");
      const response = await fetch(endpoint, { method: "POST", body: chosen });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "导入失败");
      pendingImport = null;
      message.textContent = scope === "unit" ? "知识树副本已导入，正在刷新…" : `已替换当前库，原库备份为 ${payload.backup || ""}。正在刷新…`;
      window.location.reload();
    } catch (error) {
      message.textContent = error.message;
      setBusy(false);
    }
  });
  actions.append(exportButton, sqliteButton, importButton, file);
  panel.replaceChildren(heading, intro, restoreOptions, actions, subtreeSection, message);
  auditControls = renderFileReferenceAudit(panel, { onBusy: setBusy });
  fetch("/api/study/library/tree-roots").then(async response => {
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json();
    for (const root of payload.roots || []) {
      const option = document.createElement("option");
      option.value = root.id;
      option.textContent = root.title;
      subtreeSelect.append(option);
    }
  }).catch(error => { message.textContent = `知识树列表加载失败：${error.message}`; });
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload.detail || "导出失败";
  } catch {
    return "导出失败";
  }
}
