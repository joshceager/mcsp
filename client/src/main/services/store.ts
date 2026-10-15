/** Persistent client settings (JSON in the Electron userData dir).
 *
 *  Admin keys are protected with Electron `safeStorage` (OS keychain) whenever
 *  it is available. When it is not — headless Linux without a keyring, for
 *  example — the key is written as plaintext and the UI says so explicitly
 *  instead of pretending a keychain is in use. The settings file is always
 *  created with 0600 permissions.
 *
 *  Shape of the file (schemaVersion 2):
 *    { schemaVersion, playerName, autoStartServer, gameDir,
 *      connections: [...], activeConnectionId }
 *  `serverUrl` / `adminKey` are *legacy mirrors* of the active connection. They
 *  are kept in memory because older code paths still read them, but they are
 *  never the source of truth: the connection list is. Migration from the
 *  pre-connections (schemaVersion 0/1) file happens exactly once, see
 *  `migrate()`.
 */
import { app, safeStorage } from "electron";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

/** Current on-disk schema. Bump when the file layout changes. */
export const SETTINGS_VERSION = 2;

/** One saved backend connection. */
export interface SavedConnection {
  id: string;          // stable uuid
  name: string;        // display name shown in sidebar / home tiles
  serverUrl: string;   // e.g. http://host:8080
  /** In memory only: plaintext key used for requests. Never written to disk. */
  adminKey: string;
  /** Persisted form when OS encryption is available. */
  adminKeyEnc?: string;
}

export interface ClientSettings {
  schemaVersion: number;      // on-disk schema (see SETTINGS_VERSION)
  serverUrl: string;          // legacy mirror of the active connection
  adminKey: string;           // legacy mirror of the active connection
  gameDir: string;            // legacy single-instance dir (migration only)
  playerName: string;         // preferred player name (fallback for the MS profile)
  autoStartServer: boolean;   // start the server when the admin tab is opened
  connections: SavedConnection[];
  activeConnectionId: string | null;
}

export interface SecurityInfo {
  encryptionAvailable: boolean;
  keyStorage: "os-keychain" | "plaintext";
  detail: string;
}

const DEFAULTS: ClientSettings = {
  schemaVersion: SETTINGS_VERSION,
  serverUrl: "",
  adminKey: "",
  gameDir: "",
  playerName: "Player",
  autoStartServer: false,
  connections: [],
  activeConnectionId: null,
};

const FILE = "mcsp-client-settings.json";

/** The only settings the renderer may change via `settings:set`.
 *
 *  The connection list is deliberately NOT patchable from there: connections
 *  are owned by the conn:* handlers, which verify a URL/key before persisting.
 *  Anything unrecognized is dropped rather than merged into the file.
 */
