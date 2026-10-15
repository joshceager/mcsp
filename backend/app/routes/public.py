"""Public (no key) endpoints: status, pack manifest, SSE status stream."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter()


@router.get("/status")
def get_status(request: Request):
    return request.app.state.supervisor.status().model_dump()


@router.get("/pack")
def get_pack(request: Request):
    """The published manifest: every mod with its REQUIRED side classification,
    plus the actual files currently installed in the managed server's mods dir.

    `manifest` is always a complete, valid format-v1 manifest: a deployment that
    has not published one yet is served the empty default pack (see
    ManifestStore.load_manifest), never `null`.
    """
    manifest = request.app.state.manifest_store.load_manifest()
    installed = request.app.state.packmgr.installed_files()
    return {
        "manifest": manifest.model_dump(),
        # `installedFiles` is the canonical name (matches the client type);
        # `installed` is kept as a deprecated alias for older clients.
        "installedFiles": installed,
        "installed": installed,
        "restartRequired": bool(manifest.restartRequired),
    }


@router.get("/status/stream")
async def status_stream(request: Request):
    """Server-Sent Events stream of state changes + new log lines."""
    sup = request.app.state.supervisor
    import queue as _q

    q: _q.Queue = _q.Queue()

    def on_job(job):
        q.put({"type": "job", "data": job})

    app = request.app
    app.state.job_queue.notify(on_job)
    # initial snapshot
    q.put({"type": "status", "data": sup.status().model_dump()})

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    evt = await asyncio.to_thread(q.get, timeout=1.0)
                    yield {"event": evt["type"], "data": _json(evt["data"])}
                except _q.Empty:
                    yield {"event": "ping", "data": ""}
        finally:
            app.state.job_queue.forget(on_job)

    return EventSourceResponse(gen())


def _json(obj) -> str:
    import json

    return json.dumps(obj, default=str)
