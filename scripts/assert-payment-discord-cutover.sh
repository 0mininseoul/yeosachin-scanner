#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

phase="${1:-}"
case "$phase" in
  pre-migration|activate-v2) ;;
  *) fail "usage: $0 pre-migration|activate-v2" ;;
esac

old_worker_state="${PAYMENT_DISCORD_OLD_WORKER_STATE:-}"
case "$old_worker_state" in
  drained|disabled) ;;
  *)
    fail 'PAYMENT_DISCORD_OLD_WORKER_STATE must be drained or disabled before the payment claim cutover'
    ;;
esac

v2_migration_applied="${PAYMENT_DISCORD_V2_MIGRATION_APPLIED:-false}"
v2_worker_enabled="${PAYMENT_DISCORD_V2_WORKER_ENABLED:-false}"

case "$phase" in
  pre-migration)
    [[ "$v2_migration_applied" == 'false' ]] \
      || fail 'the v2 migration must not be marked applied before the pre-migration gate'
    [[ "$v2_worker_enabled" == 'false' ]] \
      || fail 'the v2 worker must remain disabled until after the migration'
    ;;
  activate-v2)
    [[ "$v2_migration_applied" == 'true' ]] \
      || fail 'the v2 migration must be applied before activating the v2 worker'
    [[ "$v2_worker_enabled" == 'true' ]] \
      || fail 'the v2 worker must be explicitly enabled at activation'
    ;;
esac

printf 'PASS: payment Discord %s gate (old worker %s)\n' "$phase" "$old_worker_state"
