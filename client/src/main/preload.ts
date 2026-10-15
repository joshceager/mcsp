/** Preload: the ONLY bridge between the sandboxed renderer and main.
 *  Main returns result envelopes; this unwraps them into clean promises so no
 *  Electron IPC internals ever surface in user-facing text. */
import { contextBridge, ipcRenderer } from "electron";

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; status?: number };
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>;
  if (res && res.ok) return res.value as T;
  const err = new Error(res?.error?.message ?? "unknown error") as Error & { code?: string; status?: number };
  err.code = res?.error?.code ?? "error";
  err.status = res?.error?.status ?? 0;
  throw err;
}

const EVENTS = [
  "log",
  "provision",
  "server:status",
  "server:job",
  "server:log",
  "stream:error",
  "game:exit",
] as const;
type EventChannel = (typeof EVENTS)[number];

const api = {
  settings: {
    get: () => call<unknown>("settings:get"),
    set: (patch: unknown) => call<unknown>("settings:set", patch),
  },
  connections: {
    list: () => call<unknown>("conn:list"),
    verify: (payload: { serverUrl: string; adminKey?: string }) => call<unknown>("conn:verify", payload),
    save: (patch: unknown) => call<unknown>("conn:save", patch),
    delete: (id: string) => call<unknown>("conn:delete", id),
    select: (id: string) => call<unknown>("conn:select", id),
  },
  server: {
    health: () => call<unknown>("api:health"),
    status: () => call<unknown>("api:status"),
    pack: () => call<unknown>("api:pack"),
    logs: (limit?: number) => call<unknown>("api:logs", limit),
    console: (line: string) => call<unknown>("api:console", line),
    serverOp: (kind: "start" | "stop" | "restart") => call<unknown>("api:serverOp", kind),
    jobs: (limit?: number) => call<unknown>("api:jobs", limit),
    job: (id: string) => call<unknown>("api:job", id),
    backups: () => call<unknown>("api:backups"),
    restoreBackup: (id: string) => call<unknown>("api:restoreBackup", id),
    restartAck: () => call<unknown>("api:restartAck"),
    adminProbe: () => call<unknown>("api:adminProbe"),
    probeKey: (key: string) => call<unknown>("api:probeKey", key),
    addMod: (payload: unknown) => call<unknown>("api:addMod", payload),
    updateMod: (modId: string, payload: unknown) => call<unknown>("api:updateMod", modId, payload),
    removeMod: (modId: string) => call<unknown>("api:removeMod", modId),
  },
  stream: {
    subscribe: (connId: string, logs = true) => call<unknown>("stream:subscribe", connId, logs),
    unsubscribe: (connId?: string) => call<unknown>("stream:unsubscribe", connId),
  },
  sync: {
    check: (connId?: string) => call<unknown>("sync:check", connId),
    apply: (connId?: string) => call<unknown>("sync:apply", connId),
  },
  provision: {
    inspect: (connId?: string) => call<unknown>("provision:inspect", connId),
    ensure: (connId?: string, steps?: string[]) => call<unknown>("provision:ensure", connId, steps),
    command: (connId?: string) => call<unknown>("provision:command", connId),
  },
  launch: {
    start: (connId?: string) => call<unknown>("launch:start", connId),
    stop: (connId?: string) => call<unknown>("launch:stop", connId),
    status: (connId?: string) => call<unknown>("launch:status", connId),
  },
  auth: {
    status: () => call<unknown>("auth:status"),
    startLogin: () => call<unknown>("auth:startLogin"),
    loginStatus: () => call<unknown>("auth:loginStatus"),
    cancelLogin: () => call<unknown>("auth:cancelLogin"),
    signOut: () => call<unknown>("auth:signOut"),
  },
  app: {
    openExternal: (url: string) => call<unknown>("app:openExternal", url),
  },
  on: (channel: EventChannel, cb: (payload: unknown) => void) => {
    if (!EVENTS.includes(channel)) return () => undefined;
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("mcsp", api);
export type McspBridge = typeof api;
