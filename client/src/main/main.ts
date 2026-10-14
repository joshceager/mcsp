/** Electron main process: owns all FS/network/launch logic (approved boundary).
 *  The renderer is sandboxed and talks only over the typed IPC surface below. */
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { join, isAbsolute } from "path";
import { randomUUID as uuid } from "crypto";
import { ApiClient } from "./services/api";
import { Launcher } from "./services/launcher";
import { ProvisionService } from "./services/provision";
import { SettingsStore, type ClientSettings } from "./services/store";
import { SyncEngine } from "./services/sync";
import { McAuth } from "./services/auth";
import { ensureJava } from "./services/java";
import { validateManifest } from "../shared/manifest-validate";

const settingsStore = new SettingsStore();
let auth = new McAuth({ storeDir: join(app.getPath("home"), ".mcsp") });
let api: ApiClient;
let sync: SyncEngine | null = null;
let provision: ProvisionService | null = null;
let launcher: Launcher | null = null;
let win: BrowserWindow | null = null;

const REBUILD: { fn: () => void; desc: string }[] = [
  { desc: "sync", fn: () => { sync = new SyncEngine(g(), (m) => emit("log", m)); } },
  { desc: "provision", fn: () => { provision = new ProvisionService(g(), join(dataRoot(), "runtime"), (m) => emit("log", m)); } },
  { desc: "launcher", fn: () => { launcher = new Launcher(); } },
];

/** Per-connection instance dir: ~/.mcsp/instances/<connId> (cross-platform home).
 *  Falls back to the legacy gameDir for pre-multi-connection settings. */
function g(): string {
  const s = settingsStore.get();
  const conn = s.connections.find((c) => c.id === s.activeConnectionId);
  if (conn) return join(app.getPath("home"), ".mcsp", "instances", conn.id);
  return s.gameDir;
}

/** Shared data root (~/.mcsp): holds the common Java runtime so it is
 *  downloaded once, not once per server instance. */
function dataRoot(): string {
  return join(app.getPath("home"), ".mcsp");
}

function rebuildServices(): void {
  for (const r of REBUILD) r.fn();
}

function emit(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function requireReady(): { sync: SyncEngine; provision: ProvisionService; launcher: Launcher } {
  if (!sync || !provision || !launcher) {
    rebuildServices();
  }
  return { sync: sync!, provision: provision!, launcher: launcher! };
}

function validGameDir(dir: string): boolean {
  return dir.length > 0 && isAbsolute(dir);
}

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null); // no default File/Edit menu bar
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses electron ipcRenderer only
    },
  });
  win.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(async () => {
  await settingsStore.load();
  auth = new McAuth({ storeDir: join(app.getPath("home"), ".mcsp") });
  await auth.load();
  api = new ApiClient(() => settingsStore.get());
  rebuildServices();
  await createWindow();
});
app.on("window-all-closed", () => {
  launcher?.stop();
  app.quit();
});

// --------------------------------------------------------------------- IPC

ipcMain.handle("settings:get", async () => settingsStore.get());
ipcMain.handle("settings:set", async (_e, patch: Partial<ClientSettings>) => {
  await settingsStore.set(patch);
  return settingsStore.get();
});

ipcMain.handle("api:health", async () => api.health());
ipcMain.handle("api:status", async () => api.status());
ipcMain.handle("api:pack", async () => api.pack());
ipcMain.handle("api:logs", async () => api.logs());
ipcMain.handle("api:console", async (_e, line: string) => {
  if (typeof line !== "string" || !line.trim()) throw new Error("empty console command");
  return api.sendConsole(line);
});
ipcMain.handle("api:serverOp", async (_e, kind: "start" | "stop" | "restart") =>
  api.serverOp(kind));
ipcMain.handle("api:jobs", async () => api.jobs());
ipcMain.handle("api:job", async (_e, id: string) => api.job(id));
ipcMain.handle("api:restartAck", async () => api.restartAck());

ipcMain.handle("api:addMod", async (_e, payload: Record<string, unknown>) => api.addMod(payload));
ipcMain.handle("api:updateMod", async (_e, modId: string, payload: Record<string, unknown>) =>
  api.updateMod(modId, payload));
ipcMain.handle("api:removeMod", async (_e, modId: string) => api.removeMod(modId));

ipcMain.handle("sync:check", async () => {
  const pack = await api.pack();
  const v = validateManifest(pack.manifest);
  if (!v.ok) {
    return { ok: false as const, problems: v.problems, plan: null };
  }
  const s = requireReady().sync;
  const plan = await s.plan(pack.manifest);
  return { ok: true as const, problems: [], plan, manifest: pack.manifest };
});

ipcMain.handle("sync:apply", async () => {
  const pack = await api.pack();
  const v = validateManifest(pack.manifest);
  if (!v.ok) throw new Error(`manifest invalid: ${v.problems.join("; ")}`);
  const s = requireReady().sync;
  const plan = await s.plan(pack.manifest);
  const log = await s.apply(plan);
  await s.writeLocalRecord(pack.manifest, plan);
  return { log, plan };
});

