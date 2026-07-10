#!/usr/bin/env bash
set -euo pipefail

readonly CLOUD_TASKS_API="cloudtasks.googleapis.com"
readonly QUEUE_MAX_DISPATCHES_PER_SECOND="2"
readonly QUEUE_MAX_CONCURRENT_DISPATCHES="2"
readonly QUEUE_MAX_ATTEMPTS="8"
readonly QUEUE_MAX_RETRY_DURATION="3600s"
readonly QUEUE_MIN_BACKOFF="40s"
readonly QUEUE_MAX_BACKOFF="300s"
readonly QUEUE_MAX_DOUBLINGS="4"

mode="apply"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-tasks-queue.sh [--dry-run | --check]

Safely provisions or verifies the Google Cloud Tasks queue and the IAM bindings
used by the background analysis pipeline.

Required environment variables:
  ANALYSIS_TASKS_PROJECT
  ANALYSIS_TASKS_LOCATION
  ANALYSIS_TASKS_QUEUE
  ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL

Options:
  --dry-run  Print mutations without applying them. Read-only preflight checks run.
  --check    Verify the complete configuration without changing it.
  -h, --help Show this help.

The enqueuer account must already exist. The task invoker account is created when
missing. This script never creates or downloads service-account keys.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

print_command() {
  printf '[dry-run]'
  printf ' %q' "$@"
  printf '\n'
}

run_mutation() {
  if [[ "$mode" == "dry-run" ]]; then
    print_command "$@"
    return 0
  fi
  if [[ "$mode" == "check" ]]; then
    die "configuration drift requires a change; rerun without --check"
  fi
  "$@"
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || die "ANALYSIS_TASKS_PROJECT is invalid"
}

validate_location() {
  [[ "$1" =~ ^[a-z]+-[a-z]+[0-9]$ ]] \
    || die "ANALYSIS_TASKS_LOCATION is invalid"
}

validate_queue() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,98}[a-z0-9])?$ ]] \
    || die "ANALYSIS_TASKS_QUEUE is invalid"
}

validate_service_account_email() {
  local email="$1"
  local label="$2"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "$label is not a valid service-account email"
}

service_account_project() {
  local email="$1"
  local domain="${email#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

service_account_id() {
  printf '%s\n' "${1%@*}"
}

service_account_exists() {
  local email="$1"
  local project="$2"
  local accounts
  accounts="$(gcloud iam service-accounts list \
    "--project=$project" \
    '--format=value(email)')"
  grep -Fqx "$email" <<<"$accounts"
}

validate_service_account_enabled() {
  local email="$1"
  local project="$2"
  local disabled
  disabled="$(gcloud iam service-accounts describe "$email" \
    "--project=$project" \
    '--format=value(disabled)')"
  [[ "$disabled" != "true" && "$disabled" != "True" ]] \
    || die "service account is disabled: $email"
}

project_binding_exists() {
  local role="$1"
  local member="$2"
  local bindings
  bindings="$(gcloud projects get-iam-policy "$ANALYSIS_TASKS_PROJECT" \
    "--flatten=bindings[].members" \
    "--filter=bindings.role=$role AND bindings.members=$member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "${role},${member}," <<<"$bindings"
}

service_account_binding_exists() {
  local role="$1"
  local member="$2"
  local bindings
  bindings="$(gcloud iam service-accounts get-iam-policy \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--flatten=bindings[].members" \
    "--filter=bindings.role=$role AND bindings.members=$member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "${role},${member}," <<<"$bindings"
}

ensure_project_binding() {
  local role="$1"
  local member="$2"
  local description="$3"
  if project_binding_exists "$role" "$member"; then
    log "verified: $description"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "missing IAM binding: $description"
  run_mutation gcloud projects add-iam-policy-binding "$ANALYSIS_TASKS_PROJECT" \
    "--member=$member" \
    "--role=$role" \
    '--condition=None' \
    '--quiet'

  if [[ "$mode" == "apply" ]]; then
    project_binding_exists "$role" "$member" \
      || die "IAM binding was not observable after setup: $description"
  fi
}

ensure_service_account_binding() {
  local role="$1"
  local member="$2"
  local description="$3"
  if service_account_binding_exists "$role" "$member"; then
    log "verified: $description"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "missing IAM binding: $description"
  run_mutation gcloud iam service-accounts add-iam-policy-binding \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--member=$member" \
    "--role=$role" \
    '--condition=None' \
    '--quiet'

  if [[ "$mode" == "apply" ]]; then
    service_account_binding_exists "$role" "$member" \
      || die "IAM binding was not observable after setup: $description"
  fi
}

api_is_enabled() {
  local enabled
  enabled="$(gcloud services list \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    '--enabled' \
    "--filter=config.name=$CLOUD_TASKS_API" \
    '--format=value(config.name)')"
  [[ "$enabled" == "$CLOUD_TASKS_API" ]]
}

queue_exists() {
  local queues
  queues="$(gcloud tasks queues list \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    '--format=value(name)')"
  grep -Fqx "$ANALYSIS_TASKS_QUEUE" <<<"$queues"
}

queue_limits_match() {
  local policy
  policy="$(gcloud tasks queues describe "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    '--format=csv[no-heading](rateLimits.maxDispatchesPerSecond,rateLimits.maxConcurrentDispatches,retryConfig.maxAttempts,retryConfig.maxRetryDuration,retryConfig.minBackoff,retryConfig.maxBackoff,retryConfig.maxDoublings)')"
  [[ "$policy" == "2.0,2,8,3600s,40s,300s,4" \
    || "$policy" == "2,2,8,3600s,40s,300s,4" ]]
}

