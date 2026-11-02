import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { checkPaneContract } from "../../3dStudio/3dworkbench/contracts/paneContract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "web");
const label = (file) => relative(root, file).replaceAll("\\", "/");

const viewportScript = readFileSync(join(web, "mobileViewport.js"), "utf8");
function viewport(bridge) {
  const meta = { content: "width=device-width, initial-scale=1" };
  const document = { querySelector: () => meta, documentElement: { dataset: {} } };
  runInNewContext(viewportScript, { window: { StudyNative: bridge }, document });
  return { meta, dataset: document.documentElement.dataset };
}

test("Android starts at 85 percent viewport zoom and leaves ordinary browsers unchanged", () => {
  assert.equal(viewport({ contentScalePercent: () => 85 }).meta.content, "width=device-width, initial-scale=0.85");
  assert.equal(viewport({ contentScalePercent: () => 85 }).dataset.studyContentScale, "0.85");
  assert.equal(viewport().meta.content, "width=device-width, initial-scale=1");
  assert.equal(viewport({ onThemeChanged() {} }).meta.content, "width=device-width, initial-scale=1");
});

test("invalid or unavailable Android scale preferences retain a usable default viewport", () => {
  for (const value of [0, 59, 101, NaN, Infinity, "bad"]) {
    assert.equal(viewport({ contentScalePercent: () => value }).meta.content, "width=device-width, initial-scale=1");
  }
  assert.equal(viewport({ contentScalePercent() { throw Error("unavailable"); } }).meta.content, "width=device-width, initial-scale=1");
});

test("Study plugins are laid out and styled by their BSP pane", () => {
  const plugins = join(root, "plugins");
  const result = checkPaneContract({
    manifests: readdirSync(plugins).map((name) => join(plugins, name, "plugin.json")),
    stylesheets: readdirSync(web).filter((name) => name.endsWith(".css")).map((name) => join(web, name)),
    // Plugin renderer modules.  app.js is the host entry point.
    modules: readdirSync(web).filter((name) => /^study.+\.mjs$/.test(name)).map((name) => join(web, name)),
    baseline: JSON.parse(readFileSync(join(root, "tests/pane-contract-baseline.json"), "utf8")),
  }, label);
  assert.deepEqual(result.added, [], "new pane-contract violations");
  assert.deepEqual(result.stale, [], "fixed violations must be removed from tests/pane-contract-baseline.json");
});
