/** Preload: the ONLY bridge between sandboxed renderer and main. */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  },
  server: {
    health: () => ipcRenderer.invoke("api:health"),
    status: () => ipcRenderer.invoke("api:status"),
    pack: () => ipcRenderer.invoke("api:pack"),
    logs: () => ipcRenderer.invoke("api:logs"),
    console: (line: string) => ipcRenderer.invoke("api:console", line),
    serverOp: (kind: "start" | "stop" | "restart") =>
      ipcRenderer.invoke("api:serverOp", kind),
    jobs: () => ipcRenderer.invoke("api:jobs"),
    job: (id: string) => ipcRenderer.invoke("api:job", id),
    restartAck: () => ipcRenderer.invoke("api:restartAck"),
    addMod: (payload: unknown) => ipcRenderer.invoke("api:addMod", payload),
    updateMod: (modId: string, payload: unknown) =>
      ipcRenderer.invoke("api:updateMod", modId, payload),
    removeMod: (modId: string) => ipcRenderer.invoke("api:removeMod", modId),
  },
  sync: {
    check: () => ipcRenderer.invoke("sync:check"),
    apply: () => ipcRenderer.invoke("sync:apply"),
  },
  provision: {
    ensure: () => ipcRenderer.invoke("provision:ensure"),
  },
  launch: {
    start: () => ipcRenderer.invoke("launch:start"),
    stop: () => ipcRenderer.invoke("launch:stop"),
    isRunning: () => ipcRenderer.invoke("launch:isRunning"),
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (channel !== "log") return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
};

contextBridge.exposeInMainWorld("mcsp", api);
export type McspBridge = typeof api;
