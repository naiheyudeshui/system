// Optional real-Chromium check. Start the worktree server on 8033 and an
// isolated headless Chrome with --remote-debugging-port=19283 before running.
// All plugin data is mocked; this check makes no Study data writes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const base = process.env.STUDY_SMOKE_URL || "http://127.0.0.1:8033";
const targets = await (await fetch("http://127.0.0.1:19283/json/list")).json();
const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const value = JSON.parse(data);
  const request = pending.get(value.id);
  if (!request) return;
  pending.delete(value.id); clearTimeout(request.timer);
  if (value.error) request.reject(new Error(JSON.stringify(value.error)));
  else request.resolve(value.result);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: base + "/studyMarkdown.mjs" });
  for (let index = 0; index < 50; index++) {
    if (await evaluate(`location.href === ${JSON.stringify(base + "/studyMarkdown.mjs")} && document.readyState === 'complete'`)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const result = await evaluate(`(${async function () {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    document.body.style.cssText = "display:block;margin:0;padding:16px;height:auto;overflow:auto";
    for (const href of ["/styles.css?v=20261028-mobile2", "/3dworkbench/pluginWorkspace.css?v=20261028-mobile2"]) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = href;
      const loaded = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; });
      document.head.append(link); await loaded;
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const pane = document.createElement("div"); pane.className = "wb-bsp-leaf";
    pane.style.cssText = "width:1000px;height:600px;flex:none"; document.body.append(pane);
    const panel = document.createElement("section"); panel.className = "wb-plugin-content";
    panel.style.cssText = "height:100%;min-height:0;overflow:auto"; pane.append(panel);
    const { renderMarkdown } = await import("/studyMarkdown.mjs?v=20261028-main-port1");
    renderMarkdown("$\\frac{1}{\\lambda}$\n\n| short | long |\n| --- | --- |\n| one | " + "verylongunbrokentext".repeat(20) + " |", panel);
    const samples = [];
    for (const width of [1000, 380, 1000, 380, 1000]) {
      pane.style.width = width + "px"; await frame();
      samples.push({ width, viewport: innerWidth, paneHeight: pane.clientHeight, contentHeight: panel.scrollHeight, tableWidth: panel.querySelector("table").getBoundingClientRect().width, panelWidth: panel.clientWidth, scrollWidth: panel.scrollWidth });
    }
    panel.replaceChildren(); panel.className = "wb-plugin-content";
    const { renderNodeTreePanel } = await import("/studyTreeWorkspace.mjs?v=20261028-main-port1");
    const payload = { roots: [{ id: "node:root", title: "Root", data: { content_md: "Body" }, children: [] }], rows: [{ node_id: "node:root", title: "Root", content_md: "Body" }], columns: ["node_id", "title", "content_md"], detail_fields: [{ column: "content_md", format: "markdown" }], validation: { kind: "tree", root_count: 1, max_depth: 1, warnings: [] }, scopes: [] };
    await renderNodeTreePanel(panel, { api: async (url) => url.includes("/configs?") ? { configs: [] } : payload, postApi: async () => ({ node: { node_id: "node:root", title: "Root", content_md: "Body" }, version: "v1" }) });
    const button = (label) => [...panel.querySelectorAll("button")].find((node) => node.textContent === label);
    button("预览并筛选").click(); await frame(); button("打开树图").click(); await frame();
    const node = panel.querySelector(".wb-tree-graph-node"); node.dispatchEvent(new Event("click"));
    panel.querySelector(".wb-tree-graph-node").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })); await frame();
    const editorSamples = [];
    for (const width of [1000, 380, 1000, 380]) {
      pane.style.width = width + "px"; await frame();
      const title = panel.querySelector(".study-tree-preview-title");
      editorSamples.push({ width, viewport: innerWidth, font: getComputedStyle(title).fontSize, paneHeight: pane.clientHeight, scrollHeight: panel.scrollHeight });
    }
    panel.dispose(); panel.replaceChildren(); panel.className = "wb-plugin-content";
    pane.style.width = "1000px"; pane.style.height = "120px";
    const { renderTimerPanel } = await import("/studyTimers.mjs?v=20261028-main-port1");
    await renderTimerPanel(panel, { kind: "pomodoro", mode: "compact", api: async () => ({ current: null, projects: [{ id: "one", name: "Project One", status: "active" }, { id: "two", name: "Project Two", status: "active" }], history: [] }), postApi: async () => { throw new Error("Fixture must not write"); } });
    panel.querySelector(".study-time-choice-trigger").click(); await frame();
    const option = [...document.querySelectorAll('.study-time-choice-menu [role="option"]')].at(-1);
    const rect = option.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const menuVisible = option.contains(hit);
    option.click();
    const selected = panel.querySelector(".study-time-choice-trigger").textContent;
    panel.dispose();
    pane.remove();
    const spacingNodes = [];
    for (const [width, mode] of [[1000, "full"], [380, "phone"]]) {
      const leaf = document.createElement("div"); leaf.className = "wb-bsp-leaf";
      leaf.style.cssText = `width:${width}px;height:600px;flex:none`; document.body.append(leaf);
      const instance = document.createElement("div"); instance.className = "wb-plugin-instance"; leaf.append(instance);
      const timer = document.createElement("section"); timer.className = "wb-plugin-content"; instance.append(timer);
      await renderTimerPanel(timer, { kind: "pomodoro", mode, api: async () => ({ current: null, projects: [], history: [] }), postApi: async () => { throw new Error("Fixture must not write"); } });
      spacingNodes.push({ leaf, instance, timer });
    }
    await frame();
    window.__spacingSamples = () => spacingNodes.map(({ leaf, instance, timer }) => ({
      paneWidth: leaf.clientWidth, instancePadding: getComputedStyle(instance).paddingLeft,
      timerPadding: getComputedStyle(timer).paddingLeft,
      cardPadding: getComputedStyle(timer.querySelector(".study-time-summary article")).paddingLeft,
      cardRadius: getComputedStyle(timer.querySelector(".study-time-summary article")).borderTopLeftRadius,
    }));
    return { samples, editorSamples, menuVisible, selected, spacing: window.__spacingSamples() };
  }.toString()})()`);
  console.log(JSON.stringify(result, null, 2));
  if (process.env.STUDY_SMOKE_SCREENSHOT) {
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.STUDY_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }
  for (const sample of result.samples) {
    assert.ok(sample.tableWidth <= sample.panelWidth + 1);
    assert.ok(sample.scrollWidth <= sample.panelWidth + 1);
    assert.equal(sample.paneHeight, 600);
  }
  assert.equal(result.samples[0].contentHeight, result.samples[2].contentHeight);
  assert.equal(result.samples[2].contentHeight, result.samples[4].contentHeight);
  assert.equal(result.samples[1].contentHeight, result.samples[3].contentHeight);
  assert.deepEqual(result.editorSamples.map((sample) => sample.font), ["28px", "22px", "28px", "22px"]);
  assert.ok(result.editorSamples.every((sample) => sample.viewport === 1280 && sample.paneHeight === 600));
  assert.equal(result.menuVisible, true, "Project menu must escape pane clipping");
  assert.equal(result.selected, "Project Two");
  assert.deepEqual(result.spacing.map((sample) => [sample.instancePadding, sample.timerPadding, sample.cardPadding, sample.cardRadius]), [
    ["10px", "16px", "16px", "12px"], ["0px", "10px", "10px", "7px"],
  ]);
  await send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.deepEqual(await evaluate("window.__spacingSamples()"), result.spacing, "Fixed panes must keep spacing when the browser narrows");
  // Exercise the actual observer Java injects, including restored/custom themes.
  const activity = await readFile(new URL("../android/app/src/main/java/local/studykb/MainActivity.java", import.meta.url), "utf8");
  const block = activity.split("view.evaluateJavascript(")[1].split("null")[0];
  const observer = [...block.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => JSON.parse(match[0])).join("");
  const themes = await evaluate(`(async () => {
    const calls = []; window.StudyNative = { onThemeChanged() { calls.push(getComputedStyle(document.documentElement).getPropertyValue('--page').trim()); } };
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.dataset.theme = 'dark'; await frame();
    (0,eval)(${JSON.stringify(observer)});
    document.documentElement.dataset.theme = 'light'; await frame();
    document.documentElement.dataset.theme = 'dark'; await frame();
    document.documentElement.style.setProperty('--page','#abcdef'); await frame();
    return calls;
  })()`);
  assert.deepEqual(themes, ["#f2f0eb", "#0a1814", "#abcdef"]);
  console.log(JSON.stringify({ fixedPaneSpacingAt700px: result.spacing, nativeThemeObserver: themes }));
  console.log("Real Chromium migration smoke passed");
} finally { socket.close(); }
