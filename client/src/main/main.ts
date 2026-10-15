/** Electron main process: owns all FS/network/launch logic (approved boundary).
 *  The renderer is sandboxed and talks only over the typed IPC surface.
 *
 *  Every handler returns an envelope ({ok:true,value} | {ok:false,error}) so the
 *  renderer never sees "Error invoking remote method …" internals. */
import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { join, isAbsolute } from "path";
import { randomUUID as uuid } from "crypto";
import { ApiClient, ApiError, normalizeBaseUrl, verifyBackend } from "./services/api";
import { Launcher } from "./services/launcher";
import { ProvisionService, type ProvisionProgress, type ProvisionStep } from "./services/provision";
import { SettingsStore, type ClientSettings, type SavedConnection } from "./services/store";
import { SyncEngine } from "./services/sync";
import { McAuth } from "./services/auth";
import { SseStream } from "./services/streams";
import { sanitizeMessage } from "../shared/errors";
import { validateManifest } from "../shared/manifest-validate";

const settingsStore = new SettingsStore();
let auth: McAuth;
let api: ApiClient;
let win: BrowserWindow | null = null;

interface ConnServices {
  sync: SyncEngine;
  provision: ProvisionService;
  launcher: Launcher;
}

const services = new Map<string, ConnServices>();

function dataRoot(): string {
  return join(app.getPath("home"), ".mcsp");
}

function gameDirFor(connId: string): string {
  const s = settingsStore.get();
  const conn = s.connections.find((c) => c.id === connId);
  if (conn) return join(app.getPath("home"), ".mcsp", "instances", conn.id);
  return s.gameDir || join(app.getPath("home"), ".mcsp", "instances", "default");
}

/** Lazily build (and cache) the per-connection services. */
function servicesFor(connId: string): ConnServices {
  let s = services.get(connId);
  if (!s) {
    const prev = services.get(connId);
    const gameDir = gameDirFor(connId);
    const runtime = join(dataRoot(), "runtime");
    s = {
      sync: new SyncEngine(gameDir, (m) => emit("log", { connId, line: m })),
      provision: prev?.provision ?? new ProvisionService(gameDir, runtime, (m) => emit("log", { connId, line: m })),
      launcher: prev?.launcher ?? new Launcher(),
    };
    services.set(connId, s);
  }
  return s;
}

function dropServices(connId: string): void {
  const s = services.get(connId);
  s?.launcher.stop();
  services.delete(connId);
  stopStreams(connId);
}

/** Only the HTTP client is rebuilt when settings change. Connection services —
 *  and therefore a running game process — are deliberately kept, so switching
 *  views or editing a connection can never orphan a launched client (bug 23). */
function refreshApi(): void {
  api = new ApiClient(() => settingsStore.get());
}

function emit(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function requireConnId(id: unknown): string {
  const s = settingsStore.get();
  if (typeof id === "string" && s.connections.some((c) => c.id === id)) return id;
  if (s.activeConnectionId) return s.activeConnectionId;
  throw new AppError("no_server", "No server selected — add a connection first.");
}

export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(sanitizeMessage(message));
    this.name = "AppError";
  }
}

/** Uniform IPC envelope: never let raw errors cross the bridge. */
function handle<T>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<T> | T) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true as const, value: await fn(event, ...args) };
    } catch (e) {
      const err = toAppError(e);
      if (err.code !== "network_error" && err.code !== "no_server") {
        console.error(`[ipc] ${channel}: ${err.code}: ${err.message}`);
      }
      return { ok: false as const, error: { code: err.code, message: err.message, status: err.status } };
    }
  });
}

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ApiError) return new AppError(e.code, e.message, e.status);
  const msg = sanitizeMessage(e);
  const code = (e as { code?: string })?.code;
  return new AppError(typeof code === "string" ? code : "error", msg);
}

// ---------------------------------------------------------------- window

