#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_REGION="asia-northeast3"
readonly REQUIRED_SERVICE="instagram-auth-worker"
readonly DEFAULT_SESSION_SECRET_ID="instagram-auth-session-settings"
readonly DEFAULT_TIMEOUT_SECONDS="300"
readonly DEFAULT_CONCURRENCY="5"
readonly DEFAULT_MAX_INSTANCES="1"
readonly DEFAULT_MIN_INSTANCES="1"

mode="apply"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-instagram-auth-worker.sh [--dry-run]

Source-deploys the private, single-instance Instagram authenticated worker.
It never reads or prints Secret Manager payloads. Session settings are supplied
only as a pinned Secret Manager reference.

Required environment variables:
  INSTAGRAM_AUTH_WORKER_PROJECT
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION
  INSTAGRAM_AUTH_WORKER_NETWORK
  INSTAGRAM_AUTH_WORKER_SUBNET

Optional environment variables:
  INSTAGRAM_AUTH_WORKER_REGION                 Defaults to asia-northeast3; fixed.
  INSTAGRAM_AUTH_WORKER_SERVICE                Defaults to instagram-auth-worker; fixed.
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID      Defaults to instagram-auth-session-settings.

The service always has exactly one warm instance, request concurrency 5, a
300-second timeout, and unauthenticated access disabled. The caller runtime service
account is granted roles/run.invoker on this service.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_PROJECT is invalid"
}

validate_service_account_email() {
  local email="$1"
  local label="$2"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "$label is invalid"
}

validate_secret_id() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID is invalid"
}

validate_secret_version() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION must be a positive numeric Secret Manager version"
}

validate_network_name() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] \
    || die "$label is invalid"
}

print_command() {
  local argument
  printf '[dry-run]'
  for argument in "$@"; do
    printf ' %q' "$argument"
  done
  printf '\n'
}

run_mutation() {
  if [[ "$mode" == "dry-run" ]]; then
    print_command "$@"
    return 0
  fi
  "$@"
}

while (($# > 0)); do
  case "$1" in
    --dry-run) mode="dry-run" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

required_env INSTAGRAM_AUTH_WORKER_PROJECT
required_env INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
required_env INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL
required_env INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION
required_env INSTAGRAM_AUTH_WORKER_NETWORK
required_env INSTAGRAM_AUTH_WORKER_SUBNET

project="$INSTAGRAM_AUTH_WORKER_PROJECT"
region="${INSTAGRAM_AUTH_WORKER_REGION:-$REQUIRED_REGION}"
service="${INSTAGRAM_AUTH_WORKER_SERVICE:-$REQUIRED_SERVICE}"
runtime_service_account="$INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
caller_service_account="$INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL"
session_secret_id="${INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID:-$DEFAULT_SESSION_SECRET_ID}"
session_secret_version="$INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION"
network="$INSTAGRAM_AUTH_WORKER_NETWORK"
subnet="$INSTAGRAM_AUTH_WORKER_SUBNET"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_dir/services/instagram-auth-worker"

validate_project "$project"
[[ "$region" == "$REQUIRED_REGION" ]] \
  || die "INSTAGRAM_AUTH_WORKER_REGION must be $REQUIRED_REGION"
[[ "$service" == "$REQUIRED_SERVICE" ]] \
  || die "INSTAGRAM_AUTH_WORKER_SERVICE must remain $REQUIRED_SERVICE"
validate_service_account_email "$runtime_service_account" \
  "INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$caller_service_account" \
  "INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL"
validate_secret_id "$session_secret_id"
validate_secret_version "$session_secret_version"
validate_network_name "$network" "INSTAGRAM_AUTH_WORKER_NETWORK"
validate_network_name "$subnet" "INSTAGRAM_AUTH_WORKER_SUBNET"
[[ -f "$source_dir/requirements.txt" && -f "$source_dir/app/main.py" ]] \
  || die "instagram authenticated worker source is incomplete"

run_mutation gcloud run deploy "$service" \
  "--project=$project" \
  "--region=$region" \
  "--source=$source_dir" \
  "--service-account=$runtime_service_account" \
  "--port=8080" \
  "--command=uvicorn" \
  "--args=app.main:app,--host=0.0.0.0,--port=8080" \
  "--concurrency=$DEFAULT_CONCURRENCY" \
  "--max-instances=$DEFAULT_MAX_INSTANCES" \
  "--min-instances=$DEFAULT_MIN_INSTANCES" \
  "--timeout=${DEFAULT_TIMEOUT_SECONDS}s" \
  "--no-allow-unauthenticated" \
  "--network=$network" \
  "--subnet=$subnet" \
  "--vpc-egress=all-traffic" \
  "--set-env-vars=IG_MAX_IN_FLIGHT=5,IG_QUEUE_TIMEOUT_SECONDS=240,IG_RATE_LIMIT_COOLDOWN_SECONDS=900" \
  "--set-secrets=IG_SESSION_SETTINGS_BASE64=$session_secret_id:$session_secret_version" \
  --quiet

run_mutation gcloud run services add-iam-policy-binding "$service" \
  "--project=$project" \
  "--region=$region" \
  "--member=serviceAccount:$caller_service_account" \
  "--role=roles/run.invoker" \
  --quiet

printf 'configured private authenticated Instagram worker service %s\n' "$service"
