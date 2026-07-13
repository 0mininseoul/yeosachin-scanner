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
the explicit recovery runtime principal permission to enqueue and verify tasks.

Additional required environment variable:
  ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL

All queue, task identity, enqueuer, and Cloud Run settings use the
ANALYSIS_V2_TASKS_* prefix.
EOF
  exit 0
fi

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

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
  ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION; do
  [[ -n "${!name:-}" ]] || die "$name is required"
done

readonly email_pattern='^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
[[ "$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" =~ $email_pattern ]] \
  || die "ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL is invalid"

export ANALYSIS_TASKS_PROJECT="$ANALYSIS_V2_TASKS_PROJECT"
export ANALYSIS_TASKS_LOCATION="$ANALYSIS_V2_TASKS_LOCATION"
export ANALYSIS_TASKS_QUEUE="$ANALYSIS_V2_TASKS_QUEUE"
export ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_CLOUD_RUN_SERVICE="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
export ANALYSIS_TASKS_CLOUD_RUN_REGION="$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
export ANALYSIS_TASKS_MAX_RETRY_DURATION="3600s"

"$(dirname "$0")/configure-analysis-tasks-queue.sh" "$@"

recovery_project="${ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL#*@}"
recovery_project="${recovery_project%.iam.gserviceaccount.com}"
[[ "$recovery_project" == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "the recovery runtime service account must belong to ANALYSIS_V2_TASKS_PROJECT"
gcloud iam service-accounts describe \
  "$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" \
  "--project=$recovery_project" \
  '--format=value(email)' >/dev/null \
  || die "the recovery runtime service account must already exist"

readonly recovery_member="serviceAccount:$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL"

ensure_cloud_run_runtime_identity() {
  local configured
  configured="$(gcloud run services describe \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    '--format=value(spec.template.spec.serviceAccountName)')"
  if [[ "$configured" == "$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" ]]; then
    printf 'verified: Cloud Run uses the recovery runtime identity\n'
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "Cloud Run does not use ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL"
  if [[ "$mode" == "dry-run" ]]; then
    print_command gcloud run services update \
      "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
      "--service-account=$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" \
      '--quiet'
    return 0
  fi
  gcloud run services update \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--service-account=$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" \
    '--quiet'
  configured="$(gcloud run services describe \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    '--format=value(spec.template.spec.serviceAccountName)')"
  [[ "$configured" == "$ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL" ]] \
    || die "Cloud Run recovery runtime identity was not observable"
}

project_binding_exists() {
  local role="$1"
  local bindings
  bindings="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=$role AND bindings.members=$recovery_member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "${role},${recovery_member}," <<<"$bindings"
}

task_identity_binding_exists() {
  local bindings
  bindings="$(gcloud iam service-accounts get-iam-policy \
    "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=roles/iam.serviceAccountUser AND bindings.members=$recovery_member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "roles/iam.serviceAccountUser,${recovery_member}," <<<"$bindings"
}

ensure_project_binding() {
  local role="$1"
  local description="$2"
  if project_binding_exists "$role"; then
    printf 'verified: %s\n' "$description"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "missing IAM binding: $description"
  if [[ "$mode" == "dry-run" ]]; then
    print_command gcloud projects add-iam-policy-binding \
      "$ANALYSIS_V2_TASKS_PROJECT" \
      "--member=$recovery_member" \
      "--role=$role" \
      '--condition=None' \
      '--quiet'
    return 0
  fi
  gcloud projects add-iam-policy-binding \
    "$ANALYSIS_V2_TASKS_PROJECT" \
    "--member=$recovery_member" \
    "--role=$role" \
    '--condition=None' \
    '--quiet'
  project_binding_exists "$role" || die "IAM binding was not observable: $description"
}

ensure_task_identity_binding() {
  if task_identity_binding_exists; then
    printf 'verified: recovery runtime can mint the task OIDC identity\n'
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "recovery runtime cannot act as the task OIDC identity"
  if [[ "$mode" == "dry-run" ]]; then
    print_command gcloud iam service-accounts add-iam-policy-binding \
      "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--member=$recovery_member" \
      '--role=roles/iam.serviceAccountUser' \
      '--condition=None' \
      '--quiet'
    return 0
  fi
  gcloud iam service-accounts add-iam-policy-binding \
    "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--member=$recovery_member" \
    '--role=roles/iam.serviceAccountUser' \
    '--condition=None' \
    '--quiet'
  task_identity_binding_exists \
    || die "recovery runtime actAs binding was not observable"
}

# Recovery creates missing tasks and reads the exact deterministic task name before rearming.
ensure_cloud_run_runtime_identity
ensure_project_binding 'roles/cloudtasks.enqueuer' \
  'recovery runtime can enqueue replacement tasks'
ensure_project_binding 'roles/cloudtasks.viewer' \
  'recovery runtime can verify deterministic task existence'
ensure_task_identity_binding

printf 'V2 Cloud Tasks configuration verified\n'
