"""Parse Agent Markdown outlines into study_node trees."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*(?:<!--\s*(outline|topic)(?::\s*(\w+))?\s*-->)?\s*$")
ROLE_COMMENT = re.compile(r"<!--\s*(outline|topic)(?::\s*(\w+))?\s*-->")

KIND_BY_DEPTH = ["book", "chapter", "section", "topic", "group", "group"]


@dataclass
class ParsedNode:
    title: str
    role: str = "outline"
    kind: str = "section"
    answer_md: str = ""
    source_ref: str = ""
    sort_order: int = 0
    children: list[ParsedNode] = field(default_factory=list)


def _kind_for_depth(depth: int, role: str) -> str:
    if role == "topic":
        return "topic"
    return KIND_BY_DEPTH[min(depth, len(KIND_BY_DEPTH) - 1)]


def parse_outline_markdown(text: str) -> list[ParsedNode]:
    """Parse markdown headings + following paragraph as topic answer_md."""
    roots: list[ParsedNode] = []
    stack: list[tuple[int, ParsedNode]] = []
    pending_answer: list[str] = []
    sort_counters: dict[str | None, int] = {}

    def attach(node: ParsedNode, depth: int) -> None:
        while stack and stack[-1][0] >= depth:
            stack.pop()
        if stack:
            parent = stack[-1][1]
            parent_key = id(parent)
            order = sort_counters.get(parent_key, 0)
            sort_counters[parent_key] = order + 1
            node.sort_order = order
            parent.children.append(node)
        else:
            root_key = None
            order = sort_counters.get(root_key, 0)
            sort_counters[root_key] = order + 1
            node.sort_order = order
            roots.append(node)
        stack.append((depth, node))

    def flush_answer() -> None:
        nonlocal pending_answer
        if not pending_answer or not stack:
            pending_answer = []
            return
        answer = "\n".join(pending_answer).strip()
        pending_answer = []
        if answer:
            stack[-1][1].answer_md = answer
            if stack[-1][1].role == "outline":
                stack[-1][1].role = "topic"

    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            continue
        match = HEADING.match(line)
        if match:
            flush_answer()
            depth = len(match.group(1))
            title = match.group(2).strip()
            role = match.group(3) or "outline"
            kind_hint = match.group(4)
            kind = kind_hint or _kind_for_depth(depth - 1, role)
            node = ParsedNode(title=title, role=role, kind=kind)
            attach(node, depth)
            continue
        if line.lstrip().startswith("- ") or line.lstrip().startswith("* "):
            pending_answer.append(line)
            continue
        if not stack:
            continue
        pending_answer.append(line)

    flush_answer()
    return roots


def parsed_to_import_dict(nodes: list[ParsedNode]) -> list[dict[str, Any]]:
    def convert(node: ParsedNode) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "title": node.title,
            "kind": node.kind,
            "role": node.role,
            "answer_md": node.answer_md,
            "source_ref": node.source_ref,
            "sort_order": node.sort_order,
        }
        if node.children:
            payload["children"] = [convert(child) for child in node.children]
        return payload

    return [convert(node) for node in nodes]
