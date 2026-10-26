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
  assert.deepEqual(catalogTransfers.offers.map((item) => item.type), ["study.table/ref"]);
  assert.deepEqual(gridTransfers.accepts.map((item) => item.type), ["study.table/ref"]);
  assert.equal(gridTransfers.offers, undefined);
  assert.equal(catalogTransfers.accepts, undefined);
});

test("catalog and grid renderers do not import each other or own SQL", async () => {
  const catalog = await fs.readFile(path.join(root, "web", "studyTableCatalog.mjs"), "utf8");
  const grid = await fs.readFile(path.join(root, "web", "studyTableGrid.mjs"), "utf8");
  assert.doesNotMatch(catalog, /studyTableGrid|from\s+["'][^"']*study\.table-grid/);
  assert.doesNotMatch(grid, /studyTableCatalog|from\s+["'][^"']*study\.table-catalog/);
  assert.doesNotMatch(catalog, /INSERT|UPDATE|DELETE|CREATE\s+VIEW/i);
  assert.doesNotMatch(grid, /INSERT|UPDATE|DELETE|CREATE\s+VIEW/i);
  assert.doesNotMatch(grid, /selectObject|workbench:table-selection/);
  assert.match(grid, /\/api\/object\?/);
  assert.match(grid, /instanceId.*study\.table-grid/);
  assert.match(grid, /renderObjectGrid/);
  assert.match(grid, /renderObjectInspector/);
  assert.doesNotMatch(grid, /register\("study\.table-grid"/);
  assert.match(catalog, /renderObjectNavigator/);
  assert.match(catalog, /dispatchToAcceptors/);
  assert.doesNotMatch(catalog, /selectObject/);
});

test("study shell no longer relies on a legacy template holder", async () => {
  const index = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const app = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.doesNotMatch(index, /wb-legacy-workspace|wb-legacy-holder/);
  assert.doesNotMatch(app, /mountLegacyWorkspaceTemplate/);
  assert.match(index, /wb-workspace-staging/);
});
