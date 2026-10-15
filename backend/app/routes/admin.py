"""Admin endpoints (Authorization: Bearer <admin key>). All fail closed when
no key is configured."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_admin
from ..errors import ApiError, bad_request, conflict, not_found
from ..models import AddModRequest, ConsoleLine, UpdateModRequest

router = APIRouter(dependencies=[Depends(require_admin)])


@router.get("/logs")
def get_logs(request: Request, limit: int = 200):
    if limit < 1 or limit > 8000:
        raise bad_request("limit must be between 1 and 8000")
    return {"lines": request.app.state.supervisor.logs(limit)}


@router.get("/logs/stream")
async def log_stream(request: Request, tail: int = 200):
    """SSE stream of console lines.

    The ring's ``wait`` is a *threading* primitive. Awaiting it inline runs the
    wait inside the event loop and stalls every other request on the server for
    as long as the call blocks, so it is always off-loaded to a worker thread.
    """
    sup = request.app.state.supervisor
    import asyncio

    from sse_starlette.sse import EventSourceResponse

    if tail < 1 or tail > 8000:
        raise bad_request("tail must be between 1 and 8000")

    async def gen():
        lines = sup.logs(8000)
        # first flush: only the most recent `tail` lines (never the whole ring)
        for line in lines[-tail:]:
            yield {"data": line}
        last_len = len(lines)
        while True:
            if await request.is_disconnected():
                break
            await asyncio.to_thread(sup.wait_for_lines, 1.0)
            if await request.is_disconnected():
                break
            lines = sup.logs(8000)
            if len(lines) < last_len:
                new = lines  # ring wrapped/reset
            else:
                new = lines[last_len:]
            for line in new:
                yield {"data": line}
            last_len = len(lines)

    return EventSourceResponse(gen())


@router.post("/pack/mods")
def add_mod(request: Request, req: AddModRequest):
    return request.app.state.control.add_mod(req)


@router.put("/pack/mods/{mod_id}")
def update_mod(request: Request, mod_id: str, req: UpdateModRequest):
    return request.app.state.control.update_mod(mod_id, req)


@router.delete("/pack/mods/{mod_id}")
def remove_mod(request: Request, mod_id: str):
    return request.app.state.control.remove_mod(mod_id)


@router.post("/server/start")
def start_server(request: Request):
    return request.app.state.control.start_server()


@router.post("/server/stop")
def stop_server(request: Request):
    return request.app.state.control.stop_server()


@router.post("/server/restart")
def restart_server(request: Request):
    return request.app.state.control.restart_server()


@router.post("/server/console")
def console(request: Request, req: ConsoleLine):
    """Run a command on the managed Minecraft server console (admin only)."""
    try:
        return request.app.state.supervisor.send_console(req.line)
    except ValueError as e:
        raise bad_request(str(e), "invalid_console_command")
    except RuntimeError as e:
        raise conflict(str(e), "console_unavailable")


@router.get("/jobs")
def list_jobs(request: Request, limit: int = 50):
    return {"jobs": request.app.state.job_queue.list(limit)}


@router.get("/jobs/{job_id}")
def get_job(request: Request, job_id: str):
    job = request.app.state.job_queue.get(job_id)
    if job is None:
        raise not_found(f"no such job: {job_id}", "job_not_found", jobId=job_id)
    return job


@router.get("/backups")
def list_backups(request: Request):
    return {"backups": request.app.state.packmgr.list_backups()}


@router.post("/backups/{backup_id}/restore")
def restore_backup(request: Request, backup_id: str):
    return request.app.state.packmgr.restore_backup(backup_id)

@router.post("/pack/restart-ack")
def restart_ack(request: Request):
    """Acknowledge that a restart has been performed; clears restartRequired."""
    return request.app.state.serverctl.clear_restart_required()
