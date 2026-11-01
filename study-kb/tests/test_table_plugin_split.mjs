import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readManifest = async (id) => JSON.parse(await fs.readFile(path.join(root, "plugins", id, "plugin.json"), "utf8"));

test("table catalog/grid are independent plugins with a directional transfer contract", async () => {
  const catalog = await readManifest("study.table-catalog");
  const grid = await readManifest("study.table-grid");
  const catalogTransfers = catalog.contributes.transfers;
  const gridTransfers = grid.contributes.transfers;
  assert.deepEqual(catalogTransfers.offers.map((item) => item.type), ["workbench.table/ref"]);
  assert.deepEqual(gridTransfers.accepts.map((item) => item.type), ["workbench.table/ref"]);
  assert.deepEqual(gridTransfers.offers.map((item) => item.type), ["workbench.row/ref"]);
  assert.equal(catalogTransfers.accepts, undefined);
});

test("catalog and grid renderers do not import each other or own SQL", async () => {
  const components = path.join(root, "..", "3dStudio", "3dworkbench", "web", "components");
  const catalog = await fs.readFile(path.join(components, "tableCatalog.mjs"), "utf8");
  const grid = await fs.readFile(path.join(components, "tableGrid.mjs"), "utf8");
  assert.doesNotMatch(catalog, /tableGrid/);
  assert.doesNotMatch(grid, /tableCatalog/);
  assert.doesNotMatch(catalog + grid, /study/, "shared components know no product");
  const mutatingSql = /\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+VIEW)\b/i;
  assert.doesNotMatch(catalog, mutatingSql);
  assert.doesNotMatch(grid, mutatingSql);
  assert.doesNotMatch(grid, /selectObject|workbench:table-selection/);
  assert.match(grid, /\/api\/object\?/);
  assert.match(grid, /pluginId\}::\$\{context\.instanceId/);
  assert.match(grid, /renderObjectGrid/);
  assert.doesNotMatch(grid, /renderObjectInspector/, 'definitions and SQL belong to shared settings');
  assert.match(catalog, /renderObjectNavigator/);
  assert.match(catalog, /dispatchToAcceptors/);
  assert.doesNotMatch(catalog, /selectObject/);
});

test("study shell is a top bar and one BSP workspace", async () => {
  const index = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const app = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.doesNotMatch(index, /wb-legacy-workspace|wb-legacy-holder|wb-workspace-staging|left-column|right-column|data-pane|inspector-|metric-strip/);
  assert.doesNotMatch(app, /mountLegacyWorkspaceTemplate|selectObject|setupEdgeToggle|setupSidebarCollapse|setupWorkbenchSplitters|core\.table|7740/);
  assert.match(app, /createPluginWorkspace\(\{[\s\S]*container:[\s\S]*renderers:/);
});
