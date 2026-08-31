#!/usr/bin/env bash
set -euo pipefail

# Role-scoped maintenance for ordinary preflight and B-lite capacity-dispatch
# recovery.  This is intentionally separate from the paid V2 scheduler so a
# maintenance identity never needs access to both worker queues/services.
readonly RECOVERY_SCHEDULE="* * * * *"
readonly TIME_ZONE="Etc/UTC"
readonly RETRY_COUNT="3"
readonly MAX_RETRY_DURATION="300s"
readonly MIN_BACKOFF="10s"
readonly MAX_BACKOFF="60s"
readonly MAX_DOUBLINGS="3"
readonly RECOVERY_PATH="/api/analysis/preflight/recover"

mode="check"
mode_was_explicit="false"
reconcile_iam="false"
reconcile_jobs="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-preflight-maintenance.sh [--dry-run | --check | --apply]
       [--reconcile-iam] [--reconcile-jobs]

Verifies or configures the authenticated preflight capacity-recovery scheduler.
The default is read-only --check.  Both reconciliations require an explicit
--apply.  The scheduler OIDC identity is role-scoped and invokes only the
preflight recovery route.

Required environment variables:
  PREFLIGHT_TASKS_PROJECT, PREFLIGHT_TASKS_CLOUD_RUN_SERVICE,
  PREFLIGHT_TASKS_CLOUD_RUN_REGION, PREFLIGHT_TASKS_TARGET_URL,
  PREFLIGHT_TASKS_OIDC_AUDIENCE, PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL,
  PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL,
  PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE,
  PREFLIGHT_TASKS_RECOVERY_ENABLED

Optional:
  PREFLIGHT_TASKS_MAINTENANCE_LOCATION (defaults to Cloud Run region)
  PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB (defaults to analysis-preflight-recovery)
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
  [[ "$mode" == "apply" ]] || die "configuration drift requires --apply"
  "$@"
}

required_env() {
  [[ -n "${!1:-}" ]] || die "$1 is required"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid project"
}

validate_location() {
  [[ "$1" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || die "invalid location"
}

validate_service() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] || die "invalid Cloud Run service"
}

validate_job() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,198}[a-z0-9])?$ ]] || die "invalid Scheduler job"
}

validate_service_account() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "invalid service account"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

service_json() {
  gcloud run services describe "$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$PREFLIGHT_TASKS_PROJECT" \
    "--region=$PREFLIGHT_TASKS_CLOUD_RUN_REGION" \
    '--format=json'
}

service_origin_from_json() {
  jq -r '(.status.url // .status.uri // .status.address.url // empty)' <<<"$1"
}

service_iam_json() {
  gcloud run services get-iam-policy "$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$PREFLIGHT_TASKS_PROJECT" \
    "--region=$PREFLIGHT_TASKS_CLOUD_RUN_REGION" \
    '--format=json'
}

verify_maintenance_identity() {
  local config keys roles
  config="$(gcloud iam service-accounts describe \
    "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    "--project=$PREFLIGHT_TASKS_PROJECT" '--format=json')" \
    || die "preflight maintenance service account does not exist"
  jq -e --arg email "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    '(.email // "") == $email and (.disabled // false) == false' \
    <<<"$config" >/dev/null \
    || die "preflight maintenance service account is disabled or invalid"
  keys="$(gcloud iam service-accounts keys list \
    "--iam-account=$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    "--project=$PREFLIGHT_TASKS_PROJECT" --managed-by=user '--format=value(name)')"
  [[ -z "$keys" ]] || die "preflight maintenance service account has a user-managed key"
  roles="$(gcloud projects get-iam-policy "$PREFLIGHT_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=serviceAccount:$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    '--format=value(bindings.role)')"
  [[ -z "$roles" ]] || die "preflight maintenance service account must have no project-wide role"
}