verify_queue_running() {
  local state
  state="$(gcloud tasks queues describe "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    '--format=value(state)')"
  [[ "$state" == "RUNNING" ]] \
    || die "queue state is $state; inspect it and resume it explicitly if appropriate"
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      [[ "$mode" == "apply" ]] || die "choose only one of --dry-run or --check"
      mode="dry-run"
      ;;
    --check)
      [[ "$mode" == "apply" ]] || die "choose only one of --dry-run or --check"
      mode="check"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

for name in \
  ANALYSIS_TASKS_PROJECT \
  ANALYSIS_TASKS_LOCATION \
  ANALYSIS_TASKS_QUEUE \
  ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL; do
  required_env "$name"
done

validate_project "$ANALYSIS_TASKS_PROJECT"
validate_location "$ANALYSIS_TASKS_LOCATION"
validate_queue "$ANALYSIS_TASKS_QUEUE"
validate_service_account_email \
  "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email \
  "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"

queue_args=(
  "$ANALYSIS_TASKS_QUEUE"
  "--project=$ANALYSIS_TASKS_PROJECT"
  "--location=$ANALYSIS_TASKS_LOCATION"
  "--max-dispatches-per-second=$QUEUE_MAX_DISPATCHES_PER_SECOND"
  "--max-concurrent-dispatches=$QUEUE_MAX_CONCURRENT_DISPATCHES"
  "--max-attempts=$QUEUE_MAX_ATTEMPTS"
  "--max-retry-duration=$QUEUE_MAX_RETRY_DURATION"
  "--min-backoff=$QUEUE_MIN_BACKOFF"
  "--max-backoff=$QUEUE_MAX_BACKOFF"
  "--max-doublings=$QUEUE_MAX_DOUBLINGS"
  '--quiet'
)

task_account_project="$(service_account_project "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL")"
[[ "$task_account_project" == "$ANALYSIS_TASKS_PROJECT" ]] \
  || die "task invoker service account must belong to ANALYSIS_TASKS_PROJECT"
[[ "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
  != "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" ]] \
  || die "task invoker and enqueuer service accounts must be distinct"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"

project_number="$(gcloud projects describe "$ANALYSIS_TASKS_PROJECT" \
  '--format=value(projectNumber)')"
[[ "$project_number" =~ ^[0-9]+$ ]] || die "could not resolve the GCP project number"

task_account_available="true"
if service_account_exists \
  "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "$ANALYSIS_TASKS_PROJECT"; then
  validate_service_account_enabled \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "$ANALYSIS_TASKS_PROJECT"
  log "verified: task invoker service account"