function maskConnection(c: { adminKey: string; adminKeyEnc?: string }): string {
  return c.adminKey || c.adminKeyEnc ? "***" : "";
}

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 420,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // External links (MS sign-in, docs) open in the real browser, never in a
  // bare unsandboxed child window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      void openExternal(url);
    }
  });
  await win.loadFile(join(__dirname, "../renderer/index.html"));
}

async function openExternal(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
}

app.whenReady().then(async () => {
  await settingsStore.load();
  auth = new McAuth({ storeDir: dataRoot() });
  await auth.load();
  refreshApi();
  await createWindow();
});

app.on("window-all-closed", () => {
  for (const s of services.values()) s.launcher.stop();
  app.quit();
});

// ---------------------------------------------------------------- streams

interface StreamState { status?: SseStream; logs?: SseStream; logsLogged: string[] }
const streams = new Map<string, StreamState>();

function startStreams(connId: string, wantLogs: boolean): void {
  stopStreams(connId);
  const conn = settingsStore.get().connections.find((c) => c.id === connId);
  if (!conn) return;
  const base = normalizeBaseUrl(conn.serverUrl);
  const st: StreamState = { logsLogged: [] };
  st.status = new SseStream({
    url: `${base}/api/v1/status/stream`,
    onEvent: (event, data) => {
      let parsed: unknown = data;
      try { parsed = data ? JSON.parse(data) : null; } catch { /* keep raw */ }
      if (event === "job") emit("server:job", { connId, job: parsed });
      else if (event === "status") emit("server:status", { connId, status: parsed });
      else return;
    },
    onError: (msg) => emit("stream:error", { connId, stream: "status", message: sanitizeMessage(msg) }),
  });
  st.status.start();
  if (wantLogs && conn.adminKey) {
    st.logs = new SseStream({
      url: `${base}/api/v1/logs/stream`,
      headers: { Authorization: `Bearer ${conn.adminKey}` },
      onEvent: (_event, data) => emit("server:log", { connId, line: data }),
      onError: (msg) => emit("stream:error", { connId, stream: "logs", message: sanitizeMessage(msg) }),
    });
    st.logs.start();
  }
  streams.set(connId, st);
}

function stopStreams(connId: string): void {
  const st = streams.get(connId);
  if (!st) return;
  st.status?.stop();
  st.logs?.stop();
  streams.delete(connId);
}

// ---------------------------------------------------------------- settings

handle("settings:get", () => ({ settings: settingsStore.get(), security: settingsStore.security() }));
handle("settings:set", async (_e, patch: Partial<ClientSettings>) => {
  const s = await settingsStore.set(patch);
  return { settings: s, security: settingsStore.security() };
});

// ------------------------------------------------------------ connections

function publicSettings(s: ClientSettings) {
  // Never ship admin keys to the renderer: it only needs to know if one exists.
  const mask = (c: { adminKey: string; adminKeyEnc?: string }) =>
    c.adminKey || c.adminKeyEnc ? "***" : "";
  return {
    ...s,
    adminKey: mask(s),
    connections: s.connections.map((c) => ({ id: c.id, name: c.name, serverUrl: c.serverUrl, adminKey: mask(c) })),
  };
}

handle("conn:list", () => ({ settings: publicSettings(settingsStore.get()) }));

handle("conn:verify", async (_e, payload: { serverUrl: string; adminKey?: string }) => {
  const url = normalizeBaseUrl(payload?.serverUrl ?? "");
  return verifyBackend(url, payload?.adminKey ?? "");
});

