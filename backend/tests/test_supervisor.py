"""Supervisor crash policy + process scoping.

These are the behaviours behind "the managed server keeps crashing":

- a process that dies before it ever reaches readiness is a *startup* failure —
  deterministic, so it must be reported once (with the reason) and not retried;
- a process that reached readiness and then died is a *runtime* crash — retried
  with capped backoff, and the cap must actually hold for a server that boots
  and immediately dies again (it used to reset on every "running");
- an operator Stop during the backoff must cancel the restart;
- state/pid/readiness belong to one process: a superseded process's watcher (or
  the previous run's "Done" line in the shared ring) must never be mistaken for
  the current one's.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
STUB = BACKEND / "tests" / "stub_server.py"
CRASH_STUB = BACKEND / "tests" / "stub_boot_then_crash.py"
SLOW_STUB = BACKEND / "tests" / "stub_slow_boot.py"


def supervisor_for(settings_factory, **env):
    """A supervisor wired to the real bootstrap, using a stub MC process."""
    from app.bootstrap import Bootstrap
    from app.store import Store
    from app.supervisor import MinecraftServerSupervisor

    settings = settings_factory(**env)
    bootstrap = Bootstrap(settings, Store(settings.db_path))
    bootstrap.ensure_provisioned()
    events: list[dict] = []
    sup = MinecraftServerSupervisor(settings, bootstrap, on_state_change=events.append)
    return sup, events


def starts(events: list[dict]) -> int:
    """How many processes were spawned (each start flips the state to starting)."""
    return sum(1 for e in events if e.get("state") == "starting")


def wait_for(predicate, timeout: float = 15.0, what: str = "condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def test_startup_failure_is_reported_once_and_not_auto_restarted(settings_factory, monkeypatch):
    """A server that cannot boot is not retried forever: one clear error."""
    monkeypatch.setenv("MCSP_STUB_FAIL", "1")  # read by the stub at import time
    sup, events = supervisor_for(
        settings_factory, MCSP_AUTO_RESTART_BACKOFF_S=1, MCSP_AUTO_RESTART_MAX=5
    )
    try:
        with pytest.raises(RuntimeError):
            sup.start()  # the start job must fail; that is how the operator sees it
        # well past the backoff: a (wrong) restart would have spawned by now
        time.sleep(2.5)
        assert sup.state == "error"
        assert starts(events) == 1, "a startup failure must not be auto-restarted"
        assert sup._auto_restart_count == 0

        detail = sup._last_error or ""
        assert "exited during startup" in detail
        # the reason travels with the state, not just into the raw console log
        assert "OutOfMemoryError" in detail, detail
        assert any("not auto-restarting" in l for l in sup.logs(50))
    finally:
        sup.close()


def test_boot_then_crash_stops_at_the_restart_cap(settings_factory):
    """Booting once must not buy an unlimited restart budget."""
    cmd = f"{sys.executable} {CRASH_STUB} 0.5"
    sup, events = supervisor_for(
        settings_factory,
        MCSP_TEST_SERVER_CMD=cmd,
        MCSP_AUTO_RESTART_BACKOFF_S=1,
        MCSP_AUTO_RESTART_MAX=2,
        MCSP_AUTO_RESTART_STABLE_S=60,  # it never stays up long enough to earn more
    )
    try:
        sup.start()
        wait_for(
            lambda: any("auto-restart limit reached" in l for l in sup.logs(50)),
            timeout=25,
            what="the crash budget to run out",
        )
        assert sup._auto_restart_count == 2
        assert starts(events) == 3, f"expected 1 start + 2 restarts, got {starts(events)}"
        assert sup.state == "error"
        time.sleep(2.0)  # nothing else may be spawned after the cap is reached
        assert starts(events) == 3
    finally:
        sup.close()


def test_a_stable_run_gives_the_crash_budget_back(settings_factory):
    """A server that stays up long enough is not punished for an old crash."""
    cmd = f"{sys.executable} {CRASH_STUB} 1.2"
    sup, events = supervisor_for(
        settings_factory,
        MCSP_TEST_SERVER_CMD=cmd,
        MCSP_AUTO_RESTART_BACKOFF_S=1,
        MCSP_AUTO_RESTART_MAX=1,
        MCSP_AUTO_RESTART_STABLE_S=1,  # 1.2s of uptime counts as healthy
    )
    try:
        sup.start()
        wait_for(lambda: sup._auto_restart_count >= 1, timeout=15, what="the first crash")
        wait_for(lambda: starts(events) >= 2, timeout=15, what="the restart")
        # the restarted process also lived > stable window, so it gets another restart
        wait_for(lambda: starts(events) >= 3, timeout=20, what="a second restart")
    finally:
        sup.close()


def test_stop_cancels_a_pending_auto_restart(settings_factory):
    """Stop must win: the server may not come back to life after it was stopped."""
    cmd = f"{sys.executable} {CRASH_STUB} 0.5"
    sup, events = supervisor_for(
        settings_factory,
        MCSP_TEST_SERVER_CMD=cmd,
        MCSP_AUTO_RESTART_BACKOFF_S=4,
        MCSP_AUTO_RESTART_MAX=5,
    )
    try:
        sup.start()
        wait_for(lambda: sup.state == "error", timeout=15, what="the crash")
        assert sup.stop()["state"] == "stopped"
        time.sleep(5.0)  # past the 4s backoff
        assert sup.state == "stopped"
        assert starts(events) == 1, "a pending auto-restart was not cancelled by stop()"
    finally:
        sup.close()


def test_restart_ignores_the_superseded_process_watcher(settings_factory):
    """Regression: the old process's watcher used to clobber the new one.

    It cleared _proc/_pid and flipped the state to error/stopped, so a healthy
    freshly restarted server was reported as crashed and dropped from the API
    (console/stop then said "server is not running" while the JVM was alive).
    """
    sup, _ = supervisor_for(settings_factory)
    try:
        sup.start()
        old_proc, old_epoch = sup._proc, sup._epoch
        sup.restart()
        assert sup.state == "running"
        new_pid = sup._pid
        assert new_pid is not None and old_epoch != sup._epoch

        # Replay the superseded watcher exactly as a slow thread would have run it.
        sup._watch(old_proc, time.time() - 60, old_epoch, threading.Event(), threading.Event(), 0)

        assert sup.state == "running", "a superseded watcher changed the current state"
        assert sup._pid == new_pid, "a superseded watcher dropped the live process"
        assert sup._proc is not None
        sup.send_console("say hello")  # the API can still reach the running server
    finally:
        sup.close()


def test_a_new_start_waits_for_its_own_readiness_line(settings_factory):
    """Regression: the shared ring's previous "Done (...)" line made start()
    report a brand-new process as running before it had booted."""
    cmd = f"{sys.executable} {SLOW_STUB} 2"
    sup, _ = supervisor_for(settings_factory, MCSP_TEST_SERVER_CMD=cmd)
    try:
        sup.start()
        assert sup.state == "running"
        sup.stop()
        assert sup.state == "stopped"

        started = time.time()
        result = sup.start()
        elapsed = time.time() - started
        assert result["state"] == "running"
        assert elapsed >= 1.5, f"reported running after {elapsed:.2f}s from a stale line"
    finally:
        sup.close()


def test_operator_start_resets_the_crash_budget(settings_factory):
    """After an operator intervenes, the server gets a fresh restart budget."""
    cmd = f"{sys.executable} {CRASH_STUB} 0.5"
    sup, _ = supervisor_for(
        settings_factory,
        MCSP_TEST_SERVER_CMD=cmd,
        MCSP_AUTO_RESTART_BACKOFF_S=1,
        MCSP_AUTO_RESTART_MAX=1,
    )
    try:
        sup.start()
        wait_for(lambda: sup.state == "error", timeout=15, what="the crash")
        wait_for(lambda: sup._auto_restart_count >= 1, timeout=15, what="the restart budget")
        sup.start()  # operator start
        assert sup._auto_restart_count == 0
    finally:
        sup.close()
