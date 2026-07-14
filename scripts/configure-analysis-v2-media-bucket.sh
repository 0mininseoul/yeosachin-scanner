#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_LOCATION="asia-northeast3"
readonly STORAGE_API="storage.googleapis.com"
readonly IAM_API="iam.googleapis.com"
readonly DEFAULT_ROLE_ID="analysisV2MediaArtifactWorker"
readonly ROLE_PERMISSIONS="storage.objects.create,storage.objects.delete,storage.objects.get"

mode="apply"
reconcile_iam="false"
bucket_created="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-media-bucket.sh [--dry-run | --check] [--reconcile-iam]

Creates or verifies the private, short-lived V2 media artifact bucket and its
least-privilege worker IAM binding.

Apply scripts in this order:
  1. scripts/configure-analysis-v2-worker-identity.sh
  2. scripts/configure-analysis-v2-secrets.sh
  3. scripts/configure-analysis-v2-media-bucket.sh
  4. scripts/deploy-analysis-v2-worker.sh

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET

The deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL alias remains
accepted during migration. If both names are set, they must match exactly.

Optional environment variable:
  ANALYSIS_V2_MEDIA_ARTIFACT_ROLE_ID
    Project custom role ID. Defaults to analysisV2MediaArtifactWorker.

The bucket is deliberately restricted to asia-northeast3. The script enforces
uniform bucket-level access, public access prevention, disabled soft delete and
Object Versioning, and one unconditional Age=1 Delete lifecycle rule. The
worker receives only storage.objects.create/get/delete through a bucket-scoped
custom-role binding. No credential keys are created or printed.

Options:
  --dry-run  Run read-only preflight checks and print required mutations.
  --check    Verify the complete configuration without changing it.
  --reconcile-iam
             Replace reviewed IAM drift. Unexpected existing bindings otherwise
             fail closed and are never removed automatically.
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

validate_bucket() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]] \
    || die "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET is invalid"
}

validate_role_id() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_.]{2,63}$ ]] \
    || die "ANALYSIS_V2_MEDIA_ARTIFACT_ROLE_ID is invalid"
}

