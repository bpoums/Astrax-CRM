// Ingests a lead from a center's own CRM straight into the manager queue,
// the same way a closer's own submission does (pending_manager, source
// 'api'). Authenticated by a per-center API key (see
// admin_generate_center_api_key / center_api_keys), not a Supabase session --
// the center's CRM has no closer logged into Astrax behind it.
//
// Payload contract: a flat object keyed by the closer form's exact labels
// (SECTIONS in src/components/closer-form.tsx) -- "Full Name", "SSN Number",
// "Draft Date", Banking section fields included. No field mapping, no
// payment_details split: this mirrors a live closer submission, not the
// spreadsheet-import pipeline.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function corsHeaders(req: Request) {
  const requested = req.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": requested ?? "content-type, x-api-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return json(req, { error: "method not allowed" }, 405);

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) return json(req, { error: "x-api-key header required" }, 401);

  let body: { payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "bad json" }, 400);
  }

  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Object.keys(payload).length === 0) {
    return json(req, { error: "empty payload" }, 400);
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await db.rpc("submit_external_lead", {
    p_api_key: apiKey,
    p_payload: payload,
  });

  if (error) {
    const status = error.message === "invalid api key" ? 401 : 400;
    console.error("ingest-center-lead failed", error.message);
    return json(req, { error: error.message }, status);
  }

  const row = Array.isArray(data) ? data[0] : data;
  console.log("ingested center lead", row?.id, "center", row?.center_name);
  return json(req, { ok: true, id: row?.id });
});
