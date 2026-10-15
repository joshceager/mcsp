"""SSE endpoint tests: the streams must deliver data *and* leave the API usable.

Regression guard: `wait_for_lines` is a threading primitive. Calling it inline
inside the ASGI generator blocked the event loop and made every other request on
the deployment take seconds (a live console made the whole backend look dead).
"""

from __future__ import annotations

import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn

BACKEND = Path(__file__).resolve().parents[1]
FAKE = BACKEND / "tests" / "stub_server.py"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def live_server(tmp_path):
    """A real uvicorn server in a thread (the SSE paths need real ASGI streaming)."""
    from app.config import Settings
    from app.main import create_app

    settings = Settings(env={
        "MCSP_DATA_DIR": str(tmp_path / "data"),
        "MCSP_TEST_SERVER_CMD": f"{sys.executable} {FAKE}",
        "MCSP_AUTO_START": "1",
        "MCSP_ADMIN_KEY": "test-admin-key-123",
        "MCSP_API_PORT": "0",
    })
    port = _free_port()
    config = uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            if httpx.get(f"{base}/api/v1/health", timeout=1).status_code == 200:
                break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("server did not come up")
    # give the managed (stub) server a moment to log its startup lines
    time.sleep(1.5)
    try:
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def _read_stream(base: str, path: str, headers: dict, out: list, stop: threading.Event) -> None:
    try:
        with httpx.stream("GET", base + path, headers=headers, timeout=30) as r:
            for line in r.iter_lines():
                if line:
                    out.append(line)
                if stop.is_set():
                    break
    except Exception as e:  # pragma: no cover - surfaced via assertions
        out.append(f"ERROR {e}")


def test_log_stream_does_not_stall_the_api(live_server):
    base = live_server
    headers = {"Authorization": "Bearer test-admin-key-123"}
    received: list[str] = []
    stop = threading.Event()
    t = threading.Thread(target=_read_stream, args=(base, "/api/v1/logs/stream", headers, received, stop), daemon=True)
    t.start()

    deadline = time.time() + 10
    while time.time() < deadline and len(received) < 4:
        time.sleep(0.2)
    assert received, "the log stream delivered nothing"
    assert any("Done" in l or "Starting" in l for l in received), received[:5]

    # While the stream is open the API must stay responsive.
    timings = []
    for _ in range(6):
        t0 = time.perf_counter()
        r = httpx.get(f"{base}/api/v1/health", timeout=10)
        timings.append(time.perf_counter() - t0)
        assert r.status_code == 200
    stop.set()
    worst = max(timings)
    assert worst < 1.0, f"health check stalled for {worst:.2f}s with a log stream open ({timings})"


def test_status_stream_reports_state_and_stays_responsive(live_server):
    base = live_server
    received: list[str] = []
    stop = threading.Event()
    t = threading.Thread(target=_read_stream, args=(base, "/api/v1/status/stream", {}, received, stop), daemon=True)
    t.start()

    deadline = time.time() + 10
    while time.time() < deadline and not any("state" in l for l in received):
        time.sleep(0.2)
    assert any("state" in l for l in received), received[:5]

    t0 = time.perf_counter()
    assert httpx.get(f"{base}/api/v1/status", timeout=10).status_code == 200
    elapsed = time.perf_counter() - t0
    stop.set()
    assert elapsed < 1.0, f"status request took {elapsed:.2f}s with the status stream open"
