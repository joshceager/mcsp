/** Pure Minecraft/NeoForge version-JSON math: rule filtering, library paths,
 *  classpath + argument construction. No I/O so it is unit-testable. */

export interface VersionLibrary {
  name: string;
  downloads?: {
    artifact?: { path?: string; sha1?: string; size?: number; url?: string };
    classifiers?: Record<string, { path?: string; sha1?: string; size?: number; url?: string }>;
  };
  rules?: Rule[];
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
}
export interface Rule {
  action: "allow" | "deny";
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}
export type ArgEntry = string | { rules?: Rule[]; value: string | string[] };

export interface VersionJson {
  id: string;
  mainClass?: string;
  inheritsFrom?: string;
  type?: string;
  assets?: string;
  assetIndex?: { id: string; sha1?: string; size?: number; totalSize?: number; url: string };
  downloads?: Record<string, { sha1?: string; size?: number; url?: string; path?: string }>;
  libraries?: VersionLibrary[];
  arguments?: { jvm?: ArgEntry[]; game?: ArgEntry[] };
  minecraftArguments?: string;
  javaVersion?: { component?: string; majorVersion: number };
  logging?: { client?: { argument: string; file: { id: string; sha1: string; size: number; url: string } } };
  complianceLevel?: number;
}

/** A child version JSON with its parent chain folded in. */
export interface MergedVersion {
  id: string;
  mainClass: string;
  type: string;
  assetIndexName: string;
  assetIndexUrl: string | null;
  libraries: VersionLibrary[];
  jvmArgs: (string | string[])[];
  gameArgs: (string | string[])[];
  clientDownload: { url: string; sha1?: string; size?: number } | null;
  loggingFile: { url: string; sha1: string; size: number; argument: string; id: string } | null;
  javaMajor: number | null;
  lineage: string[];
}

export interface PlatformInfo {
  name: "windows" | "osx" | "linux";
  arch: string; // x86_64 / aarch64 / x86
  version?: string;
}

/** Maps Node's process.platform/arch onto Mojang's rule vocabulary. */
export function platformFromNode(platform: NodeJS.Platform | string, arch: string): PlatformInfo {
  const name = platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
  const a = arch === "arm64" || arch === "aarch64" ? "aarch64" : arch === "x32" || arch === "ia32" ? "x86" : "x86_64";
  return { name, arch: a };
}

function osRuleMatches(rule: Rule, p: PlatformInfo): boolean {
  const os = rule.os;
  if (!os) return true;
  if (os.name && os.name !== p.name) return false;
  if (os.arch) {
    // Mojang uses "x86" for 32-bit; anything else we treat as an exact match.
    if (os.arch === "x86" && p.arch !== "x86" && p.arch !== "x86_64") return false;
    if (os.arch !== "x86" && os.arch !== p.arch) return false;
  }
  return true;
}

/** Evaluate an ordered Minecraft rule list; default is deny when rules exist. */
export function rulesAllow(rules: Rule[] | undefined, p: PlatformInfo, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    const osOk = osRuleMatches(r, p);
    const featOk = !r.features || Object.entries(r.features).every(([k, v]) => Boolean(features[k]) === v);
    if (r.action === "allow" && osOk && featOk) allowed = true;
    if (r.action !== "allow") {
      if (osOk && featOk) return false;
    }
  }
  return allowed;
}

