#!/usr/bin/env bash
# bu-fork: deploy this fork onto the installed Paperclip release by overlaying
# only the compiled files that differ, with a backup for rollback.
#
# Why not `paperclipai install --ref`: a from-source install needs corepack and a
# Rust toolchain (paperclip-runner binary). Our changes are TypeScript only and
# the fork is based on the exact release that is installed, so unchanged files
# compile byte-identical; only changed files are swapped in.
#
#   bash scripts/bu/overlay-deploy.sh            # build, diff, back up, apply, restart, health-check
#   bash scripts/bu/overlay-deploy.sh --dry-run  # build and list what would change
#   bash scripts/bu/overlay-rollback.sh          # restore the previous files
#
# `paperclipai update` replaces the install and drops the overlay; re-run this after.
set -euo pipefail

DRY_RUN=0; [ "${1:-}" = "--dry-run" ] && DRY_RUN=1
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_VERSION="2026.1001.0"
INSTALL="$HOME/.paperclip/cli/installs/npm/$BASE_VERSION/node_modules/@paperclipai"
# The CLI ships as its own unscoped npm package ("paperclipai", not "@paperclipai/cli"),
# a single esbuild-bundled dist/index.js rather than a tsc dist/ tree, and isn't
# restarted (it's invoked fresh per command) -- built and diffed separately below,
# outside the generic PACKAGES loop.
CLI_INSTALL="$HOME/.paperclip/cli/installs/npm/$BASE_VERSION/node_modules/paperclipai"
BACKUPS="$HOME/.paperclip/cli/overlay-backups"
# Runtime packages the fork adds (installed outside the managed tree, then linked in).
RUNTIME_DEPS_DIR="$HOME/.paperclip/cli/bu-runtime-deps"
RUNTIME_DEPS=("baileys@7.0.0-rc14")
DB_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"
export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
# Extra copies of the same packages loaded by our external adapter plugins.
EXTRA_ROOTS=(/data/projects/paperclip-adapters/node_modules/@paperclipai)

[ -d "$INSTALL/server" ] || { echo "ERROR: $INSTALL not found (installed version changed?)"; exit 1; }
installed_version="$(node -p "require('$INSTALL/server/package.json').version")"
[ "$installed_version" = "$BASE_VERSION" ] || { echo "ERROR: installed server is $installed_version, fork base is $BASE_VERSION"; exit 1; }
[ -f "$CLI_INSTALL/package.json" ] || { echo "ERROR: $CLI_INSTALL not found (installed version changed?)"; exit 1; }
cli_installed_version="$(node -p "require('$CLI_INSTALL/package.json').version")"
[ "$cli_installed_version" = "$BASE_VERSION" ] || { echo "ERROR: installed CLI is $cli_installed_version, fork base is $BASE_VERSION"; exit 1; }

# workspace dir -> installed package dir name
PACKAGES=(
  "server:server"
  "packages/shared:shared"
  "packages/db:db"
  "packages/adapter-utils:adapter-utils"
  "packages/adapters/claude-local:adapter-claude-local"
  "packages/adapters/codex-local:adapter-codex-local"
  "packages/adapters/cursor-local:adapter-cursor-local"
  "packages/adapters/cursor-cloud:adapter-cursor-cloud"
  "packages/adapters/gemini-local:adapter-gemini-local"
  "packages/adapters/grok-local:adapter-grok-local"
  "packages/adapters/kimi-local:adapter-kimi-local"
  "packages/adapters/opencode-local:adapter-opencode-local"
  "packages/adapters/pi-local:adapter-pi-local"
  "packages/adapters/hermes:hermes-paperclip-adapter"
)

echo "== building (tsc only; the runner binary is not touched)"
cd "$REPO"
for entry in "${PACKAGES[@]}"; do
  dir="${entry%%:*}"
  if [ "$dir" = server ]; then
    (cd server && NODE_OPTIONS=--max-old-space-size=3584 npx tsc -p tsconfig.json)
  else
    (cd "$dir" && npx tsc -p tsconfig.json)
  fi
done
rm -rf packages/db/dist/migrations && cp -r packages/db/src/migrations packages/db/dist/migrations
(cd cli && npx tsc --noEmit && npm run build > /dev/null)
(cd ui && NODE_OPTIONS=--max-old-space-size=4096 npx vite build > /dev/null)
UI_DIST="$INSTALL/server/ui-dist"
ui_changed=0
if ! diff -rq ui/dist "$UI_DIST" > /dev/null 2>&1; then ui_changed=1; fi

