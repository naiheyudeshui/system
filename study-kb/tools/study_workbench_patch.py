"""Patch 3dStudio workbench server for study-kb plugins and API routes."""

from __future__ import annotations

import urllib.parse
from pathlib import Path

STUDY_PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "plugins"


def install() -> None:
    import plugin_host
    import workbench_server

    original_discover = plugin_host.discover_plugins
    original_from = plugin_host._discover_from

    def discover_plugins(root: Path | None = None) -> list[dict]:
        manifests = original_discover(root if root is not None else plugin_host.PLUGIN_ROOT)
        seen = {item["id"] for item in manifests}
        if STUDY_PLUGIN_ROOT.is_dir():
            for item in original_from(STUDY_PLUGIN_ROOT):
                if item["id"] not in seen:
                    manifests.append(item)
                    seen.add(item["id"])
        return manifests

    plugin_host.discover_plugins = discover_plugins

    original_make = workbench_server.make_handler

    def make_handler(web_root: Path, api_token: str | None = None):
        BaseHandler = original_make(web_root, api_token)

        class Handler(BaseHandler):
            def _study_query(self) -> dict[str, str]:
                parsed = urllib.parse.urlparse(self.path)
                return {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items() if values}

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlparse(self.path)
                try:
                    if parsed.path == "/api/study/tree":
                        from study_api import build_node_tree  # noqa: WPS433
                        from study_kb import open_db  # noqa: WPS433

                        params = self._study_query()
                        con = open_db()
                        try:
                            payload = build_node_tree(con, scope_id=params.get("scope") or None)
                        finally:
                            con.close()
                        self.send_json(payload)
                        return
                    if parsed.path == "/api/study/markmap":
                        from study_api import get_markmap  # noqa: WPS433

                        params = self._study_query()
                        self.send_json(
                            get_markmap(
                                scope_id=params.get("scope") or None,
                                root_id=params.get("root") or None,
                            )
                        )
                        return
                    if parsed.path.startswith("/api/study/card/"):
                        from study_api import get_card_detail  # noqa: WPS433

                        card_id = parsed.path.removeprefix("/api/study/card/").strip("/")
                        if not card_id:
                            raise ValueError("card id is required")
                        self.send_json(get_card_detail(card_id))
                        return
                    if parsed.path.startswith("/api/study/node/"):
                        from study_api import get_node_detail  # noqa: WPS433

                        node_id = parsed.path.removeprefix("/api/study/node/").strip("/")
                        if not node_id:
                            raise ValueError("node id is required")
                        self.send_json(get_node_detail(node_id))
                        return
                    if parsed.path == "/api/study/review/next":
                        from study_api import next_review_card  # noqa: WPS433

                        params = self._study_query()
                        self.send_json(
                            next_review_card(
                                view=params.get("view") or "v_study_due_cards",
                                scope_id=params.get("scope") or None,
                            )
                        )
                        return
                except Exception as error:
                    self.send_json({"detail": str(error)}, status=400)
                    return
                super().do_GET()

            def do_POST(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlparse(self.path)
                try:
                    if parsed.path == "/api/study/review/grade":
                        from study_api import grade_review_card  # noqa: WPS433

                        payload = self.read_json()
                        card_id = str(payload.get("card_id") or "").strip()
                        rating = int(payload.get("rating") or 0)
                        if not card_id or rating not in {1, 2, 3, 4}:
                            raise ValueError("card_id and rating (1-4) are required")
                        elapsed_ms = payload.get("elapsed_ms")
                        result = grade_review_card(
                            card_id=card_id,
                            rating=rating,
                            elapsed_ms=int(elapsed_ms) if elapsed_ms not in {None, ""} else None,
                            view=str(payload.get("view") or "v_study_due_cards"),
                            scope_id=str(payload.get("scope_id") or "") or None,
                        )
                        self.send_json(result)
                        return
                except Exception as error:
                    self.send_json({"detail": str(error)}, status=400)
                    return
                super().do_POST()

        return Handler

    workbench_server.make_handler = make_handler
