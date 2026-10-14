"""Shared test fixtures.

The supervisor starts REAL OS processes; a python stub plays the role of the
JVM (tests/stub_server.py) so lifecycle tests exercise the same
process-management code paths without downloading a real server.

Mod downloads go over real HTTP: a local ThreadingHTTPServer serves jars from
a temp dir, and manifests point at http://127.0.0.1:<port>/<file>.
"""

import http.server
import json
import socket
import sys
import threading
import time
import zipfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
FAKE = BACKEND / "tests" / "stub_server.py"


# ------------------------------------------------------------------ helpers

def make_mod_jar(path: Path, marker: str = "META-INF/neoforge.mods.toml", tag: str = "v1") -> Path:
    """A minimal fake NeoForge mod jar with the required loader marker."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n")
        zf.writestr(marker, f'modLoader="javafml"\nloaderVersion="[21,)"\nlicense="MIT"\n[[mods]]\nmodId="fake_{tag}"\nversion="{tag}"\n')
        zf.writestr(f"assets/{tag}/dummy.txt", "hello")
    return path


def make_bad_jar(path: Path, entry: str = "../evil.class") -> Path:
    """A jar whose zip entries attempt path traversal."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n")
        zf.writestr("META-INF/neoforge.mods.toml", 'modLoader="javafml"\n')
        zf.writestr(entry, "evil")
    return path


def sha1_of(path: Path) -> str:
    import hashlib

    return hashlib.sha1(path.read_bytes()).hexdigest()


def mod_payload(url: str, path: Path, *, mod_id="fake-test", side="both", version="1.0.0",
                name="Fake Test Mod", fname=None) -> dict:
    return {
        "modId": mod_id,
        "name": name,
        "version": version,
        "side": side,
        "file": {
            "url": url,
            "filename": fname or path.name,
            "size": path.stat().st_size,
            "hashes": {"sha1": sha1_of(path)},
        },
    }


# ------------------------------------------------------------ fixtures

@pytest.fixture()
def settings_factory(tmp_path):
    from app.config import Settings

    def make(**env_over):
        env = {
            "MCSP_DATA_DIR": str(tmp_path / "data"),
            "MCSP_TEST_SERVER_CMD": f"{sys.executable} {FAKE}",
            "MCSP_AUTO_START": "0",
            "MCSP_ADMIN_KEY": "",
        }
        env.update(env_over)
        return Settings(env=env)

    return make


@pytest.fixture(scope="session")
def jar_server():
    """Serve a directory of jars over HTTP for the duration of the session."""
    import tempfile

    serve_dir = Path(tempfile.mkdtemp(prefix="mcsp-jars-"))
    handler = lambda *args, **kw: http.server.SimpleHTTPRequestHandler(*args, directory=str(serve_dir), **kw)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    class JarServer:
        base = f"http://127.0.0.1:{port}"
        dir = serve_dir

        def url(self, fname: str) -> str:
            return f"{self.base}/{fname}"

    try:
        yield JarServer()
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture()
def client(settings_factory):
    """API client with admin auth enabled (standard management deployment)."""
    from app.main import create_app
    from fastapi.testclient import TestClient

    app = create_app(settings_factory(MCSP_ADMIN_KEY="test-admin-key-123"))
    with TestClient(app) as c:
        _wait_ready(app)
        c.headers["Authorization"] = "Bearer test-admin-key-123"
        yield c, app


@pytest.fixture()
def client_no_admin(settings_factory):
    """API client with NO admin key configured (fail-closed deployment)."""
    from app.main import create_app
    from fastapi.testclient import TestClient

    app = create_app(settings_factory())
    with TestClient(app) as c:
        _wait_ready(app)
        yield c, app


@pytest.fixture()
def client_bad_admin(settings_factory):
    """API client with an admin key set, but requests use a WRONG key."""
    from app.main import create_app
    from fastapi.testclient import TestClient

    app = create_app(settings_factory(MCSP_ADMIN_KEY="correct-key"))
    with TestClient(app) as c:
        _wait_ready(app)
        yield c, app


def _wait_ready(app, timeout=10):
    for _ in range(int(timeout / 0.05)):
        if app.state.settings_ready:
            return
        time.sleep(0.05)
    raise RuntimeError("provisioning did not become ready")


# ------------------------------------------------------------- api helpers

def wait_job(c, job_id, timeout=30):
    """Poll a job until it leaves queued/running."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = c.get(f"/api/v1/jobs/{job_id}")
        assert r.status_code == 200, r.text
        j = r.json()
        if j["state"] not in ("queued", "running"):
            return j
        time.sleep(0.1)
    raise TimeoutError(f"job {job_id} did not finish in {timeout}s")


def start_server_and_wait(c, app, timeout=30):
    r = c.post("/api/v1/server/start")
    assert r.status_code == 200, r.text
    j = wait_job(c, r.json()["id"], timeout)
    assert j["state"] == "succeeded", j
    _wait_state(app, "running", timeout)
    return j


def _wait_state(app, state, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if app.state.supervisor.state == state:
            return True
        time.sleep(0.1)
    raise TimeoutError(f"state never became {state}; last={app.state.supervisor.state}")
