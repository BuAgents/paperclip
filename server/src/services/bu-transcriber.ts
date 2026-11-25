// bu-fork: local speech-to-text (faster-whisper) for WhatsApp voice notes and
// the composer mic button. Audio never leaves the machine.
//
// PAPERCLIP_BU_WHISPER_CMD: command that takes an audio file path as its last
// argument and prints {"text","language","duration"} JSON
// (default: /data/tools/whisper/.venv/bin/python /data/tools/whisper/transcribe.py).
// One transcription runs at a time: the model uses ~0.8 GB of RAM while loaded.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Transcript {
  text: string;
  language: string | null;
  durationSec: number | null;
}

const DEFAULT_COMMAND = "/data/tools/whisper/.venv/bin/python /data/tools/whisper/transcribe.py";
const TIMEOUT_MS = 180_000;
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

let queue: Promise<unknown> = Promise.resolve();

function command(): string[] {
  return (process.env.PAPERCLIP_BU_WHISPER_CMD?.trim() || DEFAULT_COMMAND).split(/\s+/).filter(Boolean);
}

function run(file: string): Promise<Transcript> {
  const [bin, ...args] = command();
  return new Promise((resolve, reject) => {
    execFile(bin!, [...args, file], { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error(`Transcription failed: ${error.message.split("\n")[0]}`));
      try {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(lastLine) as { text?: unknown; language?: unknown; duration?: unknown; error?: unknown };
        if (typeof parsed.error === "string") return reject(new Error(`Transcription failed: ${parsed.error}`));
        resolve({
          text: typeof parsed.text === "string" ? parsed.text.trim() : "",
          language: typeof parsed.language === "string" ? parsed.language : null,
          durationSec: typeof parsed.duration === "number" ? parsed.duration : null,
        });
      } catch {
        reject(new Error("Transcription returned unreadable output"));
      }
    });
  });
}

/** Transcribes audio bytes; calls are serialized. */
export async function transcribeAudio(bytes: Buffer, extension = "ogg"): Promise<Transcript> {
  if (bytes.length === 0) throw new Error("Empty audio");
  if (bytes.length > MAX_TRANSCRIBE_BYTES) throw new Error("Audio is too large to transcribe");
  const safeExt = /^[a-z0-9]{1,5}$/.test(extension) ? extension : "bin";
  const task = queue.then(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bu-transcribe-"));
    const file = path.join(dir, `audio.${safeExt}`);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      return await run(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  queue = task.catch(() => undefined);
  return task;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
