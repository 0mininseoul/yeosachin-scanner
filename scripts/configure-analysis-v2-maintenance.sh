#!/usr/bin/env bash
set -euo pipefail

readonly SCHEDULER_API="cloudscheduler.googleapis.com"
readonly RECOVERY_SCHEDULE="* * * * *"
readonly RETENTION_SCHEDULE="*/5 * * * *"
readonly TIME_ZONE="Etc/UTC"
readonly RETRY_COUNT="3"
readonly MAX_RETRY_DURATION="300s"
readonly MIN_BACKOFF="10s"
readonly MAX_BACKOFF="60s"
readonly MAX_DOUBLINGS="3"

mode="apply"
reconcile_jobs="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-maintenance.sh [--dry-run | --check] [--reconcile-jobs]

Creates or verifies two authenticated Cloud Scheduler jobs for durable V2 job
recovery and bounded preflight PII retention.

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_RECOVERY_ENABLED

Optional environment variables:
  ANALYSIS_V2_MAINTENANCE_LOCATION        Defaults to the Cloud Run region.
  ANALYSIS_V2_RECOVERY_SCHEDULER_JOB      Defaults to analysis-v2-recovery.
  ANALYSIS_V2_RETENTION_SCHEDULER_JOB     Defaults to analysis-v2-preflight-retention.

Existing job drift fails closed. Use --reconcile-jobs only after reviewing the
current job definitions and intentionally replacing them.
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
  [[ "$mode" != "check" ]] || die "configuration drift requires a change"
  "$@"
}

required_env() {
  [[ -n "${!1:-}" ]] || die "$1 is required"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid project"
}

validate_location() {
  [[ "$1" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || die "invalid scheduler location"
}

validate_service() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] || die "invalid Cloud Run service"
}

validate_job() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,198}[a-z0-9])?$ ]] || die "invalid scheduler job"
}

validate_service_account() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "invalid maintenance service account"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

api_is_enabled() {
  local enabled
  enabled="$(gcloud services list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --enabled \
    "--filter=config.name=$SCHEDULER_API" \
    '--format=value(config.name)')"
  [[ "$enabled" == "$SCHEDULER_API" ]]
}

ensure_api() {
  if api_is_enabled; then
    log "verified: $SCHEDULER_API is enabled"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "$SCHEDULER_API is not enabled"
  run_mutation gcloud services enable "$SCHEDULER_API" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --quiet
}

service_json() {
  gcloud run services describe "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json
}

verify_maintenance_identity() {
  local config
  local keys
  local roles
  config="$(gcloud iam service-accounts describe \
    "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json)" || die "maintenance service account does not exist"
  jq -e --arg email "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    '(.email // "") == $email and (.disabled // false) == false' \
    <<<"$config" >/dev/null || die "maintenance service account is disabled or invalid"
  keys="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$keys" ]] || die "maintenance service account has a user-managed key"
  roles="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=serviceAccount:$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    '--format=value(bindings.role)')"
  [[ -z "$roles" ]] || die "maintenance service account must have no project-wide role"
}

verify_run_invoker() {
  local policy
  policy="$(gcloud run services get-iam-policy \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json)"
  jq -e --arg member "serviceAccount:$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" '
    any(.bindings[]?;
      .role == "roles/run.invoker"
      and (.condition? == null)
      and any(.members[]?; . == $member))
  ' <<<"$policy" >/dev/null \
    || die "maintenance identity cannot invoke the private Cloud Run worker"
}

job_json() {
  local job="$1"
  gcloud scheduler jobs describe "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$maintenance_location" \
    --format=json 2>/dev/null
}

