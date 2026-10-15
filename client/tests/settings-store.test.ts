/** SettingsStore: saved-connection lifecycle.
 *
 *  Regression cover for the "phantom My server connection" bug: a profile with
 *  zero saved connections must stay at zero across launches. The store keeps a
 *  legacy single-server `serverUrl` mirror for migration, and that mirror used
 *  to resurrect a brand-new connection (name "My server", fresh uuid) on every
 *  single load.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const h = vi.hoisted(() => ({ userData: "", encryption: false }));

vi.mock("electron", () => ({
  app: { getPath: () => h.userData },
  safeStorage: {
    isEncryptionAvailable: () => h.encryption,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf-8");
      if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
      return s.slice(4);
    },
  },
}));

import { SettingsStore, sanitizeSettingsPatch } from "../src/main/services/store";

const FILE = "mcsp-client-settings.json";
const path = () => join(h.userData, FILE);

async function freshProfile(): Promise<void> {
  h.userData = await fs.mkdtemp(join(tmpdir(), "mcsp-store-"));
}

async function writeRaw(obj: unknown): Promise<void> {
  await fs.writeFile(path(), JSON.stringify(obj, null, 2), "utf-8");
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path(), "utf-8"));
}

async function loadStore(): Promise<SettingsStore> {
  const s = new SettingsStore();
  await s.load();
  return s;
}

/** Save a connection the way the main process does, then delete it. */
async function addThenDeleteEverything(s: SettingsStore, name: string): Promise<void> {
  const saved = { id: `id-${name}`, name, serverUrl: "http://127.0.0.1:8080", adminKey: "" };
  await s.set({ connections: [saved], activeConnectionId: saved.id });
  await s.set({ connections: [], activeConnectionId: null });
}

beforeEach(async () => {
  h.encryption = false;
  await freshProfile();
});

describe("SettingsStore: no connection is ever invented", () => {
  it("keeps a brand-new profile at zero connections", async () => {
    const s = await loadStore();
    expect(s.get().connections).toEqual([]);
    expect(s.get().activeConnectionId).toBeNull();
  });

  it("does not resurrect a connection from the legacy mirror after the last one is deleted", async () => {
    // 1. user saves a server and later deletes it
    const first = await loadStore();
    await addThenDeleteEverything(first, "Real Server");
    expect(first.get().connections).toEqual([]);

    // 2. relaunch: the deleted connection must stay deleted
    const second = await loadStore();
    expect(second.get().connections).toEqual([]);
    expect(second.get().activeConnectionId).toBeNull();

    // 3. and again, for good measure
    const third = await loadStore();
    expect(third.get().connections).toEqual([]);
  });

  it("tolerates a polluted file that still carries a stale legacy serverUrl", async () => {
    // exactly what the buggy delete path wrote to disk
    await writeRaw({
      serverUrl: "http://127.0.0.1:8080",
      adminKey: "",
      gameDir: "",
      playerName: "Player",
      autoStartServer: false,
      connections: [],
      activeConnectionId: null,
    });
    const s = await loadStore();
    expect(s.get().connections).toEqual([]);
    expect(s.get().activeConnectionId).toBeNull();
    expect(s.get().serverUrl).toBe("");
  });

  it("stops writing the stale mirror once the last connection is gone", async () => {
    const s = await loadStore();
    await addThenDeleteEverything(s, "Real Server");
    const raw = await readRaw();
    expect(raw.serverUrl).toBe("");
    expect(raw.connections).toEqual([]);
  });
});

