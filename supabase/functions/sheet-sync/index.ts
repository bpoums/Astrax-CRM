// Upserts submission rows into Google Sheets via Apps Script.
//
// TWO SHAPES, one handler:
//
//   { ...submission }            a single row, as the old notify_sheet_sync
//                                trigger sent it. Kept working so the queue
//                                migration can be reverted by pointing the
//                                trigger back, without redeploying this.
//   { rows: [ {...}, {...} ] }   a batch, from drain_sheet_sync_queue().
//
// The batch shape is the whole point. Apps Script serialises itself on a
// 30-second LockService lock and Google's frontend rejects concurrent hits on
// a web app deployment - measured failure rates were ~20% at 5 simultaneous
// requests and ~61% at 59. Sending N rows as N requests is therefore the thing
// that loses leads.
//
// Here a batch is walked SEQUENTIALLY, awaiting each call before starting the
// next, so Apps Script only ever sees one request at a time no matter how many
// rows arrive. 25 leads become one net.http_post instead of 25, and the
// concurrency failure mode disappears without touching the Apps Script itself
// - which matters, because its deployment is owned by someone else.
//
// Every row is reported individually so a partial failure is attributable and
// only the rows that actually failed get retried.

const APPS_SCRIPT_URL = Deno.env.get('APPS_SCRIPT_URL');
const APPS_SCRIPT_SECRET = Deno.env.get('APPS_SCRIPT_SECRET');
const SYNC_SECRET = Deno.env.get('SYNC_SECRET');

/**
 * Did Apps Script actually write the row?
 *
 * It cannot be inferred from the HTTP status. A Google Apps Script web app
 * answers 200 even when doPost threw: the body is then its HTML error page,
 * not the 'ok' the handler returns on success. Trusting res.ok alone meant
 * every exception - a spreadsheet the script cannot open, a bad id, a revoked
 * authorisation - was logged as a successful sync and never retried. That is
 * exactly how uploaded leads went missing with nothing anywhere to show for it.
 *
 * Three failure shapes, all arriving as 200:
 *  - an HTML error page (starts with '<')
 *  - any body naming an Exception, whatever the locale renders around it
 *  - the literal 'unauthorized' the handler returns on a secret mismatch
 */
function appsScriptFailure(text: string): string | null {
  const body = text.trim();
  if (body === 'unauthorized') return 'apps script rejected the shared secret';
  if (body.startsWith('<') || body.includes('Exception:')) {
    // Pull the one line worth reading out of ~8KB of Google's CSP shim, so the
    // log says what broke instead of burying it.
    const match = /Exception:[^<]{0,300}/.exec(body);
    return match ? match[0].trim() : 'apps script returned an HTML error page';
  }
  return null;
}

/** The sheet row for one submission, exactly as Apps Script expects it. */
function buildRow(body: Record<string, unknown>): Record<string, unknown> {
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  const submittedByRole = String(body.submitted_by_role ?? 'closer');

  // Only a closer's own submission is Live; a validator's own form is Manual
  // even though it was typed rather than imported. The trigger sends this
  // already decided, and this is the fallback for a body that predates it.
  const leadSource =
    typeof body.lead_source === 'string' && body.lead_source
      ? body.lead_source
      : submittedByRole === 'closer'
        ? 'Live'
        : 'Manual';

  return {
    ...payload,
    'Submission ID': body.id ?? '',
    'Submitted By': body.closer_name ?? '',
    'Submitted By Role': submittedByRole,
    'Submitted At': body.submitted_at ?? '',
    'Status': body.status ?? '',
    'Disposition': body.disposition ?? '',
    'Disposed By': body.disposed_by_name ?? '',
    'Disposed At': body.disposed_at ?? '',
    'Timeout Count': body.timeout_count ?? 0,
    // Set during review by set_validator_fields, not by the form. Appended
    // after the existing keys so the columns already in the sheet keep their
    // positions. The trigger sends '' when unset, and the ?? matches the
    // fields above for a body that predates them.
    'Final Carrier': body.final_carrier ?? '',
    'Agent Name': body.agent_name ?? '',
    'Policy Number': body.policy_number ?? '',
    // The centre stamped on the lead when it was taken.
    'Center': body.center_name ?? '',
    'Source': leadSource,
    // Who imported it, for the uploaded-leads sheet's own column. Blank for
    // a live-typed submission, which has no uploader at all.
    'Uploaded By': body.uploader_name ?? '',
  };
}

/**
 * Routing key Apps Script keys its SHEETS map off: 'closer' / 'validator' for a
 * typed-in submission, 'uploaded' for anything imported by a data uploader -
 * checked first, since submitted_by_role alone cannot tell an uploaded lead
 * apart from a real closer submission (ingest_sheet_lead stamps 'closer' on
 * both).
 */
function routeKeyFor(body: Record<string, unknown>): string {
  const rowSource = String(body.source ?? 'live');
  return rowSource === 'sheet' ? 'uploaded' : String(body.submitted_by_role ?? 'closer');
}

/** One row, one Apps Script call. Never throws; the outcome is the return. */
async function postOne(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const routeKey = routeKeyFor(body);
  try {
    const res = await fetch(APPS_SCRIPT_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: APPS_SCRIPT_SECRET,
        source: routeKey,
        payload: buildRow(body),
      }),
      redirect: 'follow',
    });
    const text = await res.text();

    if (!res.ok) {
      const error = `apps script http ${res.status}`;
      console.error('sync failed', body.id, routeKey, error, text.slice(0, 200));
      return { ok: false, error };
    }

    // A 200 is not proof the row landed - see appsScriptFailure above.
    const failure = appsScriptFailure(text);
    if (failure) {
      console.error('sync failed', body.id, routeKey, failure);
      return { ok: false, error: failure };
    }

    console.log('synced', body.id, routeKey, body.status, text.slice(0, 80));
    return { ok: true };
  } catch (err) {
    const error = `fetch failed: ${String(err)}`;
    console.error('sync failed', body.id, routeKey, error);
    return { ok: false, error };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  if (!SYNC_SECRET || req.headers.get('x-sync-secret') !== SYNC_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    console.error('APPS_SCRIPT_URL or APPS_SCRIPT_SECRET not set');
    return new Response('not configured', { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // ---- Batch: one request in, one result per row out ----------------------
  //
  // Answers 200 even when individual rows failed. The caller resolves each row
  // from `results`, so a 25-row batch with one bad row retries one row rather
  // than all 25. A non-200 here means the whole batch is unaccounted for and
  // every row in it should be retried.
  if (Array.isArray(body.rows)) {
    const rows = body.rows as Record<string, unknown>[];
    const results: { submission_id: unknown; ok: boolean; error?: string }[] = [];

    // Deliberately a sequential for-loop, NOT Promise.all. Concurrency here is
    // the bug this function exists to avoid.
    for (const row of rows) {
      const outcome = await postOne(row);
      results.push({ submission_id: row.id, ...outcome });
    }

    const failed = results.filter((r) => !r.ok).length;
    console.log('batch complete', `${results.length - failed}/${results.length} ok`);

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---- Single row: the original contract, unchanged -----------------------
  const outcome = await postOne(body);
  if (!outcome.ok) return new Response(outcome.error ?? 'sync failed', { status: 502 });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
