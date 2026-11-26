#!/usr/bin/env bash
# BUD-1139 / BUD-1142: Live cutover script for Paperclip fork bump to v2026.1117.0.
#
# Usage:
#   bash scripts/ops/BUD-1139-bump.sh --dry-run
#   bash scripts/ops/BUD-1139-bump.sh --apply
#   bash scripts/ops/BUD-1139-bump.sh --rollback <BACKUP_DIR>
#
# Environment overrides:
#   DATABASE_URL   Postgres connection string (default: embedded Postgres on 127.0.0.1:54329)
#   BACKUP_ROOT    Directory for timestamped backups (default: ~/.paperclip/cli/bu-bump-backups)
#   HEALTH_URL     Health endpoint URL (default: http://127.0.0.1:3100/api/health)
#   PG_DOCKER_IMG  Fallback Docker image when pg_dump/pg_restore are not on PATH (default: postgres:18)
set -euo pipefail
umask 077

TARGET_VERSION="2026.1117.0"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.paperclip/cli/bu-bump-backups}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
DB_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"
PG_DOCKER_IMG="${PG_DOCKER_IMG:-postgres:18}"
SERVICE_NAME="${PAPERCLIP_SYSTEMD_SERVICE:-paperclipai.service}"
export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

usage() {
  echo "Usage: $0 --dry-run | --apply | --rollback BACKUP_DIR" >&2
  exit 2
}

step() {
  echo ""
  echo "==> $1"
}

check_lockfile_sync() {
  local mode="${1:-strict}"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm is not installed on PATH." >&2
    return 1
  fi
  if (cd "$REPO" && pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null 2>&1); then
    echo "OK: pnpm-lock.yaml is in sync with workspace package.json files."
    return 0
  fi
  if [ "$mode" = "dry-run" ]; then
    echo "WARNING: pnpm-lock.yaml is OUT OF SYNC with workspace package.json files."
    echo "         --apply will abort until pnpm-lock.yaml is refreshed (e.g. merge lockfile refresh PR first)."
    return 0
  fi
  echo "ERROR: pnpm-lock.yaml is out of sync with workspace package.json files." >&2
  echo "       Refresh pnpm-lock.yaml (merge the lockfile refresh PR) before running --apply." >&2
  return 1
}

pg_tool_mode() {
  if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
    echo "native"
  elif command -v docker >/dev/null 2>&1; then
    echo "docker:$PG_DOCKER_IMG"
  else
    echo "missing"
  fi
}

run_pg_dump() {
  local out_file="$1"
  local out_dir out_base
  out_dir="$(dirname "$out_file")"
  out_base="$(basename "$out_file")"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --dbname "$DB_URL" --format=custom --file "$out_file"
  else
    docker run --rm --network host --user "$(id -u):$(id -g)" \
      -v "$out_dir:/backup" "$PG_DOCKER_IMG" \
      pg_dump --dbname "$DB_URL" --format=custom --file "/backup/$out_base"
  fi
}

run_pg_restore_list() {
  local dump_file="$1"
  local dump_dir dump_base
  dump_dir="$(dirname "$dump_file")"
  dump_base="$(basename "$dump_file")"
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$dump_file" >/dev/null
  else
    docker run --rm -v "$dump_dir:/backup:ro" "$PG_DOCKER_IMG" \
      pg_restore --list "/backup/$dump_base" >/dev/null
  fi
}

run_pg_restore() {
  local dump_file="$1"
  local dump_dir dump_base
  dump_dir="$(dirname "$dump_file")"
  dump_base="$(basename "$dump_file")"
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DB_URL" "$dump_file"
  else
    docker run --rm --network host -v "$dump_dir:/backup:ro" "$PG_DOCKER_IMG" \
      pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DB_URL" "/backup/$dump_base"
  fi
}

check_health() {
  local response
  for _ in $(seq 1 40); do
    response="$(curl --silent --show-error --max-time 5 "$HEALTH_URL" || true)"
    if node -e 'const d = JSON.parse(process.argv[1]); process.exit(d && d.status === "ok" ? 0 : 1);' "$response" 2>/dev/null; then
      echo "Health OK: $response"
      return 0
    fi
    sleep 3
  done
  echo "ERROR: Health check did not become ready at $HEALTH_URL" >&2
  return 1
}

