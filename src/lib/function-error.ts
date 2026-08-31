import { FunctionsHttpError } from "@supabase/supabase-js";

/**
 * invoke() reports any non-2xx as a generic "non-2xx status code" error and
 * leaves the JSON body — where the edge functions put their real messages —
 * on error.context. Shared by the invite panel and the lead importer.
 */
export async function readFunctionError(error: unknown, fallback = "The request failed.") {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
    if (body?.error) return body.error;
  }
  return error instanceof Error ? error.message : fallback;
}
