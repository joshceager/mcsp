/** MCSP manifest + API types (mirrors backend app/models.py; format v1). */

export type Side = "client" | "server" | "both";

export interface FileRef {
  url: string;
  filename: string;
  size: number;
  hashes: Record<string, string>; // must include sha1
}

export interface ModEntry {
  modId: string;
  name: string;
  version: string;
  side: Side;
  file: FileRef;
  iconUrl?: string | null;
  notes?: string | null;
}

export interface Manifest {
  formatVersion: number;
  loader: string;
  loaderVersion: string;
  minecraftVersion: string;
  mods: ModEntry[];
  restartRequired?: boolean;
  updatedAt?: string | null;
}

export interface PackView {
  manifest: Manifest;
  installedFiles: { filename: string; size: number; modifiedAt: string }[];
  backups?: unknown[];
}

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
  state: "queued" | "running" | "succeeded" | "failed";
  progress: number | null;
  message: string | null;
  result: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Validation result for a manifest received from a backend. */
export interface ManifestValidation {
  ok: boolean;
  problems: string[];
}

/** One planned filesystem action produced by planSync(). */
export interface SyncAction {
  kind: "download" | "remove" | "keep";
  modId?: string;
  filename: string;
  url?: string;
  sha1?: string;
  size?: number;
  side: Side;
  reason: string;
}

export interface SyncPlan {
  downloads: SyncAction[];
  removals: SyncAction[];
  unchanged: SyncAction[];
  skipped: SyncAction[]; // server-only mods never installed on the client
  restartRequired: boolean;
}

/** Local record of an installed mod file. */
export interface InstalledMod {
  filename: string;
  sha1: string;
  size: number;
  modId?: string;
}
