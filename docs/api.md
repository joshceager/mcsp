# REST API v1

Base path `/api/v1`. Errors: `{ "error": "<code>", "message": "...", "details": {} }`.

## Public
- `GET /health` -> `{ ok, adminEnabled, state, ... }`
- `GET /status` -> state machine + join address/ports + `restartRequired` +
  `pendingRestart` + installed loader versions.
- `GET /pack` -> `{ manifest, installedFiles, restartRequired }` (manifest per
  docs/manifest.md; `installedFiles` = actual files in the server's mods dir.
  `installed` is a deprecated alias of the same list, kept for old clients).
- `GET /status/stream` (SSE) — status + job events.

## Admin (`Authorization: Bearer <key>`) — 503 fail-closed when no key set
- `GET /logs?limit=200`; `GET /logs/stream` (SSE tail).
- `POST /pack/mods` (AddModRequest) -> job; `PUT /pack/mods/{modId}`;
  `DELETE /pack/mods/{modId}`.
  - side=client => 422/`side_mismatch`, nothing downloaded or written.
  - sha1 mismatch => `hash_mismatch`; unsafe jar => rejected; nothing partial
    ever enters `mods/` (staging + atomic replace + backup first).
- `POST /pack/restart-ack` -> clears the restart-required flag manually.
- `POST /server/start | stop | restart` -> `{ id, kind, state }` job.
- `POST /server/console` `{ "line": "say hi" }` -> `{ sent: true }` (only when
  the process is running; 409 otherwise). Console input is passed to the
  server's stdin — it is not a shell.
- `GET /jobs[/{id}]`; `GET /backups`; `POST /backups/{id}/restore`.

## Job lifecycle
`queued -> running -> succeeded | failed` with `result` on completion
(`filesWritten`, `filesRemoved`, `restartRequired`, or `error`+`details`).
