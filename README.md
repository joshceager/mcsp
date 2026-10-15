# MCSP — Minecraft Server Pack (launcher + per-server backend)

Cross-platform desktop launcher (Electron) plus a per-deployment backend
(FastAPI) that **owns and manages its own Minecraft (NeoForge) server**.
There is no central service: each server owner runs one Docker container that
serves the REST API *and* supervises the real Minecraft server process.

## Architecture at a glance

```
+---------------------------+         +---------------------------------+
|  Desktop client (Electron)|  HTTP   |  One Docker container           |
|  - sync local instance    |-------->|  - FastAPI backend (port 8080)  |
|  - view pack / status     |         |  - supervises the JVM server    |
|  - launch Minecraft       |         |    process directly (child proc)|
|  - admin: pack ops, logs, |         |  - manages mods/, world/, config|
|    console, restart       |         |  - bind-mounted /data persists  |
+---------------------------+         +---------------------------------+
                                              | child process
                                              v
                                     java ... neoforge server (nogui)
```

- The backend is the single writer for the managed server's files. Every
  authorized mod operation downloads to staging, verifies sha1 + zip safety +
  loader marker, takes a tar.gz backup, applies atomically, then publishes the
  manifest. It is never metadata-only.
- The pack manifest is published at startup, independently of provisioning, and
  `GET /pack` always answers with a complete, valid manifest — a deployment that
  has not published one yet serves the empty default pack instead of `null`.
- Job queue: at most one mutating/lifecycle job runs at a time; overlapping
  admin requests are rejected with 409.
- Server state machine: `starting -> running -> stopping -> stopped`, crash =>
  `error` with auto-restart (capped backoff), all visible on `GET /status`.

## Quick start (server owner)

Requirements: Docker on the host; TCP 8080 (API) and 25565 (game) reachable by
players. Docker installation, firewall/port-forwarding and DNS are host-side
tasks the backend cannot perform.

```bash
mkdir -p data
# optional, to enable admin:  export MCSP_ADMIN_KEY=$(openssl rand -hex 32)
docker compose up -d --build
```

First boot provisions everything: downloads the pinned NeoForge server
(Minecraft 1.21.1 / NeoForge 21.1.259), installs it, writes `eula.txt` +
default `server.properties`, and auto-starts the server.

```bash
curl http://localhost:8080/api/v1/status    # public: state + join address
curl http://localhost:8080/api/v1/pack      # public: manifest + installed mods
```

**All persistence is via the bind mount `./data:/data`** (world, mods,
config, manifest, backups, sqlite job history). No named volumes are used.
Reverse proxying (Caddy / Tailscale serve) in front of port 8080 works as-is;
the API speaks plain HTTP with `Authorization: Bearer <key>`.

## Public vs admin API (`/api/v1`)

Public (no key): `GET /health`, `GET /status`, `GET /pack`,
`GET /status/stream` (SSE).

Admin (Bearer key; **503 fail-closed when no key is configured**):
`GET /logs` + `GET /logs/stream`, `POST/PUT/DELETE /pack/mods...`,
`POST /pack/restart-ack`, `POST /server/{start,stop,restart}`,
`POST /server/console` (run a console command), `GET /jobs[/{id}]`,
`GET /backups` + `POST /backups/{id}/restore`.

Example — add a mod (must be `side: both|server`):

```json
POST /api/v1/pack/mods
{
  "modId": "create", "name": "Create", "version": "6.0.4", "side": "both",
  "file": { "url": "https://cdn.example/create-6.0.4.jar",
            "filename": "create-6.0.4.jar", "size": 19834512,
            "hashes": { "sha1": "...40 hex..." } }
}
```

Client-only mods (`side: "client"`) are **rejected** server-side with
`side_mismatch`; server-only mods are never installed into player instances by
the client's sync planner. Both classifications are enforced in code, not just
shown in the UI.

## Desktop client (development)

```bash
cd client
npm install
npm run dev          # build main/preload/renderer, then launch Electron
npm run typecheck && npx vitest run   # checks + tests
npm run dist         # electron-builder: NSIS / dmg / AppImage per-platform
```

### Linux / WSL system dependencies

Electron needs GUI shared libraries that a fresh Debian/Ubuntu (incl. WSL)
install does not ship. If `npm run dev` fails with
`error while loading shared libraries: libnss3.so`, install them once:

```bash
sudo apt install libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libatspi2.0-0 libgtk-3-0 libglib2.0-0 libcairo2 libpango-1.0-0 \
  libcups2 libdbus-1-3 libdrm2 libgbm1 libasound2 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libxkbcommon0
```

(On Ubuntu 24.04+, `libasound2` may need to be `libasound2t64`.)
WSL users: WSLg provides the display server, so the window opens normally.

Connect: enter the server API base URL (e.g. `http://your-host:8080`). The
client fetches the manifest, plans a diff against the local instance, downloads
mod files **directly from their original URLs** (hash-verified with sha1),
skips `side=server` mods, and launches the pinned MC + NeoForge instance. Java
is pulled automatically (Adoptium Temurin 21) on first run if missing. Admin
users paste the server key. The client validates it against an admin endpoint
before saving it, then encrypts it with Electron `safeStorage` (the OS
credential store) **when one is available**. Where it is not — headless Linux
without a keyring, for example — the key is written as plaintext in the
settings JSON, which is created with `0600` permissions and says so in the
Settings panel. Nothing is silently claimed to be keychain-protected.

## Repo layout

```
backend/     FastAPI app (supervisor, bootstrap, packmgr, jobs, sqlite store) + tests
client/      Electron client (main-process services, React renderer, tests)
Dockerfile (repo root), docker-compose.yml
docs/        API + manifest format reference
.github/workflows/ci.yml
```

## Tests

Backend: 26 integration tests (real child processes) — fail-closed auth,
side enforcement, real file changes on disk, restart cycle, console, traversal
rejection, hash mismatch, manifest/disk consistency. Client: 9 vitest tests —
sync planning (server-only mods never installed client-side) and manifest
validation (traversal/URL/hash checks).