handle("conn:save", async (_e, patch: {
  id?: string; name?: string; serverUrl: string; adminKey?: string; verify?: boolean;
}) => {
  const rawUrl = String(patch?.serverUrl ?? "").trim();
  if (!rawUrl) throw new AppError("bad_url", "A server URL is required.");
  const url = normalizeBaseUrl(rawUrl);
  const key = typeof patch.adminKey === "string" ? patch.adminKey : undefined;

  // Validate BEFORE persisting: a broken entry must never be saved, made
  // active, or duplicated by a retry.
  const probe = await verifyBackend(url, key ?? "");
  if (key) {
    const probeClient = new ApiClient(() => ({
      ...settingsStore.get(),
      serverUrl: url,
      adminKey: key,
      activeConnectionId: null,
      connections: [],
    }));
    const admin = await probeClient.probeAdmin();
    if (!admin.ok) throw new AppError("bad_admin_key", `server reachable, but ${admin.message}`);
  }

  const s = settingsStore.get();
  const conns = [...s.connections];
  let saved: SavedConnection;
  if (patch.id) {
    const i = conns.findIndex((c) => c.id === patch.id);
    if (i === -1) throw new AppError("unknown_connection", "that connection no longer exists");
    saved = {
      ...conns[i],
      name: (patch.name ?? conns[i].name) || url,
      serverUrl: url,
      adminKey: key ?? conns[i].adminKey,
    };
    conns[i] = saved;
  } else {
    saved = { id: uuid(), name: (patch.name || url).trim(), serverUrl: url, adminKey: key ?? "" };
    conns.push(saved);
  }
  const next = await settingsStore.set({
    connections: conns,
    activeConnectionId: patch.id ? s.activeConnectionId : saved.id,
  });
  refreshApi();
  return {
    settings: publicSettings(next),
    connection: { id: saved.id, name: saved.name, serverUrl: saved.serverUrl, adminKey: maskConnection(saved) },
    probe,
  };
});

handle("conn:delete", async (_e, id: string) => {
  const s = settingsStore.get();
  const conns = s.connections.filter((c) => c.id !== id);
  const active = s.activeConnectionId === id ? (conns[0]?.id ?? null) : s.activeConnectionId;
  const next = await settingsStore.set({ connections: conns, activeConnectionId: active });
  dropServices(id);
  refreshApi();
  return { settings: publicSettings(next) };
});

handle("conn:select", async (_e, id: string) => {
  const s = settingsStore.get();
  if (!s.connections.some((c) => c.id === id)) throw new AppError("unknown_connection", "unknown connection id");
  const next = await settingsStore.set({ activeConnectionId: id });
  refreshApi();
  return { settings: publicSettings(next) };
});

// ------------------------------------------------------------ backend API

handle("api:health", () => api.health());
handle("api:status", () => api.status());
handle("api:pack", () => api.pack());
handle("api:logs", (_e, limit?: number) => api.logs(limit ?? 200));
handle("api:console", (_e, line: string) => {
  if (typeof line !== "string" || !line.trim()) throw new AppError("empty_command", "Type a console command first.");
  return api.sendConsole(line);
});
handle("api:serverOp", (_e, kind: "start" | "stop" | "restart") => {
  if (!["start", "stop", "restart"].includes(kind)) throw new AppError("bad_op", `unknown server operation ${kind}`);
  return api.serverOp(kind);
});
handle("api:jobs", (_e, limit?: number) => api.jobs(limit ?? 50));
handle("api:job", (_e, id: string) => api.job(id));
handle("api:backups", () => api.backups());
handle("api:restoreBackup", (_e, id: string) => api.restoreBackup(id));
handle("api:restartAck", () => api.restartAck());
handle("api:adminProbe", () => api.probeAdmin());
handle("api:probeKey", async (_e, key: string) => {
  // Validate a candidate key without persisting it.
  const conn = settingsStore.get();
  const active = conn.connections.find((c) => c.id === conn.activeConnectionId);
  const url = normalizeBaseUrl(active?.serverUrl ?? conn.serverUrl ?? "");
  if (!url) throw new AppError("no_server", "No server selected.");
  const probeClient = new ApiClient(() => ({
    ...conn, connections: [], activeConnectionId: null, serverUrl: url, adminKey: String(key ?? ""),
  }));
  return probeClient.probeAdmin();
});
handle("api:addMod", (_e, payload: Record<string, unknown>) => api.addMod(payload));
handle("api:updateMod", (_e, modId: string, payload: Record<string, unknown>) => api.updateMod(modId, payload));
handle("api:removeMod", (_e, modId: string) => api.removeMod(modId));

