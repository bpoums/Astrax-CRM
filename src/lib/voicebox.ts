import { createClient } from "@supabase/supabase-js";

/**
 * Admin-only proxy to the external "Voice Clone Studio" tool, served at a
 * clean same-origin path (`/voicebox`) instead of the tool's bare, plain-HTTP
 * IP — see `docs/features/voice-clone-studio.md` for the full history.
 *
 * Lives in `src/server.ts`'s Worker `fetch` handler, not a TanStack Start
 * file route: this app has no prior server-route usage, and `server.ts` is
 * already the confirmed, real Worker entry point (see its own docstring),
 * so intercepting these three paths here — before the normal SSR handler —
 * needed no new routing framework, just the platform's own Request/Response.
 *
 * The tool serves one self-contained HTML page (inline CSS/JS, no separate
 * asset files — confirmed live) whose own script calls three root-relative
 * endpoints: `fetch("/api/health")`, `fetch("/api/generate-text")`,
 * `fetch("/api/clone-speak")`. Serving that HTML at `/voicebox` would leave
 * those calls pointed at this app's own root instead, so the HTML is
 * rewritten in transit to point at `/voicebox/api/...`, which this file also
 * proxies through.
 *
 * Auth problem this solves: this app's Supabase session lives in
 * `localStorage`, not a cookie (see `src/integrations/supabase/client.ts`),
 * so a plain browser navigation to `/voicebox` carries no proof of who's
 * asking. The admin panel's "Open Voice Clone Studio" button first calls
 * `POST /api/voicebox/session` with its bearer token (a normal authenticated
 * fetch, same shape every other Supabase call in this app already makes);
 * on success that sets a short-lived, signed, HttpOnly session cookie, then
 * the button opens `/voicebox` in a new tab, which the browser now carries
 * that cookie to.
 */

// A hostname, not the bare IP (132.226.187.244) the tool actually runs on.
// Cloudflare Workers' fetch() rejects a raw IP-literal URL with its own
// error 1003 ("Direct IP Access Not Allowed") — confirmed live: the same
// request reaches the tool fine from a normal network path, only fails when
// made from inside the Worker. `voicebox-origin.astrax.live` is a DNS-only
// (grey-clouded, not proxied) A record pointing at that IP, added
// specifically so Workers has a hostname to fetch by; it isn't meant to be
// visited directly.
const TOOL_URL = "http://voicebox-origin.astrax.live";
const COOKIE_NAME = "voicebox_session";
const COOKIE_PATH = "/voicebox";
const SESSION_TTL_SECONDS = 30 * 60;

export type VoiceboxEnv = {
  VOICEBOX_SESSION_SECRET?: string;
};

/**
 * Cloudflare bindings/secrets in THIS Nitro build never reach a request
 * handler as a plain function argument, whatever the handler's own
 * signature looks like — confirmed by reading the built
 * `.output/server/index.mjs`: Nitro's own Cloudflare adapter
 * (`createHandler` in `node_modules/nitro/dist/presets/cloudflare/runtime/
 * _module-handler.mjs`) does `globalThis.__env__ = env` on every request and
 * then calls `nitroApp.fetch(request)` with no `env` parameter at all — so
 * `src/server.ts`'s own `env` argument is always empty by the time it
 * reaches here. `globalThis.__env__` is the only place the real bindings
 * exist. It's safe to read as a plain global despite looking
 * request-scoped: `env` is the same fixed set of bindings for every request
 * to a given Worker deployment, never data that varies per request, so two
 * requests racing on this global can never disagree about its value.
 */
function workerEnv(): VoiceboxEnv {
  return ((globalThis as { __env__?: VoiceboxEnv }).__env__ ?? {}) as VoiceboxEnv;
}

function textEncode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncode(message) as BufferSource);
  return base64UrlEncode(signature);
}

/** Same-length XOR compare — avoids a short-circuiting `===` on a secret
 *  value, which is cheap insurance even for an internal tool. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signSession(secret: string, expiresAt: number): Promise<string> {
  const payload = `admin.${expiresAt}`;
  return `${payload}.${await hmacSign(secret, payload)}`;
}

async function verifySession(secret: string, cookieValue: string | null): Promise<boolean> {
  if (!cookieValue) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [role, expiresAtRaw, signature] = parts;
  if (role !== "admin" || expiresAtRaw === undefined || signature === undefined) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() / 1000) return false;
  const expected = await hmacSign(secret, `${role}.${expiresAtRaw}`);
  return timingSafeEqual(expected, signature);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Same public values `src/integrations/supabase/client.ts` reads — not
 *  secret (the publishable key is designed to be public, protected by RLS),
 *  so no new Cloudflare secret is needed for these two. Same dual
 *  `import.meta.env` / `process.env` fallback that file already documents,
 *  since this module is bundled by the same Vite build. */
