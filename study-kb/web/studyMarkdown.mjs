import { marked } from "https://cdn.jsdelivr.net/npm/marked@15.0.7/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.2.4/+esm";

marked.setOptions({ gfm: true, breaks: true });

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
  return {
    refresh() {
      renderMarkdown(getText(), valueEl, { mode });
    },
  };
}
