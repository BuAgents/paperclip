#!/usr/bin/env bash
# bu-fork: install the local speech-to-text used by WhatsApp voice notes and the
# composer mic button (faster-whisper, CPU, int8). Audio never leaves the machine.
#   bash scripts/bu/setup-whisper.sh [dir]      default: /data/tools/whisper
set -euo pipefail
DIR="${1:-/data/tools/whisper}"
mkdir -p "$DIR"
cp "$(dirname "$0")/whisper-transcribe.py" "$DIR/transcribe.py"
chmod +x "$DIR/transcribe.py"
uv venv -q --python 3.12 "$DIR/.venv"
UV_CACHE_DIR="$DIR/.uv-cache" uv pip install -q --python "$DIR/.venv/bin/python" faster-whisper==1.1.1 requests
# First run downloads the "small" model (~460 MB) into $DIR/models.
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=1" -c:a libopus "$DIR/.selftest.ogg" -y
"$DIR/.venv/bin/python" "$DIR/transcribe.py" "$DIR/.selftest.ogg" && rm -f "$DIR/.selftest.ogg"
echo "Whisper ready in $DIR (set PAPERCLIP_BU_WHISPER_CMD if you use another location)."
