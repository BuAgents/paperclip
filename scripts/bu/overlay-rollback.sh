#!/usr/bin/env bash
# bu-fork: undo an overlay deploy (see overlay-deploy.sh). Restores the files
# that were replaced and removes the ones that were added. The additive DB
# migration is left in place; the stock release ignores the extra table.
#
#   bash scripts/bu/overlay-rollback.sh [backup-dir]   # default: the current deploy
set -euo pipefail
BACKUPS="$HOME/.paperclip/cli/overlay-backups"
backup="${1:-$(readlink -f "$BACKUPS/current")}"
[ -f "$backup/plan.tsv" ] || { echo "ERROR: no deploy backup at $backup"; exit 1; }

systemctl --user stop paperclipai.service
if [ -d "$backup/files" ]; then
  (cd "$backup/files" && find . -type f -print) | while read -r f; do cp -p "$backup/files/${f#./}" "/${f#./}"; done
fi
[ -f "$backup/new-files.txt" ] && while read -r f; do rm -f "$f"; done < "$backup/new-files.txt"
if [ -d "$backup/ui-dist" ]; then
  # overlay-deploy.sh records where it took the backup from; older backups fall back to the base release.
  if [ -f "$backup/ui-dist.path" ]; then UI_DIST="$(cat "$backup/ui-dist.path")"
  else UI_DIST="$HOME/.paperclip/cli/installs/npm/2026.1001.0/node_modules/@paperclipai/server/ui-dist"; fi
  rm -rf "$UI_DIST" && cp -a "$backup/ui-dist" "$UI_DIST"
fi
systemctl --user start paperclipai.service
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/health || true)"
  [ "$code" = 200 ] && break; sleep 3
done
rm -f "$BACKUPS/current"
echo "Rolled back $(basename "$backup"); health: HTTP $code"
