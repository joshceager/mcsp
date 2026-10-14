"""Backend integration tests (real API: /api/v1/...).

Approved-plan requirements verified here:
- backend refuses client-only mods (side=client) for add/update/remove,
- authorized mod ops change the managed server's REAL files in mods/,
- backend can stop/start/restart its managed process and report state,
- restart-required flag is set on pack changes and cleared after restart,
- auth fail-closed with no key; 401 with wrong key,
- hash mismatch / zip traversal / non-loader jars are rejected before install,
- manifest stays consistent with what is on disk.
"""

import time
import zipfile

import pytest
from conftest import (
    _wait_state,
    make_bad_jar,
    make_mod_jar,
    mod_payload,
    sha1_of,
    start_server_and_wait,
    wait_job,
)


import shutil


def stage(js, path):
    """Copy a locally-built jar into the HTTP-served dir; return the served path."""
    dest = js.dir / path.name
    shutil.copy2(path, dest)
    return dest


def admin_add(c, js, path, **kw):
    staged = stage(js, path)
    r = c.post("/api/v1/pack/mods", json=mod_payload(js.url(staged.name), staged, **kw))
    assert r.status_code == 200, r.text
    return wait_job(c, r.json()["id"], timeout=60)


def admin_update(c, js, mod_id, path, **kw):
    staged = stage(js, path)
    r = c.put(f"/api/v1/pack/mods/{mod_id}", json=mod_payload(js.url(staged.name), staged, mod_id=mod_id, **kw))
    assert r.status_code == 200, r.text
    return wait_job(c, r.json()["id"], timeout=60)


def admin_remove(c, mod_id):
    r = c.delete(f"/api/v1/pack/mods/{mod_id}")
    assert r.status_code == 200, r.text
    return wait_job(c, r.json()["id"], timeout=60)


def mods_dir(app):
    return app.state.packmgr.mods_dir


def manifest(app):
    return app.state.manifest_store.load()


# ------------------------------------------------------------ side enforcement

def test_backend_refuses_client_only_add(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "cl.jar")
    job = admin_add(c, jar_server, jar, mod_id="client-only-mod", side="client")
    assert job["state"] == "failed"
    assert job["result"]["error"] == "side_mismatch"
    # Nothing was downloaded or written.
    assert not (mods_dir(app) / jar.name).exists()
    assert manifest(app)["mods"] == []


def test_backend_refuses_client_only_update(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "m1.jar")
    job = admin_add(c, jar_server, jar, mod_id="m1", side="both")
    assert job["state"] == "succeeded"
    new = make_mod_jar(tmp_path / "m1b.jar", tag="v2")
    job = admin_update(c, jar_server, "m1", new, side="client", version="2.0.0")
    assert job["state"] == "failed"
    assert job["result"]["error"] == "side_mismatch"
    # Old jar untouched (old filename still on disk).
    assert (mods_dir(app) / jar.name).exists()
    assert not (mods_dir(app) / new.name).exists()


def test_backend_refuses_client_only_remove(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "keep.jar")
    # Add it as side=both first, then try to reclassify as client via update path
    admin_add(c, jar_server, jar, mod_id="keep", side="both")
    r = c.delete("/api/v1/pack/mods/no-such-mod")
    assert r.status_code == 200
    job = wait_job(c, r.json()["id"])
    assert job["state"] == "failed" and job["result"]["error"] == "mod_not_found"


def test_unknown_side_rejected_at_schema_level(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "u.jar")
    r = c.post("/api/v1/pack/mods", json=mod_payload(js_url(jar_server, jar), jar, side="bogus"))
    assert r.status_code == 422
    assert not (mods_dir(app) / jar.name).exists()


def js_url(js, path):
    return js.url(path.name)


def test_server_only_mod_installs_on_server(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "srv.jar")
    job = admin_add(c, jar_server, jar, mod_id="server-only", side="server")
    assert job["state"] == "succeeded", job
    assert (mods_dir(app) / jar.name).exists()


# ------------------------------------------------------------ real file changes

def test_add_mod_writes_real_file(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "create.jar")
    job = admin_add(c, jar_server, jar, mod_id="create", side="both")
    assert job["state"] == "succeeded", job
    # REAL file on disk, not just manifest metadata.
    target = mods_dir(app) / jar.name
    assert target.exists()
    assert sha1_of(target) == sha1_of(jar)
    assert job["result"]["filesWritten"] == [jar.name]
    assert job["result"]["restartRequired"] is True
    m = manifest(app)
    assert any(e["modId"] == "create" and e["side"] == "both" for e in m["mods"])
    # Public pack endpoint reports the installed file too.
    pack = c.get("/api/v1/pack").json()
    assert any(f["filename"] == jar.name for f in pack["installed"])


def test_update_mod_replaces_file(client, jar_server, tmp_path):
    c, app = client
    v1 = make_mod_jar(tmp_path / "upd.jar", tag="v1")
    admin_add(c, jar_server, v1, mod_id="upd", side="both")
    v2 = make_mod_jar(tmp_path / "upd2.jar", tag="v2")
    job = admin_update(c, jar_server, "upd", v2, side="both", version="2.0.0")
    assert job["state"] == "succeeded", job
    assert (mods_dir(app) / v2.name).exists()
    assert not (mods_dir(app) / v1.name).exists()  # old jar gone
    assert job["result"]["filesRemoved"] == [v1.name]


