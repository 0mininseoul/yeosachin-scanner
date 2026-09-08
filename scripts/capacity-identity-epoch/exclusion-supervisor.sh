#!/usr/bin/env bash

# Private fixed-token bridge for ordinary capacity mutations.
#
# Bash 3.2 (the supported macOS operator shell) has no dynamic descriptor
# allocation.  A small fixed Node launcher owns the supervisor and
# maps its two anonymous pipes onto fixed low descriptors for the re-entered
# allowlisted shell child; the protected descriptor itself is inherited
# separately and is never copied into a temporary file.

readonly CAPACITY_EXCLUSION_READ_FD=4
readonly CAPACITY_EXCLUSION_WRITE_FD=5
readonly CAPACITY_EXCLUSION_ENTRY_POINT_PATTERN='^(role-deployer|capacity-queue|preflight-maintenance|paid-maintenance)$'
readonly CAPACITY_EXCLUSION_ROLE_PATTERN='^(preflight|paid)$'

CAPACITY_EXCLUSION_ACTIVE="false"
CAPACITY_EXCLUSION_STARTED_HERE="false"
CAPACITY_EXCLUSION_ENTRY_POINT=""
CAPACITY_EXCLUSION_ROLE=""

capacity_exclusion_die() {
  printf 'error: capacity exclusion is unavailable\n' >&2
  return 1
}

capacity_exclusion_validate_tokens() {
  local entry_point="$1"
  local role="$2"
  [[ "$entry_point" =~ $CAPACITY_EXCLUSION_ENTRY_POINT_PATTERN ]] || capacity_exclusion_die
  [[ "$role" =~ $CAPACITY_EXCLUSION_ROLE_PATTERN ]] || capacity_exclusion_die
}

capacity_exclusion_fd_open() {
  local fd="$1"
  [[ "$fd" =~ ^[0-9]{1,9}$ ]] || return 1
  { : <&"$fd"; } 2>/dev/null
}

capacity_exclusion_request() {
  local command="$1"
  local entry_point="${2:-}"
  local role="${3:-}"
  local script_dir
  local args
  local selector_source="role"
  [[ "$command" == "assert" || "$command" == "adopt" || "$command" == "release" ]] \
    || capacity_exclusion_die
  [[ "$CAPACITY_EXCLUSION_ACTIVE" == "true" ]] || capacity_exclusion_die
  capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_READ_FD" || capacity_exclusion_die
  capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_WRITE_FD" || capacity_exclusion_die
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || capacity_exclusion_die
  if [[ "$(basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]}}")" == "configure-analysis-tasks-queue.sh" ]]; then
    selector_source="generic"
  fi
  args=("$command" '--control-write-fd' "$CAPACITY_EXCLUSION_WRITE_FD" '--control-read-fd' "$CAPACITY_EXCLUSION_READ_FD" '--selector-source' "$selector_source")
  if [[ "$command" != "release" ]]; then
    capacity_exclusion_validate_tokens "$entry_point" "$role"
    args+=( '--entry-point' "$entry_point" '--role' "$role" )
  fi
  node --import tsx "$script_dir/exclusion-ipc.ts" "${args[@]}" >/dev/null
}

capacity_exclusion_script_token() {
  local caller
  caller="$(basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]}}")"
  case "$caller" in
    configure-analysis-capacity-queues.sh) printf 'capacity-queues\n' ;;
    configure-analysis-tasks-queue.sh) printf 'tasks-queue\n' ;;
    configure-analysis-v2-tasks-queue.sh) printf 'v2-tasks-queue\n' ;;
    configure-preflight-tasks-queue.sh) printf 'preflight-tasks-queue\n' ;;
    configure-analysis-preflight-maintenance.sh) printf 'preflight-maintenance\n' ;;
    configure-analysis-v2-maintenance.sh) printf 'v2-maintenance\n' ;;
    deploy-analysis-capacity-workers.sh) printf 'capacity-workers\n' ;;
    *) return 1 ;;
  esac
}

capacity_exclusion_start() {
  local entry_point="$1"
  local role="$2"
  local script_dir
  local script_token
  local argument
  local launcher_args
  shift 2
  capacity_exclusion_validate_tokens "$entry_point" "$role"
  [[ "$CAPACITY_EXCLUSION_ACTIVE" == "false" ]] || capacity_exclusion_die

  # A nested approved entry point inherits the already-held supervisor.  It
  # proves the child selector through private IPC instead of trusting an
  # environment boolean or merely-present descriptor.
  if [[ -n "${ANALYSIS_CAPACITY_EXCLUSION_CONTROL_READ_FD:-}" \
     || -n "${ANALYSIS_CAPACITY_EXCLUSION_CONTROL_WRITE_FD:-}" ]]; then
    [[ "${ANALYSIS_CAPACITY_EXCLUSION_CONTROL_READ_FD:-}" == "$CAPACITY_EXCLUSION_READ_FD" \
       && "${ANALYSIS_CAPACITY_EXCLUSION_CONTROL_WRITE_FD:-}" == "$CAPACITY_EXCLUSION_WRITE_FD" ]] \
      || capacity_exclusion_die
    [[ "${ANALYSIS_CAPACITY_EXCLUSION_CONTROL_NONCE:-}" =~ ^[0-9a-f]{64}$ ]] \
      || capacity_exclusion_die
    capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_READ_FD" || capacity_exclusion_die
    capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_WRITE_FD" || capacity_exclusion_die
    CAPACITY_EXCLUSION_ACTIVE="true"
    CAPACITY_EXCLUSION_STARTED_HERE="false"
    export ANALYSIS_CAPACITY_EXCLUSION_CONTROL_READ_FD="$CAPACITY_EXCLUSION_READ_FD"
    export ANALYSIS_CAPACITY_EXCLUSION_CONTROL_WRITE_FD="$CAPACITY_EXCLUSION_WRITE_FD"
    capacity_exclusion_request adopt "$entry_point" "$role" || {
      CAPACITY_EXCLUSION_ACTIVE="false"
      capacity_exclusion_die
    }
    CAPACITY_EXCLUSION_ENTRY_POINT="$entry_point"
    CAPACITY_EXCLUSION_ROLE="$role"
    return 0
  fi

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || capacity_exclusion_die
  script_token="$(capacity_exclusion_script_token)" || capacity_exclusion_die
  launcher_args=(
    --entry-point "$entry_point"
    --role "$role"
    --script-token "$script_token"
  )
  for argument in "$@"; do
    launcher_args+=( --script-arg "$argument" )
  done
  # The launcher owns acquire, the mapped child, final release, and its exit
  # status.  Re-entry sees inherited control descriptors and only delegates.
  exec node --import tsx "$script_dir/exclusion-launcher.ts" "${launcher_args[@]}"
}

capacity_exclusion_finish() {
  # Direct ownership belongs to exclusion-launcher.ts.  Nested callers never
  # release the parent lease; EOF/launcher lifecycle handles the boundary.
  return 0
}