/** group:artifact:version[:classifier] -> relative maven path. */
export function mavenPath(name: string): string | null {
  const parts = name.split(":");
  if (parts.length < 3 || parts.length > 4) return null;
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

/** Relative path (inside libraries/) for a library artifact, if any. */
export function libraryPath(lib: VersionLibrary): string | null {
  const art = lib.downloads?.artifact;
  if (art?.path) return art.path;
  if (art?.url) {
    const m = /\/libraries\.minecraft\.net\/(.+)$/.exec(art.url) ?? /maven[^/]*\/releases\/(.+)$/.exec(art.url);
    if (m) return m[1];
  }
  return mavenPath(lib.name);
}

/** True for the vanilla json's "-cp <classpath>" pair (either element). */
export function isClasspathArg(entry: ArgEntry): boolean {
  const value = typeof entry === "string"
    ? entry
    : Array.isArray(entry.value) ? entry.value.join(" ") : String(entry.value);
  const v = value.trim();
  return v.includes("${classpath}") || v === "-cp" || v.startsWith("-cp ") || v === "-classpath";
}

export function flattenArgs(entries: ArgEntry[] | undefined, p: PlatformInfo, features: Record<string, boolean> = {}): (string | string[])[] {
  const out: (string | string[])[] = [];
  for (const e of entries ?? []) {
    if (typeof e === "string") { out.push(e); continue; }
    if (rulesAllow(e.rules, p, features)) out.push(e.value);
  }
  return out;
}

/** Fold a child version JSON together with its parents (child wins). */
export function mergeVersion(
  child: VersionJson,
  parent: VersionJson | null,
  p: PlatformInfo,
  features: Record<string, boolean> = {},
): MergedVersion {
  const lineage = [child.id, ...(parent ? [parent.id] : [])];
  const libs: VersionLibrary[] = [];
  const seen = new Set<string>();
  for (const lib of [...(parent?.libraries ?? []), ...(child.libraries ?? [])]) {
    if (seen.has(lib.name)) continue;
    seen.add(lib.name);
    if (!rulesAllow(lib.rules, p, features)) continue;
    libs.push(lib);
  }
  // Parent jvm args come first (they set up -cp/classpath), then the child's
  // loader-specific module flags. The classpath pair from the vanilla json
  // ("-cp" "${classpath}") is dropped *entirely* — keeping the bare "-cp" would
  // make the JVM swallow the next flag as the classpath — and we append our own
  // resolved classpath instead.
  const parentJvm = (parent?.arguments?.jvm ?? []).filter((a) => !isClasspathArg(a));
  const jvmArgs = [...flattenArgs(parentJvm, p, features), ...flattenArgs(child.arguments?.jvm, p, features)];
  const gameArgs = [
    ...flattenArgs(child.arguments?.game, p, features),
    ...flattenArgs(parent?.arguments?.game, p, features),
  ];
  // A version json may carry its own downloads/logging (the vanilla base
  // version) or inherit them (the loader profile inherits from vanilla).
  const clientDl = parent?.downloads?.client ?? child.downloads?.client;
  const log = parent?.logging?.client ?? child.logging?.client;
  return {
    id: child.id,
    mainClass: child.mainClass ?? parent?.mainClass ?? "net.minecraft.client.main.Main",
    type: child.type ?? parent?.type ?? "release",
    assetIndexName: child.assetIndex?.id ?? parent?.assetIndex?.id ?? parent?.assets ?? "",
    assetIndexUrl: child.assetIndex?.url ?? parent?.assetIndex?.url ?? null,
    libraries: libs,
    jvmArgs,
    gameArgs,
    clientDownload: clientDl?.url ? { url: clientDl.url, sha1: clientDl.sha1, size: clientDl.size } : null,
    loggingFile: log?.file?.url
      ? { url: log.file.url, sha1: log.file.sha1, size: log.file.size, argument: log.argument, id: log.file.id }
      : null,
    javaMajor: child.javaVersion?.majorVersion ?? parent?.javaVersion?.majorVersion ?? null,
    lineage,
  };
}

/** Classpath entries for a fully-resolved library list. */
export function classpathEntries(v: MergedVersion, libraryDir: string, extraJars: string[] = []): string[] {
  const out: string[] = [];
  for (const lib of v.libraries) {
    const rel = libraryPath(lib);
    if (rel) out.push(`${libraryDir}/${rel}`);
  }
  return [...out, ...extraJars];
}

export interface LaunchContext {
  gameDir: string;
  assetsDir: string;
  nativesDir: string;
  libraryDir: string;
  classpath: string;
  classpathSeparator: string;
  versionName: string;
  assetIndexName: string;
  versionType: string;
  playerName: string;
  uuid: string;
  accessToken: string;
  clientId: string;
  xuid: string;
  userType: string;
  launcherName: string;
  launcherVersion: string;
  extraArgs?: string[];
}

/** Substitute ${placeholders} in a launch argument. */
export function substitute(arg: string, ctx: LaunchContext): string {
  return arg.replace(/\$\{([a-z_]+)\}/gi, (whole, key: string) => {
    switch (key) {
      case "auth_player_name": return ctx.playerName;
      case "version_name": return ctx.versionName;
      case "game_directory": return ctx.gameDir;
      case "assets_root": return ctx.assetsDir;
      case "assets_index_name": return ctx.assetIndexName;
      case "auth_uuid": return ctx.uuid;
      case "auth_access_token": return ctx.accessToken;
      case "auth_session": return `token:${ctx.accessToken}`;
      case "clientid": return ctx.clientId;
      case "auth_xuid": return ctx.xuid;
      case "user_type": return ctx.userType;
      case "version_type": return ctx.versionType;
      case "natives_directory": return ctx.nativesDir;
      case "launcher_name": return ctx.launcherName;
      case "launcher_version": return ctx.launcherVersion;
      case "library_directory": return ctx.libraryDir;
      case "classpath_separator": return ctx.classpathSeparator;
      case "classpath": return ctx.classpath;
      default: return whole;
    }
  });
}

/** Build the full java argv for a merged version. */
export function buildLaunchArgs(v: MergedVersion, ctx: LaunchContext): string[] {
  const jvm: string[] = [];
  for (const a of v.jvmArgs) {
    if (Array.isArray(a)) jvm.push(...a.map((x) => substitute(x, ctx)));
    else jvm.push(substitute(a, ctx));
  }
  if (v.loggingFile) {
    jvm.push(`-Dlog4j.configurationFile=${ctx.assetsDir}/log_configs/${v.loggingFile.id}`);
  }
  jvm.push("-cp", ctx.classpath, v.mainClass);
  const game: string[] = [];
  for (const a of v.gameArgs) {
    if (Array.isArray(a)) game.push(...a.map((x) => substitute(x, ctx)));
    else game.push(substitute(a, ctx));
  }
  return [...jvm, ...game, ...(ctx.extraArgs ?? [])];
}
