#!/usr/bin/env bash
set -euo pipefail
umask 077

target_version=2026.1117.0
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup_root="$HOME/.paperclip/cli/bu-bump-backups"
health_url=http://127.0.0.1:3100/api/health

usage() {
  echo "Usage: $0 --dry-run | --apply | --rollback BACKUP_DIR" >&2
  exit 2
}

require_database_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "Set DATABASE_URL from the Paperclip service configuration before running this command." >&2
    exit 2
  fi
}

check_health() {
  local response
  for _ in $(seq 1 40); do
    response="$(curl --silent --show-error --max-time 5 "$health_url" || true)"
    if jq -e '.status == "ok"' >/dev/null 2>&1 <<< "$response"; then
      echo "Health: ok"
      return 0
    fi
    sleep 3
  done
  echo "Health check did not become ready at $health_url" >&2
  return 1
}

case "${1:-}" in
  --dry-run)
    echo "Target: paperclipai $target_version"
    echo "Repository: $repo"
    echo "Backup directory: $backup_root/<timestamp>"
    echo "Would require DATABASE_URL and run pg_dump in custom format."
    echo "Would run: paperclipai update --version $target_version --yes"
    echo "Would run: bash $repo/scripts/bu/overlay-deploy.sh"
    echo "Would check: $health_url (status ok) and paperclipai --version ($target_version)"
    echo "Rollback: $0 --rollback BACKUP_DIR"
    ;;
  --apply)
    require_database_url
    for command in pg_dump pg_restore paperclipai curl jq; do command -v "$command" >/dev/null; done
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    backup="$backup_root/$stamp"
    mkdir -p "$backup"
    echo "Backing up the database to $backup/database.dump"
    pg_dump --dbname "$DATABASE_URL" --format=custom --file "$backup/database.dump"
    pg_restore --list "$backup/database.dump" >/dev/null
    printf '%s\n' "$target_version" > "$backup/target-version.txt"
    printf '%s\n' "$(git -C "$repo" rev-parse HEAD)" > "$backup/fork-commit.txt"
    echo "Backup verified. Keep it until the cutover is accepted."
    echo "If a later step fails, run: bash $repo/scripts/ops/BUD-1139-bump.sh --rollback $backup"
    echo "Updating the managed install to $target_version"
    paperclipai update --version "$target_version" --yes
    echo "Applying the fork overlay"
    bash "$repo/scripts/bu/overlay-deploy.sh"
    check_health
    if [[ "$(paperclipai --version)" != *"$target_version"* ]]; then
      echo "The active CLI does not report $target_version" >&2
      exit 1
    fi
    echo "Cutover passed. Rollback command: bash $repo/scripts/ops/BUD-1139-bump.sh --rollback $backup"
    ;;
  --rollback)
    require_database_url
    backup="${2:-}"
    [ -n "$backup" ] && [ -f "$backup/database.dump" ] && [ -f "$backup/target-version.txt" ] || usage
    [ ! -e "$backup/rolled-back" ] || { echo "This backup was already restored." >&2; exit 1; }
    for command in pg_restore paperclipai systemctl curl jq; do command -v "$command" >/dev/null; done
    pg_restore --list "$backup/database.dump" >/dev/null
    echo "Stopping the Paperclip service"
    systemctl --user stop paperclipai.service
    if [[ "$(paperclipai --version)" == *"$target_version"* ]]; then
      echo "Returning to the previous managed install"
      paperclipai update --rollback
    else
      echo "The managed install is already outside $target_version; restoring the database only"
    fi
    echo "Restoring the pre-update database"
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DATABASE_URL" "$backup/database.dump"
    echo "Starting the Paperclip service"
    systemctl --user start paperclipai.service
    check_health
    touch "$backup/rolled-back"
    echo "Rollback passed. Backup: $backup"
    ;;
  *) usage ;;
esac
