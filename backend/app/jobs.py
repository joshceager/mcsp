"""Serialized job queue: every mutating/lifecycle operation is a job.

At most ONE job runs at a time (approved design). Submissions while a job is
running are placed in a FIFO queue; lifecycle operations may opt out of
queuing (``queue_ok=False``) to fail fast with 409 instead of waiting behind a
long-running operation. Progress/state are persisted in SQLite; clients poll
GET /api/v1/jobs/{id} or subscribe to the SSE stream.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Callable

from .errors import conflict
from .store import Store

log = logging.getLogger("mcsp.jobs")

QUEUED, RUNNING, SUCCEEDED, FAILED = "queued", "running", "succeeded", "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobQueue:
    def __init__(self, store: Store) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._busy = False
        self._queue: deque[tuple[dict, Callable[[], dict]]] = deque()
        self._listeners: list[Callable[[dict], None]] = []

    def notify(self, listener: Callable[[dict], None]) -> None:
        with self._lock:
            self._listeners.append(listener)

    def forget(self, listener) -> None:
        with self._lock:
            try:
                self._listeners.remove(listener)
            except ValueError:
                pass

    def _emit(self, job: dict) -> None:
        for cb in list(self._listeners):
            try:
                cb(job)
            except Exception:
                log.exception("job listener failed")

    def is_busy(self) -> bool:
        with self._lock:
            return self._busy

    def submit(self, kind: str, fn: Callable[[], dict], queue_ok: bool = True) -> dict:
        """Submit *fn* to run as a serialized job.

        Returns the initial job view (state=queued). ``queue_ok=False``
        rejects submission with 409 while any job is running or queued
        (used for lifecycle ops, where queueing a second restart behind a
        long one is surprising).
        """
        job = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "state": QUEUED,
            "progress": None,
            "message": None,
            "result": None,
            "createdAt": _now(),
            "updatedAt": _now(),
        }
        self.store.upsert_job(job)
        with self._lock:
            if self._busy:
                if not queue_ok:
                    raise conflict(
                        f"another operation is already running; wait for it to "
                        "finish and try again",
                        "job_busy",
                    )
                self._queue.append((job, fn))
                return job
            self._busy = True
        t = threading.Thread(target=self._run, args=(job, fn), daemon=True)
        t.start()
        return job

    def _run(self, job: dict, fn) -> None:
        job["state"] = RUNNING
        job["updatedAt"] = _now()
        self.store.upsert_job(job)
        self._emit(job)
        try:
            result = fn() or {}
            job["state"] = SUCCEEDED
            job["result"] = result
        except Exception as e:
            log.exception("job %s failed", job["kind"])
            job["state"] = FAILED
            job["result"] = {
                "error": getattr(e, "code", "internal_error"),
                "message": str(e),
                "details": getattr(e, "details", {}),
            }
        job["updatedAt"] = _now()
        self.store.upsert_job(job)
        self._emit(job)
        self._next()

    def _next(self) -> None:
        """Take the next queued job, if any; otherwise release the runner."""
        with self._lock:
            if self._queue:
                nxt, fn = self._queue.popleft()
            else:
                self._busy = False
                return
        self._run(nxt, fn)

    def get(self, job_id: str) -> dict | None:
        return self.store.get_job(job_id)

    def list(self, limit: int = 50) -> list[dict]:
        return self.store.list_jobs(limit)
