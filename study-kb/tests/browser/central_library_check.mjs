// Real Edge UI acceptance. Only use the isolated central_platform_fixture.py.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [url, source, artifacts] = process.argv.slice(2);
const reinstallMode = process.argv.includes("--reinstall");
const roundtripCurrent = process.argv.includes("--roundtrip-current");
assert.ok(url && new URL(url).hostname === "127.0.0.1" && new URL(url).port !== "8033", "isolated fixture required");
assert.ok(source && existsSync(source) && artifacts);
const folder = resolve(artifacts), downloads = join(folder, "downloads"); mkdirSync(downloads, { recursive: true });
const executable = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const profile = mkdtempSync(join(tmpdir(), "central-library-")), port = 9900 + Math.floor(Math.random() * 100);
const child = spawn(executable, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let socket, sessionId, sequence = 0, navigationCount = 0; const pending = new Map(), errors = [], checks = [], libraryRequests = [];
try {
  let endpoint;
  for (let i = 0; i < 60; i++) { try { endpoint = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; break; } catch { await sleep(100); } }
  socket = new WebSocket(endpoint); await new Promise(r => socket.addEventListener("open", r, { once: true }));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(method + " timed out")), 30000);
    pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(value.error.message)) : resolve(value.result); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId && !method.startsWith("Target.") && !method.startsWith("Browser.") ? { sessionId } : {}) }));
  });
  socket.addEventListener("message", ({ data }) => {
    const value = JSON.parse(data);
    if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); }
    if (value.method === "Runtime.exceptionThrown") errors.push(value.params.exceptionDetails.exception?.description || value.params.exceptionDetails.text);
    if (value.method === "Page.frameNavigated" && !value.params.frame.parentId) navigationCount++;
    if (value.method === "Network.requestWillBeSent" && value.params.request.url.includes('/api/study/library/')) libraryRequests.push({url:value.params.request.url,method:value.params.request.method});
    if (value.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
  });
  const evaluate = async expression => { const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result.value; };
  const waitFor = async expression => { for (let i = 0; i < 200; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(100); } throw new Error("Timed out: " + expression + " body=" + await evaluate("document.body.innerText.slice(0,500)")); };
  const { targetId } = await send("Target.createTarget", { url: "about:blank" }); ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false });
  const installFromInterface = async (ids, expectDisabled = false) => {
    await send("Page.navigate", { url: new URL("/3dworkbench/pluginInstaller.html", url).href });
    await waitFor("document.readyState==='complete'&&!!document.querySelector('.wb-plugin-manager [data-action=scan]:not(:disabled)')");
    await evaluate("document.querySelector('.wb-plugin-manager [data-action=scan]').click()");
    await waitFor("document.querySelectorAll('.wb-plugin-manager article[data-plugin-id]').length>0");
    const candidates = await evaluate("[...document.querySelectorAll('.wb-plugin-manager article[data-plugin-id]')].map(a=>({id:a.dataset.pluginId,installable:!!a.querySelector('[data-action=local-install],[data-action=local-enable]')}))");
    if (expectDisabled) assert.ok(candidates.filter(c => c.id !== 'official.plugin-manager').every(c => c.installable), "restored business plugins require individual installation");
    const requested = ids || candidates.filter(c => c.installable).map(c => c.id);
    for (const id of requested) {
      if (!candidates.find(candidate => candidate.id === id)?.installable) continue;
      await waitFor(`!!document.querySelector('.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-install"]:not(:disabled),.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-enable"]:not(:disabled)')`);
      await evaluate(`document.querySelector('.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-install"],.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-enable"]').click()`);
      await waitFor(`!document.querySelector('.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-install"],.wb-plugin-manager article[data-plugin-id="${id}"] [data-action="local-enable"]')`);
      checks.push({ scenario: "individual-interface-install", pluginId: id, pass: true });
    }
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(folder, ids?.length===1 ? "central-library-bootstrap.png" : "central-plugins-reinstalled.png"), Buffer.from(shot.data, "base64"));
    await send("Page.navigate", { url });
  };
  if (reinstallMode) await installFromInterface(["study.library"]);
  else await send("Page.navigate", { url });
  const openLibrary = async () => {
    await waitFor("!!document.querySelector('.app-launcher-button')");
    await waitFor("document.querySelector('#load-state')?.hidden===true");
    await evaluate("document.querySelector('.app-launcher-button').click()");
    await waitFor(`!!document.querySelector('.wb-launcher-results button[data-application-id="study.library"][data-action="activate"]')`);
    await evaluate(`document.querySelector('.wb-launcher-results button[data-application-id="study.library"][data-action="activate"]').click()`);
    await waitFor("!!document.querySelector('.study-library-sync input[type=file]')");
  };
  const click = text => evaluate(`(()=>{const b=[...document.querySelectorAll('.study-library-sync button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw new Error('Missing action');b.click()})()`);
  await openLibrary();
  const beforeFiles = readdirSync(downloads).filter(n => n.endsWith(".sqlite"));
  const count = beforeFiles.length;
  await click("导出全部数据");
  for (let i = 0; i < 200 && readdirSync(downloads).filter(n => n.endsWith(".sqlite")).length <= count; i++) await sleep(100);
  assert.ok(readdirSync(downloads).filter(n => n.endsWith(".sqlite")).length > count, "export button downloads database");
  checks.push({ scenario: "export-current-library-through-plugin-button", pass: true });
  if (reinstallMode) await evaluate("document.querySelector('input[aria-label=\"导入资料和方案，插件重新安装\"]').checked=true");
  const { root } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: ".study-library-sync input[type=file]" });
  const restoreSource = roundtripCurrent ? join(downloads,readdirSync(downloads).find(n=>n.endsWith('.sqlite')&&!beforeFiles.includes(n))) : resolve(source);
  const beforeRestoreNavigation = navigationCount;
  await send("DOM.setFileInputFiles", { nodeId, files: [restoreSource] });
  if (reinstallMode) {
    for (let i=0;i<200&&!libraryRequests.some(r=>r.url.includes('/api/study/library/import?reinstall_plugins=1'));i++) await sleep(100);
    assert.ok(libraryRequests.some(r=>r.url.includes('/api/study/library/import?reinstall_plugins=1')), "reinstall import mode is sent to server");
  }
  for(let i=0;i<300&&navigationCount<=beforeRestoreNavigation;i++)await sleep(100);
  assert.ok(navigationCount>beforeRestoreNavigation,"successful restore reloads the application");
  await waitFor(`(async()=>{const r=await fetch('/api/object?name=study_knowledge_item&limit=1');const p=await r.json();return r.ok&&(p.total===1253||p.row_count===1253||p.rows?.length>0)})()`);
  checks.push({ scenario: roundtripCurrent ? "restore-exported-current-library-through-file-input-and-confirmation" : "restore-main-snapshot-through-file-input-and-confirmation", pass: true });
  await sleep(400);
  if (reinstallMode) await installFromInterface(null, true);
  await openLibrary();
  const prior = readdirSync(downloads).filter(n => n.endsWith(".sqlite")).length;
  await click("导出全部数据");
  for (let i = 0; i < 200 && readdirSync(downloads).filter(n => n.endsWith(".sqlite")).length <= prior; i++) await sleep(100);
  assert.ok(readdirSync(downloads).filter(n => n.endsWith(".sqlite")).length > prior);
  checks.push({ scenario: "export-restored-library-through-plugin-button", pass: true });
  const shot = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(folder, "central-library-restored.png"), Buffer.from(shot.data, "base64"));
  assert.deepEqual(errors, []);
  const report = { checks, browserErrors: errors, libraryRequests, roundtripCurrent, restoreSource, downloads: readdirSync(downloads).filter(n => n.endsWith(".sqlite")) };
  writeFileSync(join(folder, roundtripCurrent ? "central-library-roundtrip-ui.json" : "central-library-ui.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  writeFileSync(join(folder, "central-library-progress.json"), JSON.stringify({checks,browserErrors:errors,libraryRequests},null,2));
  socket?.close(); child.kill(); await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