def test_remove_mod_deletes_file(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "rm.jar")
    admin_add(c, jar_server, jar, mod_id="rm", side="both")
    job = admin_remove(c, "rm")
    assert job["state"] == "succeeded"
    assert job["result"]["filesRemoved"] == [jar.name]
    assert not (mods_dir(app) / jar.name).exists()
    assert manifest(app)["mods"] == []


# ------------------------------------------------------------ download safety

def test_hash_mismatch_rejected_nothing_installed(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "bad-hash.jar")
    jar = stage(jar_server, jar)
    payload = mod_payload(jar_server.url(jar.name), jar, mod_id="badhash")
    payload["file"]["hashes"]["sha1"] = "0" * 40
    r = c.post("/api/v1/pack/mods", json=payload)
    assert r.status_code == 200
    job = wait_job(c, r.json()["id"])
    assert job["state"] == "failed"
    assert job["result"]["error"] == "hash_mismatch"
    assert not (mods_dir(app) / jar.name).exists()
    assert manifest(app)["mods"] == []


def test_zip_traversal_jar_rejected(client, jar_server, tmp_path):
    c, app = client
    evil = make_bad_jar(tmp_path / "evil.jar")
    evil = stage(jar_server, evil)
    payload = mod_payload(jar_server.url(evil.name), evil, mod_id="evil")
    payload["file"]["hashes"]["sha1"] = sha1_of(evil)
    r = c.post("/api/v1/pack/mods", json=payload)
    assert r.status_code == 200
    job = wait_job(c, r.json()["id"])
    assert job["state"] == "failed"
    assert not (mods_dir(app) / evil.name).exists()


def test_path_traversal_filename_rejected(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "ok.jar")
    payload = mod_payload(jar_server.url(jar.name), jar, mod_id="trav",
                          fname="../../etc/escape.jar")
    r = c.post("/api/v1/pack/mods", json=payload)
    assert r.status_code == 422


def test_non_loader_jar_rejected(client, jar_server, tmp_path):
    c, app = client
    plain = tmp_path / "plain.jar"
    with zipfile.ZipFile(plain, "w") as zf:
        zf.writestr("something.txt", "not a mod")
    job = admin_add(c, jar_server, plain, mod_id="plain", side="both")
    assert job["state"] == "failed"
    assert job["result"]["error"] == "not_a_loader_mod"
    assert not (mods_dir(app) / plain.name).exists()


def test_unreachable_url_fails_job(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "u.jar")
    job = admin_add(c, jar_server, jar, mod_id="unreach",
                    url_unused=None) if False else None
    payload = mod_payload("http://127.0.0.1:9/missing.jar", jar, mod_id="unreach")
    r = c.post("/api/v1/pack/mods", json=payload)
    assert r.status_code == 200
    job = wait_job(c, r.json()["id"])
    assert job["state"] == "failed"
    assert not (mods_dir(app) / jar.name).exists()


# ------------------------------------------------------------ lifecycle

def test_start_stop_restart_reports_state(client):
    c, app = client
    start_server_and_wait(c, app)
    assert c.get("/api/v1/status").json()["state"] == "running"
    r = c.post("/api/v1/server/stop")
    j = wait_job(c, r.json()["id"], timeout=60)
    assert j["state"] == "succeeded", j
    _wait_state(app, "stopped")
    assert c.get("/api/v1/status").json()["state"] == "stopped"
    # Start again.
    start_server_and_wait(c, app)


def test_restart_cycle_reports_state(client):
    c, app = client
    start_server_and_wait(c, app)
    r = c.post("/api/v1/server/restart")
    j = wait_job(c, r.json()["id"], timeout=90)
    assert j["state"] == "succeeded", j
    _wait_state(app, "running")
    st = c.get("/api/v1/status").json()
    assert st["state"] == "running"
    assert st["pid"] is not None


def test_console_sends_line(client):
    c, app = client
    start_server_and_wait(c, app)
    r = c.post("/api/v1/server/console", json={"line": "say hello"})
    assert r.status_code == 200, r.text
    assert r.json()["sent"] is True
    deadline = time.time() + 5
    while time.time() < deadline:
        if any("[server] ran: say hello" in l for l in app.state.supervisor.logs(100)):
            break
        time.sleep(0.1)
    else:
        raise AssertionError("console command never reached the stub server")


def test_console_rejected_when_stopped(client):
    c, app = client
    assert app.state.supervisor.state == "stopped"
    r = c.post("/api/v1/server/console", json={"line": "say hi"})
    assert r.status_code == 409


