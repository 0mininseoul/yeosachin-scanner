#!/usr/bin/env bash
set -euo pipefail

readonly IAM_API="iam.googleapis.com"
readonly VERTEX_AI_API="aiplatform.googleapis.com"
readonly VERTEX_RUNTIME_ROLE="roles/aiplatform.user"
readonly BUILD_RUNTIME_ROLE="roles/run.builder"

mode="apply"
reconcile_iam="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-worker-identity.sh [--dry-run | --check] [--reconcile-iam]

Creates or verifies the keyless Analysis V2 Cloud Run runtime identity and its
least-privilege Vertex AI project role.

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER
  ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL

The deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL alias remains
accepted during migration. If both names are set, they must match exactly.

Run the launch infrastructure in this order:
  1. scripts/configure-analysis-v2-worker-identity.sh
  2. scripts/configure-analysis-v2-secrets.sh
  3. scripts/configure-analysis-v2-media-bucket.sh
  4. scripts/deploy-analysis-v2-worker.sh

The runtime identity receives roles/aiplatform.user. Any other Vertex AI role,
roles/owner, roles/editor, project-level roles/storage.*, or project-level
roles/secretmanager.* binding is rejected. Secret access is resource-scoped.
The dedicated build identity receives only roles/run.builder, and the active
operator receives resource-scoped actAs on that build identity. Queue-scoped
Cloud Tasks recovery roles may be added later by worker deployment. This script
never creates, downloads, or prints a service-account credential key.

Options:
  --dry-run  Run read-only checks and print required mutations.
  --check    Verify the complete identity configuration without changing it.
  --reconcile-iam
             Replace drifted resource IAM with the exact declared policy. Without
             this explicit opt-in, existing unexpected IAM fails closed.
  -h, --help Show this help.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

normalize_worker_runtime_identity() {
  local canonical="${ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL:-}"
  local legacy="${ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL:-}"
  if [[ -n "$canonical" && -n "$legacy" && "$canonical" != "$legacy" ]]; then
    die "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL and deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL must match when both are set"
  fi
  export ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL="${canonical:-$legacy}"
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
  [[ "$mode" != "check" ]] \
    || die "configuration drift requires a change; rerun without --check"
  "$@"
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || die "ANALYSIS_V2_TASKS_PROJECT is invalid"
}

validate_service_account_email() {
  local email="$1"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "service account email is invalid: $email"
}

validate_deployer_member() {
  [[ "$1" =~ ^(user:[^[:space:],]+@[^[:space:],]+|serviceAccount:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com)$ ]] \
    || die "ANALYSIS_V2_DEPLOYER_IAM_MEMBER must be one user: or serviceAccount: member"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

service_account_id() {
  printf '%s\n' "${1%%@*}"
}

api_is_enabled() {
  local api="$1"
  local enabled
  enabled="$(gcloud services list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --enabled \
    "--filter=config.name=$api" \
    '--format=value(config.name)')"
  [[ "$enabled" == "$api" ]]
}

ensure_api() {
  local api="$1"
  if api_is_enabled "$api"; then
    log "verified: $api is enabled"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "$api is not enabled"
  run_mutation gcloud services enable "$api" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    api_is_enabled "$api" || die "$api enablement was not observable"
  fi
}

service_account_json() {
  gcloud iam service-accounts describe \
    "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

service_account_is_enabled() {
  local config="$1"
  jq -e \
    --arg email "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    '(.email // "") == $email and (.disabled // false) == false' \
    <<<"$config" >/dev/null
}

identity_available="false"
ensure_service_account() {
  local config
  if config="$(service_account_json)"; then
    service_account_is_enabled "$config" \
      || die "worker runtime service account is disabled or does not match the configured identity"
    identity_available="true"
    log "verified: keyless worker runtime service account exists and is enabled"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "worker runtime service account does not exist"
  run_mutation gcloud iam service-accounts create \
    "$(service_account_id "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--display-name=AI Baram Analysis V2 worker' \
    '--description=Keyless Cloud Run runtime identity for the durable Analysis V2 pipeline' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    config="$(service_account_json)" \
      || die "worker runtime service account creation was not observable"
    service_account_is_enabled "$config" \
      || die "new worker runtime service account is disabled or invalid"
    identity_available="true"
  else
    log "[dry-run] the new runtime identity will be created without credential keys"
  fi
}

verify_no_user_managed_keys() {
  if [[ "$identity_available" != "true" ]]; then
    [[ "$mode" == "dry-run" ]] \
      || die "worker runtime service account is unavailable for key verification"
    return 0
  fi

  local key_names
  key_names="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$key_names" ]] \
    || die "worker runtime service account has a user-managed credential key; remove it before launch"
  log "verified: worker runtime service account has no user-managed credential keys"
}

