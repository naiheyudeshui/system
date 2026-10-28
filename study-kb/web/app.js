import { createPluginWorkspace } from "/3dworkbench/pluginWorkspace.mjs?v=20261028-bsp1";
import { installHostHelp } from "/3dworkbench/hostHelp.mjs";
import { createEditingServices, createHttpApi } from "/3dworkbench/hostServices.mjs?v=20261028-bsp1";
import { createRefreshCoordinator } from "/3dworkbench/refreshCoordinator.mjs";
import { applyIconButtons, setupLanguageSelect, setupThemeToggle, t } from "/3dworkbench/workbenchPlatform.mjs?v=20261028-bsp1";
import { studyHelpTopics } from "./studyHelp.mjs";
import { createStudyRenderers } from "./studyPlugins.mjs?v=20261028-main-port1";

// Study host: a top bar plus one BSP workspace.  Every feature is a plugin in
// its own pane; the host keeps only the load state and the shared services.

const STUDIO_I18N = {
  zh: { "app.subtitle": "章节树、知识卡片与 FSRS 复习调度", "button.refresh": "刷新" },
  en: { "app.subtitle": "Study workbench for chapters, cards, and FSRS review scheduling", "button.refresh": "Refresh" },
};

const $ = (selector) => document.querySelector(selector);
const state = { schema: null, recordContract: null };
const { api, postApi } = createHttpApi();

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
  const subtitle = $(".brand-block p");
  if (subtitle) subtitle.textContent = t("app.subtitle");
  const refreshButton = $("#refresh");
  refreshButton.title = t("button.refresh");
  refreshButton.setAttribute("aria-label", refreshButton.title);
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

function handleLoadFailure(error) {
  console.error(error);
  setLoadState(100, error.message || String(error), { failed: true });
}

const editing = createEditingServices({
  api,
  postApi,
  getSchema: () => state.schema,
  getRecordContract: () => state.recordContract,
  onChanged: (reason) => refreshCoordinator.run({ reason }),
});

const pluginWorkspace = createPluginWorkspace({
  api,
  postApi,
  container: $("#workbench"),
  topbar: $(".topbar"),
  renderers: createStudyRenderers(editing),
  storageKey: "study-workbench-bsp-dock",
  label: "Study Knowledge Base BSP 工作区",
});

let firstLoad = true;
async function refresh() {
  if (firstLoad) setLoadState(10, "正在读取表结构与数据契约");
  const [schema, recordContract, plugins] = await Promise.all([api("/api/schema"), api("/api/record-contract"), api("/api/plugins")]);
  state.schema = schema;
  state.recordContract = recordContract;
  if (firstLoad) setLoadState(60, "正在装载插件窗格");
  await pluginWorkspace.update(plugins.plugins || []);
  if (firstLoad) {
    setLoadState(100, "工作台已就绪");
    window.setTimeout(() => { $("#load-state").hidden = true; }, 220);
    firstLoad = false;
  }
}

const refreshCoordinator = createRefreshCoordinator({
  refreshHost: () => refresh(),
  refreshVisible: ({ reason }) => pluginWorkspace.refreshVisible({ reason }),
  onStatus: ({ phase, error }) => { if (phase === "sync-error") console.warn("后台同步失败", error); },
});

$("#refresh").addEventListener("click", () => { void refreshCoordinator.run({ reason: "global" }).catch(handleLoadFailure); });
$("#retry-load").addEventListener("click", () => { firstLoad = true; void refreshCoordinator.run({ reason: "retry" }).catch(handleLoadFailure); });
setupLanguageSelect({ select: ensureLanguageSelect(), storageKey: "study-language", initial: "zh", translations: STUDIO_I18N, onChange: applyStudioLanguage });
applyStudioLanguage();
setupThemeToggle({ button: $("#theme-toggle"), storageKey: "study-theme", initial: localStorage.getItem("study-theme") || "dark" });
installHostHelp({ topics: studyHelpTopics, getContext: () => pluginWorkspace.getActiveContext() });
applyIconButtons(document);
refresh().catch(handleLoadFailure);
