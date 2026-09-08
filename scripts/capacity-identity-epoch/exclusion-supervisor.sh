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
readonly CAPACITY_EXCLUSION_PROJECT_PATTERN='^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
readonly CAPACITY_EXCLUSION_LOCATION_PATTERN='^[a-z][a-z0-9-]{0,62}$'
readonly CAPACITY_EXCLUSION_SERVICE_PATTERN='^[a-z][a-z0-9-]{0,62}$'
readonly CAPACITY_EXCLUSION_QUEUE_PATTERN='^[A-Za-z0-9-]{1,100}$'
readonly CAPACITY_EXCLUSION_SCHEDULER_PATTERN='^[A-Za-z0-9_-]+$'
readonly CAPACITY_EXCLUSION_ACCOUNT_PATTERN='^[a-z][a-z0-9-]{0,62}@[a-z][a-z0-9-]{0,62}(\.[a-z0-9-]{2,63})+$'

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

capacity_exclusion_validate_selector_atoms() {
  local entry_point="$1"
  local role="$2"
  local selector_source="role"
  local prefix
  local project
  local location
  local service
  local region
  local queue
  local maintenance_location
  local recovery_job
  local retention_job
  local service_account
  local iam_scope
  local project_var
  local location_var
  local service_var
  local region_var
  local queue_var
  local service_account_var
  if [[ "$(basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]}}")" == "configure-analysis-tasks-queue.sh" ]]; then
    selector_source="generic"
  fi
  if [[ "$selector_source" == "generic" ]]; then
    prefix='ANALYSIS_TASKS'
  elif [[ "$role" == "preflight" ]]; then
    prefix='PREFLIGHT_TASKS'
  else
    prefix='ANALYSIS_V2_TASKS'
  fi
  project_var="${prefix}_PROJECT"; project="${!project_var:-}"
  location_var="${prefix}_LOCATION"; location="${!location_var:-}"
  service_var="${prefix}_CLOUD_RUN_SERVICE"; service="${!service_var:-}"
  region_var="${prefix}_CLOUD_RUN_REGION"; region="${!region_var:-}"
  queue_var="${prefix}_QUEUE"; queue="${!queue_var:-}"
  service_account_var="${prefix}_SERVICE_ACCOUNT_EMAIL"; service_account="${!service_account_var:-}"
  [[ "$project" =~ $CAPACITY_EXCLUSION_PROJECT_PATTERN ]] || capacity_exclusion_die
  [[ -z "$service" || "$service" =~ $CAPACITY_EXCLUSION_SERVICE_PATTERN ]] || capacity_exclusion_die
  [[ -z "$region" || "$region" =~ $CAPACITY_EXCLUSION_LOCATION_PATTERN ]] || capacity_exclusion_die
  [[ -z "$location" || "$location" =~ $CAPACITY_EXCLUSION_LOCATION_PATTERN ]] || capacity_exclusion_die
  [[ -z "$queue" || "$queue" =~ $CAPACITY_EXCLUSION_QUEUE_PATTERN ]] || capacity_exclusion_die
  [[ -z "$service_account" || "$service_account" =~ $CAPACITY_EXCLUSION_ACCOUNT_PATTERN ]] || capacity_exclusion_die
  iam_scope="${ANALYSIS_TASKS_IAM_SCOPE:-project}"
  [[ "$iam_scope" == 'project' || "$iam_scope" == 'queue' ]] || capacity_exclusion_die
  if [[ "$entry_point" == 'preflight-maintenance' || "$entry_point" == 'paid-maintenance' ]]; then
    if [[ "$selector_source" == 'generic' ]]; then
      maintenance_location="$region"
      recovery_job=''
    elif [[ "$role" == 'preflight' ]]; then
      maintenance_location="${PREFLIGHT_TASKS_MAINTENANCE_LOCATION:-$region}"
      recovery_job="${PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB:-analysis-preflight-recovery}"
    else
      maintenance_location="${ANALYSIS_V2_MAINTENANCE_LOCATION:-$region}"
      recovery_job="${ANALYSIS_V2_RECOVERY_SCHEDULER_JOB:-analysis-v2-recovery}"
    fi
    [[ "$maintenance_location" =~ $CAPACITY_EXCLUSION_LOCATION_PATTERN ]] || capacity_exclusion_die
    [[ "$recovery_job" =~ $CAPACITY_EXCLUSION_SCHEDULER_PATTERN \
      && ${#recovery_job} -le 500 ]] || capacity_exclusion_die
    if [[ "$entry_point" == 'paid-maintenance' ]]; then
      retention_job="${ANALYSIS_V2_RETENTION_SCHEDULER_JOB:-analysis-v2-preflight-retention}"
      [[ "$retention_job" =~ $CAPACITY_EXCLUSION_SCHEDULER_PATTERN \
        && ${#retention_job} -le 500 ]] || capacity_exclusion_die
    fi
  fi
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
  [[ "$command" == "assert" || "$command" == "adopt" ]] \
    || capacity_exclusion_die
  [[ "$CAPACITY_EXCLUSION_ACTIVE" == "true" ]] || capacity_exclusion_die
  capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_READ_FD" || capacity_exclusion_die
  capacity_exclusion_fd_open "$CAPACITY_EXCLUSION_WRITE_FD" || capacity_exclusion_die
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || capacity_exclusion_die
  if [[ "$(basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]}}")" == "configure-analysis-tasks-queue.sh" ]]; then
    selector_source="generic"
  fi
  args=("$command" '--control-write-fd' "$CAPACITY_EXCLUSION_WRITE_FD" '--control-read-fd' "$CAPACITY_EXCLUSION_READ_FD" '--selector-source' "$selector_source")
  capacity_exclusion_validate_tokens "$entry_point" "$role"
  args+=( '--entry-point' "$entry_point" '--role' "$role" )
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
  capacity_exclusion_validate_selector_atoms "$entry_point" "$role"
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