validate_service_account_email() {
  local email="$1"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL is invalid"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
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

custom_role_json() {
  local listed
  if gcloud iam roles describe "$role_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null; then
    return 0
  fi
  listed="$(gcloud iam roles list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --show-deleted \
    "--filter=name=$custom_role_name" \
    --format=json)"
  jq -e 'length == 1' <<<"$listed" >/dev/null || return 1
  jq -c '.[0]' <<<"$listed"
}

custom_role_matches() {
  local role_json="$1"
  jq -e \
    --argjson expected '["storage.objects.create","storage.objects.delete","storage.objects.get"]' \
    '(.deleted // false) == false
      and .stage == "GA"
      and ((.includedPermissions // []) | sort) == $expected' \
    <<<"$role_json" >/dev/null
}

ensure_custom_role() {
  local role_json
  if role_json="$(custom_role_json)"; then
    if custom_role_matches "$role_json"; then
      log "verified: media artifact custom role has exactly create/get/delete"
      return 0
    fi
    [[ "$mode" != "check" ]] || die "media artifact custom role has drifted"
    if jq -e '(.deleted // false) == true' <<<"$role_json" >/dev/null; then
      run_mutation gcloud iam roles undelete "$role_id" \
        "--project=$ANALYSIS_V2_TASKS_PROJECT" \
        --quiet
    fi
    run_mutation gcloud iam roles update "$role_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      '--title=Analysis V2 media artifact worker' \
      '--description=Create, read, and delete short-lived V2 media artifacts only' \
      "--permissions=$ROLE_PERMISSIONS" \
      '--stage=GA' \
      --quiet
  else
    [[ "$mode" != "check" ]] || die "media artifact custom role does not exist"
    run_mutation gcloud iam roles create "$role_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      '--title=Analysis V2 media artifact worker' \
      '--description=Create, read, and delete short-lived V2 media artifacts only' \
      "--permissions=$ROLE_PERMISSIONS" \
      '--stage=GA' \
      --quiet
  fi

  if [[ "$mode" == "apply" ]]; then
    role_json="$(custom_role_json)" \
      || die "media artifact custom role was not observable"
    custom_role_matches "$role_json" \
      || die "media artifact custom role policy was not applied"
  fi
}

bucket_json() {
  gcloud storage buckets describe "gs://$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    --raw \
    --format=json 2>/dev/null
}

bucket_location_and_owner_match() {
  local config="$1"
  local required_location_upper
  required_location_upper="$(printf '%s' "$REQUIRED_LOCATION" | tr '[:lower:]' '[:upper:]')"
  jq -e \
    --arg location "$required_location_upper" \
    --arg project_number "$project_number" \
    '(.location | ascii_upcase) == $location
      and (.projectNumber | tostring) == $project_number' \
    <<<"$config" >/dev/null
}

bucket_security_matches() {
  local config="$1"
  jq -e '
    .iamConfiguration.uniformBucketLevelAccess.enabled == true
      and .iamConfiguration.publicAccessPrevention == "enforced"
      and (.versioning.enabled // false) == false
      and (.billing.requesterPays // false) == false
      and (.retentionPolicy? == null)
      and (.defaultEventBasedHold // false) == false
      and ((.softDeletePolicy.retentionDurationSeconds // "0") | tonumber) == 0
      and ((.lifecycle.rule // []) | length) == 1
      and .lifecycle.rule[0].action.type == "Delete"
      and (.lifecycle.rule[0].condition.age | tonumber) == 1
      and ((.lifecycle.rule[0].condition | keys | sort) == ["age"])' \
    <<<"$config" >/dev/null
}

write_lifecycle_file() {
  lifecycle_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-lifecycle.XXXXXX")"
  printf '%s\n' \
    '{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}' \
    >"$lifecycle_file"
}

ensure_bucket() {
  local config
  if config="$(bucket_json)"; then
    bucket_location_and_owner_match "$config" \
      || die "bucket must belong to the configured project and be in $REQUIRED_LOCATION"
    log "verified: media artifact bucket ownership and Seoul location"
  else
    [[ "$mode" != "check" ]] || die "media artifact bucket does not exist or is not visible"
    run_mutation gcloud storage buckets create \
      "gs://$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--location=$REQUIRED_LOCATION" \
      --uniform-bucket-level-access \
      --public-access-prevention \
      --quiet
    bucket_created="true"
    if [[ "$mode" == "dry-run" ]]; then
      config=""
    else
      config="$(bucket_json)" || die "media artifact bucket was not observable"
      bucket_location_and_owner_match "$config" \
        || die "new media artifact bucket has unexpected ownership or location"
    fi
  fi

  if [[ -n "$config" ]] && bucket_security_matches "$config"; then
    log "verified: bucket access, retention, versioning, and lifecycle controls"
    return 0
  fi

  if [[ -n "$config" ]] && jq -e '
    (.retentionPolicy? != null) or (.defaultEventBasedHold // false) == true
  ' <<<"$config" >/dev/null; then
    die "bucket retention policy and default event-based hold must be absent before launch"
  fi

  [[ "$mode" != "check" ]] || die "media artifact bucket security controls have drifted"
  [[ -n "$lifecycle_file" ]] || write_lifecycle_file
  run_mutation gcloud storage buckets update \
    "gs://$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --no-versioning \
    --clear-soft-delete \
    "--lifecycle-file=$lifecycle_file" \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    config="$(bucket_json)" || die "media artifact bucket was not observable after update"
    bucket_security_matches "$config" \
      || die "media artifact bucket security controls were not applied"
  fi
}

bucket_iam_policy() {
  gcloud storage buckets get-iam-policy \
    "gs://$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    --format=json
}

bucket_iam_matches() {
  local policy="$1"
  jq -e \
    --arg member "$worker_member" \
    --arg role "$custom_role_name" '
      ((.bindings // []) | length) == 1
      and .bindings[0].role == $role
      and (.bindings[0].condition? == null)
      and .bindings[0].members == [$member]' \
    <<<"$policy" >/dev/null
}

write_exact_bucket_policy() {
  local current_policy="$1"
  bucket_policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-bucket-iam.XXXXXX")"
  jq \
    --arg member "$worker_member" \
    --arg role "$custom_role_name" '
      .bindings = [{"role": $role, "members": [$member]}]' \
    <<<"$current_policy" >"$bucket_policy_file"
}

ensure_bucket_iam() {
  local policy
  local binding_count
  if [[ "$mode" == "dry-run" ]] && ! policy="$(bucket_iam_policy 2>/dev/null)"; then
    log "[dry-run] bucket IAM will contain only the worker custom-role binding for the runtime identity"
    return 0
  fi
  policy="${policy:-$(bucket_iam_policy)}"

  if bucket_iam_matches "$policy"; then
    log "verified: bucket is non-public and worker IAM is least-privilege"
    return 0
  fi

  [[ "$mode" != "check" ]] \
    || die "bucket IAM must contain exactly the worker custom-role binding"
  binding_count="$(jq -r '(.bindings // []) | length' <<<"$policy")"
  if [[ "$bucket_created" != "true" && "$binding_count" != "0" \
    && "$reconcile_iam" != "true" ]]; then
    die "bucket IAM has unexpected bindings; inspect or use --reconcile-iam"
  fi
  write_exact_bucket_policy "$policy"
  run_mutation gcloud storage buckets set-iam-policy \
    "gs://$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    "$bucket_policy_file" \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    policy="$(bucket_iam_policy)"
    bucket_iam_matches "$policy" \
      || die "bucket least-privilege IAM policy was not applied"
  fi
}

verify_no_inherited_storage_role() {
  local roles
  roles="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    --flatten=bindings[].members \
    "--filter=bindings.members=$worker_member" \
    '--format=value(bindings.role)')"
  if grep -Eq '^(roles/(owner|editor)|roles/storage\.)$|^roles/storage\.' <<<"$roles"; then
    die "worker has an inherited basic or storage project role; remove it before using the artifact bucket"
  fi
  log "verified: worker has no inherited basic or storage project role"
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
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET; do
  required_env "$name"
done

readonly role_id="${ANALYSIS_V2_MEDIA_ARTIFACT_ROLE_ID:-$DEFAULT_ROLE_ID}"
readonly worker_member="serviceAccount:$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
readonly custom_role_name="projects/$ANALYSIS_V2_TASKS_PROJECT/roles/$role_id"

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_bucket "$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET"
validate_role_id "$role_id"
validate_service_account_email \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
[[ "$(service_account_project "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker service account must belong to ANALYSIS_V2_TASKS_PROJECT"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"

project_number="$(gcloud projects describe "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)')"
[[ "$project_number" =~ ^[0-9]+$ ]] || die "could not resolve the GCP project number"

disabled="$(gcloud iam service-accounts describe \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "--project=$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(disabled)')" \
  || die "worker service account must already exist; run configure-analysis-v2-worker-identity.sh first"
[[ "$disabled" != "true" && "$disabled" != "True" ]] \
  || die "worker service account is disabled"

lifecycle_file=""
bucket_policy_file=""
cleanup() {
  [[ -z "$lifecycle_file" ]] || rm -f "$lifecycle_file"
  [[ -z "$bucket_policy_file" ]] || rm -f "$bucket_policy_file"
}
trap cleanup EXIT

verify_no_inherited_storage_role
ensure_api "$STORAGE_API"
ensure_api "$IAM_API"
ensure_custom_role
ensure_bucket
ensure_bucket_iam

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 media artifact bucket configuration verified"
fi
