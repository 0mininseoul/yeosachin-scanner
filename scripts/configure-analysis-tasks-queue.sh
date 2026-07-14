#!/usr/bin/env bash
set -euo pipefail

readonly CLOUD_TASKS_API="cloudtasks.googleapis.com"
readonly QUEUE_MAX_DISPATCHES_PER_SECOND="${ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND:-2}"
readonly QUEUE_MAX_CONCURRENT_DISPATCHES="${ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES:-2}"
readonly QUEUE_MAX_ATTEMPTS="8"
readonly QUEUE_MAX_RETRY_DURATION="${ANALYSIS_TASKS_MAX_RETRY_DURATION:-3600s}"
readonly QUEUE_MIN_BACKOFF="40s"
readonly QUEUE_MAX_BACKOFF="300s"
readonly QUEUE_MAX_DOUBLINGS="4"
readonly ENQUEUER_IAM_SCOPE="${ANALYSIS_TASKS_IAM_SCOPE:-project}"
readonly EXACT_IAM="${ANALYSIS_TASKS_EXACT_IAM:-false}"
readonly RUNTIME_QUEUE_ACCESS="${ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS:-none}"

mode="apply"
reconcile_iam="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-tasks-queue.sh [--dry-run | --check] [--reconcile-iam]

Safely provisions or verifies the Google Cloud Tasks queue and the IAM bindings
used by the background analysis pipeline.

Required environment variables:
  ANALYSIS_TASKS_PROJECT
  ANALYSIS_TASKS_LOCATION
  ANALYSIS_TASKS_QUEUE
  ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL

Optional private Cloud Run target variables (set both or neither):
  ANALYSIS_TASKS_CLOUD_RUN_SERVICE
  ANALYSIS_TASKS_CLOUD_RUN_REGION

Optional bounded queue overrides:
  ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND      Integer 1..100. Defaults to 2.
  ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES     Integer 1..100. Defaults to 2.
  ANALYSIS_TASKS_IAM_SCOPE                     project (default) or queue.
  ANALYSIS_TASKS_EXACT_IAM                     true or false. Defaults to false.
  ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL Required when exact IAM is true.
  ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS          none or enqueue-view.

Set ANALYSIS_TASKS_IAM_SCOPE=queue for a dedicated queue. In queue mode the
configured enqueuer must not retain project-wide roles/cloudtasks.enqueuer.

Options:
  --dry-run  Print mutations without applying them. Read-only preflight checks run.
  --check    Verify the complete configuration without changing it.
  --reconcile-iam
             Replace non-empty drifted task-SA or queue IAM. Without this
             explicit opt-in, unexpected existing IAM fails closed.
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

validate_cloud_run_service() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] \
    || die "ANALYSIS_TASKS_CLOUD_RUN_SERVICE is invalid"
}

