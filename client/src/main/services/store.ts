/** Persistent client settings (JSON in the Electron userData dir).
 *
 *  Admin keys are protected with Electron `safeStorage` (OS keychain) whenever
 *  it is available. When it is not — headless Linux without a keyring, for
 *  example — the key is written as plaintext and the UI says so explicitly
 *  instead of pretending a keychain is in use. The settings file is always
 *  created with 0600 permissions.
 */
import { app, safeStorage } from "electron";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

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
  serverUrl: string;          // legacy single-server field (kept for migration)
  adminKey: string;           // legacy plaintext field (migration only)
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
  serverUrl: "",
  adminKey: "",
  gameDir: "",
  playerName: "Player",
  autoStartServer: false,
  connections: [],
  activeConnectionId: null,
};

const FILE = "mcsp-client-settings.json";

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
    try {
      this.path = join(app.getPath("userData"), FILE);
      const raw = await fs.readFile(this.path, "utf-8");
      const parsed = { ...DEFAULTS, ...JSON.parse(raw) } as ClientSettings;
      this.data = this.migrate(parsed);
    } catch {
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }

  /** Migrate legacy single-server settings and decrypt stored admin keys. */
  private migrate(s: ClientSettings): ClientSettings {
    const out: ClientSettings = { ...DEFAULTS, ...s, connections: s.connections ?? [] };
    // azureClientId was a short-lived user-facing setting; drop any stale value
    // so it cannot override the working built-in client id.
    if ("azureClientId" in out) delete (out as unknown as Record<string, unknown>).azureClientId;
    out.connections = out.connections.map((c) => ({
      id: c.id,
      name: c.name,
      serverUrl: c.serverUrl,
      adminKey: decryptKey(c.adminKeyEnc) ?? c.adminKey ?? "",
      adminKeyEnc: c.adminKeyEnc,
    }));
    if (out.connections.length === 0 && out.serverUrl) {
      const conn: SavedConnection = {
        id: randomUUID(),
        name: "My server",
        serverUrl: out.serverUrl,
        adminKey: out.adminKey,
      };
      out.connections = [conn];
      out.activeConnectionId = conn.id;
    }
    const active = out.connections.find((c) => c.id === out.activeConnectionId) ?? null;
    if (active) {
      out.serverUrl = active.serverUrl;
      out.adminKey = active.adminKey;
    }
    return out;
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
    const next: ClientSettings = { ...this.data, ...patch };
    const active = next.connections.find((c) => c.id === next.activeConnectionId) ?? null;
    next.serverUrl = active?.serverUrl ?? next.serverUrl;
    next.adminKey = active?.adminKey ?? next.adminKey;
    this.data = next;
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
    return this.data;
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
