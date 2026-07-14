#!/usr/bin/env bash
set -euo pipefail

readonly SECRET_MANAGER_API="secretmanager.googleapis.com"
readonly SECRET_LOCATION="asia-northeast3"
readonly SECRET_ACCESSOR_ROLE="roles/secretmanager.secretAccessor"
readonly SECRET_OBSERVE_ATTEMPTS=6
readonly SECRET_OBSERVE_RETRY_DELAY_SECONDS=1
readonly SUPABASE_SECRET_ID="ai-baram-v2-supabase-service-role"
readonly IMAGE_SIGNING_SECRET_ID="ai-baram-v2-image-proxy-signing"

mode="apply"
rotate_target=""
reconcile_iam="false"

usage() {
  cat <<'EOF'
Usage: scripts/configure-analysis-v2-secrets.sh [--dry-run | --check] [--rotate TARGET] [--reconcile-iam]

Creates or verifies the three Analysis V2 Secret Manager resources and grants
the Cloud Run runtime identity resource-scoped access. Secret values are read
only when a version must be created, and are streamed from an outside-source
dotenv file directly to gcloud over stdin.

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT

The deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL alias remains
accepted during migration. If both names are set, they must match exactly.

Required for creating or rotating a version:
  ANALYSIS_V2_SECRET_SOURCE_ENV_FILE
    Dotenv file outside ANALYSIS_V2_WORKER_SOURCE_DIR. It must contain
    SUPABASE_SERVICE_ROLE_KEY, IMAGE_PROXY_SIGNING_SECRET, and the one selected
    APIFY_<SLOT>_API_TOKEN. The file is never sourced as shell code.

Optional exact numeric version pins:
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION

When a pin is omitted, exactly one enabled numeric version must be discoverable.
`latest` is never accepted. Deployments require all three explicit pins. A
create-only interrupted resource with no version history resumes its initial
version on ordinary apply. If version history exists but every version is
disabled, ordinary apply fails closed and an explicit rotation is required.

Rotate targets:
  supabase | apify | image-signing

Rotation is explicit and adds one enabled version without disabling the old
version. The script prints the new non-secret numeric pin; update the deployment
pin and redeploy before disabling the prior version.

Options:
  --dry-run       Validate inputs and print only sanitized intended mutations.
  --check         Verify resources, pinned versions, and exact IAM without changes.
  --rotate TARGET Add a new version for exactly one existing secret.
  --reconcile-iam Replace reviewed resource IAM drift. Unexpected bindings
                  otherwise fail closed and are not removed automatically.
  -h, --help      Show this help.
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
    || die "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL is invalid"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

validate_slot() {
  case "$1" in
    primary|secondary|tertiary|quaternary|quinary) ;;
    *) die "ANALYSIS_V2_APIFY_API_TOKEN_SLOT must be primary, secondary, tertiary, quaternary, or quinary" ;;
  esac
}

validate_numeric_version() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] \
    || die "$label must be an exact positive numeric version; latest is forbidden"
}

api_is_enabled() {
  local enabled
  enabled="$(gcloud services list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --enabled \
    "--filter=config.name=$SECRET_MANAGER_API" \
    '--format=value(config.name)')"
  [[ "$enabled" == "$SECRET_MANAGER_API" ]]
}

ensure_api() {
  if api_is_enabled; then
    log "verified: $SECRET_MANAGER_API is enabled"
    return 0
  fi
  [[ "$mode" != "check" ]] || die "$SECRET_MANAGER_API is not enabled"
  run_mutation gcloud services enable "$SECRET_MANAGER_API" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    api_is_enabled || die "$SECRET_MANAGER_API enablement was not observable"
  fi
}