validate_queue_capacity() {
  [[ "$QUEUE_MAX_DISPATCHES_PER_SECOND" =~ ^[1-9][0-9]*$ ]] \
    && ((10#$QUEUE_MAX_DISPATCHES_PER_SECOND <= 100)) \
    || die "ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND must be an integer from 1 through 100"
  [[ "$QUEUE_MAX_CONCURRENT_DISPATCHES" =~ ^[1-9][0-9]*$ ]] \
    && ((10#$QUEUE_MAX_CONCURRENT_DISPATCHES <= 100)) \
    || die "ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES must be an integer from 1 through 100"
}

validate_iam_scope() {
  [[ "$ENQUEUER_IAM_SCOPE" == "project" || "$ENQUEUER_IAM_SCOPE" == "queue" ]] \
    || die "ANALYSIS_TASKS_IAM_SCOPE must be project or queue"
}

validate_exact_iam_mode() {
  [[ "$EXACT_IAM" == "true" || "$EXACT_IAM" == "false" ]] \
    || die "ANALYSIS_TASKS_EXACT_IAM must be true or false"
  [[ "$RUNTIME_QUEUE_ACCESS" == "none" || "$RUNTIME_QUEUE_ACCESS" == "enqueue-view" ]] \
    || die "ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS must be none or enqueue-view"
  if [[ "$EXACT_IAM" == "true" ]]; then
    [[ "$ENQUEUER_IAM_SCOPE" == "queue" ]] \
      || die "exact task IAM requires ANALYSIS_TASKS_IAM_SCOPE=queue"
    required_env ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL
    validate_service_account_email \
      "$ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
      "ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
    [[ "$(service_account_project "$ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
      == "$ANALYSIS_TASKS_PROJECT" ]] \
      || die "runtime service account must belong to ANALYSIS_TASKS_PROJECT"
  fi
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

reject_project_binding() {
  local role="$1"
  local member="$2"
  local description="$3"
  local bindings
  bindings="$(gcloud projects get-iam-policy "$ANALYSIS_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=$role AND bindings.members=$member" \
    '--format=csv[no-heading](bindings.role,bindings.members)')"
  grep -Fq "${role},${member}" <<<"$bindings" || return 0
  die "forbidden project-wide IAM binding: $description"
}

queue_binding_exists() {
  local role="$1"
  local member="$2"
  local policy
  policy="$(gcloud tasks queues get-iam-policy "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    --format=json)"
  jq -e \
    --arg role "$role" \
    --arg member "$member" '
      any(.bindings[]?;
        .role == $role
        and (.condition? == null)
        and any(.members[]?; . == $member))' \
    <<<"$policy" >/dev/null
}

ensure_queue_binding() {
  local role="$1"
  local member="$2"
  local description="$3"
  if queue_binding_exists "$role" "$member"; then
    log "verified: $description"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "missing queue IAM binding: $description"
  run_mutation gcloud tasks queues add-iam-policy-binding \
    "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    "--member=$member" \
    "--role=$role" \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    queue_binding_exists "$role" "$member" \
      || die "queue IAM binding was not observable after setup: $description"
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

cloud_run_invoker_binding_exists() {
  local member="$1"
  local bindings
  bindings="$(gcloud run services get-iam-policy \
    "$ANALYSIS_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--region=$ANALYSIS_TASKS_CLOUD_RUN_REGION" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=roles/run.invoker AND bindings.members=$member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "roles/run.invoker,${member}," <<<"$bindings"
}

ensure_cloud_run_invoker_binding() {
  local member="$1"
  if cloud_run_invoker_binding_exists "$member"; then
    log "verified: task identity can invoke the private Cloud Run worker"
    return 0
  fi

  [[ "$mode" != "check" ]] \
    || die "missing IAM binding: task identity cannot invoke the private Cloud Run worker"
  run_mutation gcloud run services add-iam-policy-binding \
    "$ANALYSIS_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--region=$ANALYSIS_TASKS_CLOUD_RUN_REGION" \
    "--member=$member" \
    '--role=roles/run.invoker' \
    '--condition=None' \
    '--quiet'

  if [[ "$mode" == "apply" ]]; then
    cloud_run_invoker_binding_exists "$member" \
      || die "Cloud Run invoker binding was not observable after setup"
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
  [[ "$policy" == "${QUEUE_MAX_DISPATCHES_PER_SECOND}.0,${QUEUE_MAX_CONCURRENT_DISPATCHES},8,$QUEUE_MAX_RETRY_DURATION,40s,300s,4" \
    || "$policy" == "${QUEUE_MAX_DISPATCHES_PER_SECOND},${QUEUE_MAX_CONCURRENT_DISPATCHES},8,$QUEUE_MAX_RETRY_DURATION,40s,300s,4" ]]
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

ensure_queue_configuration() {
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
}

task_identity_policy() {
  gcloud iam service-accounts get-iam-policy \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    --format=json
}

queue_iam_policy() {
  gcloud tasks queues get-iam-policy "$ANALYSIS_TASKS_QUEUE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    --format=json
}

task_identity_policy_is_exact() {
  local policy="$1"
  jq -e \
    --arg enqueuer "$enqueuer_member" \
    --arg runtime "$runtime_member" \
    --arg service_agent "$service_agent_member" '
      ((.bindings // []) | length) == 1
        and .bindings[0].role == "roles/iam.serviceAccountUser"
        and (.bindings[0].condition? == null)
        and ((.bindings[0].members | sort)
          == ([$enqueuer, $runtime, $service_agent] | sort))
    ' <<<"$policy" >/dev/null
}

queue_iam_policy_is_exact() {
  local policy="$1"
  if [[ "$RUNTIME_QUEUE_ACCESS" == "enqueue-view" ]]; then
    jq -e \
      --arg enqueuer "$enqueuer_member" \
      --arg runtime "$runtime_member" '
        ((.bindings // []) | length) == 2
          and ([.bindings[].role] | sort) == [
            "roles/cloudtasks.enqueuer",
            "roles/cloudtasks.viewer"
          ]
          and ([.bindings[] | select(.role == "roles/cloudtasks.enqueuer")]
            | length) == 1
          and ([.bindings[] | select(.role == "roles/cloudtasks.enqueuer")][0]
            | (.condition? == null)
              and ((.members | sort) == ([$enqueuer, $runtime] | sort)))
          and ([.bindings[] | select(.role == "roles/cloudtasks.viewer")]
            | length) == 1
          and ([.bindings[] | select(.role == "roles/cloudtasks.viewer")][0]
            | (.condition? == null) and .members == [$runtime])
      ' <<<"$policy" >/dev/null
  else
    jq -e --arg enqueuer "$enqueuer_member" '
      ((.bindings // []) | length) == 1
        and .bindings[0].role == "roles/cloudtasks.enqueuer"
        and (.bindings[0].condition? == null)
        and .bindings[0].members == [$enqueuer]
    ' <<<"$policy" >/dev/null
  fi
}

iam_policy_is_empty() {
  jq -e '((.bindings // []) | length) == 0' <<<"$1" >/dev/null
}

iam_policy_files=()
written_iam_policy_file=""
write_exact_task_identity_policy() {
  local current="$1"
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/analysis-task-sa-iam.XXXXXX")"
  iam_policy_files+=("$file")
  jq \
    --arg enqueuer "$enqueuer_member" \
    --arg runtime "$runtime_member" \
    --arg service_agent "$service_agent_member" '
      .bindings = [{
        "role": "roles/iam.serviceAccountUser",
        "members": ([$enqueuer, $runtime, $service_agent] | sort)
      }]
    ' <<<"$current" >"$file"
  written_iam_policy_file="$file"
}

write_exact_queue_policy() {
  local current="$1"
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/analysis-queue-iam.XXXXXX")"
  iam_policy_files+=("$file")
  if [[ "$RUNTIME_QUEUE_ACCESS" == "enqueue-view" ]]; then
    jq --arg enqueuer "$enqueuer_member" --arg runtime "$runtime_member" '
      .bindings = [
        {
          "role": "roles/cloudtasks.enqueuer",
          "members": ([$enqueuer, $runtime] | sort)
        },
        {"role": "roles/cloudtasks.viewer", "members": [$runtime]}
      ]
    ' <<<"$current" >"$file"
  else
    jq --arg enqueuer "$enqueuer_member" '
      .bindings = [{"role": "roles/cloudtasks.enqueuer", "members": [$enqueuer]}]
    ' <<<"$current" >"$file"
  fi
  written_iam_policy_file="$file"
}

ensure_exact_task_identity_policy() {
  local policy
  local file
  if [[ "$mode" == "dry-run" && "$task_account_available" == "false" ]]; then
    log "[dry-run] task OIDC IAM will contain only V2 enqueuer, runtime, and Cloud Tasks service agent actAs"
    return 0
  fi
  policy="$(task_identity_policy)"
  if task_identity_policy_is_exact "$policy"; then
    log "verified: task OIDC identity has exact actAs principals and no token-creator role"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "task OIDC identity IAM has drifted"
  if ! iam_policy_is_empty "$policy" && [[ "$reconcile_iam" != "true" ]]; then
    die "task OIDC identity IAM has unexpected bindings; inspect or use --reconcile-iam"
  fi
  write_exact_task_identity_policy "$policy"
  file="$written_iam_policy_file"
  run_mutation gcloud iam service-accounts set-iam-policy \
    "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" "$file" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    policy="$(task_identity_policy)"
    task_identity_policy_is_exact "$policy" \
      || die "exact task OIDC identity IAM was not observable"
  fi
}

ensure_exact_queue_policy() {
  local policy
  local file
  if [[ "$mode" == "dry-run" ]] && ! queue_exists; then
    log "[dry-run] queue IAM will contain only the declared V2 queue principals"
    return 0
  fi
  policy="$(queue_iam_policy)"
  if queue_iam_policy_is_exact "$policy"; then
    log "verified: queue IAM has only the declared V2 principals and roles"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "queue IAM has drifted"
  if ! iam_policy_is_empty "$policy" && [[ "$reconcile_iam" != "true" ]]; then
    die "queue IAM has unexpected bindings; inspect or use --reconcile-iam"
  fi
  write_exact_queue_policy "$policy"
  file="$written_iam_policy_file"
  run_mutation gcloud tasks queues set-iam-policy \
    "$ANALYSIS_TASKS_QUEUE" "$file" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--location=$ANALYSIS_TASKS_LOCATION" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    policy="$(queue_iam_policy)"
    queue_iam_policy_is_exact "$policy" \
      || die "exact queue IAM was not observable"
  fi
}

verify_task_identity_is_keyless_and_project_role_free() {
  local keys
  local roles
  if [[ "$task_account_available" == "false" ]]; then
    [[ "$mode" == "dry-run" ]] || die "task OIDC identity is unavailable"
    return 0
  fi
  keys="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$keys" ]] || die "task OIDC identity has a user-managed key"
  roles="$(gcloud projects get-iam-policy "$ANALYSIS_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=$task_invoker_member" \
    '--format=value(bindings.role)')"
  [[ -z "$roles" ]] || die "task OIDC identity must have no project-wide role"
  log "verified: task OIDC identity is keyless and project-role-free"
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
    --reconcile-iam)
      reconcile_iam="true"
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
validate_queue_capacity
validate_iam_scope
validate_exact_iam_mode
validate_service_account_email \
  "$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email \
  "$ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"

if [[ -n "${ANALYSIS_TASKS_CLOUD_RUN_SERVICE:-}" \
   || -n "${ANALYSIS_TASKS_CLOUD_RUN_REGION:-}" ]]; then
  [[ -n "${ANALYSIS_TASKS_CLOUD_RUN_SERVICE:-}" \
     && -n "${ANALYSIS_TASKS_CLOUD_RUN_REGION:-}" ]] \
    || die "set both ANALYSIS_TASKS_CLOUD_RUN_SERVICE and ANALYSIS_TASKS_CLOUD_RUN_REGION"
  validate_cloud_run_service "$ANALYSIS_TASKS_CLOUD_RUN_SERVICE"
  validate_location "$ANALYSIS_TASKS_CLOUD_RUN_REGION"
fi

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
if [[ "$ENQUEUER_IAM_SCOPE" == "queue" ]]; then
  command -v jq >/dev/null 2>&1 || die "jq is required for queue-scoped IAM"
fi
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
readonly task_invoker_member="serviceAccount:$ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL"
readonly runtime_member="serviceAccount:${ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL:-unused@invalid}"

cleanup() {
  local file
  for file in "${iam_policy_files[@]:-}"; do
    [[ -z "$file" ]] || rm -f "$file"
  done
}
trap cleanup EXIT

ensure_project_binding \
  'roles/cloudtasks.serviceAgent' \
  "$service_agent_member" \
  'Cloud Tasks service agent project role'

if [[ "$EXACT_IAM" == "true" ]]; then
  verify_task_identity_is_keyless_and_project_role_free
  ensure_exact_task_identity_policy
elif [[ "$task_account_available" == "false" ]]; then
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
    '--role=roles/iam.serviceAccountUser' \
    '--condition=None' \
    '--quiet'
else
  ensure_service_account_binding \
    'roles/iam.serviceAccountUser' \
    "$enqueuer_member" \
    'runtime principal has iam.serviceAccounts.actAs on the task invoker'
  ensure_service_account_binding \
    'roles/iam.serviceAccountUser' \
    "$service_agent_member" \
    'Cloud Tasks service agent can act as the task OIDC identity'
fi

if [[ -n "${ANALYSIS_TASKS_CLOUD_RUN_SERVICE:-}" ]]; then
  gcloud run services describe "$ANALYSIS_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_TASKS_PROJECT" \
    "--region=$ANALYSIS_TASKS_CLOUD_RUN_REGION" \
    '--format=value(metadata.name)' >/dev/null \
    || die "private Cloud Run worker service does not exist or is not visible"
  if [[ "$EXACT_IAM" != "true" ]]; then
    ensure_cloud_run_invoker_binding "$task_invoker_member"
  fi
fi

ensure_queue_configuration

if [[ "$EXACT_IAM" == "true" ]]; then
  reject_project_binding \
    'roles/cloudtasks.enqueuer' \
    "$enqueuer_member" \
    'configured enqueuer can enqueue every queue in the project'
  reject_project_binding \
    'roles/cloudtasks.enqueuer' \
    "$runtime_member" \
    'runtime can enqueue every queue in the project'
  reject_project_binding \
    'roles/cloudtasks.viewer' \
    "$runtime_member" \
    'runtime can view every queue in the project'
  ensure_exact_queue_policy
elif [[ "$ENQUEUER_IAM_SCOPE" == "queue" ]]; then
  reject_project_binding \
    'roles/cloudtasks.enqueuer' \
    "$enqueuer_member" \
    'configured enqueuer can enqueue every queue in the project'
  ensure_queue_binding \
    'roles/cloudtasks.enqueuer' \
    "$enqueuer_member" \
    'runtime principal can enqueue only the configured Cloud Tasks queue'
else
  ensure_project_binding \
    'roles/cloudtasks.enqueuer' \
    "$enqueuer_member" \
    'runtime principal can enqueue Cloud Tasks'
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
