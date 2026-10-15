/** Launches the local Minecraft client from the provisioned NeoForge profile.
 *  Args come from the version JSON (loader + vanilla merged), so classpath,
 *  natives, assets index and JVM flags are exactly what the loader expects. */
import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { sanitizeMessage } from "../../shared/errors";
import type { Manifest } from "../../shared/types";
import { buildLaunchArgs, classpathEntries, type LaunchContext } from "../../shared/version";
import type { ProvisionService } from "./provision";

export interface LaunchRequest {
  gameDir: string;
  manifest: Manifest;
  javaBin: string;
  profile: { name: string; uuid: string; accessToken: string; clientId?: string; xuid?: string; userType?: string };
  provision: ProvisionService;
  onLog?: (line: string) => void;
  onExit?: (code: number | null) => void;
}

export interface LaunchHandle {
  pid: number | null;
  stop: () => void;
}

export class Launcher {
  private proc: ChildProcess | null = null;
  private stopped = false;

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  pid(): number | null {
    return this.isRunning() ? (this.proc?.pid ?? null) : null;
  }

  /** Build the exact argv for a launch (exposed for diagnostics/tests). */
  async buildCommand(req: LaunchRequest): Promise<{ args: string[]; javaBin: string }> {
    const { merged } = await req.provision.resolveInstalled(req.manifest);
    const extras = await req.provision.extraClasspathJars(req.manifest);
    const sep = process.platform === "win32" ? ";" : ":";
    const libraryDir = join(req.gameDir, "libraries");
    const classpath = classpathEntries(merged, libraryDir, extras).join(sep);
    const nativesDir = join(req.gameDir, `natives-${process.platform}-${process.arch}`);
    await fs.mkdir(nativesDir, { recursive: true });

    const ctx: LaunchContext = {
      gameDir: req.gameDir,
      assetsDir: join(req.gameDir, "assets"),
      nativesDir,
      libraryDir,
      classpath,
      classpathSeparator: sep,
      versionName: merged.id,
      assetIndexName: merged.assetIndexName,
      versionType: merged.type,
      playerName: req.profile.name,
      uuid: req.profile.uuid,
      accessToken: req.profile.accessToken,
      clientId: req.profile.clientId ?? "",
      xuid: req.profile.xuid ?? "",
      userType: req.profile.userType ?? "msa",
      launcherName: "mcsp",
      launcherVersion: "0.2.0",
    };
    return { args: buildLaunchArgs(merged, ctx), javaBin: req.javaBin };
  }

  async launch(req: LaunchRequest): Promise<LaunchHandle> {
    if (this.isRunning()) throw new Error("the game is already running");
    await fs.mkdir(req.gameDir, { recursive: true });
    const { args, javaBin } = await this.buildCommand(req);
    const printable = args.map((a) => (a.length > 120 ? `${a.slice(0, 60)}…(${a.length} chars)` : a));
    req.onLog?.(`$ ${javaBin} ${printable.join(" ")}`);
    const proc = spawn(javaBin, args, { cwd: req.gameDir, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    this.stopped = false;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
        if (line.trim()) req.onLog?.(line.trimEnd());
      }
    };
    proc.stdout?.on("data", forward);
    proc.stderr?.on("data", forward);
    proc.on("error", (e) => {
      req.onLog?.(`launcher error: ${sanitizeMessage(e)}`);
      this.proc = null;
      req.onExit?.(null);
    });
    proc.on("exit", (code) => {
      req.onLog?.(`Minecraft exited (code ${code ?? "?"})`);
      this.proc = null;
      req.onExit?.(code);
    });
    // Wait one tick so spawn errors surface as launch failures.
    await new Promise((r) => setTimeout(r, 120));
    if (proc.pid === undefined) throw new Error("the game process failed to start");
    return { pid: proc.pid, stop: () => this.stop() };
  }

  stop(): void {
    this.stopped = true;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }

  get wasStopped(): boolean {
    return this.stopped;
  }
}
