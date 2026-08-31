#!/usr/bin/env bash
set -euo pipefail

# Read-only validation is the safe default.  Mutation requires an explicit
# --apply acknowledgement after a successful --check/dry-run review.
mode="check"
role="${ANALYSIS_CAPACITY_ROLE:-}"
reconcile="false"
mode_was_explicit="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-capacity-queues.sh --role=preflight|paid [--dry-run | --check | --apply] [--reconcile-iam]

Configures one role's dedicated Cloud Tasks queue with queue-scoped IAM. The
  role must also be present in ANALYSIS_WORKLOAD_ROLE. Run once for each role;
  the script rejects queue, service, target, audience, and task/enqueuer/runtime/
  maintenance identity collisions. Preflight maintenance is the only scheduler
  identity allowed to invoke the preflight recovery route.

Capacity stages:
  bootstrap: role gates off; keep initial queue bounds while services are verified
  preflight initial=32, expanded=64
  paid     initial=8,  expanded=16 (or more only after the release gate)

--dry-run prints the exact delegated queue/IAM command without calling gcloud.
--check verifies the existing queue and IAM without mutating them.
--apply mutates the explicitly selected queue after all fail-closed checks.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

for argument in "$@"; do
  case "$argument" in
    --role=preflight|--role=paid) role="${argument#--role=}" ;;
    --dry-run|--check|--apply)
      [[ "$mode_was_explicit" == "false" ]] \
        || die "choose exactly one of --dry-run, --check, or --apply"
      mode="${argument#--}"
      mode_was_explicit="true"
      ;;
    --reconcile-iam) reconcile="true" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $argument" ;;
  esac
done

[[ "$reconcile" != "true" || "$mode" == "apply" ]] \
  || die "--reconcile-iam requires explicit --apply"

[[ "$role" == "preflight" || "$role" == "paid" ]] \
  || die "--role=preflight or --role=paid is required"
[[ "${ANALYSIS_WORKLOAD_ROLE:-}" == "$role" ]] \
  || die "ANALYSIS_WORKLOAD_ROLE must equal --role"

stage="${ANALYSIS_CAPACITY_STAGE:-initial}"
[[ "$stage" == "bootstrap" || "$stage" == "initial" || "$stage" == "expanded" ]] \
  || die "ANALYSIS_CAPACITY_STAGE must be bootstrap, initial, or expanded"
if [[ "$stage" == "expanded" && "${ANALYSIS_CAPACITY_EXPANSION_CANARY:-}" != "true" ]]; then
  die "expanded capacity requires ANALYSIS_CAPACITY_EXPANSION_CANARY=true"
fi

if [[ "$stage" != "bootstrap" ]]; then
  [[ "${ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE:-}" == "drain-and-block" ]] \
    || die "active capacity stages require ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE=drain-and-block"
  [[ "${ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN:-false}" == "true" ]] \
    || die "active capacity stages require legacy producers to be frozen"
  [[ "${ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED:-false}" == "true" ]] \
    || die "active capacity stages require old-target tasks to be drained"
  [[ "${ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED:-false}" == "true" ]] \
    || die "active capacity stages require old invocation targets to be blocked"
  [[ "${ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED:-false}" == "true" ]] \
    || die "active capacity stages require old queue pause/target freeze confirmation"
fi

if [[ "$role" == "preflight" ]]; then
  prefix="PREFLIGHT_TASKS"
  runtime_var="PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  maintenance_var="PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
  path="/api/analysis/preflight/worker"
  queue_rate=32
  queue_concurrency=32
  [[ "$stage" == "expanded" ]] && queue_rate=64 && queue_concurrency=64
  retry_duration="1800s"
else
  prefix="ANALYSIS_V2_TASKS"
  runtime_var="ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  maintenance_var="ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
  path="/api/analysis/v2/worker"
  queue_rate=8
  queue_concurrency=8
  [[ "$stage" == "expanded" ]] && queue_rate=16 && queue_concurrency=16
  retry_duration="3600s"
fi

project_var="${prefix}_PROJECT"
location_var="${prefix}_LOCATION"
queue_var="${prefix}_QUEUE"
target_var="${prefix}_TARGET_URL"
audience_var="${prefix}_OIDC_AUDIENCE"
task_sa_var="${prefix}_SERVICE_ACCOUNT_EMAIL"
enqueuer_var="${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
service_var="${prefix}_CLOUD_RUN_SERVICE"
region_var="${prefix}_CLOUD_RUN_REGION"

