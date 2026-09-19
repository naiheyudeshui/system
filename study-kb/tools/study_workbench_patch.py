"""Patch 3dStudio workbench server for study-kb plugins and API routes."""

from __future__ import annotations

import urllib.parse
from pathlib import Path

STUDY_PLUGIN_ROOT = Path(__file__).resolve().parents[1] / "plugins"


def install() -> None:
    from study_knowledge_edit import KnowledgeConflict
    from study_sql_configs import register_study_modules

    register_study_modules()
    import plugin_host
    import workbench_server

    original_discover = plugin_host.discover_plugins
    original_from = plugin_host._discover_from

    def discover_plugins(root: Path | None = None) -> list[dict]:
        manifests = original_discover(root if root is not None else plugin_host.PLUGIN_ROOT)
        seen = {item["id"] for item in manifests}
        if STUDY_PLUGIN_ROOT.is_dir():
            for item in original_from(STUDY_PLUGIN_ROOT):
                if item["id"] in seen:
                    raise ValueError(f"Duplicate plugin id: {item['id']}")
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
                    if parsed.path == "/api/study/review/catalog":
                        from study_review_engine import review_catalog

                        self.send_json(review_catalog())
                        return
                    if parsed.path.startswith("/api/study/review/session/"):
                        from study_review_engine import get_review_session

                        session_id = parsed.path.removeprefix("/api/study/review/session/").strip("/")
                        self.send_json(get_review_session(session_id))
                        return
                    if parsed.path == "/api/study/tree":
                        params = self._study_query()
                        if params.get("config_id"):
                            from study_sql_configs import sql_tree

                            self.send_json(sql_tree(params["config_id"]))
                            return
                        from study_api import build_node_tree  # noqa: WPS433
                        from study_kb import open_db  # noqa: WPS433

                        params = self._study_query()
                        con = open_db()
                        try:
                            if params.get("model") == "knowledge":
                                from study_api import build_knowledge_tree
                                payload = build_knowledge_tree(con, scope_id=params.get("scope") or None)
                            else:
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
                    if parsed.path in {"/api/study/knowledge/read", "/api/study/knowledge/save"}:
                        from study_knowledge_edit import read_knowledge_node, save_knowledge_node

                        self.require_external_write_auth()
                        payload = self.read_json()
                        operation = read_knowledge_node if parsed.path.endswith("/read") else save_knowledge_node
                        self.send_json(operation(payload))
                        return
                    if parsed.path in {"/api/study/review/sql-preview", "/api/study/review/sql-session"}:
                        from study_sql_configs import sql_review

                        self.require_external_write_auth()
                        payload = self.read_json()
                        self.send_json(sql_review(payload, preview=parsed.path.endswith("sql-preview")))
                        return
                    if parsed.path in {"/api/study/review/preview", "/api/study/review/session", "/api/study/review/session-grade"}:
                        from study_review_engine import grade_session, prepare_review

                        self.require_external_write_auth()
                        payload = self.read_json()
                        if parsed.path.endswith("session-grade"):
                            result = grade_session(
                                session_id=payload.get("session_id"),
                                position=payload.get("position"),
                                rating=payload.get("rating"),
                                elapsed_ms=payload.get("elapsed_ms"),
                            )
                        else:
                            result = prepare_review(payload.get("config"), preview=parsed.path.endswith("preview"))
                        self.send_json(result)
                        return
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
                except KnowledgeConflict as error:
                    self.send_json({"detail": str(error)}, status=409)
                    return
                except PermissionError as error:
                    self.send_json({"detail": str(error)}, status=403)
                    return
                except Exception as error:
                    self.send_json({"detail": str(error)}, status=400)
                    return
                super().do_POST()

        return Handler

    workbench_server.make_handler = make_handler