secret_json() {
  local secret_id="$1"
  gcloud secrets describe "$secret_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

wait_for_secret_json() {
  local secret_id="$1"
  local attempt
  local config
  for ((attempt = 1; attempt <= SECRET_OBSERVE_ATTEMPTS; attempt += 1)); do
    if config="$(secret_json "$secret_id")"; then
      printf '%s\n' "$config"
      return 0
    fi
    ((attempt < SECRET_OBSERVE_ATTEMPTS)) || break
    sleep "$SECRET_OBSERVE_RETRY_DELAY_SECONDS"
  done
  return 1
}

secret_replication_matches() {
  local config="$1"
  local secret_id="$2"
  jq -e \
    --arg project_number "$tasks_project_number" \
    --arg secret "$secret_id" \
    --arg location "$SECRET_LOCATION" '
      .name == ("projects/" + $project_number + "/secrets/" + $secret)
      and ((.replication.userManaged.replicas // []) | length) == 1
      and .replication.userManaged.replicas[0].location == $location
    ' <<<"$config" >/dev/null
}

secret_exists="false"
secret_created_now="false"
ensure_secret() {
  local secret_id="$1"
  local config
  if config="$(secret_json "$secret_id")"; then
    secret_replication_matches "$config" "$secret_id" \
      || die "Secret Manager resource $secret_id has unexpected replication or ownership"
    secret_exists="true"
    secret_created_now="false"
    log "verified: Secret Manager resource $secret_id is pinned to $SECRET_LOCATION"
    return 0
  fi

  secret_exists="false"
  secret_created_now="true"
  [[ "$mode" != "check" ]] || die "Secret Manager resource $secret_id does not exist"
  if ! run_mutation gcloud secrets create "$secret_id" \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      '--replication-policy=user-managed' \
      "--locations=$SECRET_LOCATION" \
      '--format=none' \
      --quiet; then
    [[ "$mode" == "apply" ]] \
      || die "Secret Manager resource $secret_id could not be created"
    config="$(wait_for_secret_json "$secret_id")" \
      || die "Secret Manager resource $secret_id create failed and the resource was not observable after bounded retry"
    secret_replication_matches "$config" "$secret_id" \
      || die "Secret Manager resource $secret_id became observable with unexpected replication or ownership"
    secret_exists="true"
    secret_created_now="false"
    log "verified: Secret Manager resource $secret_id became observable after create returned an error"
    return 0
  fi
  if [[ "$mode" == "apply" ]]; then
    config="$(wait_for_secret_json "$secret_id")" \
      || die "Secret Manager resource $secret_id was not observable after creation within the bounded retry window"
    secret_replication_matches "$config" "$secret_id" \
      || die "Secret Manager resource $secret_id was created with unexpected replication or ownership"
    secret_exists="true"
  fi
}

project_secret_roles_for_worker() {
  gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    '--flatten=bindings[].members' \
    "--filter=bindings.members=$worker_member" \
    '--format=value(bindings.role)'
}

verify_no_project_secret_roles() {
  local roles
  roles="$(project_secret_roles_for_worker)"
  if grep -Eq '^roles/secretmanager\.' <<<"$roles"; then
    die "worker runtime identity has a forbidden project-wide Secret Manager role"
  fi
  log "verified: worker runtime identity has no project-wide Secret Manager role"
}

secret_iam_policy() {
  local secret_id="$1"
  gcloud secrets get-iam-policy "$secret_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json
}

secret_iam_matches() {
  local policy="$1"
  jq -e \
    --arg role "$SECRET_ACCESSOR_ROLE" \
    --arg member "$worker_member" '
      ((.bindings // []) | length) == 1
      and .bindings[0].role == $role
      and (.bindings[0].condition? == null)
      and .bindings[0].members == [$member]
    ' <<<"$policy" >/dev/null
}

policy_files=("")
written_policy_file=""
write_exact_secret_policy() {
  local policy="$1"
  local policy_file
  policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-secret-iam.XXXXXX")"
  policy_files+=("$policy_file")
  jq \
    --arg role "$SECRET_ACCESSOR_ROLE" \
    --arg member "$worker_member" '
      .bindings = [{"role": $role, "members": [$member]}]
    ' <<<"$policy" >"$policy_file"
  written_policy_file="$policy_file"
}

ensure_secret_iam() {
  local secret_id="$1"
  local policy
  local policy_file
  local binding_count
  if [[ "$mode" == "dry-run" && "$secret_exists" != "true" ]]; then
    log "[dry-run] $secret_id IAM will contain only the runtime secret accessor binding"
    return 0
  fi
  policy="$(secret_iam_policy "$secret_id")"
  if secret_iam_matches "$policy"; then
    log "verified: $secret_id IAM contains only the runtime secret accessor binding"
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "Secret Manager resource $secret_id has unexpected IAM bindings"
  binding_count="$(jq -r '(.bindings // []) | length' <<<"$policy")"
  if [[ "$secret_created_now" != "true" && "$binding_count" != "0" \
    && "$reconcile_iam" != "true" ]]; then
    die "Secret Manager resource $secret_id has unexpected IAM; inspect or use --reconcile-iam"
  fi
  write_exact_secret_policy "$policy"
  policy_file="$written_policy_file"
  run_mutation gcloud secrets set-iam-policy "$secret_id" "$policy_file" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--format=none' \
    --quiet
  if [[ "$mode" == "apply" ]]; then
    policy="$(secret_iam_policy "$secret_id")"
    secret_iam_matches "$policy" \
      || die "exact IAM for Secret Manager resource $secret_id was not observable"
  fi
}

validate_source_boundary() {
  local source_file="$1"
  local source_dir
  local source_path
  local resolved_path
  command -v realpath >/dev/null 2>&1 \
    || die "realpath is required to validate secret source boundaries"
  source_dir="$(cd -P "$(dirname "$source_file")" && pwd -P)"
  source_path="$source_dir/$(basename "$source_file")"
  resolved_path="$(realpath "$source_file")" \
    || die "ANALYSIS_V2_SECRET_SOURCE_ENV_FILE could not be resolved"
  for candidate in "$source_path" "$resolved_path"; do
    case "$candidate" in
      "$worker_source_dir"|"$worker_source_dir"/*)
        die "ANALYSIS_V2_SECRET_SOURCE_ENV_FILE must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"
        ;;
    esac
  done
}

secret_source_validated="false"
ensure_secret_source() {
  [[ "$secret_source_validated" == "false" ]] || return 0
  required_env ANALYSIS_V2_SECRET_SOURCE_ENV_FILE
  [[ -f "$ANALYSIS_V2_SECRET_SOURCE_ENV_FILE" ]] \
    || die "ANALYSIS_V2_SECRET_SOURCE_ENV_FILE must be a regular file"
  validate_source_boundary "$ANALYSIS_V2_SECRET_SOURCE_ENV_FILE"
  secret_source_validated="true"
}

validate_secret_source_value() {
  local env_key="$1"
  ensure_secret_source
  env -i HOME="${HOME:-}" PATH="$PATH" \
    node --env-file="$ANALYSIS_V2_SECRET_SOURCE_ENV_FILE" -e '
      const key = process.argv[1];
      const minimum = key === "IMAGE_PROXY_SIGNING_SECRET" ? 32 : 20;
      const value = process.env[key];
      if (typeof value !== "string" || value.trim().length < minimum || /[\r\n]/.test(value)) {
        console.error(`required secret source value is missing or invalid: ${key}`);
        process.exit(1);
      }
    ' "$env_key"
}

version_json() {
  local secret_id="$1"
  local version="$2"
  gcloud secrets versions describe "$version" \
    "--secret=$secret_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    --format=json 2>/dev/null
}

verify_enabled_version() {
  local secret_id="$1"
  local version="$2"
  local config
  config="$(version_json "$secret_id" "$version")" \
    || die "pinned version $version for $secret_id does not exist"
  jq -e \
    --arg project_number "$tasks_project_number" \
    --arg secret "$secret_id" \
    --arg version "$version" '
      .name == ("projects/" + $project_number + "/secrets/" + $secret + "/versions/" + $version)
      and .state == "ENABLED"
    ' <<<"$config" >/dev/null \
    || die "pinned version $version for $secret_id is not enabled or exact"
}

enabled_version_count=0
single_enabled_version=""
inspect_enabled_versions() {
  local secret_id="$1"
  local line
  local version
  local versions_output
  enabled_version_count=0
  single_enabled_version=""
  versions_output="$(gcloud secrets versions list \
    "$secret_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--filter=state=ENABLED' \
    '--format=value(name)')" \
    || die "could not list enabled versions for $secret_id"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    version="${line##*/}"
    [[ "$version" =~ ^[1-9][0-9]*$ ]] \
      || die "enabled version discovery for $secret_id returned a non-numeric version"
    [[ "$line" == "projects/$tasks_project_number/secrets/$secret_id/versions/$version" ]] \
      || die "enabled version discovery for $secret_id returned an unexpected resource name"
    single_enabled_version="$version"
    enabled_version_count=$((enabled_version_count + 1))
  done <<<"$versions_output"
}

secret_has_version_history() {
  local secret_id="$1"
  local first_version
  local version
  first_version="$(gcloud secrets versions list \
    "$secret_id" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--limit=1' \
    '--format=value(name)')" \
    || die "could not inspect version history for $secret_id"
  [[ -n "$first_version" ]] || return 1
  version="${first_version##*/}"
  [[ "$version" =~ ^[1-9][0-9]*$ \
    && "$first_version" == "projects/$tasks_project_number/secrets/$secret_id/versions/$version" ]] \
    || die "version history for $secret_id returned an unexpected resource name"
  return 0
}

resolved_version=""
resolve_version() {
  local secret_id="$1"
  local configured_version="$2"
  local pin_name="$3"
  if [[ -n "$configured_version" ]]; then
    validate_numeric_version "$configured_version" "$pin_name"
    resolved_version="$configured_version"
  else
    inspect_enabled_versions "$secret_id"
    [[ "$enabled_version_count" == "1" ]] \
      || die "$secret_id requires an explicit numeric version pin because enabled-version discovery was not unique"
    resolved_version="$single_enabled_version"
    log "verified: discovered the single enabled numeric version for $secret_id"
  fi
  verify_enabled_version "$secret_id" "$resolved_version"
}

added_version=""
add_secret_version() {
  local secret_id="$1"
  local env_key="$2"
  local version_name
  validate_secret_source_value "$env_key"
  if [[ "$mode" == "dry-run" ]]; then
    log "[dry-run] would stream allowlisted $env_key directly to a new $secret_id version over stdin"
    added_version="pending"
    return 0
  fi
  version_name="$(
    env -i HOME="${HOME:-}" PATH="$PATH" \
      node --env-file="$ANALYSIS_V2_SECRET_SOURCE_ENV_FILE" -e '
        const key = process.argv[1];
        process.stdout.write(process.env[key]);
      ' "$env_key" \
    | gcloud secrets versions add "$secret_id" \
        "--project=$ANALYSIS_V2_TASKS_PROJECT" \
        --data-file=- \
        '--format=value(name)' \
        --quiet
  )"
  added_version="${version_name##*/}"
  validate_numeric_version "$added_version" "new version returned for $secret_id"
  verify_enabled_version "$secret_id" "$added_version"
}

process_secret() {
  local logical_target="$1"
  local secret_id="$2"
  local env_key="$3"
  local configured_version="$4"
  local pin_name="$5"

  ensure_secret "$secret_id"
  if [[ "$secret_created_now" == "false" ]]; then
    if [[ "$rotate_target" == "$logical_target" ]]; then
      add_secret_version "$secret_id" "$env_key"
      resolved_version="$added_version"
    elif [[ -n "$configured_version" ]]; then
      resolve_version "$secret_id" "$configured_version" "$pin_name"
    else
      inspect_enabled_versions "$secret_id"
      if [[ "$enabled_version_count" == "1" ]]; then
        resolved_version="$single_enabled_version"
        verify_enabled_version "$secret_id" "$resolved_version"
        log "verified: discovered the single enabled numeric version for $secret_id"
      elif [[ "$enabled_version_count" != "0" ]]; then
        die "$secret_id requires an explicit numeric version pin because enabled-version discovery was not unique"
      elif secret_has_version_history "$secret_id"; then
        die "$secret_id has version history but no enabled version; use explicit --rotate $logical_target"
      elif [[ "$mode" == "check" || -n "$rotate_target" ]]; then
        die "$secret_id has no version; run ordinary apply to resume initial version creation"
      else
        log "resuming interrupted initial version creation for $secret_id"
        add_secret_version "$secret_id" "$env_key"
        resolved_version="$added_version"
      fi
    fi
  else
    [[ -z "$rotate_target" ]] \
      || die "cannot rotate while Secret Manager resource $secret_id is missing; run initial apply first"
    add_secret_version "$secret_id" "$env_key"
    resolved_version="$added_version"
    if [[ "$resolved_version" != "pending" ]]; then
      if [[ -n "$configured_version" && "$configured_version" != "$resolved_version" ]]; then
        die "$pin_name does not match the newly created exact version"
      fi
    fi
  fi

  ensure_secret_iam "$secret_id"
  if [[ "$resolved_version" == "pending" ]]; then
    log "verified: apply will return the exact numeric pin for $pin_name"
  else
    log "pin: $pin_name=$resolved_version"
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
    --rotate)
      shift
      (($# > 0)) || die "--rotate requires supabase, apify, or image-signing"
      [[ -z "$rotate_target" ]] || die "choose only one rotate target"
      rotate_target="$1"
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

case "$rotate_target" in
  ''|supabase|apify|image-signing) ;;
  *) die "--rotate requires supabase, apify, or image-signing" ;;
esac
[[ "$mode" != "check" || -z "$rotate_target" ]] \
  || die "--check cannot be combined with --rotate"

for name in \
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT; do
  required_env "$name"
done

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_service_account_email \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
[[ "$(service_account_project "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker runtime service account must belong to ANALYSIS_V2_TASKS_PROJECT"
validate_slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT"

readonly slot_upper="$(printf '%s' "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" | tr '[:lower:]' '[:upper:]')"
readonly apify_env_key="APIFY_${slot_upper}_API_TOKEN"
readonly apify_secret_id="ai-baram-v2-apify-$ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
readonly worker_member="serviceAccount:$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v node >/dev/null 2>&1 || die "Node.js with --env-file support is required"

script_dir="$(cd "$(dirname "$0")" && pwd)"
worker_source_input="${ANALYSIS_V2_WORKER_SOURCE_DIR:-$script_dir/..}"
[[ -d "$worker_source_input" ]] \
  || die "ANALYSIS_V2_WORKER_SOURCE_DIR must be a directory"
readonly worker_source_dir="$(cd -P "$worker_source_input" && pwd -P)"

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"
tasks_project_number="$(gcloud projects describe "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)')" \
  || die "could not resolve the GCP project number"
[[ "$tasks_project_number" =~ ^[1-9][0-9]*$ ]] \
  || die "could not resolve the GCP project number"
readonly tasks_project_number
disabled="$(gcloud iam service-accounts describe \
  "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "--project=$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(disabled)')" \
  || die "worker runtime service account must already exist"
[[ "$disabled" != "true" && "$disabled" != "True" ]] \
  || die "worker runtime service account is disabled"

cleanup() {
  local file
  for file in "${policy_files[@]}"; do
    [[ -z "$file" ]] || rm -f "$file"
  done
}
trap cleanup EXIT

ensure_api
verify_no_project_secret_roles
process_secret \
  supabase \
  "$SUPABASE_SECRET_ID" \
  SUPABASE_SERVICE_ROLE_KEY \
  "${ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION:-}" \
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
process_secret \
  apify \
  "$apify_secret_id" \
  "$apify_env_key" \
  "${ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION:-}" \
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
process_secret \
  image-signing \
  "$IMAGE_SIGNING_SECRET_ID" \
  IMAGE_PROXY_SIGNING_SECRET \
  "${ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION:-}" \
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied and no secret value was printed"
else
  log "Analysis V2 Secret Manager configuration verified"
fi
