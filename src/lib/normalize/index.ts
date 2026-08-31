/**
 * Deterministic lead normalisation.
 *
 * Rules only — no LLM, no network, no randomness. The same file always yields
 * the same result, every decision can be explained by pointing at one rule, and
 * the whole thing runs in a few milliseconds per thousand rows.
 *
 * Nothing in here touches React, the DOM, or Supabase, so it can be lifted into
 * a Deno edge function unchanged.
 */
export * from "./types";
export * from "./text";
export * from "./states";
export * from "./carriers";
export * from "./rules";
export * from "./detect";
export * from "./mapping";
export * from "./lead";
export * from "./duplicates";
