#!/usr/bin/env python3
"""Transcribe one audio file locally with faster-whisper; print JSON.

    transcribe.py <audio-file>
    -> {"text": "...", "language": "pt", "duration": 14.2}

Used by Paperclip's WhatsApp channel for voice notes. Audio never leaves the machine.
Env: WHISPER_MODEL (default "small"), WHISPER_THREADS (default 4).
"""
import json
import os
import sys

from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        print(json.dumps({"error": "usage: transcribe.py <audio-file>"}))
        return 2
    model = WhisperModel(
        os.environ.get("WHISPER_MODEL", "small"),
        device="cpu",
        compute_type="int8",
        cpu_threads=int(os.environ.get("WHISPER_THREADS", "4")),
        download_root=os.path.join(HERE, "models"),
    )
    segments, info = model.transcribe(sys.argv[1], beam_size=1, vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    print(json.dumps({"text": text, "language": info.language, "duration": round(info.duration, 1)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