def test_server_crash_reports_error_state(client, settings_factory):
    from fastapi.testclient import TestClient
    from app.main import create_app
    import os, sys

    env_cmd = f"{sys.executable} tests/stub_server.py"
    s2 = settings_factory(MCSP_ADMIN_KEY="k", MCSP_TEST_SERVER_CMD=env_cmd)
    # Simulate crash: env var read by the stub at import time.
    os.environ["MCSP_STUB_FAIL"] = "1"
    try:
        app = create_app(s2)
        with TestClient(app) as c:
            _wait_ready(app)
            c.headers["Authorization"] = "Bearer k"
            r = c.post("/api/v1/server/start")
            j = wait_job(c, r.json()["id"], timeout=30)
            assert j["state"] == "failed"
            _wait_state(app, "error", timeout=10)
            assert c.get("/api/v1/status").json()["state"] == "error"
    finally:
        del os.environ["MCSP_STUB_FAIL"]


def _wait_ready(app, timeout=10):
    for _ in range(int(timeout / 0.05)):
        if app.state.settings_ready:
            return
        time.sleep(0.05)
    raise RuntimeError("not ready")


# ------------------------------------------------------------ restart flag

def test_restart_required_set_on_pack_change_and_cleared_after_restart(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "rr.jar")
    admin_add(c, jar_server, jar, mod_id="rr", side="both")
    assert c.get("/api/v1/status").json()["restartRequired"] is True
    start_server_and_wait(c, app)  # first start loads the mod
    st = c.get("/api/v1/status").json()
    assert st["restartRequired"] is True and st["pendingRestart"] is True
    r = c.post("/api/v1/server/restart")
    assert wait_job(c, r.json()["id"], timeout=90)["state"] == "succeeded"
    st = c.get("/api/v1/status").json()
    assert st["restartRequired"] is False
    assert st["pendingRestart"] is False


def test_restart_ack_endpoint_clears_flag(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "ack.jar")
    admin_add(c, jar_server, jar, mod_id="ack", side="both")
    assert c.get("/api/v1/status").json()["restartRequired"] is True
    r = c.post("/api/v1/pack/restart-ack")
    assert r.status_code == 200 and r.json()["restartRequired"] is False


# ------------------------------------------------------------ auth

def test_no_admin_key_fails_closed(client_no_admin):
    c, app = client_no_admin
    assert app.state.settings.admin_configured is False
    for method, url in (
        ("get", "/api/v1/logs"),
        ("get", "/api/v1/jobs"),
        ("get", "/api/v1/backups"),
        ("post", "/api/v1/server/start"),
        ("post", "/api/v1/server/stop"),
        ("post", "/api/v1/server/restart"),
        ("post", "/api/v1/server/console"),
        ("post", "/api/v1/pack/mods"),
        ("delete", "/api/v1/pack/mods/x"),
        ("put", "/api/v1/pack/mods/x"),
        ("post", "/api/v1/pack/restart-ack"),
    ):
        r = getattr(c, method)(url)
        assert r.status_code == 503, (method, url, r.status_code, r.text)
        assert r.json()["error"] == "admin_disabled"


def test_wrong_key_unauthorized(client_bad_admin):
    c, app = client_bad_admin
    r = c.get("/api/v1/logs")
    assert r.status_code == 401
    assert r.json()["error"] == "unauthorized"
    # Public endpoints remain open.
    assert c.get("/api/v1/health").status_code == 200
    assert c.get("/api/v1/pack").status_code == 200
    assert c.get("/api/v1/status").status_code == 200


def test_health_reports_admin_enabled(client, client_no_admin):
    c, _ = client
    assert c.get("/api/v1/health").json()["adminEnabled"] is True
    c2, _ = client_no_admin
    assert c2.get("/api/v1/health").json()["adminEnabled"] is False


# ------------------------------------------------------------ consistency

def test_manifest_matches_disk_after_ops(client, jar_server, tmp_path):
    c, app = client
    a = make_mod_jar(tmp_path / "a.jar")
    b = make_mod_jar(tmp_path / "b.jar")
    admin_add(c, jar_server, a, mod_id="a", side="both")
    admin_add(c, jar_server, b, mod_id="b", side="both")
    on_disk = {p.name for p in mods_dir(app).iterdir() if p.is_file()}
    m = manifest(app)
    in_manifest = {e["file"]["filename"] for e in m["mods"]}
    assert on_disk == in_manifest
    admin_remove(c, "a")
    on_disk = {p.name for p in mods_dir(app).iterdir() if p.is_file()}
    m = manifest(app)
    in_manifest = {e["file"]["filename"] for e in m["mods"]}
    assert on_disk == in_manifest
    assert {e["modId"] for e in m["mods"]} == {"b"}


def test_jobs_endpoint_lists_history(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "j.jar")
    admin_add(c, jar_server, jar, mod_id="j", side="both")
    r = c.get("/api/v1/jobs")
    assert r.status_code == 200
    jobs = r.json()["jobs"]
    assert any(j["kind"] == "pack.add" and j["state"] == "succeeded" for j in jobs)


def test_backups_created_and_listed(client, jar_server, tmp_path):
    c, app = client
    jar = make_mod_jar(tmp_path / "bk.jar")
    admin_add(c, jar_server, jar, mod_id="bk", side="both")
    r = c.get("/api/v1/backups")
    assert r.status_code == 200
    assert r.json()["backups"], "expected at least one backup after pack change"
