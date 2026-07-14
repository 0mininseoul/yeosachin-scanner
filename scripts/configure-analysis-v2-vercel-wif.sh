#!/usr/bin/env bash
set -euo pipefail

readonly IAM_API="iam.googleapis.com"
readonly IAM_CREDENTIALS_API="iamcredentials.googleapis.com"
readonly STS_API="sts.googleapis.com"
readonly RESOURCE_MANAGER_API="cloudresourcemanager.googleapis.com"
readonly WIF_ROLE="roles/iam.workloadIdentityUser"

mode="apply"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-vercel-wif.sh [--dry-run | --check]

Creates or verifies the keyless Vercel production OIDC trust used to
impersonate the dedicated Analysis V2/preflight Cloud Tasks enqueuer.

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL
  GCP_VERCEL_WIF_PROVIDER_RESOURCE
  VERCEL_OIDC_TEAM_SLUG
  VERCEL_OIDC_TEAM_ID
  VERCEL_OIDC_PROJECT_ID

GCP_VERCEL_WIF_PROVIDER_RESOURCE must use this exact form:
  projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER

The provider accepts only the configured immutable Vercel team ID, project ID,
and production environment. Its default audience remains the canonical Google
provider URL. The keyless enqueuer service-account resource policy must contain
only roles/iam.workloadIdentityUser for the exact project:production subject;
additional roles or principals are rejected.

Run configure-analysis-v2-worker-identity.sh first so the dedicated enqueuer
exists. This script never creates, downloads, or prints a credential key and
does not configure Vercel environment variables.

