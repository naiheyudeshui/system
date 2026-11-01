"""Stage a phone-primary Study merge into a NEW file; never write input libraries.

This is deliberately narrower than a general SQLite synchronizer. It merges the
unified knowledge model, immutable review facts and legacy timer data, retaining
the target's installed plugins, files and modern query definitions. Both sides
of changed rows are kept in a portable revision journal. Source attachments need
a dedicated adapter and are rejected rather than silently dropped.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3


FACTS = ("study_knowledge_edit", "study_knowledge_review_log",
         "study_knowledge_review_session", "study_knowledge_review_session_item")


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def readonly(path):
    path = Path(path).resolve(strict=True)
    con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def table_exists(con, table):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone() is not None


def rows(con, table):
    return [dict(row) for row in con.execute(f"SELECT * FROM {quote(table)}")]


def keys(con, table):
    info = sorted(con.execute(f"PRAGMA table_info({quote(table)})"), key=lambda row: row[5])
    return [row[1] for row in info if row[5]]


def validate(con):
    if [row[0] for row in con.execute("PRAGMA integrity_check")] != ["ok"]:
        raise ValueError("Library integrity check failed")
    if con.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("Library contains broken foreign keys")
    graph = {row[0]: row[1] for row in con.execute("SELECT id,parent_id FROM study_knowledge_item")}
    for item in graph:
        visited = set()
        current = item
        while current is not None:
            if current in visited or current not in graph:
                raise ValueError("Knowledge graph has a cycle or missing parent")
            visited.add(current)
            if len(visited) > 256:
                raise ValueError("Knowledge graph exceeds 256 levels")
            current = graph[current]
    if con.execute("SELECT 1 FROM study_knowledge_item i LEFT JOIN study_knowledge_schedule s ON s.item_id=i.id WHERE i.item_type='card' AND s.item_id IS NULL LIMIT 1").fetchone():
        raise ValueError("A knowledge card is missing its schedule")


def _merge_rows(con, source_rows, table, source_hash, *, policy):
    pk = keys(con, table)
    columns = [row[1] for row in con.execute(f"PRAGMA table_info({quote(table)})")]
    if not pk:
        raise ValueError("Merge requires explicit primary keys: " + table)
    result = {"inserted": 0, "updated": 0, "kept": 0, "identical": 0}
    where = " AND ".join(quote(key) + "=?" for key in pk)
    for incoming in source_rows:
        if set(incoming) != set(columns):
            raise ValueError("Source and target schemas differ: " + table)
        identity = tuple(incoming[key] for key in pk)
        found = con.execute(f"SELECT * FROM {quote(table)} WHERE {where}", identity).fetchone()
        if found is None:
            con.execute(f"INSERT INTO {quote(table)}({','.join(map(quote,columns))}) VALUES({','.join('?' for _ in columns)})", tuple(incoming[column] for column in columns))
            result["inserted"] += 1
            continue
        previous = dict(found)
        if previous == incoming:
            result["identical"] += 1
            continue
        if policy == "immutable":
            raise ValueError("Conflicting immutable record: " + table + " " + repr(identity))
        winner = "target" if policy == "target" else "source"
        if policy == "newer":
            if previous["updated_at"] == incoming["updated_at"]:
                raise ValueError("Ambiguous same-time mutable record: " + table + " " + repr(identity))
            winner = "source" if incoming["updated_at"] > previous["updated_at"] else "target"
        con.execute("INSERT OR IGNORE INTO study_library_merge_revision VALUES(?,?,?,?,?,?)",
                    (source_hash, table, canonical(identity), canonical(previous), canonical(incoming), winner))
        if winner == "source":
            fields = [field for field in columns if field not in pk]
            con.execute(f"UPDATE {quote(table)} SET {','.join(quote(field)+'=?' for field in fields)} WHERE {where}",
                        tuple(incoming[field] for field in fields) + identity)
            result["updated"] += 1
        else:
            result["kept"] += 1
    return result


def merge(source, target, output, *, source_is_primary=False, purge_archived_deletions=False):
    if not source_is_primary:
        raise ValueError("Explicitly select the phone as primary for knowledge revisions")
    source, target, output = Path(source).resolve(strict=True), Path(target).resolve(strict=True), Path(output).absolute()
    # Exclusive creation protects every existing file, including either input.
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("xb"):
        pass
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    report = {"sourceSha256": source_hash, "tables": {}, "knowledgePolicy": "phone-primary; previous target revisions retained"}
    with closing(readonly(source)) as src, closing(readonly(target)) as base, closing(sqlite3.connect(output)) as dst:
        dst.row_factory = sqlite3.Row
        validate(src)
        validate(base)
        if table_exists(src, "wb_file_asset") and src.execute("SELECT 1 FROM wb_file_asset LIMIT 1").fetchone():
            raise ValueError("Source contains managed attachments; merge a complete bundle with an attachment adapter")
        # A divergent editing branch needs a separate conflict-resolution plan.
        if table_exists(src, "study_knowledge_edit"):
            source_edits = {row["request_id"]: row for row in rows(src, "study_knowledge_edit")}
            if any(source_edits.get(row["request_id"]) != row for row in rows(base, "study_knowledge_edit")
                   if row["request_id"] != "migration-purge-" + source_hash):
                raise ValueError("Target has independent knowledge edits; refusing an automatic phone-primary merge")
        for table in ("legacy_study_node_archive", "legacy_study_card_archive", "legacy_study_card_fsrs_archive", "legacy_study_review_log_archive"):
            if table_exists(src, table):
                if not table_exists(base, table) or sorted(map(canonical, rows(src, table))) != sorted(map(canonical, rows(base, table))):
                    raise ValueError("Legacy archives differ; explicit migration needed: " + table)
        base.backup(dst)
        dst.execute("PRAGMA foreign_keys=ON")
        dst.execute("BEGIN IMMEDIATE")
        dst.execute("PRAGMA defer_foreign_keys=ON")
        dst.execute("""CREATE TABLE IF NOT EXISTS study_library_merge_revision(
            source_sha256 TEXT NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,
            target_json TEXT NOT NULL,source_json TEXT NOT NULL,selected_side TEXT NOT NULL,
            PRIMARY KEY(source_sha256,table_name,record_key))""")
        def apply(source_table, target_table=None, policy="immutable", selected=None):
            if not table_exists(src, source_table):
                return
            name = target_table or source_table
            data = rows(src, source_table) if selected is None else selected
            report["tables"][name] = _merge_rows(dst, data, name, source_hash, policy=policy)

        apply("study_knowledge_item", policy="source")
        apply("study_knowledge_schedule", policy="newer")
        apply("study_knowledge_scope", policy="target")
        for table in FACTS:
            apply(table)
        apply("workbench_plugin_config", policy="target")
        if table_exists(src, "study_time_session"):
            from study_time_resources import ensure_plugin_resources
            sessions = rows(src, "study_time_session")
            for plugin, kind in (("study.pomodoro", "pomodoro"), ("study.stopwatch", "stopwatch")):
                store = ensure_plugin_resources(dst, plugin)
                if kind == "pomodoro":
                    apply("study_time_project", store["project"], policy="newer")
                data = [row for row in sessions if row["timer_kind"] == kind]
                if kind == "stopwatch":
                    # Current stopwatch holds active state only; completed legacy
                    # facts remain in a separate immutable migration archive.
                    completed = [row for row in data if row["status"] not in ("running", "paused")]
                    if completed:
                        raise ValueError("Completed legacy stopwatch records need an explicit history adapter")
                apply("study_time_session", store["session"], policy="newer", selected=data)
                if kind == "stopwatch":
                    apply("study_stopwatch_lap", store["lap"])
        validate(dst)
        for table in ("study_knowledge_item", *FACTS):
            pk = keys(src, table)
            target_rows = {tuple(row[key] for key in pk): row for row in rows(dst, table)}
            if any(target_rows.get(tuple(row[key] for key in pk)) != row for row in rows(src, table)):
                raise ValueError("Source coverage verification failed: " + table)
        if purge_archived_deletions:
            from study_knowledge_delete import classify_archived_deletions, capture, remove, history
            confirmed, unknown = classify_archived_deletions(dst)
            snapshot = capture(dst, confirmed)
            remove(dst, snapshot)
            if confirmed:
                request_id = "migration-purge-" + source_hash
                dst.execute("INSERT OR IGNORE INTO study_knowledge_edit(request_id,request_hash,operation,before_json,result_json) VALUES(?,?,?,?,?)",
                            (request_id, source_hash, "delete", canonical(history(snapshot)),
                             canonical({"node": {"node_id": snapshot["items"][0]["id"], "deleted": True},
                                        "history_available": True, "deleted_count": len(confirmed), "physical_delete": True})))
            report["purged"] = {"knowledgeItems": len(confirmed), "schedules": len(snapshot["schedules"]),
                                "reviewLogs": len(snapshot["reviews"]), "scopes": len(snapshot["scopes"]),
                                "unclassifiedArchivedItemsRetained": len(unknown)}
            validate(dst)
        report["counts"] = {table: dst.execute(f"SELECT COUNT(*) FROM {quote(table)}").fetchone()[0]
                            for table in ("study_knowledge_item", "study_knowledge_schedule", *FACTS, "workbench_plugin_config")
                            if table_exists(dst, table)}
        report["activeItems"] = dst.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE status='active'").fetchone()[0]
        report["activeCards"] = dst.execute("SELECT COUNT(*) FROM study_knowledge_item WHERE status='active' AND item_type='card'").fetchone()[0]
        report["allSourceActiveKnowledgeExact"] = all(
            dict(dst.execute("SELECT * FROM study_knowledge_item WHERE id=?", (row["id"],)).fetchone()) == row
            for row in rows(src, "study_knowledge_item") if row["status"] == "active")
        dst.commit()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-is-primary", action="store_true")
    parser.add_argument("--purge-archived-deletions", action="store_true",
                        help="physically remove only archived rows traceable to past deletion operations")
    args = parser.parse_args()
    report = merge(args.source, args.target, args.output, source_is_primary=args.source_is_primary,
                   purge_archived_deletions=args.purge_archived_deletions)
    args.output.with_suffix(".merge.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
