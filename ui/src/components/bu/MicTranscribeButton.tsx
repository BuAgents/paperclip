// bu-fork: record a voice message in the browser, transcribe it on the server
// (local Whisper) and insert the text into the composer for review before sending.
import { Loader2, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { cn } from "../../lib/utils";

type State = "idle" | "recording" | "transcribing";

const MAX_RECORDING_MS = 5 * 60_000;

function preferredMimeType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function MicTranscribeButton({
  disabled,
  onTranscript,
  onError,
}: {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<State>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
      if (limit.current) clearTimeout(limit.current);
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return null;
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (timer.current) clearInterval(timer.current);
        if (limit.current) clearTimeout(limit.current);
        const blob = new Blob(chunks, { type: (rec.mimeType || mimeType || "audio/webm").split(";")[0] });
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        try {
          const form = new FormData();
          const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
          form.append("audio", blob, `voice.${extension}`);
          const result = await api.postForm<{ text: string }>("/bu/transcribe", form);
          if (result.text.trim()) onTranscript(result.text.trim());
          else onError("No speech detected in the recording.");
        } catch (error) {
          onError(error instanceof Error ? error.message : "Transcription failed");
        } finally {
          setState("idle");
        }
      };
      recorder.current = rec;
      rec.start();
      setElapsed(0);
      setState("recording");
      const startedAt = Date.now();
      timer.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
      limit.current = setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORDING_MS);
    } catch {
      onError("Microphone access was denied or is unavailable.");
      setState("idle");
    }
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  const label =
    state === "recording" ? "Stop recording and transcribe" : state === "transcribing" ? "Transcribing…" : "Dictate (transcribed before sending)";
  return (
    <button
      type="button"
      onClick={() => (state === "recording" ? stop() : state === "idle" ? void start() : undefined)}
      disabled={disabled || state === "transcribing"}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-8 shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs transition-colors disabled:opacity-50",
        state === "recording" ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      data-testid="composer-mic-button"
    >
      {state === "transcribing" ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : state === "recording" ? (
        <>
          <Square className="h-3 w-3 fill-current" aria-hidden />
          <span className="tabular-nums">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        </>
      ) : (
        <Mic className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