build_service_account_json() {
  gcloud iam service-accounts describe \
    "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

build_service_account_is_enabled() {
  local config="$1"
  jq -e \
    --arg email "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT" \
    '(.email // "") == $email and (.disabled // false) == false' \
    <<<"$config" >/dev/null
}

ensure_build_service_account() {
  local config
  if config="$(build_service_account_json)"; then
    build_service_account_is_enabled "$config" \
      || die "worker build service account is disabled or invalid"
    log "verified: keyless dedicated worker build service account exists and is enabled"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "worker build service account does not exist"
  run_mutation gcloud iam service-accounts create \
    "$(service_account_id "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT")" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--display-name=AI Baram Analysis V2 builder' \
    '--description=Keyless least-privilege source-build identity for Analysis V2 Cloud Run' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    config="$(build_service_account_json)" \
      || die "worker build service account creation was not observable"
    build_service_account_is_enabled "$config" \
      || die "new worker build service account is disabled or invalid"
  else
    log "[dry-run] the new build identity will be created without credential keys"
  fi
}

verify_no_build_user_managed_keys() {
  if ! build_service_account_json >/dev/null; then
    [[ "$mode" == "dry-run" ]] \
      || die "worker build service account is unavailable for key verification"
    return 0
  fi
  local key_names
  key_names="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$key_names" ]] \
    || die "worker build service account has a user-managed credential key; remove it before launch"
  log "verified: worker build service account has no user-managed credential keys"
}

project_roles_for_worker() {
  gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=$worker_member" \
    '--format=value(bindings.role)'
}

verify_project_role_bounds() {
  local role
  local roles
  roles="$(project_roles_for_worker)"
  while IFS= read -r role; do
    case "$role" in
      '') ;;
      roles/owner|roles/editor|roles/storage.*|roles/secretmanager.*)
        die "worker runtime identity has a forbidden broad project role: $role"
        ;;
      roles/aiplatform.*)
        [[ "$role" == "$VERTEX_RUNTIME_ROLE" ]] \
          || die "worker runtime identity has an elevated or unexpected Vertex AI role: $role"
        ;;
      *) die "worker runtime identity has an unexpected project role: $role" ;;
    esac
  done <<<"$roles"
  log "verified: worker identity has no project role beyond roles/aiplatform.user"
}

vertex_binding_exists() {
  local bindings
  bindings="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=$VERTEX_RUNTIME_ROLE AND bindings.members=$worker_member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "$VERTEX_RUNTIME_ROLE,$worker_member," <<<"$bindings"
}

ensure_vertex_binding() {
  if vertex_binding_exists; then
    log "verified: worker identity has only the required Vertex AI runtime role"
    return 0
  fi

  [[ "$mode" != "check" ]] \
    || die "worker runtime identity is missing $VERTEX_RUNTIME_ROLE"
  run_mutation gcloud projects add-iam-policy-binding \
    "$ANALYSIS_V2_TASKS_PROJECT" \
    "--member=$worker_member" \
    "--role=$VERTEX_RUNTIME_ROLE" \
    '--condition=None' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    vertex_binding_exists \
      || die "Vertex AI runtime role binding was not observable"
  fi
}

build_project_roles() {
  gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=$build_member" \
    '--format=value(bindings.role)'
}

verify_build_project_roles() {
  local role
  local roles
  roles="$(build_project_roles)"
  while IFS= read -r role; do
    case "$role" in
      '') ;;
      "$BUILD_RUNTIME_ROLE") ;;
      *) die "worker build identity has a forbidden project role: $role" ;;
    esac
  done <<<"$roles"
  log "verified: worker build identity has no project role beyond roles/run.builder"
}

build_role_binding_exists() {
  local bindings
  bindings="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.role=$BUILD_RUNTIME_ROLE AND bindings.members=$build_member" \
    '--format=csv[no-heading](bindings.role,bindings.members,bindings.condition.expression)')"
  grep -Fqx "$BUILD_RUNTIME_ROLE,$build_member," <<<"$bindings"
}

