/** End-to-end-ish tests for the provisioning/asset pipeline and for the
 *  connect-time backend validation, using local stub HTTP servers so nothing
 *  touches the real Mojang CDN.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

const libAlways = Buffer.from("lib-always");
const libLinux = Buffer.from("lib-linux-natives");
const libMac = Buffer.from("lib-mac-only");
const clientJar = Buffer.from("fake-minecraft-client-jar");
const assetA = Buffer.from("asset-alpha");
const assetB = Buffer.from("asset-beta");
const logCfg = Buffer.from("<configuration/>");

interface Stub { server: http.Server; base: string; hits: string[] }

async function startStub(handler: (url: string, req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Stub> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req.url ?? "/", req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}`, hits };
}

function send(res: http.ServerResponse, body: Buffer | string, type = "application/json", code = 200) {
  res.writeHead(code, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

let meta: Stub;
let notMcsp: Stub;
let goodBackend: Stub;
let secureBackend: Stub;

beforeAll(async () => {
  meta = await startStub((url, _req, res) => {
    const base = `${meta.base}`;
    if (url === "/mc/game/version_manifest_v2.json") {
      return send(res, JSON.stringify({ versions: [{ id: "1.21.1", url: `${base}/v/1.21.1.json` }] }));
    }
    if (url === "/v/1.21.1.json") {
      return send(res, JSON.stringify({
        id: "1.21.1",
        mainClass: "net.minecraft.client.main.Main",
        assetIndex: { id: "testidx", sha1: sha1(Buffer.from("idx")), size: 10, url: `${base}/assets/idx.json` },
        downloads: { client: { url: `${base}/client.jar`, sha1: sha1(clientJar), size: clientJar.length } },
        logging: { client: { argument: "-Dlog4j.configurationFile=${path}", file: { id: "client-1.12.xml", sha1: sha1(logCfg), size: logCfg.length, url: `${base}/log.xml` } } },
        libraries: [
          { name: "com.example:always:1.0", downloads: { artifact: { path: "com/example/always/1.0/always-1.0.jar", url: `${base}/libs/always.jar`, sha1: sha1(libAlways), size: libAlways.length } } },
          { name: "com.example:maconly:1.0", downloads: { artifact: { path: "com/example/maconly/1.0/maconly-1.0.jar", url: `${base}/libs/mac.jar`, sha1: sha1(libMac), size: libMac.length } }, rules: [{ action: "allow", os: { name: "osx" } }] },
          { name: "org.lwjgl:lwjgl:3.3.3:natives-linux", downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar", url: `${base}/libs/natives.jar`, sha1: sha1(libLinux), size: libLinux.length } }, rules: [{ action: "allow", os: { name: "linux" } }] },
        ],
        arguments: { jvm: ["-cp", "${classpath}"], game: ["--assetsDir", "${assets_root}", "--assetIndex", "${assets_index_name}"] },
      }));
    }
    if (url === "/assets/idx.json") {
      return send(res, JSON.stringify({
        objects: {
          "a.txt": { hash: sha1(assetA), size: assetA.length },
          "b.txt": { hash: sha1(assetB), size: assetB.length },
        },
      }));
    }
    if (url === `/${sha1(assetA).slice(0, 2)}/${sha1(assetA)}`) return send(res, assetA, "application/octet-stream");
    if (url === `/${sha1(assetB).slice(0, 2)}/${sha1(assetB)}`) return send(res, assetB, "application/octet-stream");
    if (url === "/libs/always.jar") return send(res, libAlways, "application/octet-stream");
    if (url === "/libs/natives.jar") return send(res, libLinux, "application/octet-stream");
    if (url === "/libs/mac.jar") return send(res, libMac, "application/octet-stream");
    if (url === "/client.jar") return send(res, clientJar, "application/octet-stream");
    if (url === "/log.xml") return send(res, logCfg, "application/xml");
    send(res, "not found", "text/plain", 404);
  });

  notMcsp = await startStub((_url, _req, res) =>
    send(res, "<!doctype html><html><head><title>Example Domain</title></head><body><p>nope</p></body></html>", "text/html"));

  goodBackend = await startStub((url, _req, res) => {
    if (url === "/api/v1/health") return send(res, JSON.stringify({ ok: true, service: "mcsp-backend", version: 1, adminEnabled: true }));
    if (url === "/api/v1/jobs?limit=1") return send(res, JSON.stringify({ jobs: [] }));
    send(res, "not found", "text/plain", 404);
  });

  // A backend that actually enforces its admin key.
  secureBackend = await startStub((url, req, res) => {
    if (url === "/api/v1/health") return send(res, JSON.stringify({ ok: true, service: "mcsp-backend", version: 1, adminEnabled: true }));
    if (req.headers.authorization !== "Bearer goodkey") {
      return send(res, JSON.stringify({ error: "unauthorized", message: "Invalid or missing admin key." }), "application/json", 401);
    }
    if (url.startsWith("/api/v1/jobs")) return send(res, JSON.stringify({ jobs: [] }));
    send(res, "not found", "text/plain", 404);
  });
});

afterAll(async () => {
  for (const s of [meta, notMcsp, goodBackend, secureBackend]) {
    await new Promise<void>((r) => s.server.close(() => r()));
  }
});

describe("connect-time backend validation (bug: any 200 URL was accepted)", () => {
  it("rejects a plain HTML page that returns 200", async () => {
    await expect(verifyBackendSafe(notMcsp.base)).rejects.toThrow(/not an MCSP backend|HTML page/);
  });

  it("rejects a host with no /api/v1/health", async () => {
    await expect(verifyBackendSafe("http://127.0.0.1:1")).rejects.toThrow(/cannot reach/);
  });

  it("accepts a real MCSP backend and reports admin availability", async () => {
    const r = await verifyBackendSafe(goodBackend.base);
    expect(r.ok).toBe(true);
    expect(r.adminEnabled).toBe(true);
    expect(r.service).toBe("mcsp-backend");
  });

  it("normalizes a bare host:port into http://", async () => {
    const hostport = goodBackend.base.replace("http://", "");
    const r = await verifyBackendSafe(hostport);
    expect(r.ok).toBe(true);
  });

  it("surfaces a rejected admin key instead of silently unlocking", async () => {
    const { ApiClient } = await import("../src/main/services/api");
    const mk = (key: string) => new ApiClient(() => ({
      serverUrl: secureBackend.base, adminKey: key, gameDir: "", playerName: "p",
      autoStartServer: false, connections: [], activeConnectionId: null,
    }));
    const bad = await mk("wrong").probeAdmin();
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/401|rejected/);
    const good = await mk("goodkey").probeAdmin();
    expect(good.ok).toBe(true);
    const empty = await mk("").probeAdmin();
    expect(empty.ok).toBe(false);
  });
});

async function verifyBackendSafe(url: string) {
  const { verifyBackend } = await import("../src/main/services/api");
  return verifyBackend(url);
}

describe("provisioning pipeline", () => {
  it("downloads the vanilla client, libraries, log config and ALL assets", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mcsp-prov-"));
    const gameDir = join(root, "inst");
    const runtimeDir = join(root, "runtime");
    process.env.MCSP_META_BASE = meta.base;
    process.env.MCSP_ASSET_BASE = meta.base;
    const logs: string[] = [];
    const { ProvisionService } = await import("../src/main/services/provision");
    const svc = new ProvisionService(gameDir, runtimeDir, (m) => logs.push(m));

    const res = await svc.ensure({ minecraftVersion: "1.21.1", loaderVersion: "21.1.259" }, { steps: ["vanilla", "assets"] });
    expect(res.installed).toEqual(expect.arrayContaining(["vanilla", "assets"]));

    // version json + client jar
    const vj = JSON.parse(await fs.readFile(join(gameDir, "versions/1.21.1/1.21.1.json"), "utf-8"));
    expect(vj.id).toBe("1.21.1");
    expect(await fs.readFile(join(gameDir, "versions/1.21.1/1.21.1.jar"))).toEqual(clientJar);

    // libraries: platform rules honoured
    expect(await fs.readFile(join(gameDir, "libraries/com/example/always/1.0/always-1.0.jar"))).toEqual(libAlways);
    await expect(fs.access(join(gameDir, "libraries/com/example/maconly/1.0/maconly-1.0.jar"))).rejects.toThrow();
    if (process.platform === "linux") {
      expect(await fs.readFile(join(gameDir, "libraries/org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar"))).toEqual(libLinux);
    }

    // assets: the index and every object it references must exist on disk
    const idx = JSON.parse(await fs.readFile(join(gameDir, "assets/indexes/testidx.json"), "utf-8"));
    expect(Object.keys(idx.objects)).toHaveLength(2);
    expect(await fs.readFile(join(gameDir, "assets/objects", sha1(assetA).slice(0, 2), sha1(assetA)))).toEqual(assetA);
    expect(await fs.readFile(join(gameDir, "assets/objects", sha1(assetB).slice(0, 2), sha1(assetB)))).toEqual(assetB);
    expect(await fs.readFile(join(gameDir, "assets/log_configs/client-1.12.xml"))).toEqual(logCfg);
    expect(logs.some((l) => l.includes("assets"))).toBe(true);

    // idempotent: a second run does no work and reports nothing to install
    const again = await svc.ensure({ minecraftVersion: "1.21.1", loaderVersion: "21.1.259" }, { steps: ["vanilla", "assets"] });
    expect(again.installed).toEqual([]);

    // inspection now reports the loader as the only missing step
    const insp = await svc.inspect({ minecraftVersion: "1.21.1", loaderVersion: "21.1.259" });
    // vanilla + assets are done; only the loader (and, on a box with no Java 21,
    // the runtime) may still be needed.
    expect(insp.needs).toContain("loader");
    expect(insp.needs).not.toContain("vanilla");
    expect(insp.needs).not.toContain("assets");
    expect(insp.assetsReady).toBe(true);
    expect(insp.clientJar).toBe(true);
    expect(insp.librariesPresent).toBe(insp.librariesTotal);
  }, 60000);

  it("writes the launcher profile the NeoForge installer demands", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mcsp-prof-"));
    const { ProvisionService } = await import("../src/main/services/provision");
    const svc = new ProvisionService(join(root, "inst"), join(root, "runtime"), () => undefined);
    await svc.ensureLauncherProfile();
    const raw = JSON.parse(await fs.readFile(join(root, "inst/launcher_profiles.json"), "utf-8"));
    expect(raw).toHaveProperty("profiles");
    // second call keeps an existing profile
    await fs.writeFile(join(root, "inst/launcher_profiles.json"), JSON.stringify({ profiles: { NeoForge: {} } }));
    await svc.ensureLauncherProfile();
    expect(JSON.parse(await fs.readFile(join(root, "inst/launcher_profiles.json"), "utf-8")).profiles).toHaveProperty("NeoForge");
  });

  it("looks for the loader profile under versions/neoforge-<loaderVersion>/ (not the MC version)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "mcsp-path-"));
    const { ProvisionService } = await import("../src/main/services/provision");
    const svc = new ProvisionService(join(root, "inst"), join(root, "runtime"), () => undefined);
    expect(svc.loaderJsonPath("21.1.259")).toMatch(/versions[/\\]neoforge-21\.1\.259[/\\]neoforge-21\.1\.259\.json$/);
    expect(svc.loaderVersionId("21.1.259")).toBe("neoforge-21.1.259");
  });
});
