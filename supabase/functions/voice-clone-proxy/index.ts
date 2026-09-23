// Admin-only proxy to the external Voice Clone Studio tool. That tool is
// plain HTTP on a bare IP with no authentication of its own, so this
// function is the entire access boundary: the browser only ever talks HTTPS
// to Supabase, and this function re-checks the caller's role itself before
// forwarding anything.
//
// verify_jwt is ON: the caller's access token is checked, then their role is
// looked up. Only admins may call this.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
// Falls back to the known address so a missing secret doesn't hard-fail —
// but set VOICE_CLONE_TOOL_URL via `supabase secrets set` so the address
// isn't pinned only in code.
const TOOL_URL = Deno.env.get('VOICE_CLONE_TOOL_URL') ?? 'http://132.226.187.244';

function corsHeaders(req: Request) {
  const requested = req.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      requested ?? 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') return json(req, { error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json(req, { error: 'missing token' }, 401);

  // 1. identify the caller using their own token
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json(req, { error: 'invalid token' }, 401);

  // 2. confirm they are an admin (read through their own RLS context)
  const { data: profile, error: profileErr } = await caller
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single();

  if (profileErr || profile?.role !== 'admin') {
    return json(req, { error: 'admins only' }, 403);
  }

  // 3. forward the multipart body as-is to the external tool. The response
  // shape isn't documented (its OpenAPI spec declares an empty schema), so
  // this stays a thin pass-through rather than reinterpreting the body.
  let upstream: Response;
  try {
    upstream = await fetch(`${TOOL_URL}/api/clone-speak`, {
      method: 'POST',
      body: req.body,
      // @ts-expect-error Deno's fetch requires duplex for a streamed body.
      duplex: 'half',
      headers: {
        'Content-Type': req.headers.get('Content-Type') ?? 'multipart/form-data',
      },
    });
  } catch (fetchErr) {
    console.error('voice clone tool unreachable', fetchErr);
    return json(req, { error: 'voice clone tool unreachable' }, 502);
  }

  // The tool returns raw audio bytes (Content-Type: audio/wav), not the JSON
  // its own OpenAPI spec implies. supabase-js's functions.invoke() only
  // returns a Blob for a response it recognises as binary
  // (application/octet-stream); anything else it reads as text, which
  // corrupts audio bytes. Passing the upstream Content-Type straight through
  // fed the client garbled text instead of a playable clip, so anything
  // that isn't JSON is normalised to octet-stream here.
  const upstreamType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: upstream.status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': upstreamType.includes('application/json')
        ? upstreamType
        : 'application/octet-stream',
    },
  });
});
