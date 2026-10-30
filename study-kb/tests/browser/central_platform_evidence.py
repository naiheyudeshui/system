"""Produce non-content evidence from a completed isolated acceptance fixture."""
from __future__ import annotations
import argparse
import json
import sqlite3
from pathlib import Path
from central_platform_fixture import fingerprint

parser=argparse.ArgumentParser()
parser.add_argument("artifacts",type=Path)
args=parser.parse_args()
folder=args.artifacts.resolve()
source=json.loads((folder/"main-source-inventory.json").read_text(encoding="utf-8"))["tables"]
current=fingerprint(folder/"acceptance.sqlite")
protected=[name for name in source if name.startswith(("study_knowledge_","legacy_study_")) or name in ("study_time_session","study_time_project","study_stopwatch_lap")]
different=[name for name in protected if source[name]!=current.get(name)]
con=sqlite3.connect((folder/"acceptance.sqlite").as_uri()+"?mode=ro",uri=True)
try:
    report={"source_table_count":len(source),"preserved_tables":{name:source[name] for name in protected},
        "unchanged":not different,"different":different,
        "foreign_key_violations":len(con.execute("PRAGMA foreign_key_check").fetchall()),
        "unresolved_dependencies":con.execute("SELECT COUNT(*) FROM wb_dependency_issue").fetchone()[0],
        "timer_migration":[{"plugin_id":r[0],"legacy_rows":r[1],"copied_rows":r[2]} for r in con.execute("SELECT plugin_id,legacy_rows,copied_rows FROM workbench_timer_resource")],
        "private_tables":[row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wbp_%' ORDER BY name")],
        "unit_bindings":[{"plugin_id":r[0],"unit_type":r[1],"units":r[2],"bindings":r[3]} for r in con.execute("""SELECT i.plugin_id,u.unit_type,COUNT(DISTINCT u.id),COUNT(b.resource_id)
            FROM wb_unit_installation i JOIN wb_plugin_unit u ON u.installation_id=i.id LEFT JOIN wb_unit_binding b ON b.unit_id=u.id
            WHERE u.status='active' GROUP BY i.plugin_id,u.unit_type""")],
        "automatic_backups":len(list((folder/"backups").glob("*.sqlite")))}
finally:
    con.close()
roundtrip_path=folder/"central-library-roundtrip-ui.json"
if roundtrip_path.is_file():
    restored_from=Path(json.loads(roundtrip_path.read_text(encoding="utf-8"))["restoreSource"])
    before=fingerprint(restored_from)
    durable=("wb_data_resource","wb_plugin_unit","wb_unit_binding","wb_unit_installation",
        "wb_resource_dependency","wb_resource_delete_receipt","workbench_plugin_config",
        "workbench_plugin_grant","workbench_plugin_layout","workbench_timer_resource",
        "workbench_plugin_collection","workbench_content_learning")
    report["roundtrip_durable_tables"]={name:{"present":name in current,"rows":current.get(name,{}).get("rows",0),"unchanged":before.get(name)==current.get(name)} for name in durable}
    def installed_state(path):
        con=sqlite3.connect(path.as_uri()+"?mode=ro",uri=True)
        con.row_factory=sqlite3.Row
        try:
            return [{key:row[key] for key in row.keys() if key!="updated_at"} for row in con.execute("SELECT * FROM workbench_plugin ORDER BY plugin_id")]
        finally:
            con.close()
    report["roundtrip_install_state_unchanged"]=installed_state(restored_from)==installed_state(folder/"acceptance.sqlite")
(folder/"central-platform-data-integrity.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
assert not different and report["foreign_key_violations"]==0 and report["unresolved_dependencies"]==0
assert all(item["unchanged"] for item in report.get("roundtrip_durable_tables",{}).values())
assert report.get("roundtrip_install_state_unchanged",True)