case "${1:-}" in
  --dry-run)
    pg_mode="$(pg_tool_mode)"
    echo "=== BUD-1139 Paperclip Fork Bump (--dry-run) ==="
    echo "Target version : $TARGET_VERSION"
    echo "Repository     : $REPO"
    echo "Git HEAD       : $(git -C "$REPO" rev-parse --short HEAD) ($(git -C "$REPO" branch --show-current || echo detached))"
    echo "Backup root    : $BACKUP_ROOT/<timestamp>"
    echo "Health URL     : $HEALTH_URL"
    echo "pg_dump mode   : $pg_mode"

    step "Step 1/5: Preflight lockfile sync check"
    check_lockfile_sync dry-run

    step "Step 2/5: Pre-update database backup"
    echo "[dry-run] Would back up database via $pg_mode pg_dump (custom format) to:"
    echo "          $BACKUP_ROOT/<timestamp>/database.dump"
    echo "[dry-run] Would verify archive integrity with pg_restore --list"

    step "Step 3/5: Update managed Paperclip CLI & server to $TARGET_VERSION"
    echo "[dry-run] Would run: paperclipai update --version $TARGET_VERSION --yes"

    step "Step 4/5: Build & apply Bu fork overlay"
    echo "[dry-run] Would run: bash $REPO/scripts/bu/overlay-deploy.sh"

    step "Step 5/5: Verify /api/health and active CLI version"
    echo "[dry-run] Would poll $HEALTH_URL for status == \"ok\""
    echo "[dry-run] Would verify: paperclipai --version contains $TARGET_VERSION"

    step "Rollback plan"
    echo "[dry-run] Rollback command:"
    echo "          bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $BACKUP_ROOT/<timestamp>"
    echo "          (stops $SERVICE_NAME, restores overlay/previous managed install, runs pg_restore --clean --if-exists, restarts service, checks $HEALTH_URL)"
    ;;

  --apply)
    step "Step 1/5: Preflight checks (tools + lockfile sync)"
    for cmd in paperclipai curl node systemctl; do
      command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: required command '$cmd' not found on PATH." >&2; exit 1; }
    done
    pg_mode="$(pg_tool_mode)"
    if [ "$pg_mode" = "missing" ]; then
      echo "ERROR: neither pg_dump/pg_restore nor docker is available on PATH." >&2
      exit 1
    fi
    echo "Using pg_dump/pg_restore mode: $pg_mode"
    check_lockfile_sync strict

    step "Step 2/5: Pre-update database backup"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    backup="$BACKUP_ROOT/$stamp"
    mkdir -p "$backup"
    echo "Writing custom-format pg_dump to $backup/database.dump"
    run_pg_dump "$backup/database.dump"
    run_pg_restore_list "$backup/database.dump"
    printf '%s\n' "$TARGET_VERSION" > "$backup/target-version.txt"
    printf '%s\n' "$(paperclipai --version 2>/dev/null || echo unknown)" > "$backup/previous-version.txt"
    printf '%s\n' "$(git -C "$REPO" rev-parse HEAD)" > "$backup/fork-commit.txt"
    echo "Backup verified at $backup"
    echo "If any later step fails, roll back with:"
    echo "  bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup"

    step "Step 3/5: Update managed Paperclip install to $TARGET_VERSION"
    paperclipai update --version "$TARGET_VERSION" --yes

    step "Step 4/5: Apply Bu fork overlay"
    bash "$REPO/scripts/bu/overlay-deploy.sh"

    step "Step 5/5: Verify /api/health and active CLI version"
    check_health
    active_version="$(paperclipai --version)"
    echo "Active CLI version: $active_version"
    if [[ "$active_version" != *"$TARGET_VERSION"* ]]; then
      echo "ERROR: Active CLI version '$active_version' does not contain '$TARGET_VERSION'." >&2
      echo "Rollback with: bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup" >&2
      exit 1
    fi
    echo ""
    echo "Cutover succeeded ($TARGET_VERSION). Keep backup until verified: $backup"
    ;;

  --rollback)
    backup="${2:-}"
    [ -n "$backup" ] && [ -f "$backup/database.dump" ] && [ -f "$backup/target-version.txt" ] || usage
    [ ! -e "$backup/rolled-back" ] || { echo "ERROR: Backup $backup was already restored." >&2; exit 1; }

    step "Rollback 1/5: Preflight checks and backup verification"
    for cmd in paperclipai systemctl curl node; do
      command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: required command '$cmd' not found on PATH." >&2; exit 1; }
    done
    pg_mode="$(pg_tool_mode)"
    if [ "$pg_mode" = "missing" ]; then
      echo "ERROR: neither pg_restore nor docker is available on PATH." >&2
      exit 1
    fi
    run_pg_restore_list "$backup/database.dump"
    echo "Backup archive verified ($pg_mode)."

    step "Rollback 2/5: Stopping $SERVICE_NAME"
    systemctl --user stop "$SERVICE_NAME"

    step "Rollback 3/5: Restoring previous managed install / overlay files"
    if [ -L "$HOME/.paperclip/cli/overlay-backups/current" ]; then
      echo "Overlay backup detected; rolling back managed payload first."
    fi
    if [[ "$(paperclipai --version 2>/dev/null || true)" == *"$TARGET_VERSION"* ]]; then
      echo "Flipping managed install back with: paperclipai update --rollback"
      paperclipai update --rollback
    else
      echo "Active CLI is already outside $TARGET_VERSION; skipping paperclipai update --rollback."
    fi

    step "Rollback 4/5: Restoring pre-update database from $backup/database.dump"
    run_pg_restore "$backup/database.dump"

    step "Rollback 5/5: Starting $SERVICE_NAME and verifying health"
    systemctl --user start "$SERVICE_NAME"
    check_health
    touch "$backup/rolled-back"
    echo ""
    echo "Rollback succeeded. Restored from: $backup"
    ;;

  *)
    usage
    ;;
esac