else
  [[ "$mode" != "check" ]] || die "task invoker service account does not exist"
  run_mutation gcloud iam service-accounts create \
    "$(service_account_id "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL")" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    '--display-name=AI Baram analysis task invoker' \
    '--description=OIDC identity used only by the analysis Cloud Tasks queue' \
    '--quiet'
  if [[ "$mode" == "apply" ]]; then
    service_account_exists \
      "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
      "$ANALYSIS_TASKS_PROJECT" \
      || die "task invoker service account creation did not complete"
    validate_service_account_enabled \
      "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
      "$ANALYSIS_TASKS_PROJECT"
  else
    task_account_available="false"
  fi
fi

enqueuer_project="$(service_account_project \
  "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL")"
if service_account_exists \
  "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
  "$enqueuer_project"; then
  validate_service_account_enabled \
    "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "$enqueuer_project"
  log "verified: enqueuer service account"
else
  die "enqueuer service account must already exist and be visible to the operator"
fi

api_was_enabled="true"
if api_is_enabled; then
  log "verified: $CLOUD_TASKS_API is enabled"
else
  api_was_enabled="false"
  [[ "$mode" != "check" ]] || die "$CLOUD_TASKS_API is not enabled"
  run_mutation gcloud services enable "$CLOUD_TASKS_API" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    '--quiet'
fi

# Creating a service identity is idempotent and repairs projects where API activation did
# not materialize the Cloud Tasks service agent. It does not create any credential key.
if [[ "$mode" != "check" ]]; then
  run_mutation gcloud beta services identity create \
    "--service=$CLOUD_TASKS_API" \
    "--project=$ANALYSIS_TASKS_PROJECT"
fi

readonly enqueuer_member="serviceAccount:$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
readonly service_agent_member="serviceAccount:service-${project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"

ensure_project_binding \
  'roles/cloudtasks.serviceAgent' \
  "$service_agent_member" \
  'Cloud Tasks service agent project role'
ensure_project_binding \
  'roles/cloudtasks.enqueuer' \
  "$enqueuer_member" \
  'runtime principal can enqueue Cloud Tasks'

if [[ "$task_account_available" == "false" ]]; then
  [[ "$mode" == "dry-run" ]] || die "task invoker service account is unavailable"
  run_mutation gcloud iam service-accounts add-iam-policy-binding \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--member=$enqueuer_member" \
    '--role=roles/iam.serviceAccountUser' \
    '--condition=None' \
    '--quiet'
  run_mutation gcloud iam service-accounts add-iam-policy-binding \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--member=$service_agent_member" \
    '--role=roles/iam.serviceAccountTokenCreator' \
    '--condition=None' \
    '--quiet'
else
  ensure_service_account_binding \
    'roles/iam.serviceAccountUser' \
    "$enqueuer_member" \
    'runtime principal has iam.serviceAccounts.actAs on the task invoker'
  ensure_service_account_binding \
    'roles/iam.serviceAccountTokenCreator' \
    "$service_agent_member" \
    'Cloud Tasks service agent can mint the task OIDC token'
fi

if [[ "$mode" == "dry-run" && "$api_was_enabled" == "false" ]]; then
  run_mutation gcloud tasks queues create "${queue_args[@]}"
elif queue_exists; then
  if queue_limits_match; then
    log "verified: queue rate and retry policy"
  else
    [[ "$mode" != "check" ]] || die "queue rate or retry policy has drifted"
    run_mutation gcloud tasks queues update "${queue_args[@]}"
  fi
  if [[ "$mode" != "dry-run" ]]; then
    queue_limits_match || die "queue policy was not applied"
    verify_queue_running
  fi
else
  [[ "$mode" != "check" ]] || die "analysis task queue does not exist"
  run_mutation gcloud tasks queues create "${queue_args[@]}"
  if [[ "$mode" == "apply" ]]; then
    queue_limits_match || die "queue policy was not applied"
    verify_queue_running
  fi
fi

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  gcloud tasks queues describe "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    '--format=yaml(state,rateLimits,retryConfig)'
  log "Cloud Tasks configuration verified"
fi
