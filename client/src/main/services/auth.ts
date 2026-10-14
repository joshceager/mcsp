/** Microsoft account sign-in for online-mode play, Modrinth-style:
 *  1. device-code OAuth against Azure AD (login.microsoftonline.com/consumers)
 *  2. Xbox Live XBL + XSTS tokens
 *  3. Minecraft services login -> bearer token + profile (uuid + name)
 *  4. Yggdrasil "join" handshake so online-mode servers accept the client.
 *  Tokens are cached in ~/.mcsp/auth.json and refreshed automatically.
 */
import { promises as fs } from "fs";
import { createHash } from "crypto";
import { join } from "path";

// Azure AD application (client) id. Defaults to Prism Launcher's published
// MSA client id (from their CMakeLists.txt) so sign-in works out of the box;
// override via the account bar / azureClientId setting if you register your
// own app (portal.azure.com -> Entra ID -> App registrations -> enable
// public client flows).
export const DEFAULT_CLIENT_ID = "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb";
const TENANT = "consumers";
const SCOPES = "XboxLive.signin offline_access";

const DEVICE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`;
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const XBL_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_AUTH_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const MC_SESSION_URL = "https://sessionserver.mojang.com/session/minecraft/join";

export interface McProfile {
  /** Mojang session access token (NOT the MS token). */
  accessToken: string;
  /** Undashed player UUID, e.g. 71fac49ab05c4bcf8b3af45e4c0c04b2 */
  uuid: string;
  /** Dashed form of the same UUID. */
  uuidDashed: string;
  /** Current Minecraft username. */
  name: string;
  /** Epoch seconds when accessToken expires (Mojang tokens last ~24h). */
  expiresAt: number;
  /** MS refresh token used to silently re-login when the session expires. */
  msRefreshToken?: string;
}

export interface DeviceCodeStart {
  deviceCode: string;    // internal: needed to poll for the token
  userCode: string;      // the code the user types on microsoft.com/link
  verificationUri: string;
  message: string;
  interval: number;      // polling interval seconds
  expiresIn: number;     // seconds until the code expires
}

interface McAuthDeps {
  /** Where to persist the cached profile (auth.json). */
  storeDir: string;
  /** Azure application (client) id for the device flow. */
  clientId: string;
  /** Status callback (shown in the UI / log). */
  onStatus?: (msg: string) => void;
}

async function postJson(url: string, body: unknown, headers?: Record<string, string> | undefined) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: resp.status, ok: resp.ok, json };
}

async function postForm(url: string, params: Record<string, string>) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await resp.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: resp.status, ok: resp.ok, json };
}

function errFrom(json: unknown, fallback = "request failed"): string {
  const j = json as { error?: string; error_description?: string; Message?: string; raw?: string };
  return j?.error_description ?? j?.error ?? j?.Message ?? j?.raw ?? fallback;
}

export class McAuth {
  private profile: McProfile | null = null;
  private file = "";

  constructor(private deps: McAuthDeps) {}

  async load(): Promise<void> {
    this.file = join(this.deps.storeDir, "auth.json");
    try {
      const p = JSON.parse(await fs.readFile(this.file, "utf-8")) as McProfile;
      if (p && typeof p.accessToken === "string") this.profile = p;
    } catch { /* no cached profile */ }
  }

  current(): McProfile | null {
    return this.profile;
  }

  /** True if we hold a Mojang token that is still valid (with 60s slack). */
  hasValidSession(): boolean {
    return this.profile !== null && this.profile.expiresAt > Date.now() / 1000 + 60;
  }

  /** Save the profile to disk (tokens at rest under the user's home dir). */
  private async persist(): Promise<void> {
    await fs.mkdir(this.deps.storeDir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.profile, null, 2), "utf-8");
  }

  /** Step 1: request a device code the user will enter at microsoft.com/link. */
  async startDeviceLogin(): Promise<DeviceCodeStart> {
    if (!this.deps.clientId) {
      throw new Error(
        "no Azure client id configured — create a free app registration at " +
        "portal.azure.com (Entra ID -> App registrations, account type " +
        "\"any organizational directory and personal Microsoft accounts\", " +
        "public client flows enabled) and paste its Application (client) ID here",
      );
    }
    const r = await postForm(DEVICE_URL, { client_id: this.deps.clientId, scope: SCOPES });
    const j = r.json as {
      device_code?: string; user_code?: string; verification_uri?: string;
      message?: string; interval?: number; expires_in?: number; error?: string;
    };
    if (!r.ok || !j.device_code) {
      const msg = errFrom(j);
      if (/700016/.test(msg)) {
        throw new Error(
          `device code request failed: the client id ${this.deps.clientId} is not a valid ` +
          `app registration (AADSTS700016). Register an app at portal.azure.com and set its ` +
          `Application (client) ID in the account bar.`,
        );
      }
      if (/7000218/.test(msg)) {
        throw new Error(
          "device code request failed: the app registration must allow public client flows " +
          "(AADSTS7000218) — enable it under Authentication in the Azure portal.",
        );
      }
      throw new Error(`device code request failed: ${msg}`);
    }
    return {
      deviceCode: j.device_code!,
      userCode: j.user_code!,
      verificationUri: j.verification_uri ?? "https://www.microsoft.com/link",
      message: j.message ?? `Go to ${j.verification_uri} and enter the code ${j.user_code}`,
      interval: j.interval ?? 5,
      expiresIn: j.expires_in ?? 900,
    };
  }

  /** Step 2: poll until the user finishes entering the code. */
  async waitForDevice(start: DeviceCodeStart): Promise<McProfile> {
    const deadline = Date.now() + start.expiresIn * 1000;
    let wait = start.interval * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait));
      const r = await postForm(TOKEN_URL, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: this.deps.clientId,
        device_code: start.deviceCode,
      });
      const j = r.json as {
        access_token?: string; refresh_token?: string; error?: string;
        error_description?: string;
      };
      if (r.ok && j.access_token) {
        return this.exchangeToProfile(j.access_token, j.refresh_token);
      }
      if (j.error === "authorization_pending") continue; // keep polling
      if (j.error === "slow_down") { wait += 3000; continue; }
      throw new Error(`device login failed: ${errFrom(j)}`);
    }
    throw new Error("device login timed out — the code expired");
  }

  /** Exchange the MS access token: XBL -> XSTS -> Minecraft services. */
  private async exchangeToProfile(msToken: string, refreshToken?: string): Promise<McProfile> {
    // --- Xbox Live user token
    const xbl = await postJson(XBL_URL, {
      Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com",
        RpsTicket: `d=${msToken}` },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    });
    if (!xbl.ok) throw new Error(`Xbox Live auth failed: ${errFrom(xbl.json)}`);
    const xblTok = (xbl.json as { Token: string }).Token;

    // --- XSTS token (this is what Minecraft actually consumes)
    const xsts = await postJson(XSTS_URL, {
      Properties: { SandboxId: "RETAIL", UserTokens: [xblTok] },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT",
    });
    if (!xsts.ok) {
      const code = (xsts.json as { XErr?: number })?.XErr;
      const hint = code === 2148916233
        ? " — this account has no Xbox profile"
        : code === 2148916238
          ? " — this is a child account"
          : "";
      throw new Error(`XSTS auth failed (${code ?? "?"})${hint}`);
    }
    const xstsTok = (xsts.json as { Token: string }).Token;
    const uhs = ((xsts.json as { DisplayClaims: { xui: { uhs: string }[] } })
      .DisplayClaims.xui[0].uhs);

    // --- Minecraft services login
    const mc = await postJson(MC_AUTH_URL, { identityToken: `XBL3.0 x=${uhs};${xstsTok}` });
    if (!mc.ok) throw new Error(`Minecraft login failed: ${errFrom(mc.json)}`);
    const mcJ = mc.json as { access_token: string; expires_in: number };

    // --- Profile (uuid + name)
    const prof = await fetch(MC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${mcJ.access_token}` },
    });
    if (!prof.ok) {
      throw new Error(prof.status === 404
        ? "this Microsoft account does not own Minecraft"
        : `profile fetch failed: HTTP ${prof.status}`);
    }
    const pj = (await prof.json()) as { id: string; name: string };
    const profile: McProfile = {
      accessToken: mcJ.access_token,
      uuid: pj.id,
      uuidDashed: pj.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"),
      name: pj.name,
      expiresAt: Math.floor(Date.now() / 1000) + mcJ.expires_in,
      msRefreshToken: refreshToken,
    };
    this.profile = profile;
    await this.persist();
    this.deps.onStatus?.(`signed in as ${profile.name}`);
    return profile;
  }

  /** Silent re-login with the stored MS refresh token (no user interaction). */
  async refresh(): Promise<McProfile> {
    const p = this.profile;
    if (!p?.msRefreshToken) throw new Error("no stored refresh token; sign in again");
    const r = await postForm(TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: this.deps.clientId,
      refresh_token: p.msRefreshToken,
      scope: SCOPES,
    });
    const j = r.json as { access_token?: string; refresh_token?: string; error?: string };
    if (!r.ok || !j.access_token) throw new Error(`token refresh failed: ${errFrom(j)}`);
    return this.exchangeToProfile(j.access_token, j.refresh_token ?? p.msRefreshToken);
  }

  /** Ensure a usable Mojang session: use cache, refresh, or throw. */
  async ensureSession(): Promise<McProfile> {
    if (this.hasValidSession()) return this.profile!;
    try { return await this.refresh(); } catch { /* fall through */ }
    throw new Error("not signed in — use the account screen to sign in");
  }

  /** Clear the cached session (user-initiated sign-out). */
  async signOut(): Promise<void> {
    this.profile = null;
    try { await fs.rm(this.file, { force: true }); } catch { /* ok */ }
  }

  /** Yggdrasil join handshake — required for online-mode servers to accept us. */
  async joinServer(serverIdHex: string, selectedProfile: string): Promise<void> {
    const p = await this.ensureSession();
    const resp = await fetch(MC_SESSION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: p.accessToken,
        selectedProfile, // undashed uuid
        serverId: serverIdHex,
      }),
    });
    if (!resp.ok) throw new Error(`session join failed: HTTP ${resp.status}`);
  }
}

/** Compute the Mojang serverId hash the client sends for the join handshake:
 *  sha1 of "<serverId hash from handshake> <sharedSecret> <publicKey>"
 *  as hex — the launcher receives these from the MC protocol handshake layer. */
export function computeServerId(base: string, sharedSecret: Buffer, publicKey: Buffer): string {
  const h = createHash("sha1");
  h.update(base);
  h.update(sharedSecret);
  h.update(publicKey);
  return h.digest("hex");
}