function supabaseConfig(): { url: string; key: string } | null {
  const url = import.meta.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"];
  const key =
    import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return null;
  return { url, key };
}

/** Mirrors `supabase/functions/voice-clone-proxy/index.ts`'s own check —
 *  same two-step "identify the caller, then read their role" shape. */
async function callerIsAdmin(bearerToken: string): Promise<boolean> {
  const config = supabaseConfig();
  if (!config) return false;
  const client = createClient(config.url, config.key, {
    global: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user) return false;
  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .single();
  return !profileError && profile?.role === "admin";
}

function corsHeaders(request: Request): HeadersInit {
  // Echoed, not `*`: this is a credentialed request (Set-Cookie relies on
  // it), and `Access-Control-Allow-Credentials: true` cannot pair with a
  // wildcard origin.
  const origin = request.headers.get("Origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonResponse(request: Request, body: unknown, status: number): Response {
  const headers = new Headers(corsHeaders(request));
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleSessionRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "method not allowed" }, 405);
  }
  const secret = workerEnv().VOICEBOX_SESSION_SECRET;
  if (!secret) return jsonResponse(request, { error: "voicebox not configured" }, 500);

  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer "))
    return jsonResponse(request, { error: "missing token" }, 401);

  const admin = await callerIsAdmin(authHeader.slice("Bearer ".length));
  if (!admin) return jsonResponse(request, { error: "admins only" }, 403);

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const cookieValue = await signSession(secret, expiresAt);
  const headers = new Headers(corsHeaders(request));
  headers.set("Content-Type", "application/json");
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${cookieValue}; Path=${COOKIE_PATH}; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/** The tool's own literal `fetch()` calls, confirmed live by fetching the
 *  page and grepping its inline script — not guessed. Rewritten so the
 *  proxied page calls back through `/voicebox/api/...` instead of this
 *  app's own root. */
const FETCH_PATH_REWRITES: [string, string][] = [
  ['fetch("/api/health")', 'fetch("/voicebox/api/health")'],
  ['fetch("/api/generate-text"', 'fetch("/voicebox/api/generate-text"'],
  ['fetch("/api/clone-speak"', 'fetch("/voicebox/api/clone-speak"'],
];

async function proxyRootPage(): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${TOOL_URL}/`, { method: "GET" });
  } catch (error) {
    console.error("voicebox: tool unreachable", error);
    return new Response("Voice Clone Studio is unreachable.", { status: 502 });
  }
  let html = await upstream.text();
  for (const [from, to] of FETCH_PATH_REWRITES) html = html.split(from).join(to);
  return new Response(html, {
    status: upstream.status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Thin pass-through for the tool's own `/api/*` calls, reached at
 *  `/voicebox/api/*` after the rewrite above — same
 *  stream-the-body-back shape `voice-clone-proxy`'s edge function already
 *  uses for the same tool. */
async function proxyApi(request: Request, url: URL): Promise<Response> {
  const targetPath = url.pathname.slice("/voicebox".length); // "/api/health" etc.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(`${TOOL_URL}${targetPath}`, {
      method: request.method,
      headers: hasBody
        ? { "Content-Type": request.headers.get("Content-Type") ?? "application/json" }
        : undefined,
      body: hasBody ? request.body : undefined,
      // @ts-expect-error Workers' fetch requires duplex for a streamed body.
      duplex: hasBody ? "half" : undefined,
    });
  } catch (error) {
    console.error("voicebox: tool API unreachable", error);
    return jsonResponse(request, { error: "voice clone tool unreachable" }, 502);
  }
  // Same normalisation `voice-clone-proxy` already needs: the tool returns
  // raw audio bytes for clone-speak, not the JSON its OpenAPI spec implies.
  const upstreamType = upstream.headers.get("Content-Type") ?? "application/octet-stream";
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstreamType.includes("application/json")
        ? upstreamType
        : "application/octet-stream",
    },
  });
}

/**
 * Entry point called from `src/server.ts`. Returns `null` for any request
 * this module doesn't own, so the caller falls through to normal SSR.
 */
export async function handleVoicebox(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/voicebox/session") {
    return handleSessionRequest(request);
  }

  if (url.pathname !== "/voicebox" && !url.pathname.startsWith("/voicebox/")) {
    return null;
  }

  const secret = workerEnv().VOICEBOX_SESSION_SECRET;
  if (!secret) return new Response("Voice Clone Studio is not configured.", { status: 500 });

  const valid = await verifySession(secret, readCookie(request, COOKIE_NAME));
  if (!valid) {
    return Response.redirect(new URL("/admin?tab=voice-clone", url.origin).toString(), 302);
  }

  if (url.pathname === "/voicebox") return proxyRootPage();
  if (url.pathname.startsWith("/voicebox/api/")) return proxyApi(request, url);
  return new Response("Not found", { status: 404 });
}
