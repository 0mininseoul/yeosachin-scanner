#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_dir/scripts/assert-payment-discord-cutover.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

if env -u PAYMENT_DISCORD_OLD_WORKER_STATE "$script" pre-migration >/dev/null 2>&1; then
  fail 'missing old-worker state was accepted'
fi

if PAYMENT_DISCORD_OLD_WORKER_STATE=active "$script" pre-migration >/dev/null 2>&1; then
  fail 'active old worker was accepted'
fi

if ! PAYMENT_DISCORD_OLD_WORKER_STATE=drained "$script" pre-migration >/dev/null; then
  fail 'drained old worker was rejected before migration'
fi

if ! PAYMENT_DISCORD_OLD_WORKER_STATE=disabled PAYMENT_DISCORD_V2_MIGRATION_APPLIED=true PAYMENT_DISCORD_V2_WORKER_ENABLED=true "$script" activate-v2 >/dev/null; then
  fail 'disabled old worker was rejected during v2 activation'
fi

if PAYMENT_DISCORD_OLD_WORKER_STATE=disabled PAYMENT_DISCORD_V2_WORKER_ENABLED=true "$script" pre-migration >/dev/null 2>&1; then
  fail 'v2 worker enabled before migration was accepted'
fi

if PAYMENT_DISCORD_OLD_WORKER_STATE=disabled PAYMENT_DISCORD_V2_WORKER_ENABLED=true "$script" activate-v2 >/dev/null 2>&1; then
  fail 'v2 activation without applied migration was accepted'
fi

printf 'PASS: payment Discord cutover script contract\n'