handle("stream:subscribe", (_e, connId: string, wantLogs = true) => {
  const id = requireConnId(connId);
  startStreams(id, Boolean(wantLogs));
  return { subscribed: id };
});
handle("stream:unsubscribe", (_e, connId?: string) => {
  if (connId) stopStreams(connId);
  else for (const id of [...streams.keys()]) stopStreams(id);
  return { ok: true };
});

// ------------------------------------------------------------------ sync

async function activeManifest() {
  const pack = await api.pack();
  const v = validateManifest(pack.manifest);
  if (!v.ok) throw new AppError("manifest_invalid", `the server's pack manifest is invalid: ${v.problems.join("; ")}`);
  return { pack, manifest: v.manifest! };
}

handle("sync:check", async (_e, connId?: string) => {
  const { pack, manifest } = await activeManifest();
  const { sync } = servicesFor(requireConnId(connId));
  const plan = await sync.plan(manifest);
  return { ok: true as const, problems: [], plan, manifest, pack };
});

handle("sync:apply", async (_e, connId?: string) => {
  const { pack, manifest } = await activeManifest();
  const { sync } = servicesFor(requireConnId(connId));
  const plan = await sync.plan(manifest);
  const log = await sync.apply(plan);
  await sync.writeLocalRecord(manifest, plan);
  return { log, plan, pack, manifest };
});

// ------------------------------------------------------------- provision

handle("provision:inspect", async (_e, connId?: string) => {
  const { manifest } = await activeManifest();
  const id = requireConnId(connId);
  const { provision } = servicesFor(id);
  const inspection = await provision.inspect(manifest);
  return { inspection, manifest, gameDir: gameDirFor(id) };
});

handle("provision:ensure", async (_e, connId?: string, steps?: ProvisionStep[]) => {
  const { manifest } = await activeManifest();
  const id = requireConnId(connId);
  const { provision } = servicesFor(id);
  const onProgress = (p: ProvisionProgress) => emit("provision", { connId: id, ...p });
  return provision.ensure(manifest, { steps, onProgress });
});

handle("provision:command", async (_e, connId?: string) => {
  const { manifest } = await activeManifest();
  const id = requireConnId(connId);
  const s = servicesFor(id);
  // Same java binary the launcher would use, so the diagnostic command is real.
  const javaBin = (await s.provision.readMarker())?.javaHome ?? "java";
  return s.launcher.buildCommand({
    gameDir: gameDirFor(id),
    manifest,
    javaBin,
    profile: { name: settingsStore.get().playerName || "Player", uuid: "0".repeat(32), accessToken: "0" },
    provision: s.provision,
  });
});

// ---------------------------------------------------------------- launch

handle("launch:start", async (_e, connId?: string) => {
  const id = requireConnId(connId);
  // 1. Cheapest, most actionable check first: the account session.
  const profile = await auth.ensureSession().catch((e) => {
    throw new AppError(
      "not_signed_in",
      `${sanitizeMessage(e)} — use “Sign in with Microsoft” in the account bar on Home, then launch again.`,
    );
  });
  // 2. Validate the pack manifest before touching the disk.
  const { manifest } = await activeManifest();
  const s = servicesFor(id);
  // 3. Prepare anything missing, visibly (progress events reach the UI).
  const inspection = await s.provision.inspect(manifest);
  if (inspection.needs.length) {
    emit("provision", { connId: id, step: "java", message: `preparing game files: ${inspection.needs.join(", ")}` });
    const onProgress = (p: ProvisionProgress) => emit("provision", { connId: id, ...p });
    await s.provision.ensure(manifest, { onProgress });
  }
  const settings = settingsStore.get();
  const handle = await s.launcher.launch({
    gameDir: gameDirFor(id),
    manifest,
    javaBin: (await s.provision.readMarker())?.javaHome ?? "java",
    provision: s.provision,
    profile: {
      name: profile.name || settings.playerName || "Player",
      uuid: profile.uuid,
      accessToken: profile.accessToken,
    },
    onLog: (m) => emit("log", { connId: id, line: m }),
    onExit: (code) => emit("game:exit", { connId: id, code }),
  });
  return { pid: handle.pid, connId: id };
});

