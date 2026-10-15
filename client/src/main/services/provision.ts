/** Game provisioning: Java runtime, vanilla client (jars + libraries + assets),
 *  then the NeoForge loader profile.
 *
 *  Every step is announced, idempotent (marker file + on-disk checks) and can be
 *  re-run; nothing is ever downloaded silently behind another button.
 *
 *  The NeoForge installer refuses to run without a launcher profile
 *  ("There is no minecraft launcher profile… you need to run the launcher
 *  first!"), so we create a minimal `launcher_profiles.json` first. The profile
 *  it produces is `versions/neoforge-<loaderVersion>/` — NOT
 *  `neoforge-<minecraftVersion>/`, which is what broke provisioning before.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { summarizeProcessFailure } from "../../shared/errors";
import type { VersionJson, VersionLibrary } from "../../shared/version";
import { libraryPath, mergeVersion, platformFromNode, rulesAllow } from "../../shared/version";
import { AssetStore } from "./assets";
import { cachedJava, ensureJava, javaBinName, javaStatus, type JavaStatus } from "./java";
import { downloadFile, exists, fetchJson, mapLimit } from "./net";

export type ProvisionStep = "java" | "vanilla" | "assets" | "loader";

export interface ProvisionProgress {
  step: ProvisionStep;
  message: string;
  done?: number;
  total?: number;
}

export interface ProvisionInspection {
  java: JavaStatus;
  clientJar: boolean;
  versionJson: boolean;
  librariesPresent: number;
  librariesTotal: number;
  assetsReady: boolean;
  loaderReady: boolean;
  loaderVersionInstalled: string | null;
  installedMcVersion: string | null;
  /** Steps that would perform work right now. */
  needs: ProvisionStep[];
}

export interface ProvisionResult {
  javaBin: string;
  loaderVersion: string;
  versionId: string;
  clientVersion: string;
  action: "already-installed" | "installed" | "updated";
  installed: ProvisionStep[];
  gameDir: string;
}

export interface ProvisionUrls {
  metaBase: string;
  assetBase: string;
  maven: string;
}

export const DEFAULT_URLS: ProvisionUrls = {
  metaBase: "https://piston-meta.mojang.com",
  assetBase: "https://resources.download.minecraft.net",
  maven: "https://maven.neoforged.net/releases",
};

interface Marker {
  loaderVersion?: string;
  javaHome?: string;
  clientVersion?: string;
  assetsIndex?: string;
  steps?: Partial<Record<ProvisionStep, boolean>>;
  installedAt?: string;
}

export class ProvisionService {
  private urls: ProvisionUrls;
  private running: Promise<ProvisionResult> | null = null;

  constructor(
    private gameDir: string,
    private runtimeDir: string,
    private log: (msg: string) => void,
    urls: Partial<ProvisionUrls> = {},
  ) {
    this.urls = { ...DEFAULT_URLS, ...urls };
    // Allow tests/CI to point the pipeline at a local mirror.
    if (process.env.MCSP_META_BASE) this.urls.metaBase = process.env.MCSP_META_BASE.replace(/\/$/, "");
    if (process.env.MCSP_ASSET_BASE) this.urls.assetBase = process.env.MCSP_ASSET_BASE.replace(/\/$/, "");
    if (process.env.MCSP_MAVEN_BASE) this.urls.maven = process.env.MCSP_MAVEN_BASE.replace(/\/$/, "");
  }

  markerPath(): string { return join(this.gameDir, "mcsp-provision.json"); }
  versionsDir(): string { return join(this.gameDir, "versions"); }
  librariesDir(): string { return join(this.gameDir, "libraries"); }
  assetsDir(): string { return join(this.gameDir, "assets"); }
  nativesDir(): string { return join(this.gameDir, `natives-${process.platform}-${process.arch}`); }
  loaderVersionId(loaderVersion: string): string { return `neoforge-${loaderVersion}`; }
  loaderJsonPath(loaderVersion: string): string {
    return join(this.versionsDir(), this.loaderVersionId(loaderVersion), `${this.loaderVersionId(loaderVersion)}.json`);
  }
  vanillaJsonPath(mcVersion: string): string { return join(this.versionsDir(), mcVersion, `${mcVersion}.json`); }
  vanillaJarPath(mcVersion: string): string { return join(this.versionsDir(), mcVersion, `${mcVersion}.jar`); }
  assetsStore(): AssetStore { return new AssetStore(this.assetsDir(), this.urls.assetBase); }

