/** Electron main process: owns all FS/network/launch logic (approved boundary).
 *  The renderer is sandboxed and talks only over the typed IPC surface below. */
import { app, BrowserWindow, ipcMain } from "electron";
import { join, isAbsolute } from "path";
import { ApiClient } from "./services/api";
import { Launcher } from "./services/launcher";
import { ProvisionService } from "./services/provision";
import { SettingsStore, type ClientSettings } from "./services/store";
import { SyncEngine } from "./services/sync";
import { ensureJava } from "./services/java";
import { validateManifest } from "../shared/manifest-validate";

const settingsStore = new SettingsStore();
let api: ApiClient;
let sync: SyncEngine | null = null;
let provision: ProvisionService | null = null;
let launcher: Launcher | null = null;
let win: BrowserWindow | null = null;

const REBUILD: { fn: () => void; desc: string }[] = [
  { desc: "sync", fn: () => { sync = new SyncEngine(g(), (m) => emit("log", m)); } },
  { desc: "provision", fn: () => { provision = new ProvisionService(g(), join(g(), "mcsp-runtime"), (m) => emit("log", m)); } },
  { desc: "launcher", fn: () => { launcher = new Launcher(); } },
];

function g(): string {
  return settingsStore.get().gameDir;
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
  const settings = settingsStore.get();
  const handle = await services.launcher.launch({
    gameDir: settings.gameDir,
    manifest: pack.manifest,
    javaBin: res.javaBin,
    playerName: settings.playerName || "Player",
    onLog: (m) => emit("log", m),
  });
  return { pid: handle.process.pid };
});

ipcMain.handle("launch:stop", async () => {
  launcher?.stop();
  return { stopped: true };
});
ipcMain.handle("launch:isRunning", async () => ({ running: launcher?.isRunning() ?? false }));

// --------------------------------------------------------------- helpers for tests
export function __testables() {
  return { settingsStore, REBUILD, validGameDir };
}
