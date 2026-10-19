export function renderLibrarySyncPanel(panel) {
  panel.classList.add("study-library-sync");
  const heading = document.createElement("h3");
  heading.textContent = "库同步";
  const intro = document.createElement("p");
  intro.className = "action-hint";
  intro.textContent = "导出或替换的是当前打开的这一台服务里的学习库。连手机地址就是手机库，连电脑本机就是电脑库。导入会覆盖卡片、复习记录和番茄钟，替换前会先自动备份当前库。";
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
  const message = document.createElement("p");
  message.className = "action-hint";
  message.setAttribute("role", "status");

  const setBusy = (busy) => {
    exportButton.disabled = busy;
    importButton.disabled = busy;
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
    const confirmed = window.confirm(`将用“${chosen.name}”替换当前学习库。当前的卡片、复习记录和番茄钟会被覆盖。替换前会先自动备份当前库。`);
    if (!confirmed) return;
    setBusy(true);
    message.textContent = "正在替换当前库…";
    try {
      const response = await fetch("/api/study/library/import", { method: "POST", body: chosen });
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
  panel.replaceChildren(heading, intro, actions, message);
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