describe("SettingsStore: legacy single-server migration", () => {
  const legacy = { serverUrl: "http://legacy:8080", adminKey: "legacy-key", gameDir: "", playerName: "Player", autoStartServer: false };

  it("adopts a pre-connections settings file exactly once", async () => {
    await writeRaw(legacy);

    const first = await loadStore();
    expect(first.get().connections).toHaveLength(1);
    expect(first.get().connections[0].name).toBe("My server");
    expect(first.get().connections[0].serverUrl).toBe("http://legacy:8080");
    const adoptedId = first.get().connections[0].id;
    expect(first.get().activeConnectionId).toBe(adoptedId);

    // the upgrade is persisted, so the id is stable across launches
    const second = await loadStore();
    expect(second.get().connections).toHaveLength(1);
    expect(second.get().connections[0].id).toBe(adoptedId);
    expect(second.get().activeConnectionId).toBe(adoptedId);
  });

  it("lets the user delete the migrated connection for good", async () => {
    await writeRaw(legacy);
    const first = await loadStore();
    expect(first.get().connections).toHaveLength(1);
    await first.set({ connections: [], activeConnectionId: null });

    const second = await loadStore();
    expect(second.get().connections).toEqual([]);
  });

  it("does not re-adopt the legacy fields once the file is versioned", async () => {
    await writeRaw({ ...legacy, schemaVersion: 2, connections: [], activeConnectionId: null });
    const s = await loadStore();
    expect(s.get().connections).toEqual([]);
  });
});

describe("SettingsStore: admin key handling", () => {
  const conn = (adminKey: string) => ({ id: "c1", name: "S", serverUrl: "http://x:8080", adminKey });

  it("keeps plaintext keys when no keychain is available, and says so", async () => {
    const s = await loadStore();
    await s.set({ connections: [conn("plain-key")], activeConnectionId: "c1" });
    const raw = await readRaw();
    expect((raw.connections as { adminKey: string }[])[0].adminKey).toBe("plain-key");
    expect(s.security().keyStorage).toBe("plaintext");
  });

  it("never writes a plaintext key when encryption is available", async () => {
    h.encryption = true;
    const s = await loadStore();
    await s.set({ connections: [conn("secret-key")], activeConnectionId: "c1" });
    const raw = await readRaw();
    const stored = (raw.connections as { adminKey: string; adminKeyEnc: string }[])[0];
    expect(stored.adminKey).toBe("");
    expect(stored.adminKeyEnc).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain("secret-key");
    expect((await loadStore()).get().connections[0].adminKey).toBe("secret-key");
  });

  it("survives a key that cannot be decrypted (e.g. a new machine key)", async () => {
    h.encryption = true;
    await writeRaw({ schemaVersion: 2, connections: [{ id: "c1", name: "S", serverUrl: "http://x:8080", adminKey: "", adminKeyEnc: "bm90LWEtY2lwaGVy" }], activeConnectionId: "c1" });
    const s = await loadStore();
    expect(s.get().connections[0].adminKey).toBe("");
  });
});

describe("settings:set input from the renderer", () => {
  it("only accepts known scalar settings, never the connection list", () => {
    const patch = sanitizeSettingsPatch({
      playerName: "Alice",
      autoStartServer: true,
      connections: [],
      activeConnectionId: null,
      schemaVersion: 99,
      serverUrl: "http://evil:8080",
    });
    expect(patch).toEqual({ playerName: "Alice", autoStartServer: true });
  });

  it("ignores junk payloads instead of throwing", () => {
    expect(sanitizeSettingsPatch(null)).toEqual({});
    expect(sanitizeSettingsPatch("nope")).toEqual({});
    expect(sanitizeSettingsPatch({ playerName: 42, autoStartServer: "yes" })).toEqual({});
  });

  it("keeps the saved connection list intact through a settings save", async () => {
    const s = await loadStore();
    await s.set({ connections: [{ id: "c1", name: "S", serverUrl: "http://x:8080", adminKey: "" }], activeConnectionId: "c1" });

    const patched = await s.set(sanitizeSettingsPatch({ playerName: "Alice", connections: [], activeConnectionId: null }));
    expect(patched.playerName).toBe("Alice");
    expect(patched.connections).toHaveLength(1);
    expect((await readRaw()).connections).toHaveLength(1);
  });
});