  async readMarker(): Promise<Marker | null> {
    try {
      return JSON.parse(await fs.readFile(this.markerPath(), "utf-8")) as Marker;
    } catch {
      return null;
    }
  }

  private async writeMarker(patch: Marker): Promise<void> {
    const cur = (await this.readMarker()) ?? {};
    const next: Marker = { ...cur, ...patch, steps: { ...cur.steps, ...patch.steps }, installedAt: new Date().toISOString() };
    await fs.mkdir(this.gameDir, { recursive: true });
    await fs.writeFile(this.markerPath(), JSON.stringify(next, null, 2), "utf-8");
  }

  // ------------------------------------------------------------- inspection

  /** What is missing right now? Never downloads anything. */
  async inspect(manifest: { minecraftVersion: string; loaderVersion: string }): Promise<ProvisionInspection> {
    const marker = await this.readMarker();
    const java = await javaStatus(this.runtimeDir);
    const versionJson = await exists(this.vanillaJsonPath(manifest.minecraftVersion));
    const clientJar = await exists(this.vanillaJarPath(manifest.minecraftVersion));
    const loaderReady = await exists(this.loaderJsonPath(manifest.loaderVersion));

    let libsTotal = 0;
    let libsPresent = 0;
    if (versionJson) {
      try {
        const vj = JSON.parse(await fs.readFile(this.vanillaJsonPath(manifest.minecraftVersion), "utf-8")) as VersionJson;
        const merged = mergeVersion(vj, null, platformFromNode(process.platform, process.arch));
        for (const lib of merged.libraries) {
          const rel = libraryPath(lib);
          if (!rel) continue;
          libsTotal++;
          if (await exists(join(this.librariesDir(), rel))) libsPresent++;
        }
      } catch { /* corrupt json → treat as missing */ }
    }
    const assetsReady = versionJson
      ? await this.assetsStore().isComplete(await this.assetIndexId(manifest.minecraftVersion))
      : false;

    const needs: ProvisionStep[] = [];
    if (!java.ready) needs.push("java");
    if (!versionJson || !clientJar || libsPresent < libsTotal) needs.push("vanilla");
    if (!assetsReady) needs.push("assets");
    if (!loaderReady || marker?.loaderVersion !== manifest.loaderVersion) needs.push("loader");

    return {
      java,
      clientJar,
      versionJson,
      librariesPresent: libsPresent,
      librariesTotal: libsTotal,
      assetsReady,
      loaderReady,
      loaderVersionInstalled: marker?.loaderVersion ?? null,
      installedMcVersion: marker?.clientVersion ?? null,
      needs,
    };
  }

  // --------------------------------------------------------------- ensure

  /** Provision everything the manifest needs. Concurrent calls are coalesced. */
  async ensure(
    manifest: { minecraftVersion: string; loaderVersion: string },
    opts: { onProgress?: (p: ProvisionProgress) => void; steps?: ProvisionStep[] } = {},
  ): Promise<ProvisionResult> {
    if (this.running) return this.running;
    this.running = this._ensure(manifest, opts).finally(() => { this.running = null; });
    return this.running;
  }

