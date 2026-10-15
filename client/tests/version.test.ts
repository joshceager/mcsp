import { describe, expect, it } from "vitest";
import {
  buildLaunchArgs, classpathEntries, libraryPath, mavenPath, mergeVersion, rulesAllow,
  type LaunchContext, type PlatformInfo, type VersionJson,
} from "../src/shared/version";

const linux: PlatformInfo = { name: "linux", arch: "x86_64" };

function base(): VersionJson {
  return {
    id: "1.21.1",
    mainClass: "net.minecraft.client.main.Main",
    assets: "17",
    assetIndex: { id: "17", url: "https://meta/17.json", sha1: "a".repeat(40), size: 10 },
    downloads: { client: { url: "https://meta/client.jar", sha1: "b".repeat(40), size: 100 } },
    javaVersion: { majorVersion: 21 },
    logging: { client: { argument: "-Dlog4j.configurationFile=${path}", file: { id: "client-1.12.xml", sha1: "c".repeat(40), size: 5, url: "https://meta/log.xml" } } },
    libraries: [
      { name: "com.example:always:1.0", downloads: { artifact: { path: "com/example/always/1.0/always-1.0.jar", url: "https://libs/always.jar", sha1: "d".repeat(40), size: 1 } } },
      { name: "com.example:maconly:1.0", downloads: { artifact: { path: "com/example/maconly/1.0/maconly-1.0.jar", url: "https://libs/mac.jar" } }, rules: [{ action: "allow", os: { name: "osx" } }] },
      { name: "org.lwjgl:lwjgl:3.3.3:natives-linux", downloads: { artifact: { path: "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar", url: "https://libs/nat.jar" } }, rules: [{ action: "allow", os: { name: "linux" } }] },
    ],
    arguments: {
      jvm: ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}"],
      game: ["--username", "${auth_player_name}", "--gameDir", "${game_directory}", "--assetsDir", "${assets_root}", "--assetIndex", "${assets_index_name}", "--uuid", "${auth_uuid}"],
    },
  };
}

const loader: VersionJson = {
  id: "neoforge-21.1.259",
  mainClass: "cpw.mods.bootstraplauncher.BootstrapLauncher",
  inheritsFrom: "1.21.1",
  arguments: {
    jvm: ["-DignoreList=client-extra,${version_name}.jar", "-DlibraryDirectory=${library_directory}", "-p", "${library_directory}/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar"],
    game: ["--launchTarget", "forgeclient"],
  },
  libraries: [{ name: "net.neoforged:neoforge:21.1.259:client", downloads: { artifact: { path: "net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar", url: "https://maven/nf.jar" } } }],
};

describe("maven/library path resolution", () => {
  it("builds maven paths including classifiers", () => {
    expect(mavenPath("org.lwjgl:lwjgl:3.3.3")).toBe("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3.jar");
    expect(mavenPath("org.lwjgl:lwjgl:3.3.3:natives-linux")).toBe("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar");
    expect(mavenPath("nonsense")).toBeNull();
  });

  it("prefers the downloads.artifact.path", () => {
    expect(libraryPath({ name: "a:b:1", downloads: { artifact: { path: "x/y.jar" } } })).toBe("x/y.jar");
  });
});

describe("rule evaluation (OS filtering)", () => {
  it("keeps default libs and linux natives, drops mac-only libs", () => {
    expect(rulesAllow(undefined, linux)).toBe(true);
    expect(rulesAllow([{ action: "allow", os: { name: "osx" } }], linux)).toBe(false);
    expect(rulesAllow([{ action: "allow", os: { name: "linux" } }], linux)).toBe(true);
  });
});

