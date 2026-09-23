# Voice Clone Studio

Admin tab (`/admin?tab=voice-clone`) that wraps an external, third-party
"Voice Clone Studio" tool: upload a short voice sample, type text, get back
a clip of that voice speaking it.

## Why this isn't an iframe

The tool runs at `http://132.226.187.244` — a bare IP, plain HTTP, **with no
authentication of its own** (its `/docs` and `/openapi.json` are open to
anyone who reaches that address). The CRM is HTTPS on Cloudflare Workers, so
a browser blocks mixed-content requests/iframes to a plain-HTTP origin
anyway — but even if it didn't, embedding it directly would hand every admin
browser a raw, unauthenticated endpoint and put its address in client-side
network traffic.

Instead the browser only ever calls the `voice-clone-proxy` Supabase edge
function over HTTPS
(`supabase/functions/voice-clone-proxy/index.ts`). That function:

1. Requires a valid JWT (`verify_jwt: true`) and looks up the caller's own
   `profiles.role`, rejecting with `403` unless it's `admin` — same pattern
   as `invite-user`.
2. Forwards the request body as-is to `POST {VOICE_CLONE_TOOL_URL}/api/clone-speak`
   (a multipart form: `voice_sample` file + `text`).
3. Streams the tool's response straight back, whatever it is.

`VOICE_CLONE_TOOL_URL` is an edge function env var; if unset it falls back
to the known IP, but set it via `supabase secrets set` so the address isn't
pinned only in code.

**This function is the tool's entire access boundary.** The external tool
itself has no auth — nothing stops someone who has the IP from calling it
directly. Admin-only in this CRM controls who can reach it *through us*, not
who can reach the tool at all.

## Response shape is not fully known

The tool's own OpenAPI spec declares `clone-speak`'s response as
`200: { schema: {} }` — undocumented. `voice-clone-studio.tsx` reads
defensively: `resolveAudioSrc()` checks a handful of likely keys
(`audio_base64`, `audio`, `audio_url`, `url`, `output_url`, `data`) for a
data URL, an `http` URL, or bare base64 (assumed `audio/wav` if so), and
falls back to printing the raw JSON response if none match. If the tool's
actual field name differs, update `AUDIO_KEYS` in that file rather than
guessing further.

## Not wired up

`POST /api/generate-text` (the tool's separate Groq-backed text generation
endpoint) is not used here — only voice cloning.

## Known limitations

- No usage log/audit trail — this is a live pass-through, nothing about a
  clone request is persisted.
- No rate limiting on the proxy; the external tool's own capacity is the
  only limit.
- The external tool's availability, auth model, and response shape are
  outside this repo's control and were verified only once, live, on
  2026-09-23.
