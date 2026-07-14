#!/usr/bin/env bash
set -euo pipefail

mode="apply"
show_help="false"
for argument in "$@"; do
  case "$argument" in
    --dry-run) mode="dry-run" ;;
    --check) mode="check" ;;
    -h|--help) show_help="true" ;;
    *) ;;
  esac
done

if [[ "$show_help" == "true" ]]; then
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-tasks-queue.sh [--dry-run | --check]

Provisions the V2 queue through configure-analysis-tasks-queue.sh, then grants
the worker runtime principal queue-scoped permission to enqueue and verify
tasks. No V2 identity receives project-wide task access.

Additional required environment variable:
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL

The deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL alias remains
accepted during migration. If both names are set, they must match exactly.

Optional V2 queue capacity variables:
  ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND      Defaults to 10.
  ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES     Defaults to 12.

All queue, task identity, enqueuer, and Cloud Run settings use the
ANALYSIS_V2_TASKS_* prefix.
EOF
  exit 0
fi

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

canonical_runtime_identity="${ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL:-}"
legacy_runtime_identity="${ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL:-}"
if [[ -n "$canonical_runtime_identity" && -n "$legacy_runtime_identity" \
  && "$canonical_runtime_identity" != "$legacy_runtime_identity" ]]; then
  die "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL and deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL must match when both are set"
fi
export ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL="${canonical_runtime_identity:-$legacy_runtime_identity}"

print_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

for name in \
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_LOCATION \
  ANALYSIS_V2_TASKS_QUEUE \
  ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION; do
  [[ -n "${!name:-}" ]] || die "$name is required"
done

readonly email_pattern='^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
[[ "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" =~ $email_pattern ]] \
  || die "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL is invalid"

export ANALYSIS_TASKS_PROJECT="$ANALYSIS_V2_TASKS_PROJECT"
export ANALYSIS_TASKS_LOCATION="$ANALYSIS_V2_TASKS_LOCATION"
export ANALYSIS_TASKS_QUEUE="$ANALYSIS_V2_TASKS_QUEUE"
export ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_CLOUD_RUN_SERVICE="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
export ANALYSIS_TASKS_CLOUD_RUN_REGION="$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
export ANALYSIS_TASKS_MAX_RETRY_DURATION="3600s"
export ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND="${ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND:-10}"
export ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES="${ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES:-12}"
export ANALYSIS_TASKS_IAM_SCOPE="queue"
export ANALYSIS_TASKS_EXACT_IAM="true"
export ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS="enqueue-view"

bash "$(dirname "$0")/configure-analysis-tasks-queue.sh" "$@"

runtime_project="${ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL#*@}"
runtime_project="${runtime_project%.iam.gserviceaccount.com}"
[[ "$runtime_project" == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "the worker runtime service account must belong to ANALYSIS_V2_TASKS_PROJECT"
gcloud iam service-accounts describe \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "--project=$runtime_project" \
  '--format=value(email)' >/dev/null \
  || die "the worker runtime service account must already exist"

ensure_cloud_run_runtime_identity() {
  local configured
  configured="$(gcloud run services describe \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    '--format=value(spec.template.spec.serviceAccountName)')"
  if [[ "$configured" == "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" ]]; then
    printf 'verified: Cloud Run uses the worker runtime identity\n'
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "Cloud Run does not use ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  if [[ "$mode" == "dry-run" ]]; then
    print_command gcloud run services update \
      "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
      "--service-account=$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
      '--quiet'
    return 0
  fi
  gcloud run services update \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--service-account=$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    '--quiet'
  configured="$(gcloud run services describe \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    '--format=value(spec.template.spec.serviceAccountName)')"
  [[ "$configured" == "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" ]] \
    || die "Cloud Run worker runtime identity was not observable"
}

# Recovery creates missing tasks and reads deterministic task names before rearming. The generic
# exact-IAM mode already validates the entire queue and task-SA policies, including the runtime
# enqueuer/viewer roles and the complete actAs principal set.
ensure_cloud_run_runtime_identity

printf 'V2 Cloud Tasks configuration verified\n'
