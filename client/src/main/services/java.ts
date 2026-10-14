/** Java runtime provisioning: pulls an Adoptium JRE on first run if no
 *  usable Java 21+ is available on this machine (approved requirement). */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { downloadFile } from "./download";

const ADOPTIUM = "https://api.adoptium.net/v3/assets/latest/{ver}/hotspot?os={os}&architecture={arch}&image_type=jre";

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

/** Returns a path to a java binary, downloading one if needed. */
export async function ensureJava(runtimeDir: string): Promise<string> {
  const marker = join(runtimeDir, "java-home.txt");
  try {
    const home = (await fs.readFile(marker, "utf-8")).trim();
    const bin = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
    await fs.access(bin);
    return bin;
  } catch {
    /* fall through to system check */
  }

  const sys = await systemJavaVersion();
  if (sys !== null && sys >= 21) {
    return "java";
  }

  // Download an Adoptium JRE into the instance's runtime dir.
  const url = ADOPTIUM
    .replace("{ver}", "21")
    .replace("{os}", osName())
    .replace("{arch}", archName());
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Adoptium API error: HTTP ${resp.status}`);
  const assets = (await resp.json()) as { binary: { package: { link: string } } }[];
  if (!assets.length) throw new Error("Adoptium API returned no JRE 21 packages");
  const link = assets[0].binary.package.link;
  const pkg = join(runtimeDir, `jre21${osName() === "windows" ? ".zip" : ".tar.gz"}`);
  await downloadFile({ url: link, dest: pkg });
  const extractRoot = join(runtimeDir, "jre21");
  await extractArchive(pkg, extractRoot);
  await fs.rm(pkg, { force: true });
  // Archives contain one top-level directory; find the java binary beneath it.
  const entries = await fs.readdir(extractRoot);
  if (entries.length !== 1) throw new Error(`unexpected JRE archive layout: ${entries}`);
  const home = join(extractRoot, entries[0]);
  const bin = join(home, "bin", process.platform === "win32" ? "java.exe" : "java");
  await fs.writeFile(marker, home, "utf-8");
  return bin;
}

async function systemJavaVersion(): Promise<number | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile("java", ["-version"], (err, stdout, stderr) =>
        err ? reject(err) : resolve(String(stderr || stdout)),
      );
    });
    const m = out.match(/version "(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  const { execFile } = await import("child_process");
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
