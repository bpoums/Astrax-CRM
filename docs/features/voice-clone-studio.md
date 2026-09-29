# Voice Clone Studio

Admin tab (`/admin?tab=voice-clone`) that opens an external, third-party
"Voice Clone Studio" tool in a new browser tab, at a clean same-origin URL
(`astrax.live/voicebox`) instead of the tool's own bare, plain-HTTP IP:
upload a short voice sample, type text, get back a clip of that voice
speaking it.

## Current shape (changed 2026-09-28) — the tool's own real interface

The tab used to embed a hand-built React form (`voice-clone-studio.tsx`,
now deleted) that called just one of the tool's endpoints through a Supabase
edge function. It now opens the tool's actual page, unmodified, proxied
through this app's own Worker — so every feature the tool's own UI offers
(including its separate text-generation endpoint, previously "not wired
up") is reachable, not just clone-speak.

**Why not an iframe, still.** The tool runs at `http://132.226.187.244` — a
bare IP, plain HTTP, with no authentication of its own (its `/docs` and
`/openapi.json` are open to anyone who reaches that address). Iframing it
directly would still hand every admin browser a raw, unauthenticated
endpoint and put its address in client-side network traffic, exactly as
before. The fix is the same shape as before, just wider: the browser only
ever talks to this app's own origin, which proxies server-side.

## How it works

`src/components/voicebox-launcher.tsx` — the tab's only content — is an
"Open Voice Clone Studio" button, not a form. Clicking it:

1. `POST https://astrax.live/api/voicebox/session` with the current
   session's `Authorization: Bearer <token>` and `credentials: "include"`.
2. That request is handled in `src/lib/voicebox.ts`, called from
   `src/server.ts` (this app's actual Cloudflare Workers `fetch` handler —
   confirmed the real entry point via its own docstring and
   `vite.config.ts`'s `server: { entry: "server" }`, and by grepping the
   built `.output/server/_ssr/ssr.mjs` for the literal Supabase project ref
   after a build, to confirm env values are statically inlined rather than
   read at runtime from somewhere that doesn't exist in a Worker). It
   verifies the token via Supabase (`auth.getUser`, then `profiles.role`,
   the same two-step check `voice-clone-proxy` already used) and, if admin,
   sets a short-lived (30 min), signed, `HttpOnly`, `Secure`,
   `SameSite=Lax` cookie scoped to `Path=/voicebox`.
3. The button then `window.open("https://astrax.live/voicebox", "_blank")`
   — a plain top-level navigation, which now carries that cookie.
4. `GET /voicebox` (same file) verifies the cookie's signature and expiry.
   Valid: fetches the tool's real HTML from `voicebox-origin.astrax.live`
   server-side and returns it. Invalid or missing: redirects to
   `/admin?tab=voice-clone`
   — there is nothing to see at this URL without a session minted by the
   button above.
5. `GET|POST /voicebox/api/health`, `/voicebox/api/generate-text`,
   `/voicebox/api/clone-speak` — same cookie check, then a thin pass-through
   to the tool's matching `/api/...` path. The audio/wav-vs-declared-JSON
   content-type normalization `voice-clone-proxy` already needed is reused
   here verbatim.

**Why those three paths specifically, and why rewritten.** The tool serves
one self-contained HTML page (inline CSS/JS, no separate asset files —
confirmed live by fetching it and grepping for `src=`/`href=`, the only
external references are Google Fonts) whose own script calls exactly three
root-relative endpoints: `fetch("/api/health")`, `fetch("/api/generate-text")`,
`fetch("/api/clone-speak")` (confirmed by grepping the fetched HTML for
those literals). Serving that HTML unmodified at `/voicebox` would leave
those calls pointed at this app's own root (`astrax.live/api/...`), not
`/voicebox/api/...`, so `proxyRootPage()` in `voicebox.ts` rewrites those
three exact literal strings in transit before returning the HTML — a plain
text substitution against confirmed strings, not speculative rewriting of
unknown markup.

## Auth model

No new Supabase secret. `VOICEBOX_SESSION_SECRET` is a **Cloudflare Worker
secret** (`wrangler secret put VOICEBOX_SESSION_SECRET`) — these routes run
in the Worker (`src/server.ts`), not a Deno edge function, so a Supabase
secret wouldn't be reachable from here. The Supabase URL and publishable key
`voicebox.ts` uses to check the caller's role are **not** secret (the
publishable key is meant to be public, protected by RLS) and are read the
same dual `import.meta.env`/`process.env` way
`src/integrations/supabase/client.ts` already does — no new env var needed
for those two.

**Fixed 2026-09-28, same day as first deploy: bindings/secrets never reach a
handler as a function argument in this Nitro build, whatever the handler's
own `fetch(request, env, ctx)` signature suggests.** First shipped reading
`env` as `src/server.ts`'s own second parameter — Cloudflare's textbook
convention, and what `env` looks like it should be. It was always empty at
runtime (`VOICEBOX_SESSION_SECRET` reading as "not configured" even after
setting the real secret), traced by reading the *built* `.output/server/
index.mjs`: Nitro's own Cloudflare adapter (`createHandler` in
`node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs`)
does `globalThis.__env__ = env` on every request, then calls
`nitroApp.fetch(request)` with **no `env` argument at all** — so anything
downstream, including `src/server.ts`, never receives it as a parameter no
matter how it's declared. `workerEnv()` in `voicebox.ts` reads
`globalThis.__env__` directly instead. Safe as a plain global despite
looking request-scoped: `env` is the same fixed set of bindings for every
request to a given Worker deployment, never per-request data, so two
requests racing on it can never actually disagree about its value.

