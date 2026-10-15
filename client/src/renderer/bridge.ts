/** Typed access to the preload bridge, plus the UI-facing data shapes. */

export interface SavedConnection {
  id: string;
  name: string;
  serverUrl: string;
  /** "***" when a key is stored (the real key never leaves the main process). */
  adminKey: string;
}
export interface ClientSettings {
  /** On-disk schema version (see main/services/store.ts). */
  schemaVersion?: number;
  serverUrl: string;
  adminKey: string;
  gameDir: string;
  playerName: string;
  autoStartServer: boolean;
  connections: SavedConnection[];
  activeConnectionId: string | null;
}
export interface SecurityInfo {
  encryptionAvailable: boolean;
  keyStorage: "os-keychain" | "plaintext";
  detail: string;
}
export interface SettingsBundle { settings: ClientSettings; security: SecurityInfo }

export interface ServerStatus {
  state: "starting" | "running" | "stopping" | "stopped" | "error";
  pid: number | null;
  startedAt: string | null;
  restartRequired: boolean;
  pendingRestart: boolean;
  autoRestartCount: number;
  installedMcVersion: string | null;
  installedLoader: string | null;
  installedLoaderVersion: string | null;
  joinAddress: string | null;
  joinPort: number;
  apiPort: number;
  adminEnabled: boolean;
  managerEnabled: boolean;
}
export interface JobView {
  id: string;
  kind: string;
  state: "queued" | "running" | "succeeded" | "failed" | string;
  progress: number | null;
  message: string | null;
  result: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}
export interface ModEntry {
  modId: string; name: string; version: string; side: string;
  file: { url: string; filename: string; size: number; hashes: Record<string, string> };
}
export interface Manifest {
  formatVersion: number; loader: string; loaderVersion: string; minecraftVersion: string;
  mods: ModEntry[]; restartRequired?: boolean; updatedAt?: string | null;
}
export interface PackView {
  manifest: Manifest | null;
  installedFiles?: { filename: string; size: number; modifiedAt: string }[];
  installed?: { filename: string; size: number; modifiedAt: string }[];
  restartRequired?: boolean;
}
export interface BackupView { id: string; size?: number; createdAt?: string; reason?: string; path?: string }
export interface SyncAction { kind: string; modId?: string; filename: string; reason: string; side: string }
export interface SyncPlan {
  downloads: SyncAction[]; removals: SyncAction[]; unchanged: SyncAction[]; skipped: SyncAction[];
  restartRequired: boolean;
}
export interface ProvisionInspection {
  java: { ready: boolean; source: string; version: number | null; path: string | null };
  clientJar: boolean; versionJson: boolean;
  librariesPresent: number; librariesTotal: number;
  assetsReady: boolean; loaderReady: boolean;
  loaderVersionInstalled: string | null; installedMcVersion: string | null;
  needs: string[];
}
export interface AuthStatus { signedIn: boolean; name: string | null; expiresSoon: boolean }
export interface LoginStart { userCode: string; verificationUri: string; expiresIn: number; interval: number; alreadyPending: boolean }
export interface LoginStatus {
  pending: boolean; userCode: string; verificationUri: string;
  expiresIn: number; interval: number; error: string | null; signedIn: boolean; name: string | null;
}
export interface ConnectVerify { ok: boolean; url: string; adminEnabled: boolean; service?: string; version?: number | string }
export interface LaunchStatus { running: boolean; pid: number | null; connId: string | null }

export interface Bridge {
  settings: { get(): Promise<SettingsBundle>; set(p: Partial<ClientSettings>): Promise<SettingsBundle> };
  connections: {
    list(): Promise<{ settings: ClientSettings }>;
    verify(p: { serverUrl: string; adminKey?: string }): Promise<ConnectVerify>;
    save(p: { id?: string; name?: string; serverUrl: string; adminKey?: string }): Promise<{ settings: ClientSettings; connection: SavedConnection }>;
    delete(id: string): Promise<{ settings: ClientSettings }>;
    select(id: string): Promise<{ settings: ClientSettings }>;
  };
  server: {
    health(): Promise<{ ok: boolean; service?: string; adminEnabled: boolean }>;
    status(): Promise<ServerStatus>;
    pack(): Promise<PackView>;
    logs(limit?: number): Promise<{ lines: string[] }>;
    console(line: string): Promise<unknown>;
    serverOp(kind: "start" | "stop" | "restart"): Promise<{ id: string }>;
    jobs(limit?: number): Promise<{ jobs: JobView[] }>;
    job(id: string): Promise<JobView>;
    backups(): Promise<{ backups: BackupView[] }>;
    restoreBackup(id: string): Promise<unknown>;
    restartAck(): Promise<{ restartRequired: boolean }>;
    adminProbe(): Promise<{ ok: boolean; adminEnabled: boolean; message: string }>;
    probeKey(key: string): Promise<{ ok: boolean; adminEnabled: boolean; message: string }>;
    addMod(payload: unknown): Promise<{ id: string }>;
    updateMod(modId: string, payload: unknown): Promise<{ id: string }>;
    removeMod(modId: string): Promise<{ id: string }>;
  };
  stream: { subscribe(connId: string, logs?: boolean): Promise<unknown>; unsubscribe(connId?: string): Promise<unknown> };
  sync: { check(connId?: string): Promise<{ ok: boolean; problems?: string[]; plan: SyncPlan | null; manifest?: Manifest; pack?: PackView }>; apply(connId?: string): Promise<{ log: string[]; plan: SyncPlan; pack: PackView; manifest: Manifest }> };
  provision: {
    inspect(connId?: string): Promise<{ inspection: ProvisionInspection; manifest: Manifest; gameDir: string }>;
    ensure(connId?: string, steps?: string[]): Promise<{ installed: string[]; javaBin: string; action: string; gameDir: string }>;
    command(connId?: string): Promise<{ args: string[]; javaBin: string }>;
  };
  launch: { start(connId?: string): Promise<{ pid: number; connId: string }>; stop(connId?: string): Promise<{ stopped: boolean; connId: string | null }>; status(connId?: string): Promise<LaunchStatus> };
  auth: {
    status(): Promise<AuthStatus>;
    startLogin(): Promise<LoginStart>;
    loginStatus(): Promise<LoginStatus>;
    cancelLogin(): Promise<unknown>;
    signOut(): Promise<unknown>;
  };
  app: { openExternal(url: string): Promise<unknown> };
  on(channel: "log" | "provision" | "server:status" | "server:job" | "server:log" | "stream:error" | "game:exit", cb: (payload: unknown) => void): () => void;
}

declare global {
  interface Window { mcsp: Bridge }
}

export const bridge = (): Bridge => window.mcsp;