echo "== diffing against the installed release"
plan="$(mktemp)"
for entry in "${PACKAGES[@]}"; do
  dir="${entry%%:*}"; pkg="${entry##*:}"
  roots=("$INSTALL/$pkg")
  for extra in "${EXTRA_ROOTS[@]}"; do
    [ -f "$extra/$pkg/package.json" ] || continue
    [ "$(node -p "require('$extra/$pkg/package.json').version")" = "$BASE_VERSION" ] && roots+=("$extra/$pkg")
  done
  for root in "${roots[@]}"; do
    (cd "$dir/dist" && find . -type f \( -name "*.js" -o -name "*.sql" -o -name "*.json" \) \
      ! -name "*.test.js" ! -path "./vendor/*" ! -path "./test/*" ! -path "./__tests__/*" -print) | while read -r f; do
      src="$REPO/$dir/dist/${f#./}"; dst="$root/dist/${f#./}"
      if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then echo "$src	$dst"; fi
    done
  done
done > "$plan"
cli_src="$REPO/cli/dist/index.js"; cli_dst="$CLI_INSTALL/dist/index.js"
if [ ! -f "$cli_dst" ] || ! cmp -s "$cli_src" "$cli_dst"; then echo "$cli_src	$cli_dst" >> "$plan"; fi
count="$(wc -l < "$plan")"
sed -E "s#^[^\t]*\t##; s#$HOME#~#" "$plan"
echo "== $count file(s) to overlay; UI bundle changed: $ui_changed"
[ "$count" -gt 0 ] || [ "$ui_changed" = 1 ] || { echo "Nothing to do."; exit 0; }
[ "$DRY_RUN" = 1 ] && exit 0

echo "== applying pending migrations (additive) while the current server runs"
(cd packages/db && DATABASE_URL="$DB_URL" npx tsx src/migrate.ts)

stamp="$(date +%Y%m%d-%H%M%S)"; backup="$BACKUPS/$stamp"; mkdir -p "$backup"
cp "$plan" "$backup/plan.tsv"
while IFS=$'\t' read -r src dst; do
  if [ -f "$dst" ]; then mkdir -p "$backup/files$(dirname "$dst")"; cp -p "$dst" "$backup/files$dst"; else echo "$dst" >> "$backup/new-files.txt"; fi
done < "$plan"
git -C "$REPO" rev-parse HEAD > "$backup/commit.txt"
[ "$ui_changed" = 1 ] && { cp -a "$UI_DIST" "$backup/ui-dist"; echo "$UI_DIST" > "$backup/ui-dist.path"; }
echo "== backup: $backup"

echo "== runtime dependencies"
mkdir -p "$RUNTIME_DEPS_DIR"
[ -f "$RUNTIME_DEPS_DIR/package.json" ] || echo '{"name":"bu-runtime-deps","private":true}' > "$RUNTIME_DEPS_DIR/package.json"
npm install --prefix "$RUNTIME_DEPS_DIR" --no-audit --no-fund "${RUNTIME_DEPS[@]}" > /dev/null
for spec in "${RUNTIME_DEPS[@]}"; do
  name="${spec%@*}"; link="$INSTALL/server/node_modules/$name"
  if [ ! -e "$link" ]; then echo "$link" >> "$backup/new-files.txt"; ln -s "$RUNTIME_DEPS_DIR/node_modules/$name" "$link"; fi
done

echo "== stopping Paperclip"
systemctl --user stop paperclipai.service
while IFS=$'\t' read -r src dst; do mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; done < "$plan"
if [ "$ui_changed" = 1 ]; then rm -rf "$UI_DIST.new" && cp -a "$REPO/ui/dist" "$UI_DIST.new" && rm -rf "$UI_DIST" && mv "$UI_DIST.new" "$UI_DIST"; fi
echo "== starting Paperclip"
systemctl --user start paperclipai.service
for _ in $(seq 1 40); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/health || true)"
  [ "$code" = 200 ] && break; sleep 3
done
if [ "$code" != 200 ]; then
  echo "!! health check failed (HTTP $code) — rolling back"
  bash "$REPO/scripts/bu/overlay-rollback.sh" "$backup"
  exit 1
fi
ln -sfn "$backup" "$BACKUPS/current"
echo "== deployed $(cat "$backup/commit.txt" | cut -c1-12); rollback: bash scripts/bu/overlay-rollback.sh"
