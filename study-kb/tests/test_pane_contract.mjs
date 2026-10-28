import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPaneContract } from "../../3dStudio/3dworkbench/contracts/paneContract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = join(root, "web");
const label = (file) => relative(root, file).replaceAll("\\", "/");

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
