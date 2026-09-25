import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

/**
 * Free-form tags on one accepted lead — `add_submission_tag` /
 * `remove_submission_tag` refuse anything not `disposition = 'accepted'` and
 * not archived, so this only ever mounts where that's already true (the
 * Customers Pipeline detail sheet).
 *
 * One tag matters mechanically, not just cosmetically: a tag whose
 * `allows_duplicate_ssn` is set exempts this lead's SSN from the block in
 * `submit_form_internal`, letting a closer or validator file a genuine
 * second policy for the same customer. The vocabulary itself (which tags
 * exist, which one(s) carry that flag) is admin/cxm-managed data in
 * `cx_tags`, not hardcoded here — this component just lists whatever's
 * active and toggles membership.
 */

type CxTag = {
  id: string;
  label: string;
  allows_duplicate_ssn: boolean;
};

function tagsKey(submissionId: string) {
  return ["submission-tags", submissionId] as const;
}

function vocabKey() {
  return ["cx-tags", "active"] as const;
}

export function SubmissionTags({
  submissionId,
  readOnly = false,
}: {
  submissionId: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();

  const vocab = useQuery({
    queryKey: vocabKey(),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cx_tags")
        .select("id, label, allows_duplicate_ssn")
        .eq("active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CxTag[];
    },
    // The vocabulary changes rarely and is shared across every open sheet.
    staleTime: 5 * 60 * 1000,
  });

  const applied = useQuery({
    queryKey: tagsKey(submissionId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submission_tags")
        .select("tag_id")
        .eq("submission_id", submissionId);
      if (error) throw error;
      return new Set((data ?? []).map((row) => row.tag_id as string));
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ tag, on }: { tag: CxTag; on: boolean }) => {
      const { error } = await supabase.rpc(on ? "add_submission_tag" : "remove_submission_tag", {
        p_sub: submissionId,
        p_tag: tag.id,
      });
      if (error) throw error;
    },
    onSuccess: (_data, { tag, on }) => {
      toast.success(on ? `Tagged ${tag.label}` : `Removed ${tag.label}`);
      queryClient.invalidateQueries({ queryKey: tagsKey(submissionId) });
    },
    // add_submission_tag raises its own message ("not authorized", "lead is
    // not in the customer pipeline") — show that, not a generic one.
    onError: (error: Error) => toast.error(error.message),
  });

  if (vocab.isLoading || applied.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="panel-title">Tags</h3>
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const tags = vocab.data ?? [];
  const appliedIds = applied.data ?? new Set<string>();

  if (tags.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="panel-title">Tags</h3>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const on = appliedIds.has(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              disabled={readOnly || toggle.isPending}
              aria-pressed={on}
              className={on ? "chip chip-active" : "chip"}
              onClick={() => toggle.mutate({ tag, on: !on })}
              title={
                tag.allows_duplicate_ssn
                  ? "Exempts this lead's SSN from the duplicate-SSN block on new submissions"
                  : undefined
              }
            >
              {tag.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
