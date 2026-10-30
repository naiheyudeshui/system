import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../3dStudio/3dworkbench/web/refreshCoordinator.mjs", import.meta.url), "utf8");
const context = vm.createContext({ console, Promise, TypeError, Boolean });
const module = new vm.SourceTextModule(source, { context });
await module.link(() => {}); await module.evaluate();
const { createRefreshCoordinator } = module.namespace;

test("global refresh is single-flight and calls host plus visible work once", async () => {
  const calls = []; let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = createRefreshCoordinator({
    refreshHost: async ({ reason }) => { calls.push("host:" + reason); await gate; return "ok"; },
    refreshVisible: async ({ reason }) => { calls.push("visible:" + reason); },
    syncBackground: async ({ reason }) => { calls.push("sync:" + reason); },
  });
  const first = coordinator.run({ reason: "global" });
  const second = coordinator.run({ reason: "global" });
  assert.equal(first, second);
  assert.equal(coordinator.running, true);
  release();
  assert.equal(await first, "ok");
  assert.deepEqual(calls, ["sync:global", "host:global", "visible:global"]);
  assert.equal(coordinator.running, false);
});

test("background sync failure is reported but does not prevent host refresh", async () => {
  const phases = []; let hostOptions;
  const coordinator = createRefreshCoordinator({
    refreshHost: async (options) => { hostOptions = options; return 3; },
    syncBackground: async () => { throw new Error("offline"); },
    onStatus: ({ phase }) => phases.push(phase),
  });
  assert.equal(await coordinator.run({ reason: "retry" }), 3);
  assert.equal(hostOptions.reason, "retry");
  assert.equal(hostOptions.syncError.message, "offline");
  assert.deepEqual(phases, ["sync", "sync-error", "host", "visible", "done"]);
});

test("host failure releases the single-flight lock and can be retried", async () => {
  let count = 0;
  const coordinator = createRefreshCoordinator({ refreshHost: async () => { count++; if (count === 1) throw new Error("bad"); return count; } });
  await assert.rejects(coordinator.run(), /bad/);
  assert.equal(coordinator.running, false);
  assert.equal(await coordinator.run(), 2);
});

test("plugin mutations arriving during refresh coalesce into a subsequent catalogue read", async () => {
  let release, reads = 0;
  const calls = [], gate = new Promise(resolve => { release = resolve; });
  const coordinator = createRefreshCoordinator({
    refreshHost: async ({ reason }) => { calls.push(reason); if (++reads === 1) await gate; return reads; },
  });
  const first = coordinator.run({ reason: "global" });
  await Promise.resolve();
  assert.equal(coordinator.run({ reason: "plugins" }), first);
  assert.equal(coordinator.run({ reason: "plugins" }), first);
  release();
  assert.equal(await first, 2);
  assert.deepEqual(calls, ["global", "plugins"]);
  assert.equal(coordinator.running, false);
});
