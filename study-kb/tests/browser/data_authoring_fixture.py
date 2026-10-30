"""Disposable HTTP fixture for real-browser authoring checks. Stop with stdin."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import sys
import tempfile
import threading

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / "study-kb/tools"))
from study_kb import open_db
import serve_workbench

with tempfile.TemporaryDirectory(prefix="study-authoring-browser-") as folder:
    database = Path(folder) / "fixture.sqlite"
    # study_kb imported connect before the HTTP shim; pin its original module's
    # default too, so product routes and shared routes use the same fixture.
    import db
    db.DB_PATH = database
    con = open_db(database)
    with con:
        con.execute("CREATE TABLE fixture_existing_nodes(node_id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,content_md TEXT)")
        con.executemany("INSERT INTO fixture_existing_nodes VALUES (?,?,?,?)", [("r", None, "Existing root", "Existing content"), ("c", "r", "Existing child", "")])
    con.close()
    check = open_db()
    assert Path(check.execute("PRAGMA database_list").fetchone()[2]).resolve() == database.resolve()
    check.close()
    serve_workbench.STUDY_DB = database
    serve_workbench._install_db_shim()
    serve_workbench._install_workbench_study_shim()
    import study_workbench_patch
    study_workbench_patch.install()
    import workbench_server
    server = ThreadingHTTPServer(("127.0.0.1", 0), workbench_server.make_handler(root / "study-kb/web"))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    print(json.dumps({"url": "http://127.0.0.1:" + str(server.server_address[1]), "database": str(database)}), flush=True)
    try:
        sys.stdin.readline()
    finally:
        server.shutdown(); server.server_close(); thread.join()
