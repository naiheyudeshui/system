import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;");

function balancedGroup(source, open) {
  if (source[open] !== "{") return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return [source.slice(open + 1, index), index + 1];
  }
  return null;
}

const MATH_SYMBOLS = [
  ["varepsilon", "ε"], ["vartheta", "ϑ"], ["varsigma", "ς"], ["varrho", "ϱ"], ["varphi", "ϕ"], ["varpi", "ϖ"],
  ["rightarrow", "→"], ["leftarrow", "←"], ["therefore", "∴"], ["infty", "∞"], ["equiv", "≡"], ["approx", "≈"],
  ["lambda", "λ"], ["Lambda", "Λ"], ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["Gamma", "Γ"],
  ["delta", "δ"], ["Delta", "Δ"], ["epsilon", "ε"], ["zeta", "ζ"], ["theta", "θ"], ["Theta", "Θ"],
  ["iota", "ι"], ["kappa", "κ"], ["sigma", "σ"], ["Sigma", "Σ"], ["omega", "ω"], ["Omega", "Ω"],
  ["times", "×"], ["cdot", "·"], ["ldots", "…"], ["cdots", "⋯"], ["dots", "…"], ["prod", "∏"],
  ["sum", "∑"], ["neq", "≠"], ["leq", "≤"], ["geq", "≥"], ["phi", "φ"], ["Phi", "Φ"],
  ["psi", "ψ"], ["Psi", "Ψ"], ["rho", "ρ"], ["tau", "τ"], ["eta", "η"], ["chi", "χ"], ["div", "÷"],
  ["pm", "±"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"], ["Xi", "Ξ"], ["pi", "π"], ["Pi", "Π"],
  ["le", "≤"], ["ge", "≥"], ["to", "→"], ["in", "∈"], ["left", ""], ["right", ""],
];
const mathSymbolMap = new Map(MATH_SYMBOLS);
const mathSymbolPattern = new RegExp(
  `\\\\(?:${MATH_SYMBOLS.map(([name]) => name).sort((left, right) => right.length - left.length).join("|")})(?![A-Za-z])`,
  "g",
);

function replaceMathSymbols(value) {
  mathSymbolPattern.lastIndex = 0;
  return value.replace(mathSymbolPattern, (match) => mathSymbolMap.get(match.slice(1)) ?? match);
}

function latexToHtml(source) {
  let value = String(source ?? "").trim();
  const fragments = [];
  const stash = (html) => `\u0000${fragments.push(html) - 1}\u0000`;
  let index = 0;
  while ((index = value.indexOf("\\frac", index)) >= 0) {
    const first = balancedGroup(value, index + 5);
    const second = first && balancedGroup(value, first[1]);
    if (!second) { index += 5; continue; }
    value = value.slice(0, index) + stash(`<span class="study-math-frac"><span class="study-math-num">${latexToHtml(first[0])}</span><span class="study-math-den">${latexToHtml(second[0])}</span></span>`) + value.slice(second[1]);
    index += 1;
  }
  index = 0;
  while ((index = value.indexOf("\\text", index)) >= 0) {
    const group = balancedGroup(value, index + 5);
    if (!group) { index += 5; continue; }
    value = value.slice(0, index) + stash(`<span class="study-math-text">${escapeHtml(group[0]).replace(/\\%/g, "%")}</span>`) + value.slice(group[1]);
    index += 1;
  }
  for (const command of ["mathrm", "mathbf", "mathit", "underline", "overline"]) {
    index = 0;
    while ((index = value.indexOf(`\\${command}`, index)) >= 0) {
      const group = balancedGroup(value, index + command.length + 1);
      if (!group) { index += command.length + 1; continue; }
      const className = command === "mathbf" ? "study-math-bold" : command === "underline" ? "study-math-underline" : command === "overline" ? "study-math-overline" : "study-math-text";
      value = value.slice(0, index) + stash(`<span class="${className}">${latexToHtml(group[0])}</span>`) + value.slice(group[1]);
      index += 1;
    }
  }
  index = 0;
  while ((index = value.indexOf("\\sqrt", index)) >= 0) {
    const group = balancedGroup(value, index + 5);
    if (!group) { index += 5; continue; }
    value = value.slice(0, index) + stash(`<span class="study-math-root">√<span>${latexToHtml(group[0])}</span></span>`) + value.slice(group[1]);
    index += 1;
  }
  let html = replaceMathSymbols(escapeHtml(value))
    .replace(/\\%/g, "%").replace(/\\,/g, " ")
    .replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>")
    .replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>")
    .replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>")
    .replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>")
    .replace(/[{}]/g, "");
  html = html.replace(/\u0000(\d+)\u0000/g, (_, fragment) => fragments[Number(fragment)] || "");
  return `<span class="study-math" role="math">${html}</span>`;
}

// Let the Markdown lexer recognize math, so literal dollars inside fenced
// code, inline code, and escaped text retain their original meaning.
marked.use({ extensions: [{
  name: "studyMath", level: "inline",
  start: (source) => source.indexOf("$"),
  tokenizer(source) {
    const match = /^\$\$([\s\S]+?)\$\$|^\$([^$\n]+?)\$/.exec(source);
    if (match) return { type: "studyMath", raw: match[0], text: match[1] ?? match[2] };
  },
  renderer: (token) => latexToHtml(token.text),
}] });

function balanceTableColumns(table) {
  const rows = [...table.rows];
  if (!rows.length) return;
  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  if (!columnCount) return;
  const lengths = Array.from({ length: columnCount }, (_, column) => Math.min(160, Math.max(1, ...rows.map((row) => {
    const cell = row.cells[column];
    return cell ? cell.textContent.trim().replace(/\s+/g, " ").length : 0;
  }))));
  const weights = lengths.map((length) => 2 + Math.sqrt(length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const colgroup = document.createElement("colgroup");
  for (const weight of weights) {
    const col = document.createElement("col");
    col.style.width = `${(weight / total) * 100}%`;
    colgroup.append(col);
  }
  table.querySelector("colgroup")?.remove();
  table.prepend(colgroup);
}

export function renderMarkdown(text, targetEl, { mode = "render" } = {}) {
  if (!targetEl) return;
  const raw = String(text ?? "").trim();
  if (mode === "source") {
    targetEl.textContent = raw || "—";
    targetEl.classList.remove("study-md");
    return;
  }
  if (!raw) {
    targetEl.innerHTML = '<span class="study-md-empty">—</span>';
    targetEl.classList.add("study-md");
    return;
  }
  const html = DOMPurify.sanitize(marked.parse(raw), { USE_PROFILES: { html: true } });
  targetEl.innerHTML = html;
  targetEl.classList.add("study-md");
  for (const table of targetEl.querySelectorAll("table")) {
    balanceTableColumns(table);
    if (table.parentElement?.classList.contains("study-table-scroll")) continue;
    const scroll = document.createElement("div");
    scroll.className = "study-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "可横向滚动的表格");
    table.before(scroll);
    scroll.append(table);
  }
}

export function attachMarkdownToggle(toolbar, valueEl, getText) {
  let mode = "render";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "study-md-toggle";
  btn.textContent = "源码";
  btn.title = "在 Markdown 渲染与源码之间切换";
  btn.addEventListener("click", () => {
    mode = mode === "render" ? "source" : "render";
    btn.textContent = mode === "render" ? "源码" : "渲染";
    renderMarkdown(getText(), valueEl, { mode });
  });
  toolbar.append(btn);
  return { refresh: () => renderMarkdown(getText(), valueEl, { mode }) };
}
