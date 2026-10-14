"""SQLite persistence for job history (aiosqlite-free: one background thread)."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    progress REAL,
    message TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Store:
    """Minimal SQLite wrapper: a single connection guarded by a lock.

    All writes are tiny and fast (job rows), so a coarse lock is fine and
    keeps us dependency-free (no aiosqlite).
    """

    def __init__(self, db_path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def upsert_job(self, job: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, kind, state, progress, message, result, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET state=excluded.state, progress=excluded.progress, "
                "message=excluded.message, result=excluded.result, updated_at=excluded.updated_at",
                (
                    job["id"],
                    job["kind"],
                    job["state"],
                    job.get("progress"),
                    job.get("message"),
                    json.dumps(job.get("result")) if job.get("result") is not None else None,
                    job.get("createdAt") or job.get("updatedAt") or _now_iso(),
                    job.get("updatedAt") or job.get("createdAt") or _now_iso(),
                ),
            )
            self._conn.commit()

    def get_job(self, job_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return self._row_to_job(row)

    def list_jobs(self, limit: int = 100) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [self._row_to_job(r) for r in rows]

    @staticmethod
    def _row_to_job(row) -> dict:
        return {
            "id": row["id"],
            "kind": row["kind"],
            "state": row["state"],
            "progress": row["progress"],
            "message": row["message"],
            "result": json.loads(row["result"]) if row["result"] else None,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self._conn.commit()

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None
