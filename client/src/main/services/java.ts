/** Java runtime provisioning: reuse a bundled/system JRE 21+, otherwise fetch
 *  an Adoptium JRE once into the shared runtime dir (never per instance).
 *  The download is always announced first (it is ~165 MB). */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { downloadFile } from "./net";

const ADOPTIUM = "https://api.adoptium.net/v3/assets/latest/{ver}/hotspot?os={os}&architecture={arch}&image_type=jre";

export interface JavaProgress { message: string; received?: number; total?: number | null }

function osName(): string {
  switch (process.platform) {
    case "win32": return "windows";
    case "darwin": return "mac";
    default: return "linux";
  }
}

function archName(): string {
  const arch = process.arch as string;
  return arch === "arm64" || arch === "aarch64" ? "aarch64" : "x64";
}

export function javaBinName(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}

/** Where a previously downloaded runtime lives (recorded in java-home.txt). */
export async function cachedJava(runtimeDir: string): Promise<string | null> {
  try {
    const home = (await fs.readFile(join(runtimeDir, "java-home.txt"), "utf-8")).trim();
    const bin = join(home, "bin", javaBinName());
    await fs.access(bin);
    return bin;
  } catch {
    return null;
  }
}

export async function systemJavaVersion(): Promise<number | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("java", ["-version"], (err, _stdout, stderr) =>
        err ? reject(err) : resolve(String(stderr)),
      );
    });
    const m = out.match(/version "(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export interface JavaStatus {
  ready: boolean;
  source: "bundled" | "downloaded" | "system" | "none";
  version: number | null;
  path: string | null;
}

/** Report whether a usable Java 21+ exists — does not download anything. */
export async function javaStatus(runtimeDir: string): Promise<JavaStatus> {
  const cached = await cachedJava(runtimeDir);
  if (cached) return { ready: true, source: "downloaded", version: null, path: cached };
  const sys = await systemJavaVersion();
  if (sys !== null && sys >= 21) return { ready: true, source: "system", version: sys, path: "java" };
  return { ready: false, source: "none", version: sys, path: null };
}

/** Resolve a java binary, downloading a JRE only when necessary. */
export async function ensureJava(runtimeDir: string, onProgress?: (p: JavaProgress) => void): Promise<string> {
  const cached = await cachedJava(runtimeDir);
  if (cached) { onProgress?.({ message: "using cached Java runtime" }); return cached; }

  const sys = await systemJavaVersion();
  if (sys !== null && sys >= 21) {
    onProgress?.({ message: `using system Java ${sys}` });
    return "java";
  }
  if (sys !== null) {
    onProgress?.({ message: `system Java ${sys} is older than 21 — downloading JRE 21` });
  }

  const url = ADOPTIUM.replace("{ver}", "21").replace("{os}", osName()).replace("{arch}", archName());
  onProgress?.({ message: "looking up Adoptium Temurin JRE 21…" });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Adoptium API error: HTTP ${resp.status}`);
  const assets = (await resp.json()) as { binary: { package: { link: string } } }[];
  if (!assets.length) throw new Error("Adoptium API returned no JRE 21 packages");
  const link = assets[0].binary.package.link;
  const ext = osName() === "windows" ? ".zip" : ".tar.gz";
  const pkg = join(runtimeDir, `jre21${ext}`);
  onProgress?.({ message: "downloading Adoptium Temurin JRE 21 (~165 MB, one time)…" });
  await downloadFile({
    url: link,
    dest: pkg,
    maxBytes: 400 * 1024 * 1024,
    onProgress: (received, total) =>
      onProgress?.({ message: `downloading JRE 21… ${fmtMb(received)}${total ? ` / ${fmtMb(total)}` : ""} MB`, received, total }),
  });
  const extractRoot = join(runtimeDir, "jre21");
  onProgress?.({ message: "extracting Java runtime…" });
  await extractArchive(pkg, extractRoot);
  await fs.rm(pkg, { force: true });
  const entries = await fs.readdir(extractRoot);
  if (entries.length !== 1) throw new Error(`unexpected JRE archive layout: ${entries.join(", ")}`);
  const home = join(extractRoot, entries[0]);
  const bin = join(home, "bin", javaBinName());
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(join(runtimeDir, "java-home.txt"), home, "utf-8");
  onProgress?.({ message: "Java runtime ready" });
  return bin;
}

function fmtMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  const { mkdir } = await import("fs/promises");
  await mkdir(dest, { recursive: true });
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`,
      ]);
    } else {
      await execFileAsync("unzip", ["-o", archive, "-d", dest]);
    }
  } else {
    await execFileAsync("tar", ["-xzf", archive, "-C", dest]);
  }
}

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}
