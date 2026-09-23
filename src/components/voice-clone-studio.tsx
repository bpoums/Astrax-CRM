import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { readFunctionError } from "@/lib/function-error";

/**
 * Admin-only tab for the external "Voice Clone Studio" tool. The tool itself
 * runs on plain HTTP with no authentication of its own, so the browser never
 * talks to it directly — every call goes through the `voice-clone-proxy` edge
 * function, which re-checks the caller is an admin before forwarding.
 *
 * The tool actually returns the cloned clip as raw `audio/wav` bytes, not
 * JSON (confirmed live — its own OpenAPI spec wrongly declares an empty JSON
 * schema). The edge function normalises any non-JSON upstream response to
 * `application/octet-stream`, which is the one binary type
 * `supabase.functions.invoke()` returns as a `Blob` rather than mangling as
 * text. If the tool ever does return JSON instead (its documented content
 * type), this still checks a few likely field names as a fallback.
 */

type CloneResult = Blob | Record<string, unknown>;

const AUDIO_KEYS = ["audio_base64", "audio", "audio_url", "url", "output_url", "data"];

function resolveAudioSrc(result: CloneResult): string | null {
  if (result instanceof Blob) return URL.createObjectURL(result);
  for (const key of AUDIO_KEYS) {
    const value = result[key];
    if (typeof value !== "string" || !value) continue;
    if (value.startsWith("data:") || value.startsWith("http")) return value;
    // Bare base64 — assume the tool's default output is wav.
    return `data:audio/wav;base64,${value}`;
  }
  return null;
}

export function VoiceCloneStudio() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<CloneResult | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);

  // A Blob result needs an object URL, which must be revoked once it's no
  // longer shown — otherwise each clone leaks the previous clip's memory.
  useEffect(() => {
    if (!result) {
      setAudioSrc(null);
      return;
    }
    const src = resolveAudioSrc(result);
    setAudioSrc(src);
    return () => {
      if (src?.startsWith("blob:")) URL.revokeObjectURL(src);
    };
  }, [result]);

  const clone = useMutation({
    mutationFn: async (vars: { file: File; text: string }) => {
      const body = new FormData();
      body.append("voice_sample", vars.file);
      body.append("text", vars.text);
      const { data, error } = await supabase.functions.invoke("voice-clone-proxy", { body });
      if (error) {
        throw new Error(
          await readFunctionError(error, "The voice clone tool could not be reached."),
        );
      }
      return data as CloneResult;
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success("Voice cloned");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      toast.error("Attach a voice sample first.");
      return;
    }
    if (!text.trim()) {
      toast.error("Enter text to speak.");
      return;
    }
    setResult(null);
    clone.mutate({ file, text: text.trim() });
  }

  return (
    <section className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="panel-title">Voice Clone Studio</h2>
        {/* <span className="text-[0.66rem] text-muted-foreground"> */}
          {/* Proxied through the server — the external tool is never called from your browser directly. */}
        {/* </span> */}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="voice-clone-sample" className="field-label">
            Voice sample<span className="text-accent"> *</span>
          </label>
          <input
            id="voice-clone-sample"
            type="file"
            accept="audio/*"
            className="field-input"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="voice-clone-text" className="field-label">
            Text to speak<span className="text-accent"> *</span>
          </label>
          <textarea
            id="voice-clone-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="field-input min-h-24"
            placeholder="What should the cloned voice say?"
            required
          />
        </div>

        <button
          type="submit"
          className="btn-submit w-fit"
          disabled={clone.isPending || !file || !text.trim()}
        >
          {clone.isPending ? "Cloning…" : "Clone & speak"}
        </button>
      </form>

      {result ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          {audioSrc ? (
            <audio controls src={audioSrc} className="w-full" />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                The tool responded but this component doesn't recognise the audio field — showing
                the raw response instead.
              </p>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-[0.7rem]">
                {JSON.stringify(result, null, 2)}
              </pre>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
