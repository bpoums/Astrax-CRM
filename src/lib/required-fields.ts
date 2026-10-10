import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { RequiredField } from "@/lib/missing-upload";

/**
 * The required fields of an uploaded lead, in the order the form asks for them,
 * from `uploaded_required_fields()` — the one definition the database fills
 * `missing_info` / `missing_bank` from.
 *
 * Shared by the uploader's review step and by the completeness strip on every
 * list, under one query key, so the list is fetched once per session and cannot
 * differ between the two. It only changes in a migration, hence never stale.
 *
 * A refused read surfaces as `isError` with the database's own message; callers
 * decide what to draw, but none may treat it as "nothing is required".
 */
export function useUploadedRequiredFields() {
  return useQuery({
    queryKey: ["uploaded-required-fields"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("uploaded_required_fields");
      if (error) throw error;
      return (data ?? []).map((row): RequiredField => ({
        label: row.label,
        grp: row.grp === "bank" ? "bank" : "core",
      }));
    },
  });
}