ipcMain.handle("provision:ensure", async () => {
  const pack = await api.pack();
  const v = validateManifest(pack.manifest);
  if (!v.ok) throw new Error(`manifest invalid: ${v.problems.join("; ")}`);
  return requireReady().provision.ensure(pack.manifest, ensureJava);
});

ipcMain.handle("launch:start", async () => {
  const pack = await api.pack();
  const v = validateManifest(pack.manifest);
  if (!v.ok) throw new Error(`manifest invalid: ${v.problems.join("; ")}`);
  const services = requireReady();
  const res = await services.provision.ensure(pack.manifest, ensureJava);
  const profile = await auth.ensureSession(); // online mode: real MS account
  const handle = await services.launcher.launch({
    gameDir: g(),
    manifest: pack.manifest,
    javaBin: res.javaBin,
    profile: { name: profile.name, uuid: profile.uuid, accessToken: profile.accessToken },
    onLog: (m) => emit("log", m),
  });
  return { pid: handle.process.pid };
});

ipcMain.handle("launch:stop", async () => {
  launcher?.stop();
  return { stopped: true };
});
ipcMain.handle("launch:isRunning", async () => ({ running: launcher?.isRunning() ?? false }));


// ------------------------------------------------------- account auth (MS)
ipcMain.handle("auth:status", async () => {
  const p = auth.current();
  return {
    signedIn: auth.hasValidSession(),
    name: p?.name ?? null,
    expiresSoon: p !== null && !auth.hasValidSession(),
  };
});
let pendingLogin: Promise<void> | null = null;
let loginError: string | null = null;

ipcMain.handle("auth:startLogin", async () => {
  if (pendingLogin) return { userCode: loginUserCode, verificationUri: loginUri };
  loginError = null;
  const start = await auth.startDeviceLogin();
  loginUserCode = start.userCode;
  loginUri = start.verificationUri;
  pendingLogin = auth.waitForDevice(start)
    .then(() => { loginError = null; })
    .catch((e) => { loginError = String(e); })
    .finally(() => { pendingLogin = null; });
  return { userCode: start.userCode, verificationUri: start.verificationUri };
});
let loginUserCode = "";
let loginUri = "";

ipcMain.handle("auth:loginStatus", async () => ({
  pending: pendingLogin !== null,
  userCode: loginUserCode,
  verificationUri: loginUri,
  error: loginError,
  signedIn: auth.hasValidSession(),
  name: auth.current()?.name ?? null,
}));
ipcMain.handle("auth:signOut", async () => {
  await auth.signOut();
  return { signedIn: false };
});

// ----------------------------------------------------- connection management
function upsertConnection(patch: {
  id?: string; name?: string; serverUrl: string; adminKey?: string;
}): Promise<ClientSettings> {
  const s = settingsStore.get();
  const conns = [...s.connections];
  if (patch.id) {
    const i = conns.findIndex((c) => c.id === patch.id);
    if (i === -1) throw new Error("unknown connection id");
    conns[i] = { ...conns[i], name: patch.name ?? conns[i].name,
      serverUrl: patch.serverUrl.replace(/\/+$/, ""), adminKey: patch.adminKey ?? conns[i].adminKey };
    return settingsStore.set({ connections: conns });
  }
  const conn = {
    id: uuid(),
    name: patch.name || patch.serverUrl,
    serverUrl: patch.serverUrl.replace(/\/+$/, ""),
    adminKey: patch.adminKey ?? "",
  };
  conns.push(conn);
  return settingsStore.set({ connections: conns, activeConnectionId: conn.id });
}

ipcMain.handle("conn:list", async () => {
  const s = settingsStore.get();
  return { connections: s.connections, activeConnectionId: s.activeConnectionId };
});
ipcMain.handle("conn:save", async (_e, patch: Record<string, string>) => {
  if (typeof patch.serverUrl !== "string" || !patch.serverUrl.trim()) throw new Error("server URL required");
  const cs = await upsertConnection({
    id: typeof patch.id === "string" && patch.id ? patch.id : undefined,
    name: typeof patch.name === "string" ? patch.name : undefined,
    serverUrl: patch.serverUrl,
    adminKey: typeof patch.adminKey === "string" ? patch.adminKey : undefined,
  });
  api = new ApiClient(() => settingsStore.get());
  rebuildServices();
  return cs;
});
ipcMain.handle("conn:delete", async (_e, id: string) => {
  const s = settingsStore.get();
  const conns = s.connections.filter((c) => c.id !== id);
  const active = s.activeConnectionId === id ? (conns[0]?.id ?? null) : s.activeConnectionId;
  const cs = await settingsStore.set({ connections: conns, activeConnectionId: active });
  api = new ApiClient(() => settingsStore.get());
  rebuildServices();
  return cs;
});
ipcMain.handle("conn:select", async (_e, id: string) => {
  const s = settingsStore.get();
  if (!s.connections.some((c) => c.id === id)) throw new Error("unknown connection id");
  const cs = await settingsStore.set({ activeConnectionId: id });
  api = new ApiClient(() => settingsStore.get());
  rebuildServices();
  return cs;
});

// --------------------------------------------------------------- helpers for tests
export function __testables() {
  return { settingsStore, REBUILD, validGameDir };
}
