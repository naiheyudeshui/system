import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { renderMarkdown, attachMarkdownToggle } = await import("../web/studyMarkdown.mjs?test=20261028-main-port1");

function render(source) {
  const target = document.createElement("div");
  renderMarkdown(source, target);
  return target;
}

test("renders common TeX symbols without leaving commands in the document", () => {
  const target = render("$\\lambda_1 + \\mu + \\infty + \\rightarrow$");
  assert.equal(target.querySelector('[role="math"]')?.textContent, "λ1 + μ + ∞ + →");
  assert.equal(target.querySelector("sub")?.textContent, "1");
  assert.doesNotMatch(target.textContent, /\\lambda|\\mu|\\infty|\\rightarrow/);
});

test("renders fractions and keeps table columns balanced inside a scroll region", () => {
  const target = render("$\\frac{1}{\\lambda}$\n\n| short | a much longer cell with readable text |\n| --- | --- |\n| one | two |");
  assert.equal(target.querySelectorAll(".study-math-frac").length, 1);
  const scroll = target.querySelector(".study-table-scroll");
  assert.ok(scroll);
  const columns = scroll.querySelectorAll("colgroup col");
  assert.equal(columns.length, 2);
  assert.ok([...columns].every((column) => /%$/.test(column.style.width)));
  const widths = [...columns].map((column) => Number.parseFloat(column.style.width));
  assert.ok(widths[1] > widths[0]);
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 100) < 0.001);
});

test("Markdown source toggle preserves text and sanitized render drops executable markup", () => {
  const source = '$\\sqrt{2} + \\alphabeta$\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const target = render(source);
  assert.ok(target.querySelector(".study-math-root"));
  assert.match(target.textContent, /\\alphabeta/);
  assert.equal(target.querySelector("script,[onerror]"), null);
  const toolbar = document.createElement("div");
  attachMarkdownToggle(toolbar, target, () => source).refresh();
  toolbar.querySelector("button").click();
  assert.equal(target.textContent, source);
  assert.equal(target.querySelector("img"), null);
  toolbar.querySelector("button").click();
  assert.equal(target.querySelector("script,[onerror]"), null);
});

test("math rendering preserves code examples and escaped dollar signs", () => {
  const target = render('`$\\lambda$`\n\n```text\n$\\alpha$\n```\n\n\\$literal\\$\n\n$$\\sqrt{2}$$');
  assert.deepEqual([...target.querySelectorAll("code")].map((node) => node.textContent.trim()), ["$\\lambda$", "$\\alpha$"]);
  assert.match(target.textContent, /\$literal\$/);
  assert.equal(target.querySelector('code [role="math"]'), null);
  assert.equal(target.querySelectorAll(".study-math-root").length, 1);
});