describe("mergeVersion (loader + vanilla)", () => {
  it("folds parent libraries in and filters by platform", () => {
    const m = mergeVersion(loader, base(), linux);
    const paths = m.libraries.map((l) => libraryPath(l));
    expect(paths).toContain("com/example/always/1.0/always-1.0.jar");
    expect(paths).toContain("org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-linux.jar");
    expect(paths).not.toContain("com/example/maconly/1.0/maconly-1.0.jar");
    expect(paths).toContain("net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar");
    expect(m.mainClass).toBe("cpw.mods.bootstraplauncher.BootstrapLauncher");
    expect(m.assetIndexName).toBe("17");
    expect(m.clientDownload?.url).toBe("https://meta/client.jar");
    expect(m.loggingFile?.id).toBe("client-1.12.xml");
  });

  it("exposes the client jar + logging config when there is no parent (vanilla base)", () => {
    const m = mergeVersion(base(), null, linux);
    expect(m.clientDownload?.url).toBe("https://meta/client.jar");
    expect(m.loggingFile?.id).toBe("client-1.12.xml");
    expect(m.assetIndexUrl).toBe("https://meta/17.json");
  });

  it("drops the parent's -cp/${classpath} pair completely (no dangling -cp)", () => {
    const m = mergeVersion(loader, base(), linux);
    const flat = m.jvmArgs.map((a) => (Array.isArray(a) ? a.join(" ") : a));
    expect(flat.some((a) => a.includes("${classpath}"))).toBe(false);
    expect(flat.map((a) => a.trim())).not.toContain("-cp");
    expect(flat.map((a) => a.trim())).not.toContain("-classpath");
    // and the built command has exactly one, with the real classpath after it
    const args = buildLaunchArgs(m, ctx());
    expect(args.filter((a) => a === "-cp")).toHaveLength(1);
    expect(args[args.indexOf("-cp") + 1]).toBe("/inst/libraries/a.jar:/inst/libraries/b.jar");
    expect(args[args.indexOf("-cp") + 2]).toBe("cpw.mods.bootstraplauncher.BootstrapLauncher");
  });
});

const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
    gameDir: "/inst", assetsDir: "/inst/assets", nativesDir: "/inst/natives-x64",
    libraryDir: "/inst/libraries", classpath: "/inst/libraries/a.jar:/inst/libraries/b.jar",
    classpathSeparator: ":", versionName: "neoforge-21.1.259", assetIndexName: "17",
    versionType: "release", playerName: "Steve", uuid: "uuid-1", accessToken: "tok",
    clientId: "cid", xuid: "xuid", userType: "msa", launcherName: "mcsp", launcherVersion: "0.2.0",
    ...over,
});

describe("launch argument construction", () => {
  it("passes the asset directory AND the asset index (no more assetless launches)", () => {
    const m = mergeVersion(loader, base(), linux);
    const args = buildLaunchArgs(m, ctx());
    expect(args[args.indexOf("--assetsDir") + 1]).toBe("/inst/assets");
    expect(args[args.indexOf("--assetIndex") + 1]).toBe("17");
    expect(args[args.indexOf("--gameDir") + 1]).toBe("/inst");
    expect(args[args.indexOf("--username") + 1]).toBe("Steve");
    expect(args).toContain("-Dlog4j.configurationFile=/inst/assets/log_configs/client-1.12.xml");
    expect(args).toContain("/inst/libraries/a.jar:/inst/libraries/b.jar");
    // loader game args first, then the vanilla ones
    expect(args.indexOf("--launchTarget")).toBeLessThan(args.indexOf("--username"));
    expect(args).toContain("forgeclient");
  });

  it("substitutes ${library_directory} for the loader's module path", () => {
    const m = mergeVersion(loader, base(), linux);
    const args = buildLaunchArgs(m, ctx());
    // the loader passes its module path as a separate "-p <paths>" pair
    expect(args).toContain("-p");
    expect(args.some((a) => a.includes("/inst/libraries/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar"))).toBe(true);
    expect(args).toContain("-DlibraryDirectory=/inst/libraries");
    expect(args).toContain("-DignoreList=client-extra,neoforge-21.1.259.jar");
  });

  it("puts every library on the classpath, plus the loader's extra jars", () => {
    const m = mergeVersion(loader, base(), linux);
    const cp = classpathEntries(m, "/libs", ["/inst/versions/neoforge-21.1.259/neoforge-21.1.259.jar"]);
    expect(cp).toContain("/libs/com/example/always/1.0/always-1.0.jar");
    expect(cp).toContain("/inst/versions/neoforge-21.1.259/neoforge-21.1.259.jar");
    expect(cp).toContain("/libs/net/neoforged/neoforge/21.1.259/neoforge-21.1.259-client.jar");
  });
});