  private async _ensure(
    manifest: { minecraftVersion: string; loaderVersion: string },
    opts: { onProgress?: (p: ProvisionProgress) => void; steps?: ProvisionStep[] },
  ): Promise<ProvisionResult> {
    const want = opts.steps;
    const should = (s: ProvisionStep) => !want || want.includes(s);
    const step = (p: ProvisionProgress) => { this.log(p.message); opts.onProgress?.(p); };
    const before = await this.readMarker();
    const installed: ProvisionStep[] = [];

    // 1. Java runtime ------------------------------------------------------
    let javaBin: string;
    if (should("java")) {
      step({ step: "java", message: "checking Java runtime…" });
      const pre = await javaStatus(this.runtimeDir);
      javaBin = await ensureJava(this.runtimeDir, (p) => step({ step: "java", message: p.message, done: p.received, total: p.total ?? undefined }));
      if (pre.source !== "downloaded" || !(await cachedJava(this.runtimeDir))) installed.push("java");
      await this.writeMarker({ javaHome: javaBin });
    } else {
      javaBin = (await cachedJava(this.runtimeDir)) ?? "java";
    }

    // 2. Vanilla client: version json + client jar + libraries -------------
    const vanilla = await this.ensureVanilla(manifest.minecraftVersion, should("vanilla"), step);
    if (vanilla.did) installed.push("vanilla");

    // 3. Assets ------------------------------------------------------------
    if (should("assets")) {
      const already = await this.assetsStore().isComplete(vanilla.assetIndexId);
      if (already) {
        step({ step: "assets", message: `assets for ${vanilla.assetIndexId} already present` });
      } else {
        if (!vanilla.assetIndexUrl) throw new Error("version manifest has no asset index url");
        step({ step: "assets", message: `downloading assets (index ${vanilla.assetIndexId})` });
        await this.assetsStore().ensure(vanilla.assetIndexId, vanilla.assetIndexUrl, (p) =>
          step({ step: "assets", message: p.message ?? "downloading assets", done: p.done, total: p.total }));
        installed.push("assets");
      }
      await this.writeMarker({ assetsIndex: vanilla.assetIndexId });
    }

    // 4. NeoForge loader profile ------------------------------------------
    let loaderReady = await exists(this.loaderJsonPath(manifest.loaderVersion));
    const markerMatches = (await this.readMarker())?.loaderVersion === manifest.loaderVersion;
    if (should("loader") && (!loaderReady || !markerMatches)) {
      step({ step: "loader", message: `installing NeoForge ${manifest.loaderVersion} (MC ${manifest.minecraftVersion})…` });
      await this.ensureLauncherProfile();
      await this.runInstaller(manifest.loaderVersion, javaBin, step);
      loaderReady = await exists(this.loaderJsonPath(manifest.loaderVersion));
      if (!loaderReady) {
        throw new Error(
          `NeoForge installer finished but no profile was created at versions/${this.loaderVersionId(manifest.loaderVersion)}/`,
        );
      }
      await this.linkLoaderJar(manifest.loaderVersion);
      await this.writeMarker({ loaderVersion: manifest.loaderVersion, clientVersion: manifest.minecraftVersion, steps: { loader: true } });
      installed.push("loader");
      step({ step: "loader", message: `NeoForge ${manifest.loaderVersion} ready` });
    } else if (!loaderReady) {
      step({ step: "loader", message: `NeoForge ${manifest.loaderVersion} not installed (skipped)` });
    }

    const action: ProvisionResult["action"] = installed.length === 0
      ? "already-installed"
      : before?.loaderVersion && before.loaderVersion !== manifest.loaderVersion ? "updated" : "installed";
    const result: ProvisionResult = {
      javaBin,
      loaderVersion: manifest.loaderVersion,
      versionId: this.loaderVersionId(manifest.loaderVersion),
      clientVersion: manifest.minecraftVersion,
      action,
      installed,
      gameDir: this.gameDir,
    };
    opts.onProgress?.({ step: "loader", message: installed.length ? `prepared: ${installed.join(", ")}` : "already prepared" });
    return result;
  }

  // ---------------------------------------------------------------- vanilla