job_is_exact() {
  local config="$1"
  local schedule="$2"
  local uri="$3"
  local deadline="$4"
  jq -e \
    --arg schedule "$schedule" \
    --arg uri "$uri" \
    --arg audience "$service_origin" \
    --arg service_account "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    --arg deadline "$deadline" '
      .schedule == $schedule
        and .timeZone == "Etc/UTC"
        and .httpTarget.uri == $uri
        and .httpTarget.httpMethod == "POST"
        and .httpTarget.oidcToken.serviceAccountEmail == $service_account
        and .httpTarget.oidcToken.audience == $audience
        and (.httpTarget.headers["Content-Type"] // "") == "application/json"
        and (.httpTarget.body // "") == "e30="
        and .attemptDeadline == $deadline
        and ((.retryConfig.retryCount // 0) | tonumber) == 3
        and .retryConfig.maxRetryDuration == "300s"
        and .retryConfig.minBackoffDuration == "10s"
        and .retryConfig.maxBackoffDuration == "60s"
        and ((.retryConfig.maxDoublings // 0) | tonumber) == 3
    ' <<<"$config" >/dev/null
}

job_state_is_exact() {
  local config="$1"
  local desired_state="$2"
  jq -e --arg desired_state "$desired_state" \
    '(.state // "ENABLED") == $desired_state' \
    <<<"$config" >/dev/null
}

ensure_job_state() {
  local job="$1"
  local desired_state="$2"
  local config="$3"
  local action
  local current_state
  if job_state_is_exact "$config" "$desired_state"; then
    log "verified: scheduler job state is exact: $job ($desired_state)"
    return 0
  fi

  current_state="$(jq -r '.state // "ENABLED"' <<<"$config")"
  if [[ "$current_state" == "PAUSED" && "$desired_state" == "ENABLED" ]]; then
    action="resume"
  elif [[ "$current_state" == "ENABLED" && "$desired_state" == "PAUSED" ]]; then
    action="pause"
  else
    die "scheduler job has an unsupported state transition: $job ($current_state -> $desired_state)"
  fi
  [[ "$mode" != "check" ]] \
    || die "scheduler job state has drifted: $job ($desired_state required)"
  run_mutation gcloud scheduler jobs "$action" "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$maintenance_location" \
    --quiet
}

job_args() {
  local job="$1"
  local schedule="$2"
  local uri="$3"
  local deadline="$4"
  local operation="$5"
  local headers_arg='--headers=Content-Type=application/json'
  [[ "$operation" == "create" || "$operation" == "update" ]] \
    || die "invalid Scheduler mutation operation"
  if [[ "$operation" == "update" ]]; then
    headers_arg='--update-headers=Content-Type=application/json'
  fi
  scheduler_args=(
    "$job"
    "--project=$ANALYSIS_V2_TASKS_PROJECT"
    "--location=$maintenance_location"
    "--schedule=$schedule"
    "--time-zone=$TIME_ZONE"
    "--uri=$uri"
    '--http-method=POST'
    "$headers_arg"
    '--message-body={}'
    "--oidc-service-account-email=$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
    "--oidc-token-audience=$service_origin"
    "--attempt-deadline=$deadline"
    "--max-retry-attempts=$RETRY_COUNT"
    "--max-retry-duration=$MAX_RETRY_DURATION"
    "--min-backoff=$MIN_BACKOFF"
    "--max-backoff=$MAX_BACKOFF"
    "--max-doublings=$MAX_DOUBLINGS"
    --quiet
  )
}

ensure_job() {
  local job="$1"
  local schedule="$2"
  local uri="$3"
  local deadline="$4"
  local desired_state="$5"
  local config
  if config="$(job_json "$job")"; then
    if ! job_is_exact "$config" "$schedule" "$uri" "$deadline"; then
      if [[ "$mode" == "apply" ]] \
        && ! job_state_is_exact "$config" "PAUSED"; then
        ensure_job_state "$job" "PAUSED" "$config"
        config="$(job_json "$job")" \
          || die "scheduler job disappeared after the safety pause: $job"
        job_state_is_exact "$config" "PAUSED" \
          || die "scheduler job safety pause was not observable: $job"
        log "safety pause applied before reporting scheduler configuration drift: $job"
      fi
      [[ "$mode" != "check" ]] || die "scheduler job has drifted: $job"
      [[ "$reconcile_jobs" == "true" ]] \
        || die "scheduler job has drifted; inspect or use --reconcile-jobs: $job"
      job_args "$job" "$schedule" "$uri" "$deadline" update
      run_mutation gcloud scheduler jobs update http "${scheduler_args[@]}"
      if [[ "$mode" == "apply" ]]; then
        config="$(job_json "$job")" || die "scheduler job was not observable: $job"
      fi
    else
      log "verified: scheduler job configuration is exact: $job"
    fi
  else
    [[ "$mode" != "check" ]] || die "scheduler job does not exist: $job"
    job_args "$job" "$schedule" "$uri" "$deadline" create
    run_mutation gcloud scheduler jobs create http "${scheduler_args[@]}"
    if [[ "$mode" == "apply" ]]; then
      config="$(job_json "$job")" || die "scheduler job was not observable: $job"
    else
      config='{"state":"ENABLED"}'
    fi
  fi

  ensure_job_state "$job" "$desired_state" "$config"
  if [[ "$mode" == "apply" ]]; then
    config="$(job_json "$job")" || die "scheduler job was not observable: $job"
    job_is_exact "$config" "$schedule" "$uri" "$deadline" \
      || die "scheduler job configuration is not exact: $job"
    job_state_is_exact "$config" "$desired_state" \
      || die "scheduler job state is not exact: $job ($desired_state required)"
  fi
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      [[ "$mode" == "apply" ]] || die "choose only one mode"
      mode="dry-run"
      ;;
    --check)
      [[ "$mode" == "apply" ]] || die "choose only one mode"
      mode="check"
      ;;
    --reconcile-jobs)
      reconcile_jobs="true"
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
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION \
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_RECOVERY_ENABLED; do
  required_env "$name"
done

readonly maintenance_location="${ANALYSIS_V2_MAINTENANCE_LOCATION:-$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION}"
readonly recovery_job="${ANALYSIS_V2_RECOVERY_SCHEDULER_JOB:-analysis-v2-recovery}"
readonly retention_job="${ANALYSIS_V2_RETENTION_SCHEDULER_JOB:-analysis-v2-preflight-retention}"
validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_location "$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
validate_location "$maintenance_location"
validate_service "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
validate_service_account "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
validate_job "$recovery_job"
validate_job "$retention_job"
[[ "$recovery_job" != "$retention_job" ]] || die "maintenance job names must be distinct"
[[ "$ANALYSIS_V2_RECOVERY_ENABLED" == "true" \
  || "$ANALYSIS_V2_RECOVERY_ENABLED" == "false" ]] \
  || die "ANALYSIS_V2_RECOVERY_ENABLED must be true or false"
[[ "$(service_account_project "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] || die "maintenance identity belongs to another project"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"

service_config="$(service_json)" || die "Cloud Run worker does not exist"
readonly service_origin="$(jq -er '.status.url // .status.address.url' <<<"$service_config")"
[[ "$service_origin" =~ ^https://[a-z0-9.-]+$ ]] || die "Cloud Run worker URL is invalid"

verify_maintenance_identity
verify_run_invoker
ensure_api
if [[ "$ANALYSIS_V2_RECOVERY_ENABLED" == "true" ]]; then
  readonly recovery_job_state="ENABLED"
else
  readonly recovery_job_state="PAUSED"
fi
ensure_job "$recovery_job" "$RECOVERY_SCHEDULE" \
  "$service_origin/api/analysis/v2/recover" "300s" "$recovery_job_state"
ensure_job "$retention_job" "$RETENTION_SCHEDULE" \
  "$service_origin/api/analysis/preflight/retention" "60s" "ENABLED"

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 recovery and preflight retention schedulers verified"
fi
