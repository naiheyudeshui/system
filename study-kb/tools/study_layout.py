"""Study BSP layout: the default workspace and migrations of retired leaves."""

from __future__ import annotations

from workbench_plugins import bsp_leaf, bsp_split, register_leaf_migration, set_default_layout

CATALOG_RATIO = 0.25


def table_pair(suffix="1"):
    """Table catalog on the left, the grid it feeds on the right."""
    return bsp_split(
        bsp_leaf("study.table-catalog", f"study.table-catalog#{suffix}"),
        bsp_leaf("study.table-grid", f"study.table-grid#{suffix}"),
        ratio=CATALOG_RATIO,
    )


def _instance_suffix(leaf):
    # "core.table#1" -> "core-1": unique per retired leaf and distinct from
    # instances the user created from the Dock ("#1", "#<timestamp>").
    return "core-" + str(leaf.get("instanceId", "")).rsplit("#", 1)[-1]


def register_study_layout():
    set_default_layout(table_pair())
    # core.table wrapped the legacy fixed table shell; the two table plugins
    # replace it.  core.metrics was the empty metrics shell before study.metrics.
    register_leaf_migration("core.table", lambda leaf: table_pair(_instance_suffix(leaf)))
    register_leaf_migration("core.metrics", lambda leaf: bsp_leaf("study.metrics", f"study.metrics#{_instance_suffix(leaf)}"))