  /** Ensure the vanilla version json, client jar and libraries are present. */
  async ensureVanilla(
    mcVersion: string,
    doWork: boolean,
    step: (p: ProvisionProgress) => void,
  ): Promise<{ did: boolean; assetIndexId: string; assetIndexUrl: string | null; json: VersionJson }> {
    const jsonPath = this.vanillaJsonPath(mcVersion);
    let json: VersionJson | null = null;
    if (await exists(jsonPath)) {
      try { json = JSON.parse(await fs.readFile(jsonPath, "utf-8")) as VersionJson; } catch { json = null; }
    }
    const haveJar = await exists(this.vanillaJarPath(mcVersion));
    if (!json || !haveJar) {
      if (!doWork) {
        // Report what we know from any cached metadata.
        json ??= await this.cachedVersionJson(mcVersion).catch(() => null);
        return { did: false, assetIndexId: json?.assetIndex?.id ?? json?.assets ?? mcVersion, assetIndexUrl: json?.assetIndex?.url ?? null, json: (json ?? { id: mcVersion }) };
      }
      step({ step: "vanilla", message: `fetching Minecraft ${mcVersion} metadata…` });
      json ??= await this.fetchVersionJson(mcVersion);
      await fs.mkdir(join(this.versionsDir(), mcVersion), { recursive: true });
      await fs.writeFile(jsonPath, JSON.stringify(json, null, 2), "utf-8");
    }

    const merged = mergeVersion(json, null, platformFromNode(process.platform, process.arch));
    const jobs: Promise<unknown>[] = [];

    // libraries (+ platform natives, which are ordinary library entries)
    for (const lib of merged.libraries) {
      const rel = libraryPath(lib);
      const art = lib.downloads?.artifact;
      if (!rel || !art?.url) continue;
      const dest = join(this.librariesDir(), rel);
      if (await exists(dest)) continue;
      if (!doWork) continue;
      step({ step: "vanilla", message: `library ${rel.split("/").pop()}` });
      jobs.push(downloadFile({ url: art.url, dest, expectedSha1: art.sha1, expectedSize: art.size, maxBytes: 128 * 1024 * 1024 }));
    }

    // client jar
    if (!haveJar && doWork && merged.clientDownload) {
      step({ step: "vanilla", message: `Minecraft ${mcVersion} client jar` });
      jobs.push(downloadFile({
        url: merged.clientDownload.url,
        dest: this.vanillaJarPath(mcVersion),
        expectedSha1: merged.clientDownload.sha1,
        expectedSize: merged.clientDownload.size,
        maxBytes: 128 * 1024 * 1024,
      }));
    }

    // log4j config
    if (doWork && merged.loggingFile) {
      const dest = join(this.assetsDir(), "log_configs", merged.loggingFile.id);
      if (!(await exists(dest))) {
        jobs.push(downloadFile({ url: merged.loggingFile.url, dest, expectedSha1: merged.loggingFile.sha1, maxBytes: 1024 * 1024 }));
      }
    }

    if (jobs.length) {
      step({ step: "vanilla", message: `downloading ${jobs.length} vanilla file(s)…` });
      await mapLimit(jobs, 6, async (j) => j);
      step({ step: "vanilla", message: "vanilla client files ready" });
    }
    return {
      did: jobs.length > 0,
      assetIndexId: merged.assetIndexName || mcVersion,
      assetIndexUrl: merged.assetIndexUrl,
      json,
    };
  }

  private async cachedVersionJson(mcVersion: string): Promise<VersionJson> {
    return this.fetchVersionJson(mcVersion);
  }

  /** Resolve a version json via the Mojang version manifest (cached 6h). */
  private async fetchVersionJson(mcVersion: string): Promise<VersionJson> {
    const cache = join(this.runtimeDir, "version_manifest_v2.json");
    let manifest: { versions: { id: string; url: string }[] } | null = null;
    try {
      const st = await fs.stat(cache);
      if (Date.now() - st.mtimeMs < 6 * 3600 * 1000) {
        manifest = JSON.parse(await fs.readFile(cache, "utf-8"));
      }
    } catch { /* refetch */ }
    if (!manifest) {
      manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(
        `${this.urls.metaBase}/mc/game/version_manifest_v2.json`,
      );
      await fs.mkdir(this.runtimeDir, { recursive: true });
      await fs.writeFile(cache, JSON.stringify(manifest), "utf-8");
    }
    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (!entry) throw new Error(`Minecraft version ${mcVersion} is not in the official version manifest`);
    return fetchJson<VersionJson>(entry.url);
  }

  /** Which asset index id belongs to a version (without downloading it). */
  async assetIndexId(mcVersion: string): Promise<string> {
    try {
      const json = JSON.parse(await fs.readFile(this.vanillaJsonPath(mcVersion), "utf-8")) as VersionJson;
      return json.assetIndex?.id ?? json.assets ?? mcVersion;
    } catch {
      return mcVersion;
    }
  }

