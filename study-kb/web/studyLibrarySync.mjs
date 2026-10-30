export function renderLibrarySyncPanel(panel) {
  panel.classList.add("study-library-sync");
  const heading = document.createElement("h3");
  heading.textContent = "库同步";
  const intro = document.createElement("p");
  intro.className = "action-hint";
  intro.textContent = "导出或恢复当前服务的完整数据库，包含资料、复习记录、计时状态和插件数据绑定。插件安装包另行管理。恢复前会校验备份并自动备份当前库；恢复期间暂停数据库访问。请先结束其他旧版本服务对同一数据库的访问。";
  const actions = document.createElement("div");
  actions.className = "action-group";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "primary";
  exportButton.textContent = "导出全部数据";
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "导入并替换";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".sqlite,application/vnd.sqlite3,application/x-sqlite3";
  file.hidden = true;
  const restoreOptions = document.createElement("label");
  restoreOptions.className = "action-hint";
  const reinstall = document.createElement("input");
  reinstall.type = "checkbox";
  reinstall.setAttribute("aria-label", "导入资料和方案，插件重新安装");
  restoreOptions.append(reinstall, document.createTextNode("导入资料和方案，插件重新安装（保留历史与绑定配置，清除插件启用和授权状态）"));
  const message = document.createElement("p");
  message.className = "action-hint";
  message.setAttribute("role", "status");

  const setBusy = (busy) => {
    exportButton.disabled = busy;
    importButton.disabled = busy;
    reinstall.disabled = busy;
  };
  exportButton.addEventListener("click", async () => {
    setBusy(true);
    message.textContent = "正在导出当前库…";
    try {
      const response = await fetch("/api/study/library/export");
      if (!response.ok) throw new Error(await readError(response));
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filenameFrom(response.headers.get("Content-Disposition")) || "study.sqlite";
      link.click();
      URL.revokeObjectURL(link.href);
      message.textContent = `已导出 ${link.download}`;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      setBusy(false);
    }
  });
  importButton.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const chosen = file.files && file.files[0];
    file.value = "";
    if (!chosen) return;
    const reinstallPlugins = reinstall.checked;
    const mode = reinstallPlugins ? "插件将停用并清除授权，请通过插件管理逐个扫描安装。" : "保留备份中的插件启用及授权状态。";
    const confirmed = window.confirm(`将用“${chosen.name}”恢复当前服务的全部数据库内容，包括资料、复习记录、计时状态和插件数据绑定。${mode}当前库将先自动备份。插件安装包不会随数据库文件安装。是否继续？`);
    if (!confirmed) return;
    setBusy(true);
    message.textContent = "正在校验备份并等待数据库空闲，随后恢复当前库…";
    try {
      const response = await fetch("/api/study/library/import" + (reinstallPlugins ? "?reinstall_plugins=1" : ""), { method: "POST", body: chosen });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "导入失败");
      message.textContent = `已替换当前库，原库备份为 ${payload.backup || ""}。正在刷新…`;
      window.location.reload();
    } catch (error) {
      message.textContent = error.message;
      setBusy(false);
    }
  });
  actions.append(exportButton, importButton, file);
  panel.replaceChildren(heading, intro, restoreOptions, actions, message);
}

function filenameFrom(header) {
  const match = /filename="([^"]+)"/.exec(header || "");
  return match ? match[1] : "";
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload.detail || "导出失败";
  } catch {
    return "导出失败";
  }
}