verify_invoker_policy() {
  local policy="$1"
  jq -e \
    --arg task "serviceAccount:$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL" \
    --arg maintenance "serviceAccount:$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" '
      ([.bindings[]? | select(.role == "roles/run.invoker")] as $rows
        | ($rows | length) == 1
        and ($rows[0].condition? == null)
        and (($rows[0].members | sort) == ([$task, $maintenance] | sort))
        and ([$rows[].members[]?]
          | all(. != "allUsers" and . != "allAuthenticatedUsers")))
    ' <<<"$policy" >/dev/null
}

write_exact_invoker_policy() {
  local current="$1"
  local file
  file="$(mktemp "${TMPDIR:-/tmp}/analysis-preflight-maintenance-iam.XXXXXX")"
  iam_policy_file="$file"
  jq \
    --arg task "serviceAccount:$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL" \
    --arg maintenance "serviceAccount:$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" '
      .bindings = ((.bindings // [])
        | map(select(.role != "roles/run.invoker"))
        + [{"role": "roles/run.invoker", "members": [$task, $maintenance]}])
    ' <<<"$current" >"$file"
}

job_json() {
  gcloud scheduler jobs describe "$PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB" \
    "--project=$PREFLIGHT_TASKS_PROJECT" \
    "--location=$maintenance_location" '--format=json' 2>/dev/null
}

job_is_exact() {
  local config="$1"
  jq -e \
    --arg uri "$recovery_uri" \
    --arg audience "$maintenance_audience" \
    --arg service_account "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" '
      .schedule == "* * * * *"
        and .timeZone == "Etc/UTC"
        and .httpTarget.uri == $uri
        and .httpTarget.httpMethod == "POST"
        and .httpTarget.oidcToken.serviceAccountEmail == $service_account
        and .httpTarget.oidcToken.audience == $audience
        and (.httpTarget.headers["Content-Type"] // "") == "application/json"
        and (.httpTarget.body // "") == "e30="
        and .attemptDeadline == "300s"
        and ((.retryConfig.retryCount // 0) | tonumber) == 3
        and .retryConfig.maxRetryDuration == "300s"
        and .retryConfig.minBackoffDuration == "10s"
        and .retryConfig.maxBackoffDuration == "60s"
        and ((.retryConfig.maxDoublings // 0) | tonumber) == 3
    ' <<<"$config" >/dev/null
}

job_state_is_exact() {
  jq -e --arg desired "$recovery_job_state" \
    '(.state // "ENABLED") == $desired' <<<"$1" >/dev/null
}

job_args() {
  local operation="$1"
  local headers='--headers=Content-Type=application/json'
  [[ "$operation" == "create" || "$operation" == "update" ]] || die "invalid scheduler operation"
  [[ "$operation" == "update" ]] && headers='--update-headers=Content-Type=application/json'
  scheduler_args=(
    "$PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB"
    "--project=$PREFLIGHT_TASKS_PROJECT"
    "--location=$maintenance_location"
    "--schedule=$RECOVERY_SCHEDULE"
    "--time-zone=$TIME_ZONE"
    "--uri=$recovery_uri"
    '--http-method=POST'
    "$headers"
    '--message-body={}'
    "--oidc-service-account-email=$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
    "--oidc-token-audience=$maintenance_audience"
    '--attempt-deadline=300s'
    "--max-retry-attempts=$RETRY_COUNT"
    "--max-retry-duration=$MAX_RETRY_DURATION"
    "--min-backoff=$MIN_BACKOFF"
    "--max-backoff=$MAX_BACKOFF"
    "--max-doublings=$MAX_DOUBLINGS"
    --quiet
  )
}

ensure_job_state() {
  local config="$1"
  if job_state_is_exact "$config"; then
    return 0
  fi
  local current_state action
  current_state="$(jq -r '.state // "ENABLED"' <<<"$config")"
  if [[ "$current_state" == "PAUSED" && "$recovery_job_state" == "ENABLED" ]]; then
    action=resume
  elif [[ "$current_state" == "ENABLED" && "$recovery_job_state" == "PAUSED" ]]; then
    action=pause
  else
    die "unsupported scheduler state transition: $current_state -> $recovery_job_state"
  fi
  [[ "$mode" == "check" ]] && die "scheduler job state has drifted"
  run_mutation gcloud scheduler jobs "$action" "$PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB" \
    "--project=$PREFLIGHT_TASKS_PROJECT" "--location=$maintenance_location" --quiet
}

ensure_job() {
  local config
  if config="$(job_json)"; then
    if ! job_is_exact "$config"; then
      if [[ "$mode" == "check" ]]; then
        die "preflight recovery scheduler job has drifted"
      fi
      [[ "$reconcile_jobs" == "true" ]] || die "scheduler job drift requires --reconcile-jobs"
      job_args update
      run_mutation gcloud scheduler jobs update http "${scheduler_args[@]}"
      [[ "$mode" == "apply" ]] && config="$(job_json)" || config='{"state":"ENABLED"}'
    fi
  else
    [[ "$mode" == "check" ]] && die "preflight recovery scheduler job does not exist"
    job_args create
    run_mutation gcloud scheduler jobs create http "${scheduler_args[@]}"
    [[ "$mode" == "apply" ]] && config="$(job_json)" || config='{"state":"ENABLED"}'
  fi
  ensure_job_state "$config"
  if [[ "$mode" == "apply" ]]; then
    config="$(job_json)" || die "scheduler job was not observable after apply"
    job_is_exact "$config" || die "scheduler job configuration was not observable after apply"
    job_state_is_exact "$config" || die "scheduler job state was not observable after apply"
  fi
}

while (($# > 0)); do
  case "$1" in
    --dry-run|--check|--apply)
      [[ "$mode_was_explicit" == "false" ]] || die "choose exactly one of --dry-run, --check, or --apply"
      mode="${1#--}"
      mode_was_explicit="true"
      ;;
    --reconcile-iam)
      reconcile_iam="true"
      ;;
    --reconcile-jobs)
      reconcile_jobs="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ "$reconcile_iam" != "true" || ("$mode" == "apply" && "$mode_was_explicit" == "true") ]] \
  || die "--reconcile-iam requires explicit --apply"
[[ "$reconcile_jobs" != "true" || ("$mode" == "apply" && "$mode_was_explicit" == "true") ]] \
  || die "--reconcile-jobs requires explicit --apply"

for name in \
  PREFLIGHT_TASKS_PROJECT \
  PREFLIGHT_TASKS_CLOUD_RUN_SERVICE \
  PREFLIGHT_TASKS_CLOUD_RUN_REGION \
  PREFLIGHT_TASKS_TARGET_URL \
  PREFLIGHT_TASKS_OIDC_AUDIENCE \
  PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL \
  PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL \
  PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE \
  PREFLIGHT_TASKS_RECOVERY_ENABLED; do
  required_env "$name"
done

readonly maintenance_location="${PREFLIGHT_TASKS_MAINTENANCE_LOCATION:-$PREFLIGHT_TASKS_CLOUD_RUN_REGION}"
readonly recovery_job_state="$([[ "$PREFLIGHT_TASKS_RECOVERY_ENABLED" == "true" ]] && printf ENABLED || printf PAUSED)"
readonly maintenance_audience="${PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE%/}"
validate_project "$PREFLIGHT_TASKS_PROJECT"
validate_location "$PREFLIGHT_TASKS_CLOUD_RUN_REGION"
validate_location "$maintenance_location"
validate_service "$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE"
validate_service_account "$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
validate_job "${PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB:-analysis-preflight-recovery}"
readonly PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB="${PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB:-analysis-preflight-recovery}"
[[ "$PREFLIGHT_TASKS_RECOVERY_ENABLED" == "true" || "$PREFLIGHT_TASKS_RECOVERY_ENABLED" == "false" ]] \
  || die "PREFLIGHT_TASKS_RECOVERY_ENABLED must be true or false"
[[ "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" != "$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL" ]] \
  || die "preflight maintenance and task identities must be distinct"
[[ "$(service_account_project "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL")" == "$PREFLIGHT_TASKS_PROJECT" ]] \
  || die "preflight maintenance identity belongs to another project"
[[ "$PREFLIGHT_TASKS_TARGET_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/api/analysis/preflight/worker$ ]] \
  || die "PREFLIGHT_TASKS_TARGET_URL must be the exact preflight worker endpoint"
preflight_origin="${PREFLIGHT_TASKS_TARGET_URL%/api/analysis/preflight/worker}"
readonly recovery_uri="${preflight_origin%/}$RECOVERY_PATH"
[[ "$PREFLIGHT_TASKS_OIDC_AUDIENCE" == "$preflight_origin" || "$PREFLIGHT_TASKS_OIDC_AUDIENCE" == "$preflight_origin/" ]] \
  || die "PREFLIGHT_TASKS_OIDC_AUDIENCE must equal the preflight origin"
[[ "$maintenance_audience" == "${preflight_origin%/}" ]] \
  || die "PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE must equal the preflight origin"
[[ "$recovery_uri" == "$preflight_origin$RECOVERY_PATH" ]] \
  || die "preflight recovery URI is not derived from the worker origin"

iam_policy_file=""
cleanup() {
  [[ -z "${iam_policy_file:-}" ]] || rm -f -- "$iam_policy_file"
}
trap cleanup EXIT

if [[ "$mode" == "dry-run" ]]; then
  job_args create
  print_command gcloud scheduler jobs create http "${scheduler_args[@]}"
  printf 'plan: preflight recovery service=%s uri=%s audience=%s task=%s maintenance=%s state=%s\n' \
    "$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE" "$recovery_uri" "$maintenance_audience" \
    "$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "$PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" "$recovery_job_state"
  printf 'dry-run complete: no remote service, IAM, API, or scheduler state was observed or changed\n'
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"

service_config="$(service_json)" || die "preflight Cloud Run service does not exist"
observed_origin="$(service_origin_from_json "$service_config")"
[[ "$observed_origin" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "Cloud Run service URL is invalid"
[[ "${observed_origin%/}" == "${preflight_origin%/}" ]] \
  || die "Cloud Run canonical URL does not match the preflight target origin"
service_iam="$(service_iam_json)" || die "preflight Cloud Run IAM could not be observed"
if ! verify_invoker_policy "$service_iam"; then
  if [[ "$reconcile_iam" == "true" ]]; then
    write_exact_invoker_policy "$service_iam"
    run_mutation gcloud run services set-iam-policy \
      "$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE" "$iam_policy_file" \
      "--project=$PREFLIGHT_TASKS_PROJECT" "--region=$PREFLIGHT_TASKS_CLOUD_RUN_REGION" --quiet
    service_iam="$(service_iam_json)" || die "preflight Cloud Run IAM disappeared after reconcile"
    verify_invoker_policy "$service_iam" \
      || die "preflight Cloud Run invoker policy was not observable after reconcile"
  else
    die "preflight Cloud Run invoker IAM drifted; use --apply --reconcile-iam after review"
  fi
fi
verify_maintenance_identity

api_enabled="$(gcloud services list --project="$PREFLIGHT_TASKS_PROJECT" --enabled \
  '--filter=config.name=cloudscheduler.googleapis.com' '--format=value(config.name)')"
if [[ "$api_enabled" != "cloudscheduler.googleapis.com" ]]; then
  [[ "$mode" == "apply" ]] || die "cloudscheduler.googleapis.com is not enabled"
  run_mutation gcloud services enable cloudscheduler.googleapis.com \
    "--project=$PREFLIGHT_TASKS_PROJECT" --quiet
fi
ensure_job
log "verified: preflight maintenance identity, private invoker, and recovery scheduler"
