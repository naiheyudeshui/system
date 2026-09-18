"""Patch 3dStudio workbench API defaults for study-kb (no sales_order / job tables)."""

from __future__ import annotations

from typing import Any

STUDY_METRIC_SQL = {
    "due_cards": "SELECT COUNT(*) FROM v_study_due_cards",
    "active_cards": "SELECT COUNT(*) FROM study_card WHERE status = 'active'",
    "study_nodes": "SELECT COUNT(*) FROM study_node",
    "review_today": (
        "SELECT COUNT(*) FROM study_review_log "
        "WHERE date(reviewed_at) = date('now', 'localtime')"
    ),
}

STUDY_SYSTEM_METRICS = {
    metric_id: {
        "id": metric_id,
        "label": label,
        "sql": STUDY_METRIC_SQL[metric_id],
        "format": "number",
        "system": True,
    }
    for metric_id, label in {
        "due_cards": "今日到期",
        "active_cards": "活跃卡片",
        "study_nodes": "章节节点",
        "review_today": "今日复习",
    }.items()
}

STUDY_DEFAULT_DASHBOARD = {
    "metrics_visible": True,
    "inspector_visible": True,
    "enabled_metrics": list(STUDY_METRIC_SQL.keys()),
    "metric_labels": {},
    "builtin_metric_sql": {},
    "plugin_order": [],
}


def install() -> None:
    import workbench_api as api

    api.SYSTEM_METRIC_DEFINITIONS = STUDY_SYSTEM_METRICS
    api.BUILTIN_METRIC_SQL = dict(STUDY_METRIC_SQL)
    api.DEFAULT_DASHBOARD = dict(STUDY_DEFAULT_DASHBOARD)

    original_metrics = api.metrics

    def metrics(db_path=None) -> dict[str, Any]:
        con = api.connect(db_path)
        try:

            def scalar(sql: str) -> Any:
                row = con.execute(sql).fetchone()
                return row[0] if row else 0

            dashboard = api._dashboard_value(con)
            catalog = api._metric_definition_catalog(con)
            enabled = dashboard.get("enabled_metrics", api.DEFAULT_DASHBOARD["enabled_metrics"])
            if not isinstance(enabled, list):
                enabled = api.DEFAULT_DASHBOARD["enabled_metrics"]
            payload: dict[str, Any] = {"schema": "rsim.study.metrics/v1"}
            for metric_id in enabled:
                definition = catalog.get(str(metric_id))
                if definition:
                    payload[definition["id"]] = scalar(definition["sql"])
            for metric in dashboard.get("custom_metrics", []):
                if metric.get("enabled"):
                    payload[f"custom_{metric['id']}"] = scalar(metric["sql"])
            return payload
        finally:
            con.close()

    api.metrics = metrics

    def command_catalog() -> dict[str, Any]:
        return {"schema": "rsim.study.commands/v1", "commands": []}

    api.command_catalog = command_catalog