project="${!project_var:-}"
location="${!location_var:-}"
queue="${!queue_var:-}"
target="${!target_var:-}"
audience="${!audience_var:-}"
task_sa="${!task_sa_var:-}"
enqueuer="${!enqueuer_var:-}"
service="${!service_var:-}"
region="${!region_var:-}"
runtime="${!runtime_var:-}"
maintenance="${!maintenance_var:-}"

for pair in \
  "project:$project" "location:$location" "queue:$queue" "target:$target" \
  "audience:$audience" "task service account:$task_sa" "enqueuer:$enqueuer" \
  "Cloud Run service:$service" "Cloud Run region:$region" "runtime:$runtime"; do
  [[ "$pair" == *:* && -n "${pair#*:}" ]] || die "missing capacity configuration"
done
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid project"
[[ "$location" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || die "invalid location"
[[ "$queue" =~ ^[a-z]([a-z0-9-]{0,98}[a-z0-9])?$ ]] || die "invalid queue"
[[ "$service" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] || die "invalid Cloud Run service"
[[ "$service" == *"$role"* ]] || die "Cloud Run service must contain its workload role"
[[ "$task_sa" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
  || die "invalid task service account"
[[ "$enqueuer" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
  || die "invalid enqueuer service account"
[[ "$runtime" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
  || die "invalid runtime service account"
if [[ "$role" == "paid" ]]; then
  [[ -n "$maintenance" ]] || die "ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL is required for paid queue IAM"
  [[ "$maintenance" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "invalid maintenance service account"
else
  [[ -n "$maintenance" ]] || die "PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL is required for preflight recovery IAM"
  [[ "$maintenance" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "invalid maintenance service account"
fi
[[ "$target" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?${path}$ ]] \
  || die "target URL must be the exact HTTPS $path endpoint"
origin="${target%$path}"
[[ "$audience" == "$origin" || "$audience" == "$origin/" ]] \
  || die "OIDC audience must be the target origin"

other_prefix="PREFLIGHT_TASKS"
[[ "$role" == "preflight" ]] && other_prefix="ANALYSIS_V2_TASKS"
other_queue_var="${other_prefix}_QUEUE"
other_service_var="${other_prefix}_CLOUD_RUN_SERVICE"
other_target_var="${other_prefix}_TARGET_URL"
other_audience_var="${other_prefix}_OIDC_AUDIENCE"
other_queue="${!other_queue_var:-}"
other_service="${!other_service_var:-}"
other_target="${!other_target_var:-}"
other_audience="${!other_audience_var:-}"
other_task_sa_var="${other_prefix}_SERVICE_ACCOUNT_EMAIL"
other_enqueuer_var="${other_prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
other_runtime_var="PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
[[ "$role" == "preflight" ]] && other_runtime_var="ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
other_maintenance_var="PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
[[ "$role" == "preflight" ]] && other_maintenance_var="ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
other_task_sa="${!other_task_sa_var:-}"
other_enqueuer="${!other_enqueuer_var:-}"
other_runtime="${!other_runtime_var:-}"
other_maintenance="${!other_maintenance_var:-}"
[[ -n "$other_queue" && "$queue" != "$other_queue" ]] \
  || die "preflight and paid queue names must be distinct"
[[ -n "$other_service" && "$service" != "$other_service" ]] \
  || die "preflight and paid Cloud Run service names must be distinct"
[[ -n "$other_target" && -n "$other_audience" ]] \
  || die "the other workload target and OIDC audience are required"
other_path="/api/analysis/v2/worker"
[[ "$role" == "paid" ]] && other_path="/api/analysis/preflight/worker"
[[ "${target%$path}" != "${other_target%$other_path}" ]] \
  || die "preflight and paid target origins must be distinct"
[[ "${audience%/}" != "${other_audience%/}" ]] \
  || die "preflight and paid OIDC audiences must be distinct"
[[ -n "$other_task_sa" && -n "$other_enqueuer" && -n "$other_runtime" && -n "$other_maintenance" ]] \
  || die "the other workload task, enqueuer, runtime, and maintenance identities are required"

identity_labels=(
  "${role} task service account"
  "${role} enqueuer service account"
  "${role} runtime service account"
  "other workload task service account"
  "other workload enqueuer service account"
  "other workload runtime service account"
  "${role} maintenance service account"
  "other workload maintenance service account"
)
identity_values=(
  "$task_sa"
  "$enqueuer"
  "$runtime"
  "$other_task_sa"
  "$other_enqueuer"
  "$other_runtime"
  "$maintenance"
  "$other_maintenance"
)
for ((identity_index = 0; identity_index < ${#identity_values[@]}; identity_index += 1)); do
  for ((other_identity_index = identity_index + 1; other_identity_index < ${#identity_values[@]}; other_identity_index += 1)); do
    [[ "${identity_values[$identity_index]}" != "${identity_values[$other_identity_index]}" ]] \
      || die "${identity_labels[$identity_index]} must be distinct from ${identity_labels[$other_identity_index]}"
  done
done
export ANALYSIS_TASKS_PROJECT="$project"
export ANALYSIS_TASKS_LOCATION="$location"
export ANALYSIS_TASKS_QUEUE="$queue"
export ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL="$task_sa"
export ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL="$enqueuer"
export ANALYSIS_TASKS_CLOUD_RUN_SERVICE="$service"
export ANALYSIS_TASKS_CLOUD_RUN_REGION="$region"
export ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND="$queue_rate"
export ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES="$queue_concurrency"
export ANALYSIS_TASKS_MAX_RETRY_DURATION="$retry_duration"
export ANALYSIS_TASKS_IAM_SCOPE="queue"
export ANALYSIS_TASKS_EXACT_IAM="true"
export ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL="$runtime"
export ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS="enqueue-view"
export ANALYSIS_TASKS_CLOUD_RUN_ALLOWED_INVOKER_MEMBERS="serviceAccount:$task_sa,serviceAccount:$maintenance"
export ANALYSIS_TASKS_EXPECTED_QUEUE_STATE="RUNNING"
if [[ "$stage" == "bootstrap" ]]; then
  export ANALYSIS_TASKS_EXPECTED_QUEUE_STATE="PAUSED"
fi

generic_script="$(dirname "$0")/configure-analysis-tasks-queue.sh"
generic_args=()
[[ "$mode" == "dry-run" ]] && generic_args+=(--dry-run)
[[ "$mode" == "check" ]] && generic_args+=(--check)
[[ "$mode" == "apply" ]] && generic_args+=(--apply)
[[ "$reconcile" == "true" ]] && generic_args+=(--reconcile-iam)

if [[ "$mode" == "dry-run" ]]; then
  print_command env \
    "ANALYSIS_TASKS_PROJECT=$project" \
    "ANALYSIS_TASKS_LOCATION=$location" \
    "ANALYSIS_TASKS_QUEUE=$queue" \
    "ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND=$queue_rate" \
    "ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES=$queue_concurrency" \
    "ANALYSIS_TASKS_IAM_SCOPE=queue" \
    "ANALYSIS_TASKS_EXACT_IAM=true" \
    "ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS=enqueue-view" \
    "ANALYSIS_TASKS_EXPECTED_QUEUE_STATE=$ANALYSIS_TASKS_EXPECTED_QUEUE_STATE" \
    "ANALYSIS_TASKS_CLOUD_RUN_ALLOWED_INVOKER_MEMBERS=${ANALYSIS_TASKS_CLOUD_RUN_ALLOWED_INVOKER_MEMBERS}" \
    bash "$generic_script" "${generic_args[@]}"
  printf 'plan: %s role, queue=%s, service=%s, target=%s, audience=%s, concurrency=%s\n' \
    "$role" "$queue" "$service" "$target" "$audience" "$queue_concurrency"
  printf 'plan: task=%s enqueuer=%s runtime=%s maintenance=%s; other-task=%s other-enqueuer=%s other-runtime=%s other-maintenance=%s\n' \
    "$task_sa" "$enqueuer" "$runtime" "$maintenance" "$other_task_sa" "$other_enqueuer" "$other_runtime" "$other_maintenance"
  printf 'plan: check queue limits/state=%s, roles/cloudtasks.enqueuer queue-scoped IAM, task actAs, Cloud Run private invoker, and all eight identity collisions\n' "$ANALYSIS_TASKS_EXPECTED_QUEUE_STATE"
  printf 'dry-run complete: no remote configuration was verified or changed\n'
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is required for --check/--apply"
command -v jq >/dev/null 2>&1 || die "jq is required for --check/--apply"
bash "$generic_script" "${generic_args[@]}"
printf 'verified: %s capacity queue and queue-scoped IAM\n' "$role"
