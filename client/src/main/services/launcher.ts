/** Launches the local Minecraft client with the pack's loader profile. */
import { spawn, type ChildProcess } from "child_process";
import type { Dirent } from "fs";
import { promises as fs } from "fs";
import { join } from "path";
import type { Manifest } from "../../shared/types";

export interface LaunchOptions {
  gameDir: string;
  manifest: Manifest;
  javaBin: string;
  playerName: string;
  extraArgs?: string[];
  onLog?: (line: string) => void;
}

export interface LaunchHandle {
  process: ChildProcess;
  stop: () => void;
}

export class Launcher {
  private proc: ChildProcess | null = null;

  isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async launch(opts: LaunchOptions): Promise<LaunchHandle> {
    if (this.isRunning()) throw new Error("a Minecraft client is already running");
    const { gameDir, manifest, javaBin, playerName } = opts;
    const profileName = `neoforge-${manifest.minecraftVersion}`;
    const gameJarDir = join(gameDir, "versions", profileName);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mainClass = await this.readMainClass(gameJarDir, profileName);
    const libsDir = join(gameDir, "libraries");
    const nativesDir = join(gameDir, `natives-${process.platform}`);

    // Build a minimal-but-valid classpath: the loader libraries this profile needs.
    const classpath = await this.buildClasspath(gameJarDir, libsDir);

    const args = [
      `-Djava.library.path=${nativesDir}`,
      `-cp`, classpath,
      mainClass,
      "--gameDir", gameDir,
      "--launchTarget", "forgeclient",
      "--fml.neoVersion", manifest.loaderVersion,
      "--fml.mcVersion", manifest.minecraftVersion,
      "--fml.forgeVersion", "", // NeoForge has no separate forge version
      "--fml.fmlVersion", "1",
      "--version", profileName,
      "--username", playerName,
      "--assetIndex", manifest.minecraftVersion,
    ];
    for (const extra of opts.extraArgs ?? []) args.push(extra);

    opts.onLog?.(`$ ${javaBin} ${args.join(" ")}`);
    const proc = spawn(javaBin, args, { cwd: gameDir, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (line.trim()) opts.onLog?.(line.trimEnd());
      }
    };
    proc.stdout?.on("data", forward);
    proc.stderr?.on("data", forward);
    proc.on("exit", () => {
      opts.onLog?.("minecraft client exited");
      this.proc = null;
    });
    return { process: proc, stop: () => proc.kill() };
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  private async readMainClass(verDir: string, profileName: string): Promise<string> {
    const jsonPath = join(verDir, `${profileName}.json`);
    const data = JSON.parse(await fs.readFile(jsonPath, "utf-8")) as {
      mainClass?: string;
      arguments?: { game?: string[]; jvm?: string[] };
      minecraftArguments?: string;
    };
    return data.mainClass ?? "net.minecraftforge.fml.loading.ImmediateEntryHandler";
  }

  private async buildClasspath(verDir: string, libsDir: string): Promise<string> {
    // Walk the libraries/ tree; the installer puts everything NeoForge needs there.
    const parts: string[] = [];
    const stack: string[] = [libsDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (p.endsWith(".jar")) parts.push(p);
      }
    }
    // The profile jar itself last (so its overrides win).
    let entries: Dirent[];
    try {
      entries = await fs.readdir(verDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jar")) parts.push(join(verDir, e.name));
    }
    const sep = process.platform === "win32" ? ";" : ":";
    return parts.join(sep);
  }
}