The session cookie is a plain HMAC-SHA256 (Web Crypto, no new dependency)
over `admin.<expiry-epoch-seconds>`, verified with a constant-time compare.
It only ever encodes "an admin verified this" plus an expiry — no user id,
nothing else worth protecting if the cookie value leaked, beyond the 30
minutes of access it would grant.

**Fixed 2026-09-28, same day: Cloudflare Workers' `fetch()` rejects a raw
IP-literal URL with its own error 1003 ("Direct IP Access Not Allowed").**
`TOOL_URL` was first the tool's bare IP (`http://132.226.187.244`) —
`voice-clone-proxy`'s own Deno edge function uses the same bare IP
successfully, so this wasn't an obvious risk to expect. Confirmed live: the
exact same request reached the tool fine from a normal outside network path,
but failed specifically when made from inside the Worker. Fixed by adding a
DNS-only (grey-clouded, not proxied through Cloudflare) `A` record,
`voicebox-origin.astrax.live → 132.226.187.244`, in the same Cloudflare zone,
and pointing `TOOL_URL` at that hostname instead — Workers has no issue
fetching a hostname, only a bare IP literal. That record isn't meant to be
visited directly; it exists purely so the Worker has a name to fetch by.

## Domain

`astrax.live` is attached to the same Cloudflare Worker (`bpoums-closerform`)
as a Custom Domain, via the Cloudflare dashboard — not a `wrangler.json`
change (see that file's own comments on why hand-editing deploy config here
is risky). It serves the exact same app as the `workers.dev` URL; only the
`Set-Cookie` from `/api/voicebox/session` is scoped to whichever host
answered the request (no explicit `Domain=` attribute is set — it defaults
to the exact host, which also means the whole flow is testable against the
`workers.dev` URL before `astrax.live` DNS is live).

## Not wired up

Nothing — this is the one difference from the previous version.
`POST /api/generate-text`, previously explicitly unused, is now reachable
through the tool's own UI like every other feature it offers, since the
whole interface is proxied rather than one hand-picked endpoint.

## Superseded, not removed

`supabase/functions/voice-clone-proxy/index.ts` is left deployed but
**unused** — nothing in the app calls it anymore. Kept as-is rather than
deleted (explicit decision), so treat any future change to that function as
dead-code maintenance, not the active path.

## Known limitations

- **Session expiry mid-use has no graceful handling.** If the 30-minute
  cookie expires while the `/voicebox` tab is still open, the *tool's own*
  script starts getting 401s from its `fetch()` calls and shows whatever
  error state it has for that — this app can't intercept it, since it's the
  external tool's script, not ours. Re-clicking "Open Voice Clone Studio"
  mints a fresh session in a fresh tab.
- No usage log/audit trail — this is a live pass-through, nothing about a
  session or a clone/generate request is persisted, same as before.
- No rate limiting; the external tool's own capacity is the only limit.
- The external tool's availability, HTML structure, and the three fetch-path
  literals this relies on are outside this repo's control and were verified
  only once, live, on 2026-09-28. If the tool's own frontend changes those
  literal strings, the rewrite in `proxyRootPage()` silently stops matching
  and the proxied page's own API calls will 404 against this app's root.