ensure_build_role_binding() {
  if build_role_binding_exists; then
    log "verified: build identity has only the required Cloud Run builder role"
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "worker build identity is missing $BUILD_RUNTIME_ROLE"
  run_mutation gcloud projects add-iam-policy-binding \
    "$ANALYSIS_V2_TASKS_PROJECT" \
    "--member=$build_member" \
    "--role=$BUILD_RUNTIME_ROLE" \
    '--condition=None' \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    build_role_binding_exists \
      || die "Cloud Run builder role binding was not observable"
  fi
}

enqueuer_service_account_json() {
  gcloud iam service-accounts describe \
    "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

ensure_enqueuer_service_account() {
  local config
  if config="$(enqueuer_service_account_json)"; then
    jq -e \
      --arg email "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
      '(.email // "") == $email and (.disabled // false) == false' \
      <<<"$config" >/dev/null \
      || die "dedicated V2 enqueuer service account is disabled or invalid"
    log "verified: dedicated keyless V2/preflight enqueuer exists and is enabled"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "dedicated V2/preflight enqueuer does not exist"
  run_mutation gcloud iam service-accounts create \
    "$(service_account_id "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL")" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--display-name=AI Baram V2 queue enqueuer' \
    '--description=Keyless identity restricted to the V2 and preflight Cloud Tasks queues' \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    config="$(enqueuer_service_account_json)" \
      || die "dedicated V2 enqueuer creation was not observable"
    jq -e '(.disabled // false) == false' <<<"$config" >/dev/null \
      || die "new dedicated V2 enqueuer is disabled"
  fi
}

verify_enqueuer_keyless_and_project_role_free() {
  if ! enqueuer_service_account_json >/dev/null; then
    [[ "$mode" == "dry-run" ]] || die "dedicated V2 enqueuer is unavailable"
    log "[dry-run] the dedicated V2 enqueuer will be created without credential keys"
    return 0
  fi
  local key_names
  local roles
  key_names="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$key_names" ]] \
    || die "dedicated V2 enqueuer has a user-managed credential key"
  roles="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=$enqueuer_member" \
    '--format=value(bindings.role)')"
  [[ -z "$roles" ]] \
    || die "dedicated V2 enqueuer must have no project-wide role"
  log "verified: dedicated V2 enqueuer is keyless and has no project-wide role"
}

managed_identity_json() {
  local email="$1"
  gcloud iam service-accounts describe "$email" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

ensure_managed_identity() {
  local email="$1"
  local display_name="$2"
  local description="$3"
  local config
  if config="$(managed_identity_json "$email")"; then
    jq -e --arg email "$email" \
      '(.email // "") == $email and (.disabled // false) == false' \
      <<<"$config" >/dev/null \
      || die "managed identity is disabled or invalid: $email"
    log "verified: managed identity exists and is enabled: $email"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "managed identity does not exist: $email"
  run_mutation gcloud iam service-accounts create \
    "$(service_account_id "$email")" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--display-name=$display_name" \
    "--description=$description" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    config="$(managed_identity_json "$email")" \
      || die "managed identity creation was not observable: $email"
    jq -e --arg email "$email" \
      '(.email // "") == $email and (.disabled // false) == false' \
      <<<"$config" >/dev/null \
      || die "new managed identity is disabled or invalid: $email"
  fi
}

verify_identity_keyless_and_project_role_free() {
  local email="$1"
  local label="$2"
  if ! managed_identity_json "$email" >/dev/null; then
    [[ "$mode" == "dry-run" ]] || die "$label is unavailable"
    log "[dry-run] $label will be keyless and project-role-free"
    return 0
  fi
  local key_names
  local roles
  key_names="$(gcloud iam service-accounts keys list \
    "--iam-account=$email" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$key_names" ]] || die "$label has a user-managed credential key"
  roles="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=serviceAccount:$email" \
    '--format=value(bindings.role)')"
  [[ -z "$roles" ]] || die "$label must have no project-wide role"
  log "verified: $label is keyless and project-role-free"
}

service_account_policy_json() {
  local email="$1"
  gcloud iam service-accounts get-iam-policy "$email" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json
}