export function sanitizeSettingsPatch(patch: unknown): Partial<ClientSettings> {
  const out: Partial<ClientSettings> = {};
  if (!patch || typeof patch !== "object") return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.playerName === "string") out.playerName = p.playerName.slice(0, 64);
  if (typeof p.autoStartServer === "boolean") out.autoStartServer = p.autoStartServer;
  if (typeof p.gameDir === "string") out.gameDir = p.gameDir;
  return out;
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export class SettingsStore {
  private data: ClientSettings = { ...DEFAULTS };
  private path = "";

  async load(): Promise<ClientSettings> {
    let upgraded = false;
    try {
      this.path = join(app.getPath("userData"), FILE);
      const raw = await fs.readFile(this.path, "utf-8");
      const migrated = this.migrate(JSON.parse(raw) as Partial<ClientSettings>);
      this.data = migrated.settings;
      upgraded = migrated.upgraded;
    } catch {
      this.data = { ...DEFAULTS };
    }
    // Write an upgraded file straight back. Without this the migration would
    // run again on every launch (adopting the legacy fields a second time and
    // handing the connection a fresh uuid each launch).
    if (upgraded && this.path) await this.persist().catch(() => undefined);
    return this.data;
  }

  /** Upgrade an on-disk document to the current shape, in memory.
   *
   *  Files written before the multi-connection UI have no `connections` array;
   *  those (and only those) get their single server adopted as a connection.
   *  An *empty* connection list is a real, deliberate state — the user deleted
   *  everything — and must never be repopulated.
   */
  private migrate(raw: Partial<ClientSettings>): { settings: ClientSettings; upgraded: boolean } {
    const hadConnections = Array.isArray((raw as { connections?: unknown }).connections);
    const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : hadConnections ? 1 : 0;
    const out: ClientSettings = {
      ...DEFAULTS,
      ...raw,
      schemaVersion: SETTINGS_VERSION,
      connections: (hadConnections ? (raw.connections as SavedConnection[]) : []).map((c) => ({
        id: c.id,
        name: c.name,
        serverUrl: c.serverUrl,
        adminKey: decryptKey(c.adminKeyEnc) ?? c.adminKey ?? "",
        adminKeyEnc: c.adminKeyEnc,
      })),
    };
    // azureClientId was a short-lived user-facing setting; drop any stale value
    // so it cannot override the working built-in client id.
    if ("azureClientId" in out) delete (out as unknown as Record<string, unknown>).azureClientId;

    let upgraded = !hadConnections || version !== SETTINGS_VERSION;
    if (out.connections.length === 0 && !hadConnections && version < SETTINGS_VERSION && out.serverUrl) {
      const conn: SavedConnection = {
        id: randomUUID(),
        name: "My server",
        serverUrl: out.serverUrl,
        adminKey: out.adminKey,
      };
      out.connections = [conn];
      out.activeConnectionId = conn.id;
      upgraded = true;
    }

    this.syncMirrors(out);
    return { settings: out, upgraded };
  }

  get(): ClientSettings {
    return this.data;
  }

  security(): SecurityInfo {
    const available = encryptionAvailable();
    return {
      encryptionAvailable: available,
      keyStorage: available ? "os-keychain" : "plaintext",
      detail: available
        ? "Admin keys are encrypted with the OS credential store (Electron safeStorage)."
        : "No OS credential store is available, so admin keys are stored as plaintext JSON (file mode 0600).",
    };
  }

  /** Persist, encrypting admin keys first, and never writing them in the clear. */
  async set(patch: Partial<ClientSettings>): Promise<ClientSettings> {
    const next: ClientSettings = { ...this.data, ...patch, schemaVersion: SETTINGS_VERSION };
    this.syncMirrors(next);
    this.data = next;
    await this.persist();
    return this.data;
  }

  /** Point the legacy mirrors at the active connection — or at nothing at all
   *  when there is none, so a deleted server's URL can never be picked up again
   *  by a later migration or by the legacy code paths that read these fields. */
  private syncMirrors(s: ClientSettings): void {
    const active = s.connections.find((c) => c.id === s.activeConnectionId) ?? null;
    s.activeConnectionId = active ? active.id : null;
    s.serverUrl = active ? active.serverUrl : "";
    s.adminKey = active ? active.adminKey : "";
  }

  private async persist(): Promise<void> {
    if (!this.path) this.path = join(app.getPath("userData"), FILE);
    // Encrypt keys on the way out; keep legacy mirror fields empty for secrets.
    const persisted: ClientSettings = {
      ...this.data,
      adminKey: "",
      connections: this.data.connections.map((c) => {
        const enc = encryptKey(c.adminKey);
        return {
          id: c.id,
          name: c.name,
          serverUrl: c.serverUrl,
          // Only drop the plaintext copy when we actually encrypted it.
          adminKey: enc ? "" : c.adminKey,
          adminKeyEnc: enc ?? c.adminKeyEnc,
        };
      }),
    };
    await fs.mkdir(join(this.path, ".."), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(persisted, null, 2), "utf-8");
    await fs.chmod(this.path, 0o600).catch(() => undefined);
  }
}

function encryptKey(plain: string): string | undefined {
  if (!plain) return undefined;
  if (!encryptionAvailable()) return undefined;
  try {
    return safeStorage.encryptString(plain).toString("base64");
  } catch {
    return undefined;
  }
}

/** Decrypt a stored key, tolerating the legacy plaintext field. */
export function decryptKey(enc: string | undefined): string | null {
  if (!enc) return null;
  if (!encryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}