  // ----------------------------------------------------------------- loader

  /** A minimal launcher profile so the NeoForge installer will run headless. */
  async ensureLauncherProfile(): Promise<void> {
    const path = join(this.gameDir, "launcher_profiles.json");
    await fs.mkdir(this.gameDir, { recursive: true });
    if (await exists(path)) {
      try {
        const cur = JSON.parse(await fs.readFile(path, "utf-8")) as { profiles?: Record<string, unknown> };
        if (cur.profiles && Object.keys(cur.profiles).length > 0) return;
      } catch { /* rewrite */ }
    }
    await fs.writeFile(path, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), "utf-8");
    this.log("created launcher_profiles.json (required by the NeoForge installer)");
  }

  private async runInstaller(
    loaderVersion: string,
    javaBin: string,
    step: (p: ProvisionProgress) => void,
  ): Promise<void> {
    const url = `${this.urls.maven}/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    const installer = join(this.runtimeDir, `neoforge-${loaderVersion}-installer.jar`);
    step({ step: "loader", message: "downloading NeoForge installer…" });
    await downloadFile({ url, dest: installer, maxBytes: 64 * 1024 * 1024 });
    const bin = javaBin === "java" ? javaBin : javaBin || join(this.runtimeDir, "jre21", javaBinName());
    await fs.mkdir(this.gameDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        bin,
        ["-jar", installer, "--installClient", this.gameDir],
        { cwd: this.gameDir, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(summarizeProcessFailure(stdout, stderr, "NeoForge installer failed")));
          } else {
            resolve();
          }
        },
      );
    });
  }

  /** Expose the loader's patched client jar as versions/<id>/<id>.jar, which is
   *  the jar the NeoForge `-DignoreList=${version_name}.jar` expects. */
  async linkLoaderJar(loaderVersion: string): Promise<void> {
    const id = this.loaderVersionId(loaderVersion);
    const src = join(this.librariesDir(), "net", "neoforged", "neoforge", loaderVersion, `neoforge-${loaderVersion}-client.jar`);
    const dest = join(this.versionsDir(), id, `${id}.jar`);
    if (!(await exists(src))) return;
    if (await exists(dest)) return;
    try {
      await fs.link(src, dest);
    } catch {
      await fs.copyFile(src, dest);
    }
  }

  /** Merge the installed NeoForge profile with its vanilla parent. */
  async resolveInstalled(manifest: { minecraftVersion: string; loaderVersion: string }) {
    const loaderPath = this.loaderJsonPath(manifest.loaderVersion);
    if (!(await exists(loaderPath))) throw new Error(`loader profile missing at ${loaderPath} — run “Prepare game files” first`);
    const child = JSON.parse(await fs.readFile(loaderPath, "utf-8")) as VersionJson;
    const parentId = child.inheritsFrom ?? manifest.minecraftVersion;
    let parent: VersionJson | null = null;
    const parentPath = this.vanillaJsonPath(parentId);
    if (await exists(parentPath)) parent = JSON.parse(await fs.readFile(parentPath, "utf-8")) as VersionJson;
    return { child, parent, merged: mergeVersion(child, parent, platformFromNode(process.platform, process.arch)) };
  }

  /** Extra jars that a NeoForge launch needs but the version json omits. */
  async extraClasspathJars(manifest: { minecraftVersion: string; loaderVersion: string }): Promise<string[]> {
    const out: string[] = [];
    const id = this.loaderVersionId(manifest.loaderVersion);
    const patched = join(this.versionsDir(), id, `${id}.jar`);
    if (await exists(patched)) out.push(patched);
    // "client-extra" (vanilla classes stripped by the installer's patcher)
    try {
      const dir = join(this.librariesDir(), "net", "minecraft", "client");
      for (const sub of await fs.readdir(dir)) {
        const p = join(dir, sub);
        for (const f of await fs.readdir(p)) {
          if (f.endsWith("-extra.jar")) out.push(join(p, f));
        }
      }
    } catch { /* not needed on every loader */ }
    return out;
  }
}