handle("launch:stop", async (_e, connId?: string) => {
  const existing = connId && services.has(connId) ? services.get(connId)! : null;
  if (existing) {
    existing.launcher.stop();
    return { stopped: true, connId };
  }
  // Fall back to the active connection's launcher, then to any running one, so a
  // running game is never orphaned just because the user switched views.
  for (const [id, s] of services) {
    if (s.launcher.isRunning()) {
      s.launcher.stop();
      return { stopped: true, connId: id };
    }
  }
  return { stopped: false, connId: connId ?? null };
});

handle("launch:status", async (_e, connId?: string) => {
  const s = connId ? services.get(connId) : null;
  if (s?.launcher.isRunning()) return { running: true, pid: s.launcher.pid(), connId };
  const running = [...services.entries()].find(([, v]) => v.launcher.isRunning());
  return running
    ? { running: true, pid: running[1].launcher.pid(), connId: running[0] }
    : { running: false, pid: null, connId: connId ?? null };
});

// ------------------------------------------------------- account auth (MS)

handle("auth:status", () => {
  const p = auth.current();
  return {
    signedIn: auth.hasValidSession(),
    name: p?.name ?? null,
    expiresSoon: p !== null && !auth.hasValidSession(),
  };
});

let pendingLogin: Promise<void> | null = null;
let loginError: string | null = null;
let loginUserCode = "";
let loginUri = "";
let loginExpiresAt = 0;
let loginIntervalMs = 5000;

handle("auth:startLogin", async () => {
  if (pendingLogin) return { userCode: loginUserCode, verificationUri: loginUri, expiresIn: Math.max(0, Math.round((loginExpiresAt - Date.now()) / 1000)), interval: loginIntervalMs / 1000, alreadyPending: true };
  loginError = null;
  const start = await auth.startDeviceLogin();
  loginUserCode = start.userCode;
  loginUri = start.verificationUri;
  loginExpiresAt = Date.now() + start.expiresIn * 1000;
  loginIntervalMs = start.interval * 1000;
  pendingLogin = auth.waitForDevice(start)
    .then(() => { loginError = null; })
    .catch((e) => { loginError = sanitizeMessage(e); })
    .finally(() => { pendingLogin = null; });
  return { userCode: start.userCode, verificationUri: start.verificationUri, expiresIn: start.expiresIn, interval: start.interval, alreadyPending: false };
});

handle("auth:loginStatus", () => ({
  pending: pendingLogin !== null,
  userCode: loginUserCode,
  verificationUri: loginUri,
  expiresIn: pendingLogin ? Math.max(0, Math.round((loginExpiresAt - Date.now()) / 1000)) : 0,
  interval: loginIntervalMs / 1000,
  error: loginError,
  signedIn: auth.hasValidSession(),
  name: auth.current()?.name ?? null,
}));

handle("auth:cancelLogin", () => {
  pendingLogin = null;
  loginError = "sign-in cancelled";
  loginUserCode = "";
  loginUri = "";
  return { pending: false };
});

handle("auth:signOut", async () => {
  await auth.signOut();
  return { signedIn: false };
});

handle("app:openExternal", async (_e, url: string) => {
  await openExternal(String(url));
  return { opened: true };
});

// --------------------------------------------------------------- helpers

export function __testables() {
  return { settingsStore, servicesFor, validGameDir, gameDirFor };
}

function validGameDir(dir: string): boolean {
  return dir.length > 0 && isAbsolute(dir);
}
void validGameDir;