deployer_policy_is_exact() {
  local policy="$1"
  jq -e --arg member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER" '
    ((.bindings // []) | length) == 1
      and .bindings[0].role == "roles/iam.serviceAccountUser"
      and (.bindings[0].condition? == null)
      and .bindings[0].members == [$member]
  ' <<<"$policy" >/dev/null
}

policy_is_empty() {
  jq -e '((.bindings // []) | length) == 0' <<<"$1" >/dev/null
}

policy_files=()
written_policy_file=""
write_exact_deployer_policy() {
  local policy="$1"
  local policy_file
  policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-identity-iam.XXXXXX")"
  policy_files+=("$policy_file")
  jq --arg member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER" '
    .bindings = [{
      "role": "roles/iam.serviceAccountUser",
      "members": [$member]
    }]
  ' <<<"$policy" >"$policy_file"
  written_policy_file="$policy_file"
}

ensure_exact_deployer_policy() {
  local email="$1"
  local label="$2"
  local policy
  local policy_file
  if [[ "$mode" == "dry-run" ]] && ! managed_identity_json "$email" >/dev/null; then
    log "[dry-run] $label IAM will contain only deployer actAs"
    return 0
  fi
  policy="$(service_account_policy_json "$email")"
  if deployer_policy_is_exact "$policy"; then
    log "verified: $label IAM contains only the declared deployer actAs binding"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "$label IAM has drifted"
  if ! policy_is_empty "$policy" && [[ "$reconcile_iam" != "true" ]]; then
    die "$label IAM has unexpected bindings; inspect them or rerun with --reconcile-iam"
  fi
  write_exact_deployer_policy "$policy"
  policy_file="$written_policy_file"
  run_mutation gcloud iam service-accounts set-iam-policy \
    "$email" "$policy_file" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    policy="$(service_account_policy_json "$email")"
    deployer_policy_is_exact "$policy" \
      || die "$label exact deployer IAM was not observable"
  fi
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

normalize_worker_runtime_identity

for name in \
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT \
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER \
  ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL; do
  required_env "$name"
done

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_service_account_email \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
validate_service_account_email "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
validate_deployer_member "$ANALYSIS_V2_DEPLOYER_IAM_MEMBER"
[[ "$(service_account_project "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker runtime service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker build service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "task OIDC service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "V2 enqueuer service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "maintenance service account must belong to ANALYSIS_V2_TASKS_PROJECT"

v2_identities=(
  "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
  "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
  "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
)
for ((i = 0; i < ${#v2_identities[@]}; i++)); do
  for ((j = i + 1; j < ${#v2_identities[@]}; j++)); do
    [[ "${v2_identities[$i]}" != "${v2_identities[$j]}" ]] \
      || die "all V2 task, enqueuer, runtime, maintenance, and build identities must be distinct"
  done
  for legacy_identity in \
    "$ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL" \
    "$ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"; do
    [[ "${v2_identities[$i]}" != "$legacy_identity" ]] \
      || die "V2 identities must not reuse a V1 task or enqueuer identity"
  done
done

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"
gcloud projects describe "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)' | grep -Eq '^[0-9]+$' \
  || die "could not resolve the GCP project number"

readonly worker_member="serviceAccount:$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
readonly build_member="serviceAccount:$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
readonly enqueuer_member="serviceAccount:$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"

cleanup() {
  local file
  for file in "${policy_files[@]:-}"; do
    [[ -z "$file" ]] || rm -f "$file"
  done
}
trap cleanup EXIT

ensure_api "$IAM_API"
ensure_api "$VERTEX_AI_API"
ensure_service_account
verify_no_user_managed_keys
verify_project_role_bounds
ensure_vertex_binding
ensure_build_service_account
verify_no_build_user_managed_keys
verify_build_project_roles
ensure_build_role_binding
ensure_exact_deployer_policy \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "worker runtime service account"
ensure_exact_deployer_policy \
  "$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT" \
  "worker build service account"
ensure_enqueuer_service_account
verify_enqueuer_keyless_and_project_role_free
ensure_managed_identity \
  "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "AI Baram V2 task invoker" \
  "Keyless OIDC identity used only by V2 and preflight Cloud Tasks"
verify_identity_keyless_and_project_role_free \
  "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "V2 task OIDC identity"
ensure_managed_identity \
  "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
  "AI Baram V2 maintenance" \
  "Keyless OIDC identity restricted to scheduled V2 maintenance routes"
verify_identity_keyless_and_project_role_free \
  "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
  "V2 maintenance identity"
ensure_exact_deployer_policy \
  "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
  "V2 maintenance service account"

if [[ "$mode" == "apply" ]]; then
  verify_project_role_bounds
  verify_build_project_roles
fi

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 keyless worker identity configuration verified"
fi
