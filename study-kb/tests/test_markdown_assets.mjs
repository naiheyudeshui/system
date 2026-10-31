import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<html><body><div id='body'></div><div id='tools'></div></body></html>", { url: "http://localhost:18034" });
globalThis.window = dom.window; globalThis.document = dom.window.document;
const { renderMarkdown, markdownAssetIds, attachAssetImport } = await import("../web/studyMarkdown.mjs");
const id = "52bac056-4cb6-4f75-81d3-655c35e2ecfb";
test("Markdown AST resolves image and reference links but preserves source and code", () => {
  const source = `![图](wb-asset://${id})\n\n[PDF][doc]\n\n[doc]: wb-asset://${id}\n\n\`wb-asset://${id}\`\n\n<img src=x onerror=alert(1)>`;
  const target = document.getElementById("body"); renderMarkdown(source, target);
  assert.equal(target.querySelector("img").getAttribute("src"), `/api/platform/files/${id}/content`);
  assert.equal(target.querySelector("a").getAttribute("href"), `/api/platform/files/${id}/content`);
  assert.equal(target.querySelector("code").textContent, `wb-asset://${id}`);
  assert.equal(target.querySelector("[onerror]"), null);
  assert.deepEqual(markdownAssetIds(source), [id]);
  renderMarkdown(source, target, { mode: "source" }); assert.equal(target.textContent, source);
});
test("copying an attachment inserts only Markdown and does not submit the note", async () => {
  const tools = document.getElementById("tools"), calls = [], statuses = [];
  let body = "原文";
  const files = { status: async () => ({ initialized: true }), upload: async file => { calls.push(file); return { asset: { assetId: id } }; } };
  const editor = attachAssetImport(tools, { files, getText: () => body, setText: text => { body = text; }, onStatus: text => statuses.push(text) });
  const input = tools.querySelector("input"), file = new dom.window.File(["image"], "图.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file] }); input.dispatchEvent(new dom.window.Event("change"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(body, `原文\n\n![图.png](wb-asset://${id})`);
  assert.match(statuses.at(-1), /请保存正文/);
  editor.dispose(); assert.equal(tools.children.length, 0);
});