Options:
  --dry-run  Run read-only checks and print required mutations.
  --check    Verify the complete trust configuration without changing it.
  -h, --help Show this help.
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
  [[ "$1" =~ ^[a-z0-9-]{1,63}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL is invalid"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

validate_team_slug() {
  local value="$1"
  [[ ${#value} -ge 2 && ${#value} -le 100 \
    && "$value" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]] \
    || die "VERCEL_OIDC_TEAM_SLUG is invalid"
}

validate_vercel_id() {
  local value="$1"
  local prefix="$2"
  [[ "$value" =~ ^${prefix}_[A-Za-z0-9]{8,64}$ ]] \
    || die "VERCEL_OIDC_${prefix^^}_ID is invalid"
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
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  GCP_VERCEL_WIF_PROVIDER_RESOURCE \
  VERCEL_OIDC_TEAM_SLUG \
  VERCEL_OIDC_TEAM_ID \
  VERCEL_OIDC_PROJECT_ID; do
  required_env "$name"
done

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_service_account_email \
  "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
[[ "$(service_account_project \
  "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "the WIF enqueuer must belong to ANALYSIS_V2_TASKS_PROJECT"
validate_team_slug "$VERCEL_OIDC_TEAM_SLUG"
validate_vercel_id "$VERCEL_OIDC_TEAM_ID" "team"
validate_vercel_id "$VERCEL_OIDC_PROJECT_ID" "prj"

provider_resource_pattern='^projects/([0-9]{6,20})/locations/global/workloadIdentityPools/([a-z]([a-z0-9-]{2,30})[a-z0-9])/providers/([a-z]([a-z0-9-]{2,30})[a-z0-9])$'
[[ "$GCP_VERCEL_WIF_PROVIDER_RESOURCE" =~ $provider_resource_pattern ]] \
  || die "GCP_VERCEL_WIF_PROVIDER_RESOURCE is invalid"
readonly configured_project_number="${BASH_REMATCH[1]}"
readonly pool_id="${BASH_REMATCH[2]}"
readonly provider_id="${BASH_REMATCH[4]}"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

active_account="$(gcloud auth list \
  --filter=status:ACTIVE \
  --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"

observed_project_number="$(gcloud projects describe \
  "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)')"
[[ "$observed_project_number" =~ ^[0-9]{6,20}$ ]] \
  || die "could not resolve the GCP project number"
[[ "$observed_project_number" == "$configured_project_number" ]] \
  || die "GCP_VERCEL_WIF_PROVIDER_RESOURCE project number does not match the project"

readonly issuer_uri="https://oidc.vercel.com/$VERCEL_OIDC_TEAM_SLUG"
readonly subject_value="$VERCEL_OIDC_PROJECT_ID:production"
readonly subject_member="principal://iam.googleapis.com/projects/$configured_project_number/locations/global/workloadIdentityPools/$pool_id/subject/$subject_value"
readonly attribute_mapping="google.subject=assertion.project_id+':'+assertion.environment,attribute.owner_id=assertion.owner_id,attribute.project_id=assertion.project_id,attribute.environment=assertion.environment"
readonly attribute_condition="assertion.owner_id=='$VERCEL_OIDC_TEAM_ID'&&assertion.project_id=='$VERCEL_OIDC_PROJECT_ID'&&assertion.environment=='production'"

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

enqueuer_json() {
  gcloud iam service-accounts describe \
    "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

verify_enqueuer() {
  local config
  config="$(enqueuer_json)" \
    || die "dedicated V2 enqueuer does not exist; run the worker identity script first"
  jq -e \
    --arg email "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    '(.email // "") == $email and (.disabled // false) == false' \
    <<<"$config" >/dev/null \
    || die "dedicated V2 enqueuer is disabled or invalid"

  local keys
  keys="$(gcloud iam service-accounts keys list \
    "--iam-account=$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --managed-by=user \
    '--format=value(name)')"
  [[ -z "$keys" ]] \
    || die "dedicated V2 enqueuer has a user-managed credential key"

  local project_roles
  project_roles="$(gcloud projects get-iam-policy \
    "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=serviceAccount:$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    '--format=value(bindings.role)')"
  [[ -z "$project_roles" ]] \
    || die "dedicated V2 enqueuer must have no project-wide role"
  log "verified: dedicated V2 enqueuer is enabled, keyless, and project-role-free"
}

pool_json() {
  gcloud iam workload-identity-pools describe "$pool_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --location=global \
    --format=json 2>/dev/null
}

pool_is_ready() {
  jq -e \
    '(.state // "ACTIVE") == "ACTIVE" and (.disabled // false) == false' \
    <<<"$1" >/dev/null
}

ensure_pool() {
  local config
  if config="$(pool_json)"; then
    if pool_is_ready "$config"; then
      log "verified: Vercel production workload identity pool is active"
      return 0
    fi
    jq -e '(.state // "") == "DELETED"' <<<"$config" >/dev/null \
      && die "workload identity pool is soft-deleted; manual review is required"
    [[ "$mode" != "check" ]] || die "workload identity pool is disabled"
    run_mutation gcloud iam workload-identity-pools update "$pool_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      --location=global \
      --no-disabled \
      --quiet
  else
    [[ "$mode" != "check" ]] || die "workload identity pool does not exist"
    run_mutation gcloud iam workload-identity-pools create "$pool_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      --location=global \
      '--display-name=Vercel production' \
      '--description=Keyless production trust for AI Baram Cloud Tasks enqueue' \
      --quiet
  fi

  if [[ "$mode" == "apply" ]]; then
    config="$(pool_json)" || die "workload identity pool creation was not observable"
    pool_is_ready "$config" || die "workload identity pool is not active"
  fi
}

provider_json() {
  gcloud iam workload-identity-pools providers describe "$provider_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --location=global \
    "--workload-identity-pool=$pool_id" \
    --format=json 2>/dev/null
}

provider_inventory_json() {
  gcloud iam workload-identity-pools providers list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --location=global \
    "--workload-identity-pool=$pool_id" \
    --show-deleted \
    --format=json 2>/dev/null
}

verify_no_unexpected_provider() {
  local inventory
  local expected_name="$GCP_VERCEL_WIF_PROVIDER_RESOURCE"
  if ! inventory="$(provider_inventory_json)"; then
    if [[ "$mode" == "dry-run" ]] && ! pool_json >/dev/null; then
      log "[dry-run] the new pool will contain only the configured provider"
      return 0
    fi
    die "workload identity provider inventory is not observable"
  fi
  jq -e --arg expected "$expected_name" '
    all(.[]?; (.name // "") == $expected)
      and ([.[]? | select((.name // "") != $expected)] | length) == 0
  ' <<<"$inventory" >/dev/null \
    || die "workload identity pool contains an unexpected active, disabled, or soft-deleted provider"
  jq -e --arg expected "$expected_name" '
    any(.[]?;
      (.name // "") == $expected
      and ((.state // "ACTIVE") == "DELETED" or (.disabled // false) == true))
  ' <<<"$inventory" >/dev/null \
    && die "configured workload identity provider is disabled or soft-deleted; manual review is required"
  log "verified: workload identity pool has no second provider, including deleted providers"
}

verify_exact_provider_inventory() {
  local inventory
  inventory="$(provider_inventory_json)" \
    || die "workload identity provider inventory is not observable"
  jq -e --arg expected "$GCP_VERCEL_WIF_PROVIDER_RESOURCE" '
    length == 1
      and .[0].name == $expected
      and (.[0].state // "ACTIVE") == "ACTIVE"
      and (.[0].disabled // false) == false
  ' <<<"$inventory" >/dev/null \
    || die "workload identity pool must contain exactly the configured provider"
}

provider_has_uploaded_jwks() {
  jq -e '((.oidc.jwksJson // "") | length) > 0' <<<"$1" >/dev/null
}

provider_is_exact() {
  local config="$1"
  jq -e \
    --arg issuer "$issuer_uri" \
    --arg subject "assertion.project_id+':'+assertion.environment" \
    --arg condition "$attribute_condition" '
      (.state // "ACTIVE") == "ACTIVE"
      and (.disabled // false) == false
      and .oidc.issuerUri == $issuer
      and ((.oidc.allowedAudiences // []) | length) == 0
      and ((.oidc.jwksJson // "") | length) == 0
      and .attributeCondition == $condition
      and (.attributeMapping | keys | sort) == [
        "attribute.environment",
        "attribute.owner_id",
        "attribute.project_id",
        "google.subject"
      ]
      and .attributeMapping["google.subject"] == $subject
      and .attributeMapping["attribute.owner_id"] == "assertion.owner_id"
      and .attributeMapping["attribute.project_id"] == "assertion.project_id"
      and .attributeMapping["attribute.environment"] == "assertion.environment"
    ' <<<"$config" >/dev/null
}

ensure_provider() {
  local config
  if config="$(provider_json)"; then
    provider_has_uploaded_jwks "$config" \
      && die "provider has uploaded JWKs; manual review is required"
    if provider_is_exact "$config"; then
      log "verified: Vercel OIDC provider has exact immutable production trust"
      return 0
    fi
    jq -e '(.state // "") == "DELETED"' <<<"$config" >/dev/null \
      && die "workload identity provider is soft-deleted; manual review is required"
    die "Vercel OIDC provider configuration has drifted; manual review is required"
  else
    [[ "$mode" != "check" ]] || die "Vercel OIDC provider does not exist"
    run_mutation gcloud iam workload-identity-pools providers create-oidc \
      "$provider_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      --location=global \
      "--workload-identity-pool=$pool_id" \
      '--display-name=AI Baram Vercel' \
      '--description=Exact Vercel production project trust for the V2 enqueuer' \
      "--issuer-uri=$issuer_uri" \
      "--attribute-mapping=$attribute_mapping" \
      "--attribute-condition=$attribute_condition" \
      --quiet
  fi

  if [[ "$mode" == "apply" ]]; then
    config="$(provider_json)" || die "OIDC provider creation was not observable"
    provider_is_exact "$config" || die "OIDC provider configuration is not exact"
  fi
}

enqueuer_policy_json() {
  gcloud iam service-accounts get-iam-policy \
    "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json
}

wif_policy_is_exact() {
  jq -e \
    --arg role "$WIF_ROLE" \
    --arg member "$subject_member" '
      (.bindings // []) as $bindings
      | ($bindings | length) == 1
      and $bindings[0].role == $role
      and (($bindings[0].condition // null) == null)
      and (($bindings[0].members // []) == [$member])
    ' <<<"$1" >/dev/null
}

ensure_wif_binding() {
  local policy
  policy="$(enqueuer_policy_json)"
  if wif_policy_is_exact "$policy"; then
    log "verified: only the exact Vercel production subject can impersonate the enqueuer"
    return 0
  fi

  local binding_count
  binding_count="$(jq -r '(.bindings // []) | length' <<<"$policy")"
  [[ "$binding_count" == "0" ]] \
    || die "unexpected service-account resource IAM bindings or principals exist on the dedicated enqueuer"
  [[ "$mode" != "check" ]] \
    || die "exact Vercel production subject cannot impersonate the enqueuer"

  run_mutation gcloud iam service-accounts add-iam-policy-binding \
    "$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--member=$subject_member" \
    "--role=$WIF_ROLE" \
    '--condition=None' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    policy="$(enqueuer_policy_json)"
    wif_policy_is_exact "$policy" \
      || die "workload identity binding was not observable or is not exact"
  fi
}

for api in \
  "$IAM_API" \
  "$IAM_CREDENTIALS_API" \
  "$STS_API" \
  "$RESOURCE_MANAGER_API"; do
  ensure_api "$api"
done
verify_enqueuer
ensure_pool
verify_no_unexpected_provider
ensure_provider
if [[ "$mode" == "apply" || "$mode" == "check" ]]; then
  verify_exact_provider_inventory
fi
ensure_wif_binding

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Vercel production Workload Identity Federation configuration verified"
fi
