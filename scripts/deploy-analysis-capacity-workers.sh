#!/usr/bin/env bash
set -euo pipefail

# Split-capacity Cloud Run deployment. The runtime manifest is the sole
# non-secret environment source; build inputs and runtime secrets are supplied
# through separate, externally-resolved files/Secret Manager references.
readonly DEFAULT_LOCATION="asia-northeast3"
readonly SUPABASE_SECRET_ID="ai-baram-v2-supabase-service-role"
readonly IMAGE_SIGNING_SECRET_ID="ai-baram-v2-image-proxy-signing"
readonly PREFLIGHT_IDENTITY_HMAC_SECRET_ID="ai-baram-v2-preflight-identity-hmac"
readonly GENDER_ROUTING_HMAC_SECRET_ID="ai-baram-v2-gender-routing-hmac"
readonly APIFY_SLOTS=(primary secondary tertiary quaternary quinary senary septenary tenth)
readonly PROVENANCE_LABEL_KEY="analysis-capacity-source-commit"

mode="check"
mode_was_explicit="false"
reconcile_iam="false"
reconcile_jobs="false"
role="${ANALYSIS_CAPACITY_ROLE:-}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-analysis-capacity-workers.sh --role=preflight|paid [--dry-run | --check | --apply] [--reconcile-iam] [--reconcile-jobs]

Deploys one private split-capacity Cloud Run worker from the shared source
tree. Existing queue names remain analysis-preflight and analysis-v2-pipeline.
The external runtime and build manifests must be strict JSON objects and are
the only non-secret environment inputs. Runtime credentials are always pinned
numeric Secret Manager references; plaintext credentials are rejected.

Required inputs:
  ANALYSIS_CAPACITY_ENV_VARS_FILE
    Non-empty external strict JSON runtime manifest.
  ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE
    Non-empty external strict JSON build manifest containing exactly the two
    public Supabase inputs NEXT_PUBLIC_SUPABASE_URL and
    NEXT_PUBLIC_SUPABASE_ANON_KEY.
  ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT
    Existing dedicated Cloud Build service account.
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION
  ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION
  ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION

Active-stage legacy freeze observations (these are read from the resources,
not accepted from the matching *_CONFIRMED booleans):
  ANALYSIS_CAPACITY_LEGACY_QUEUE_PROJECT, _LOCATION, _QUEUE
  ANALYSIS_CAPACITY_LEGACY_TARGET_URL
  ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL
  ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE

Modes:
  --dry-run  Print the executable source/build/secret deployment plan only.
  --check    Verify the observed canonical URL/traffic revision, manifest,
             env gates, scaling, runtime, exact pinned secret refs, and
             private IAM without mutating resources. (Default.)
  --apply    Deploy and then run the exact same full verification.
  --reconcile-iam is valid only with an explicit --apply and replaces only the
             roles/run.invoker binding; unrelated service IAM bindings remain.
  --reconcile-jobs is valid only with an explicit --apply and permits replacing
             reviewed preflight recovery scheduler drift.

Stage contract:
  bootstrap: all admission/worker gates false; private build/runtime/IAM only.
  initial:   role gates and admission true; preflight max 32, paid max 8.
  expanded:  role gates and admission true; preflight max 64, paid max 16,
             and ANALYSIS_CAPACITY_EXPANSION_CANARY=true.
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

while (($# > 0)); do
  case "$1" in
    --role=preflight|--role=paid)
      role="${1#--role=}"
      ;;
    --dry-run|--check|--apply)
      [[ "$mode_was_explicit" == "false" ]] \
        || die "choose exactly one of --dry-run, --check, or --apply"
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
    *)
      die "unknown argument: $1"
      ;;
  esac
  shift
done

[[ "$reconcile_iam" != "true" || ("$mode" == "apply" && "$mode_was_explicit" == "true") ]] \
  || die "--reconcile-iam requires explicit --apply"
[[ "$reconcile_jobs" != "true" || ("$mode" == "apply" && "$mode_was_explicit" == "true") ]] \
  || die "--reconcile-jobs requires explicit --apply"
[[ "$role" == "preflight" || "$role" == "paid" ]] \
  || die "--role=preflight or --role=paid is required"
[[ "${ANALYSIS_WORKLOAD_ROLE:-}" == "$role" ]] \
  || die "ANALYSIS_WORKLOAD_ROLE must equal --role"

stage="${ANALYSIS_CAPACITY_STAGE:-initial}"
expansion_canary="${ANALYSIS_CAPACITY_EXPANSION_CANARY:-false}"
[[ "$stage" == "bootstrap" || "$stage" == "initial" || "$stage" == "expanded" ]] \
  || die "ANALYSIS_CAPACITY_STAGE must be bootstrap, initial, or expanded"
[[ "$expansion_canary" == "true" || "$expansion_canary" == "false" ]] \
  || die "ANALYSIS_CAPACITY_EXPANSION_CANARY must be true or false"
if [[ "$stage" == "expanded" && "$expansion_canary" != "true" ]]; then
  die "expanded capacity requires ANALYSIS_CAPACITY_EXPANSION_CANARY=true"
fi
if [[ "$stage" != "expanded" && "$expansion_canary" == "true" ]]; then
  die "ANALYSIS_CAPACITY_EXPANSION_CANARY=true is valid only for expanded capacity"
fi

legacy_freeze_mode="${ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE:-bootstrap}"
legacy_producers_frozen="${ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN:-false}"
legacy_tasks_drained="${ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED:-false}"
legacy_targets_blocked="${ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED:-false}"
legacy_queue_pause_confirmed="${ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED:-false}"
public_freeze_enabled="${ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED:-false}"
if [[ "$stage" != "bootstrap" ]]; then
  [[ "$legacy_freeze_mode" == "drain-and-block" ]] \
    || die "active capacity stages require ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE=drain-and-block"
  [[ "$legacy_producers_frozen" == "true" ]] \
    || die "active capacity stages require legacy producers to be frozen"
  [[ "$legacy_tasks_drained" == "true" ]] \
    || die "active capacity stages require old-target tasks to be drained"
  [[ "$legacy_targets_blocked" == "true" ]] \
    || die "active capacity stages require old invocation targets to be blocked"
  [[ "$legacy_queue_pause_confirmed" == "true" ]] \
    || die "active capacity stages require old queue pause/target freeze confirmation"
  [[ "$public_freeze_enabled" == "true" ]] \
    || die "active capacity stages require ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED=true"
fi

if [[ "$role" == "preflight" ]]; then
  prefix="PREFLIGHT_TASKS"
  runtime_var="PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  maintenance_var="PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
  maintenance_audience_var="PREFLIGHT_TASKS_MAINTENANCE_OIDC_AUDIENCE"
  recovery_gate_var="PREFLIGHT_TASKS_RECOVERY_ENABLED"
  path="/api/analysis/preflight/worker"
  max_instances=32
  required_gates=(PREFLIGHT_TASKS_ENABLED)
  [[ "$stage" == "expanded" ]] && max_instances=64
else
  prefix="ANALYSIS_V2_TASKS"
  runtime_var="ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  maintenance_var="ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
  maintenance_audience_var="ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE"
  recovery_gate_var="ANALYSIS_V2_RECOVERY_ENABLED"
  path="/api/analysis/v2/worker"
  max_instances=8
  required_gates=(ANALYSIS_V2_TASKS_ENABLED ANALYSIS_V2_WORKER_ENABLED)
  [[ "$stage" == "expanded" ]] && max_instances=16
fi

project_var="${prefix}_PROJECT"
location_var="${prefix}_LOCATION"
region_var="${prefix}_CLOUD_RUN_REGION"
service_var="${prefix}_CLOUD_RUN_SERVICE"
queue_var="${prefix}_QUEUE"
target_var="${prefix}_TARGET_URL"
audience_var="${prefix}_OIDC_AUDIENCE"
task_sa_var="${prefix}_SERVICE_ACCOUNT_EMAIL"
enqueuer_var="${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL"

project="${!project_var:-}"
location="${!location_var:-}"
region="${!region_var:-}"
service="${!service_var:-}"
queue="${!queue_var:-}"
target="${!target_var:-}"
audience="${!audience_var:-}"
task_sa="${!task_sa_var:-}"
enqueuer="${!enqueuer_var:-}"
runtime="${!runtime_var:-}"
maintenance="${!maintenance_var:-}"
maintenance_audience="${!maintenance_audience_var:-}"
recovery_enabled="${!recovery_gate_var:-}"
source_dir="${ANALYSIS_CAPACITY_SOURCE_DIR:-.}"
env_file="${ANALYSIS_CAPACITY_ENV_VARS_FILE:-}"
build_env_file="${ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE:-}"
build_service_account="${ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT:-}"
deploy_lock_bucket="${ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET:-}"
legacy_queue_project="${ANALYSIS_CAPACITY_LEGACY_QUEUE_PROJECT:-}"
legacy_queue_location="${ANALYSIS_CAPACITY_LEGACY_QUEUE_LOCATION:-}"
legacy_queue="${ANALYSIS_CAPACITY_LEGACY_QUEUE:-}"
legacy_target_url="${ANALYSIS_CAPACITY_LEGACY_TARGET_URL:-}"
legacy_target_resource="${ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE:-}"
public_freeze_readiness_url="${ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL:-}"

[[ -n "$project" && -n "$location" && -n "$region" && -n "$service" \
   && -n "$queue" && -n "$target" && -n "$audience" && -n "$task_sa" \
   && -n "$enqueuer" && -n "$runtime" ]] \
  || die "role-prefixed project, location, region, queue, service, target, audience, task, enqueuer, and runtime are required"
worker_cpu="${ANALYSIS_CAPACITY_WORKER_CPU:-2}"
worker_memory="${ANALYSIS_CAPACITY_WORKER_MEMORY:-2Gi}"
[[ -n "$env_file" ]] || die "ANALYSIS_CAPACITY_ENV_VARS_FILE must be a non-empty manifest path"
[[ -n "$build_env_file" ]] \
  || die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be a non-empty manifest path"
[[ -n "$build_service_account" ]] \
  || die "ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT is required"
[[ -n "$deploy_lock_bucket" ]] \
  || die "ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET is required"
[[ "$worker_cpu" =~ ^(1|2|4)$ ]] \
  || die "ANALYSIS_CAPACITY_WORKER_CPU must be 1, 2, or 4"
[[ "$worker_memory" =~ ^[1-9][0-9]*(Mi|Gi)$ ]] \
  || die "ANALYSIS_CAPACITY_WORKER_MEMORY must use Mi or Gi units"

[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "invalid project"
[[ "$location" == "$DEFAULT_LOCATION" ]] || die "location must be $DEFAULT_LOCATION"
[[ "$region" == "$DEFAULT_LOCATION" ]] || die "Cloud Run region must be $DEFAULT_LOCATION"
[[ "$queue" =~ ^[a-z]([a-z0-9-]{0,98}[a-z0-9])?$ ]] || die "invalid queue"
[[ "$service" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] || die "invalid Cloud Run service"
[[ "$service" == *"$role"* ]] || die "Cloud Run service must contain its workload role"
service_account_pattern='^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$'
[[ "$task_sa" =~ $service_account_pattern ]] || die "invalid task service account"
[[ "$enqueuer" =~ $service_account_pattern ]] || die "invalid enqueuer service account"
[[ "$runtime" =~ $service_account_pattern ]] || die "invalid runtime service account"
[[ -n "$maintenance" ]] || die "$maintenance_var is required for the $role worker"
[[ "$maintenance" =~ $service_account_pattern ]] || die "invalid maintenance service account"
[[ "$build_service_account" =~ $service_account_pattern ]] \
  || die "invalid build service account"
[[ "$task_sa" != "$runtime" && "$task_sa" != "$enqueuer" && "$runtime" != "$enqueuer" ]] \
  || die "task, enqueuer, and runtime identities must be distinct"
[[ "${task_sa#*@}" == "${project}.iam.gserviceaccount.com" ]] \
  || die "task service account must belong to the task project"
[[ "${runtime#*@}" == "${project}.iam.gserviceaccount.com" ]] \
  || die "runtime service account must belong to the task project"
[[ "${build_service_account#*@}" == "${project}.iam.gserviceaccount.com" ]] \
  || die "build service account must belong to the task project"
[[ "${maintenance#*@}" == "${project}.iam.gserviceaccount.com" ]] \
  || die "maintenance service account must belong to the task project"
[[ "$maintenance" != "$task_sa" && "$maintenance" != "$enqueuer" \
   && "$maintenance" != "$runtime" && "$maintenance" != "$build_service_account" ]] \
  || die "$role maintenance identity must be distinct from task, enqueuer, runtime, and build identities"
[[ "$target" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?${path}$ ]] \
  || die "target URL must be the exact HTTPS $path endpoint"
origin="${target%$path}"
[[ "$audience" == "$origin" || "$audience" == "$origin/" ]] \
  || die "OIDC audience must be the target origin"
[[ -n "$maintenance_audience" ]] || die "$maintenance_audience_var is required for the $role worker"
[[ "$maintenance_audience" == "$origin" || "$maintenance_audience" == "$origin/" ]] \
  || die "$maintenance_audience_var must equal the target origin"
[[ "$recovery_enabled" == "true" || "$recovery_enabled" == "false" ]] \
  || die "$recovery_gate_var must be explicitly true or false"
if [[ "$stage" == "bootstrap" ]]; then
  [[ "$recovery_enabled" == "false" ]] \
    || die "$recovery_gate_var must be false during bootstrap"
else
  [[ "$recovery_enabled" == "true" ]] \
    || die "$recovery_gate_var must be true after bootstrap"
fi

if [[ "$stage" != "bootstrap" ]]; then
  [[ -n "$legacy_queue_project" && -n "$legacy_queue_location" && -n "$legacy_queue" \
     && -n "$legacy_target_url" && -n "$legacy_target_resource" \
     && -n "$public_freeze_readiness_url" ]] \
    || die "active capacity stages require exact legacy queue, target, and public freeze observation identifiers"
  [[ "$legacy_queue_project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || die "ANALYSIS_CAPACITY_LEGACY_QUEUE_PROJECT is invalid"
  [[ "$legacy_queue_location" =~ ^[a-z]+-[a-z]+[0-9]$ ]] \
    || die "ANALYSIS_CAPACITY_LEGACY_QUEUE_LOCATION is invalid"
  [[ "$legacy_queue" =~ ^[a-z]([a-z0-9-]{0,98}[a-z0-9])?$ ]] \
    || die "ANALYSIS_CAPACITY_LEGACY_QUEUE is invalid"
  [[ "$legacy_target_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/api/analysis/(start|step|run)$ ]] \
    || die "ANALYSIS_CAPACITY_LEGACY_TARGET_URL must be one exact public V1 route"
  [[ "$public_freeze_readiness_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/api/analysis/capacity/readiness$ ]] \
    || die "ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL must be the exact read-only freeze endpoint"
  [[ -n "$legacy_target_resource" && ${#legacy_target_resource} -le 256 \
     && "$legacy_target_resource" != *[!A-Za-z0-9._:/@-]* ]] \
    || die "ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE is invalid"
  legacy_public_origin="${legacy_target_url%%/api/analysis/*}"
  readiness_public_origin="${public_freeze_readiness_url%%/api/analysis/*}"
  [[ -n "$legacy_public_origin" && "$legacy_public_origin" == "$readiness_public_origin" ]] \
    || die "public readiness and legacy V1 target URLs must share the exact same origin"
fi

other_prefix="PREFLIGHT_TASKS"
[[ "$role" == "preflight" ]] && other_prefix="ANALYSIS_V2_TASKS"
other_path="/api/analysis/v2/worker"
[[ "$role" == "paid" ]] && other_path="/api/analysis/preflight/worker"
other_target_var="${other_prefix}_TARGET_URL"
other_audience_var="${other_prefix}_OIDC_AUDIENCE"
other_queue_var="${other_prefix}_QUEUE"
other_service_var="${other_prefix}_CLOUD_RUN_SERVICE"
other_task_var="${other_prefix}_SERVICE_ACCOUNT_EMAIL"
other_enqueuer_var="${other_prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
other_runtime_var="PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
[[ "$role" == "preflight" ]] && other_runtime_var="ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
other_target="${!other_target_var:-}"
other_audience="${!other_audience_var:-}"
other_queue="${!other_queue_var:-}"
other_service="${!other_service_var:-}"
other_task="${!other_task_var:-}"
other_enqueuer="${!other_enqueuer_var:-}"
other_runtime="${!other_runtime_var:-}"
[[ -n "$other_target" && -n "$other_audience" && -n "$other_queue" && -n "$other_service" \
   && -n "$other_task" && -n "$other_enqueuer" && -n "$other_runtime" ]] \
  || die "the other workload target, audience, queue, service, and identities are required"
[[ "$queue" != "$other_queue" ]] || die "preflight and paid queue names must be distinct"
[[ "$service" != "$other_service" ]] || die "preflight and paid Cloud Run service names must be distinct"
[[ "${origin%/}" != "${other_target%$other_path}" ]] \
  || die "preflight and paid target origins must be distinct"
[[ "${audience%/}" != "${other_audience%/}" ]] \
  || die "preflight and paid OIDC audiences must be distinct"
identity_values=("$task_sa" "$enqueuer" "$runtime" "$other_task" "$other_enqueuer" "$other_runtime")
for ((identity_index = 0; identity_index < ${#identity_values[@]}; identity_index += 1)); do
  for ((other_identity_index = identity_index + 1; other_identity_index < ${#identity_values[@]}; other_identity_index += 1)); do
    [[ "${identity_values[$identity_index]}" != "${identity_values[$other_identity_index]}" ]] \
      || die "all preflight/paid task, enqueuer, and runtime identities must be distinct"
  done
done

command -v jq >/dev/null 2>&1 || die "jq is required before parsing strict JSON manifests"
[[ -d "$source_dir" ]] || die "ANALYSIS_CAPACITY_SOURCE_DIR does not exist"
[[ -f "$source_dir/package.json" ]] || die "ANALYSIS_CAPACITY_SOURCE_DIR must contain package.json"
[[ -f "$env_file" ]] || die "ANALYSIS_CAPACITY_ENV_VARS_FILE does not exist"
[[ -s "$env_file" ]] || die "ANALYSIS_CAPACITY_ENV_VARS_FILE must not be empty"
[[ -f "$build_env_file" ]] || die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE does not exist"
[[ -s "$build_env_file" ]] || die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must not be empty"

manifest_value() {
  local file="$1"
  local key="$2"
  jq -er --arg key "$key" \
    'if type == "object" and (.[$key] | type) == "string" then .[$key] else empty end' \
    "$file"
}

require_manifest_value() {
  local file="$1"
  local key="$2"
  local expected="$3"
  local actual
  actual="$(manifest_value "$file" "$key" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] \
    || die "runtime manifest does not set the required $key value"
}

validate_runtime_manifest() {
  jq -e 'type == "object"' "$env_file" >/dev/null \
    || die "runtime env manifest must be a strict JSON object"
  require_manifest_value "$env_file" "$project_var" "$project"
  require_manifest_value "$env_file" "${prefix}_LOCATION" "$location"
  require_manifest_value "$env_file" "$queue_var" "$queue"
  require_manifest_value "$env_file" "$target_var" "$target"
  require_manifest_value "$env_file" "$audience_var" "$audience"
  require_manifest_value "$env_file" "$task_sa_var" "$task_sa"
  require_manifest_value "$env_file" "$maintenance_var" "$maintenance"
  require_manifest_value "$env_file" "$maintenance_audience_var" "$maintenance_audience"
  require_manifest_value "$env_file" "$recovery_gate_var" "$recovery_enabled"
  require_manifest_value "$env_file" ANALYSIS_WORKLOAD_ROLE "$role"
  require_manifest_value "$env_file" ANALYSIS_CAPACITY_STAGE "$stage"
  require_manifest_value "$env_file" ANALYSIS_CAPACITY_EXPANSION_CANARY "$expansion_canary"
  require_manifest_value "$env_file" ANALYSIS_CAPACITY_WORKER_CPU "$worker_cpu"
  require_manifest_value "$env_file" ANALYSIS_CAPACITY_WORKER_MEMORY "$worker_memory"
  require_manifest_value "$env_file" ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED "$public_freeze_enabled"
  # The active exact-three preflight rollout retires beta_prepare entirely;
  # only an isolated legacy-drain rehearsal may carry an explicit true value.
  require_manifest_value "$env_file" ANALYSIS_BETA_PREPARE_ENABLED false
  if [[ "$stage" == "bootstrap" ]]; then
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE bootstrap
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN false
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED false
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED false
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED false
  else
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE drain-and-block
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN true
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED true
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED true
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED true
  fi
  if [[ "$stage" == "bootstrap" ]]; then
    require_manifest_value "$env_file" ANALYSIS_PROVIDER_ADMISSION_ENABLED false
    for gate in "${required_gates[@]}"; do
      require_manifest_value "$env_file" "$gate" false
    done
  else
    require_manifest_value "$env_file" ANALYSIS_PROVIDER_ADMISSION_ENABLED true
    require_manifest_value "$env_file" ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED true
    for gate in "${required_gates[@]}"; do
      require_manifest_value "$env_file" "$gate" true
    done
  fi
  while IFS= read -r key; do
    case "$key" in
      APIFY_*_API_TOKEN|APIFY_API_TOKEN|SUPABASE_SERVICE_ROLE_KEY|IMAGE_PROXY_SIGNING_SECRET|ANALYSIS_V2_*_HMAC_SECRET|*_PASSWORD|*_PRIVATE_KEY|*_ACCESS_TOKEN|*_REFRESH_TOKEN|*_SECRET)
        die "runtime manifest contains a plaintext credential key: $key"
        ;;
    esac
  done < <(jq -r 'keys[]' "$env_file")
}

validate_build_manifest() {
  jq -e \
    'type == "object"
     and ((keys | sort) == ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"])
     and (.NEXT_PUBLIC_SUPABASE_URL | type == "string" and length > 0)
     and (.NEXT_PUBLIC_SUPABASE_ANON_KEY | type == "string" and length > 0)' \
    "$build_env_file" >/dev/null \
    || die "build env manifest must be strict JSON with exactly two non-empty public Supabase values"
  jq -e '.NEXT_PUBLIC_SUPABASE_URL | test("^https://[a-z0-9]{20}\\.supabase\\.co$")' \
    "$build_env_file" >/dev/null \
    || die "build env manifest Supabase URL is not canonical HTTPS"
}

validate_runtime_manifest
validate_build_manifest

source_sha="$(git -C "$source_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" \
  || die "ANALYSIS_CAPACITY_SOURCE_DIR must have a valid Git source commit"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] \
  || die "ANALYSIS_CAPACITY_SOURCE_DIR source provenance is invalid"
[[ -z "$(git -C "$source_dir" status --porcelain --untracked-files=all)" ]] \
  || die "ANALYSIS_CAPACITY_SOURCE_DIR must have no tracked, staged, or untracked changes"

[[ "$deploy_lock_bucket" != */* && "$deploy_lock_bucket" != *[[:space:]]* ]] \
  || die "ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET must be one exact bucket name"

numeric_version() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] \
    || die "$name must be an exact positive numeric Secret Manager version; latest is forbidden"
}

supabase_secret_version="${ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION:-}"
apify_secret_version="${ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION:-}"
image_signing_secret_version="${ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION:-}"
identity_hmac_secret_version="${ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION:-}"
gender_hmac_secret_version="${ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION:-}"
numeric_version ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION "$supabase_secret_version"
numeric_version ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION "$apify_secret_version"
numeric_version ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION "$image_signing_secret_version"
numeric_version ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION "$identity_hmac_secret_version"
numeric_version ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION "$gender_hmac_secret_version"

if [[ "$mode" == "check" || "$mode" == "apply" ]]; then
  github_ci_script="$(dirname "$0")/require-github-ci-success.sh"
  [[ -f "$github_ci_script" ]] || die "require-github-ci-success.sh is missing"
  bash "$github_ci_script" "$source_sha"
fi

supabase_public_url="$(manifest_value "$build_env_file" NEXT_PUBLIC_SUPABASE_URL)"

call_capacity_activation_readiness_rpc() {
  local response
  response="$({
    gcloud secrets versions access "$supabase_secret_version" \
      "--secret=$SUPABASE_SECRET_ID" \
      "--project=$project" \
      --no-log-http \
      --verbosity=error \
      --quiet \
      | awk '
          NR == 1 && length($0) > 0 {
            printf "apikey: %s\n", $0
            printf "Authorization: Bearer %s\n", $0
            next
          }
          { exit 42 }
          END { if (NR != 1) exit 42 }
        '
  } | curl --disable --silent --show-error --fail-with-body \
      --header @- \
      --request POST \
      --header 'Content-Type: application/json' \
      --proto '=https' \
      --max-redirs 0 \
      --url "${supabase_public_url%/}/rest/v1/rpc/analysis_capacity_activation_readiness" \
      --data-binary '{}')" || return 1
  printf '%s\n' "$response"
}

verify_capacity_activation_readiness() {
  local response
  [[ "$stage" != "bootstrap" ]] || return 0
  command -v curl >/dev/null 2>&1 || die "curl is required for the authoritative capacity activation barrier"
  response="$(call_capacity_activation_readiness_rpc)" \
    || die "authoritative capacity activation readiness could not be obtained"
  jq -e '
    (keys | sort) == ([
      "ready",
      "legacyActiveProviderRuns",
      "legacyActivePreflightRuns",
      "legacyActiveProfileRepairRuns",
      "legacyActiveV1ProviderRuns",
      "legacyActiveProcessingClaims",
      "legacyActiveV2JobClaims",
      "legacyActiveProfileProviderCanaryRuns",
      "legacyActiveOldTargetInvocations",
      "legacyActiveQueuedPreflightTasks",
      "legacyActiveQueuedV2Tasks",
      "legacyActiveFreshAdmissions",
      "legacyActiveBetaPrepare",
      "unreconciledProviderRuns",
      "unreconciledPreflightRuns",
      "unreconciledProfileRepairRuns",
      "unreconciledV1ProviderRuns",
      "unreconciledProfileProviderCanaryRuns",
      "legacyActiveTotal",
      "unreconciledTotal"
    ] | sort)
    and .ready == true
    and ([
      .legacyActiveProviderRuns,
      .legacyActivePreflightRuns,
      .legacyActiveProfileRepairRuns,
      .legacyActiveV1ProviderRuns,
      .legacyActiveProcessingClaims,
      .legacyActiveV2JobClaims,
      .legacyActiveProfileProviderCanaryRuns,
      .legacyActiveOldTargetInvocations,
      .legacyActiveQueuedPreflightTasks,
      .legacyActiveQueuedV2Tasks,
      .legacyActiveFreshAdmissions,
      .legacyActiveBetaPrepare,
      .unreconciledProviderRuns,
      .unreconciledPreflightRuns,
      .unreconciledProfileRepairRuns,
      .unreconciledV1ProviderRuns,
      .unreconciledProfileProviderCanaryRuns,
      .legacyActiveTotal,
      .unreconciledTotal
    ] | all(type == "number" and . == 0))
  ' <<<"$response" >/dev/null \
    || die "authoritative capacity activation barrier is not ready; legacy active or unreconciled provider work remains"
  log "verified: authoritative zero legacy active/ambiguous and unreconciled provider ledger barrier"
}

call_public_freeze_readiness() {
  curl --disable --proto '=https' --tlsv1.2 \
    --max-redirs 0 --connect-timeout 10 --max-time 30 \
    --fail --silent --show-error \
    --request GET \
    --header 'Accept: application/json' \
    --url "$public_freeze_readiness_url"
}

verify_legacy_quiescence() {
  [[ "$stage" != "bootstrap" ]] || return 0
  local queue_json
  local task_json
  local public_json
  queue_json="$(gcloud tasks queues describe "$legacy_queue" \
    "--project=$legacy_queue_project" \
    "--location=$legacy_queue_location" \
    '--format=json')" \
    || die "legacy Cloud Tasks queue could not be observed"
  jq -e --arg queue "$legacy_queue" '
    ((.name // "") | endswith("/queues/" + $queue))
    and (.state // "") == "PAUSED"
  ' <<<"$queue_json" >/dev/null \
    || die "legacy Cloud Tasks queue is not the exact PAUSED queue"
  task_json="$(gcloud tasks list \
    "--queue=$legacy_queue" \
    "--project=$legacy_queue_project" \
    "--location=$legacy_queue_location" \
    '--format=json')" \
    || die "legacy Cloud Tasks queue contents could not be observed"
  jq -e 'type == "array" and length == 0' <<<"$task_json" >/dev/null \
    || die "legacy Cloud Tasks queue is not empty"
  public_json="$(call_public_freeze_readiness)" \
    || die "public V1 freeze readiness observation failed"
  jq -e --arg source_sha "$source_sha" \
    --arg target_resource "$legacy_target_resource" '
    (keys | sort) == ["freezeMode", "legacyTargetResource", "publicFreezeEnabled", "ready", "routes", "schemaVersion", "sourceSha", "stage"]
    and .schemaVersion == "analysis-public-freeze-readiness-v1"
    and .ready == true
    and (.stage == "initial" or .stage == "expanded")
    and .freezeMode == "drain-and-block"
    and .publicFreezeEnabled == true
    and .sourceSha == $source_sha
    and .legacyTargetResource == $target_resource
    and ((.routes | keys | sort) == ["/api/analysis/run", "/api/analysis/start", "/api/analysis/step"])
    and ([.routes[] | select(.gateState == "frozen" and .expectedStatus == 410 and .gateBeforeRuntime == true)] | length) == 3
  ' <<<"$public_json" >/dev/null \
    || die "public V1 service does not expose exact gate-before-runtime freeze evidence"
  probe_legacy_route() {
    local route="$1"
    local body_file
    local status
    body_file="$(mktemp "${TMPDIR:-/tmp}/analysis-capacity-public-freeze.XXXXXX")"
    if ! status="$(curl --disable --proto '=https' --tlsv1.2 \
      --max-redirs 0 --connect-timeout 10 --max-time 30 \
      --silent --show-error \
      --request POST \
      --header 'Accept: application/json' \
      --header 'Content-Type: application/json' \
      --data-binary '{}' \
      --output "$body_file" \
      --write-out '%{http_code}' \
      --url "${legacy_public_origin}${route}")"; then
      rm -f -- "$body_file"
      die "public V1 freeze probe failed for $route"
    fi
    if [[ "$status" != '410' ]]; then
      rm -f -- "$body_file"
      die "public V1 freeze probe for $route returned HTTP $status, expected 410"
    fi
    jq -e 'type == "object" and (keys | sort) == ["code"] and .code == "LEGACY_ANALYSIS_FROZEN"' \
      "$body_file" >/dev/null 2>&1 \
      || { rm -f -- "$body_file"; die "public V1 freeze probe for $route did not return exact LEGACY_ANALYSIS_FROZEN JSON"; }
    rm -f -- "$body_file"
  }
  for legacy_route in /api/analysis/start /api/analysis/step /api/analysis/run; do
    probe_legacy_route "$legacy_route"
  done
  log "verified: legacy queue $legacy_queue is paused and empty; public target $legacy_target_url is frozen"
}

selected_slot="${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-}"
[[ "$selected_slot" =~ ^(primary|secondary|tertiary|quaternary|quinary|senary|septenary|tenth)$ ]] \
  || die "ANALYSIS_V2_APIFY_API_TOKEN_SLOT is invalid"
if [[ "$role" == "paid" && "$stage" != "bootstrap" ]]; then
  [[ "$selected_slot" == "secondary" ]] \
    || die "active paid worker must select ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary"
fi
require_manifest_value "$env_file" ANALYSIS_V2_APIFY_API_TOKEN_SLOT "$selected_slot"
selected_slot_upper="$(printf '%s' "$selected_slot" | tr '[:lower:]' '[:upper:]')"
apify_env_key="APIFY_${selected_slot_upper}_API_TOKEN"

secret_ref_entries=(
  "$apify_env_key|ai-baram-v2-apify-$selected_slot|$apify_secret_version"
  "SUPABASE_SERVICE_ROLE_KEY|$SUPABASE_SECRET_ID|$supabase_secret_version"
  "IMAGE_PROXY_SIGNING_SECRET|$IMAGE_SIGNING_SECRET_ID|$image_signing_secret_version"
  "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET|$PREFLIGHT_IDENTITY_HMAC_SECRET_ID|$identity_hmac_secret_version"
  "ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET|$GENDER_ROUTING_HMAC_SECRET_ID|$gender_hmac_secret_version"
)

additional_refs="${ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS:-}"
if [[ -n "$additional_refs" ]]; then
  IFS=',' read -r -a additional_entries <<<"$additional_refs"
  for entry in "${additional_entries[@]}"; do
    slot="${entry%%:*}"
    version="${entry#*:}"
    [[ "$entry" == "$slot:$version" && -n "$slot" && -n "$version" ]] \
      || die "ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS must be slot:version entries"
    [[ "$slot" =~ ^(primary|secondary|tertiary|quaternary|quinary|senary|septenary|tenth)$ ]] \
      || die "invalid additional Apify credential slot"
    numeric_version ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS "$version"
    [[ "$slot" != "$selected_slot" ]] || die "additional Apify refs must not repeat selected slot"
    slot_upper="$(printf '%s' "$slot" | tr '[:lower:]' '[:upper:]')"
    secret_ref_entries+=("APIFY_${slot_upper}_API_TOKEN|ai-baram-v2-apify-$slot|$version")
  done
fi
if [[ "$role" == "preflight" ]]; then
  preflight_slots="${PREFLIGHT_APIFY_API_TOKEN_SLOTS:-primary,quinary,senary}"
  IFS=',' read -r -a required_preflight_slots <<<"$preflight_slots"
  [[ "$preflight_slots" == "primary,quinary,senary" ]] \
    || die "PREFLIGHT_APIFY_API_TOKEN_SLOTS must remain exactly primary,quinary,senary"
  slot_is_preflight="false"
  for slot in "${required_preflight_slots[@]}"; do
    [[ "$slot" == "$selected_slot" ]] && slot_is_preflight="true"
  done
  [[ "$slot_is_preflight" == "true" ]] \
    || die "preflight selected Apify slot must belong to primary,quinary,senary"
  for slot in "${required_preflight_slots[@]}"; do
    found="false"
    slot_upper="$(printf '%s' "$slot" | tr '[:lower:]' '[:upper:]')"
    expected_env="APIFY_${slot_upper}_API_TOKEN"
    for entry in "${secret_ref_entries[@]}"; do
      [[ "${entry%%|*}" == "$expected_env" ]] && found="true"
    done
      [[ "$found" == "true" ]] \
      || die "preflight requires an exact numeric Apify Secret Manager ref for $slot"
  done
  apify_entry_count=0
  for entry in "${secret_ref_entries[@]}"; do
    [[ "${entry%%|*}" == APIFY_*_API_TOKEN ]] || continue
    apify_entry_count=$((apify_entry_count + 1))
    expected_slot="$(printf '%s' "${entry%%|*}" | sed -E 's/^APIFY_(.*)_API_TOKEN$/\1/' | tr '[:upper:]' '[:lower:]')"
    [[ ",${preflight_slots}," == *",${expected_slot},"* ]] \
      || die "preflight cannot carry an Apify ref outside primary,quinary,senary"
  done
  [[ "$apify_entry_count" == "3" ]] \
    || die "preflight must carry exactly three Apify refs: primary,quinary,senary"
else
  # Paid V2 can resume frozen policy cohorts on every historical credential slot.  Requiring
  # the complete eight-slot inventory here keeps release/recovery from depending on a selected
  # slot only; the ordinary production relationship policy still selects secondary at runtime.
  for slot in "${APIFY_SLOTS[@]}"; do
    found="false"
    slot_upper="$(printf '%s' "$slot" | tr '[:lower:]' '[:upper:]')"
    expected_env="APIFY_${slot_upper}_API_TOKEN"
    for entry in "${secret_ref_entries[@]}"; do
      [[ "${entry%%|*}" == "$expected_env" ]] && found="true"
    done
    [[ "$found" == "true" ]] \
      || die "paid worker requires an exact numeric Apify Secret Manager ref for every slot ($slot)"
  done
  apify_entry_count=0
  for entry in "${secret_ref_entries[@]}"; do
    [[ "${entry%%|*}" == APIFY_*_API_TOKEN ]] || continue
    apify_entry_count=$((apify_entry_count + 1))
  done
  [[ "$apify_entry_count" == "8" ]] \
    || die "paid worker must carry exactly eight Apify refs"
fi

secret_assignments=""
for entry in "${secret_ref_entries[@]}"; do
  secret_env="${entry%%|*}"
  remainder="${entry#*|}"
  secret_id="${remainder%%|*}"
  secret_version="${remainder#*|}"
  assignment="$secret_env=$secret_id:$secret_version"
  if [[ -n "$secret_assignments" ]]; then secret_assignments="$secret_assignments,"; fi
  secret_assignments="$secret_assignments$assignment"
done

allowed_invoker_members_json="$(printf '%s\n' \
  "serviceAccount:$task_sa" "serviceAccount:$maintenance" \
  | jq -Rsc 'split("\n") | map(select(length > 0)) | unique | sort')"

iam_policy_file=""
deploy_lock_payload_file=""
deploy_lock_url=""
deploy_lock_generation=""
deploy_lock_acquired="false"
rollback_armed="false"
previous_traffic_json='[]'
previous_traffic_projection='[]'
previous_traffic_spec=''
staged_revision=''
cleanup() {
  local cleanup_status=0
  if [[ -n "${iam_policy_file:-}" ]]; then
    rm -f -- "$iam_policy_file"
    iam_policy_file=""
  fi
  if [[ -n "${deploy_lock_payload_file:-}" ]]; then
    rm -f -- "$deploy_lock_payload_file"
    deploy_lock_payload_file=""
  fi
  if [[ "$deploy_lock_acquired" == "true" ]]; then
    if ! gcloud storage rm "$deploy_lock_url" \
      "--if-generation-match=$deploy_lock_generation" --quiet >/dev/null 2>&1; then
      printf 'critical: deploy lock release failed; inspect %s before manual removal\n' "$deploy_lock_url" >&2
      cleanup_status=1
    else
      deploy_lock_acquired="false"
    fi
  fi
  return "$cleanup_status"
}

rollback_live_traffic() {
  [[ "$rollback_armed" == "true" ]] || return 0
  [[ -n "$previous_traffic_spec" ]] || {
    printf 'critical: no prior traffic allocation was captured; refusing implicit rollback\n' >&2
    return 1
  }
  local current_json
  local current_projection
  local staged_projection
  current_json="$(gcloud run services describe "$service" \
    "--project=$project" "--region=$region" '--format=json' 2>/dev/null)" \
    || { printf 'critical: could not observe service before rollback\n' >&2; return 1; }
  current_projection="$(traffic_projection "$current_json")" || return 1
  staged_projection="$(jq -cn --arg revision "$staged_revision" '[{revisionName:$revision,percent:100}]')"
  # A rollback is ownership-safe: another deploy must not be overwritten.  We
  # only accept the captured allocation or the exact staged single revision.
  if [[ "$current_projection" != "$previous_traffic_projection" \
     && "$current_projection" != "$staged_projection" ]]; then
    printf 'critical: refusing stale rollback because live traffic is owned by another revision\n' >&2
    return 1
  fi
  gcloud run services update-traffic "$service" \
    "--project=$project" "--region=$region" \
    "--to-revisions=$previous_traffic_spec" --quiet >/dev/null \
    || { printf 'critical: exact previous traffic rollback failed\n' >&2; return 1; }
  current_json="$(gcloud run services describe "$service" \
    "--project=$project" "--region=$region" '--format=json' 2>/dev/null)" \
    || { printf 'critical: could not observe service after rollback\n' >&2; return 1; }
  current_projection="$(traffic_projection "$current_json")" || return 1
  [[ "$current_projection" == "$previous_traffic_projection" ]] \
    || { printf 'critical: rollback traffic does not match the captured allocation\n' >&2; return 1; }
  printf 'rollback verified: restored exact pre-deploy traffic allocation\n' >&2
  rollback_armed="false"
}

on_exit() {
  local status="$?"
  trap - EXIT
  if [[ "$status" != "0" && "$rollback_armed" == "true" ]]; then
    rollback_live_traffic \
      || printf 'critical: automatic rollback could not be verified; inspect service traffic before retrying\n' >&2
  fi
  local cleanup_status=0
  cleanup || cleanup_status="$?"
  if [[ "$status" == "0" && "$cleanup_status" != "0" ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap on_exit EXIT

deploy_args=(
  run deploy "$service"
  "--project=$project"
  "--region=$region"
  "--source=$source_dir"
  "--service-account=$runtime"
  '--execution-environment=gen2'
  '--concurrency=1'
  "--max-instances=$max_instances"
  '--min-instances=0'
  '--timeout=600s'
  "--cpu=$worker_cpu"
  "--memory=$worker_memory"
  '--no-allow-unauthenticated'
  '--ingress=all'
  '--cpu-throttling'
  "--env-vars-file=$env_file"
  "--build-env-vars-file=$build_env_file"
  "--build-service-account=projects/$project/serviceAccounts/$build_service_account"
  "--set-secrets=$secret_assignments"
  "--update-labels=analysis-workload-role=$role,analysis-capacity-stage=$stage,$PROVENANCE_LABEL_KEY=$source_sha"
  '--quiet'
)
if [[ "$stage" != "bootstrap" ]]; then
  # Active revisions are staged with no traffic.  The authoritative readiness
  # barrier is checked immediately before promotion below.
  deploy_args+=( '--no-traffic' )
fi

if [[ "$mode" == "dry-run" ]]; then
  print_command gcloud "${deploy_args[@]}"
  printf 'plan: %s worker source=%s runtime-manifest=%s build-manifest=%s build-service-account=%s\n' \
    "$role" "$source_dir" "$env_file" "$build_env_file" "$build_service_account"
  printf 'plan: queue=%s target=%s audience=%s task=%s enqueuer=%s runtime=%s max-instances=%s\n' \
    "$queue" "$target" "$audience" "$task_sa" "$enqueuer" "$runtime" "$max_instances"
  printf 'plan: validate canonical status URL, serving revision/traffic, role gates, scaling, exact numeric secret refs, and private IAM\n'
  printf 'dry-run complete: no remote service was observed or changed\n'
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is required for --check/--apply"

service_json=""
service_iam_json=""
env_value() {
  local key="$1"
  jq -r --arg key "$key" \
    '[.spec.template.spec.containers[]?.env[]? | select(.name == $key) | .value][0] // empty' \
    <<<"$service_json"
}

canonical_service_url() {
  jq -r '(.status.url // .status.uri // empty)' <<<"$service_json"
}

traffic_projection() {
  local config="$1"
  jq -c '
    [.status.traffic[]?
      | select((.percent // 0) | tonumber > 0)
      | {revisionName: (.revisionName // ""), percent: ((.percent // 0) | tonumber)}]
    | sort_by(.revisionName)
  ' <<<"$config"
}

traffic_revision_spec() {
  local config="$1"
  jq -r '
    [.status.traffic[]?
      | select((.percent // 0) | tonumber > 0)
      | "\(.revisionName)=\((.percent // 0) | tonumber)"]
    | join(",")
  ' <<<"$config"
}

observe_deploy_lock() {
  local attempt
  local generation
  local owner
  for attempt in 1 2 3; do
    generation="$(gcloud storage objects describe "$deploy_lock_url" \
      '--format=value(generation)' 2>/dev/null || true)"
    if [[ "$generation" =~ ^[1-9][0-9]*$ ]]; then
      owner="$(gcloud storage cat "$deploy_lock_url#$generation" 2>/dev/null || true)"
      if [[ -n "$owner" ]]; then
        printf '%s\t%s\n' "$generation" "$owner"
        return 0
      fi
    fi
    [[ "$attempt" == 3 ]] || sleep "$attempt"
  done
  return 1
}

acquire_deploy_lock() {
  local payload
  local owner_token
  local observed
  local observed_generation
  local observed_owner
  deploy_lock_url="gs://$deploy_lock_bucket/$project/$region/$service.lock"
  deploy_lock_payload_file="$(mktemp "${TMPDIR:-/tmp}/analysis-capacity-deploy-lock.XXXXXX")"
  owner_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" \
    || die "could not generate the deploy-lock owner token"
  payload="$source_sha $owner_token"
  printf '%s\n' "$payload" >"$deploy_lock_payload_file"
  if ! gcloud storage cp "$deploy_lock_payload_file" "$deploy_lock_url" \
    --if-generation-match=0 --quiet >/dev/null 2>&1; then
    log "deploy lock create response was not successful; observing the generation owner"
  fi
  observed="$(observe_deploy_lock)" \
    || die "deploy lock ownership was not observable after bounded retries"
  observed_generation="${observed%%$'\t'*}"
  observed_owner="${observed#*$'\t'}"
  [[ "$observed_owner" == "$payload" ]] \
    || die "another deployment owns the generation-bound deploy lock (owner length ${#observed_owner}, expected ${#payload})"
  deploy_lock_generation="$observed_generation"
  deploy_lock_acquired="true"
  log "acquired generation-bound deploy lock for $service"
}

number_annotation() {
  local key="$1"
  jq -r --arg key "$key" \
    '(.spec.template.metadata.annotations[$key] // "") | tostring' <<<"$service_json"
}

service_exists() {
  gcloud run services describe "$service" \
    "--project=$project" "--region=$region" '--format=json' >/dev/null 2>&1
}

verify_service_iam() {
  jq -e --argjson expected "$allowed_invoker_members_json" '
    ([.bindings[]? | select(.role == "roles/run.invoker")] as $invokers
      | ($invokers | length) == 1
      and ($invokers[0].condition? == null)
      and (($invokers[0].members | sort) == ($expected | sort))
      and ([$invokers[].members[]?]
        | all(. != "allUsers" and . != "allAuthenticatedUsers")))
  ' <<<"$service_iam_json" >/dev/null
}

write_exact_service_iam_policy() {
  local file="$1"
  jq --argjson expected "$allowed_invoker_members_json" '
    .bindings = ((.bindings // [])
      | map(select(.role != "roles/run.invoker"))
      + [{"role": "roles/run.invoker", "members": $expected}])
  ' <<<"$service_iam_json" >"$file"
}

verify_secret_ref() {
  local env_name="$1"
  local secret_name="$2"
  local version="$3"
  jq -e --arg env_name "$env_name" --arg secret_name "$secret_name" --arg version "$version" '
    [.spec.template.spec.containers[]?.env[]? | select(.name == $env_name)] as $entries
    | ($entries | length) == 1
    and ($entries[0] | has("value") | not)
    and ($entries[0].valueFrom.secretKeyRef.name == $secret_name)
    and (($entries[0].valueFrom.secretKeyRef.key | tostring) == $version)
  ' <<<"$service_json" >/dev/null
}

verify_traffic_revision() {
  local latest_ready
  latest_ready="$(jq -r '.status.latestReadyRevisionName // empty' <<<"$service_json")"
  [[ -n "$latest_ready" ]] || die "Cloud Run service has no latest ready revision"
  jq -e --arg latest "$latest_ready" '
    ([.status.traffic[]? | select((.percent | tonumber) == 100)] | length) == 1
    and ([.status.traffic[]? | select((.percent | tonumber) == 100)][0].revisionName == $latest)
  ' <<<"$service_json" >/dev/null \
    || die "Cloud Run traffic is not serving the latest ready revision at 100 percent"
}

verify_staged_revision() {
  local revision="$1"
  local revision_json
  revision_json="$(gcloud run revisions describe "$revision" \
    "--project=$project" "--region=$region" '--format=json')" \
    || die "Cloud Run staged revision could not be observed"
  jq -e --arg expected_revision "$revision" --arg expected_service "$service" --arg source_sha "$source_sha" '
    .metadata.name == $expected_revision
    and (
      (.metadata.labels["serving.knative.dev/service"] // "")
        == $expected_service
      or (.metadata.labels["run.googleapis.com/service"] // "")
        == $expected_service
      or ([.metadata.ownerReferences[]?.name] | index($expected_service) != null)
    )
    and ([.status.conditions[]?
      | select(.type == "Ready" and .status == "True")] | length) == 1
    and ((.spec.containers[0].image // "") | test("@sha256:[0-9a-f]{64}$"))
    and ((.metadata.labels["analysis-capacity-source-commit"] // "") == $source_sha)
  ' <<<"$revision_json" >/dev/null \
    || die "Cloud Run staged revision is not the exact Ready revision for this service"
  local revision_env_value
  revision_env_value() {
    local key="$1"
    jq -r --arg key "$key" \
      '[.spec.containers[]?.env[]? | select(.name == $key) | .value][0] // empty' \
      <<<"$revision_json"
  }
  local revision_secret_ref
  revision_secret_ref() {
    local env_name="$1"
    local secret_name="$2"
    local version="$3"
    jq -e --arg env_name "$env_name" --arg secret_name "$secret_name" --arg version "$version" '
      [.spec.containers[]?.env[]? | select(.name == $env_name)] as $entries
      | ($entries | length) == 1
      and ($entries[0] | has("value") | not)
      and ($entries[0].valueFrom.secretKeyRef.name == $secret_name)
      and (($entries[0].valueFrom.secretKeyRef.key | tostring) == $version)
    ' <<<"$revision_json" >/dev/null
  }
  while IFS= read -r key; do
    expected_value="$(manifest_value "$env_file" "$key")"
    [[ "$(revision_env_value "$key")" == "$expected_value" ]] \
      || die "Cloud Run staged revision environment drifted for $key"
  done < <(jq -r 'keys[]' "$env_file")
  [[ "$(jq -r '.spec.serviceAccountName // empty' <<<"$revision_json")" == "$runtime" ]] \
    || die "Cloud Run staged revision runtime service account drifted"
  [[ "$(jq -r '.spec.containerConcurrency // empty' <<<"$revision_json")" == "1" ]] \
    || die "Cloud Run staged revision containerConcurrency must be 1"
  [[ "$(jq -r '.spec.timeoutSeconds // .spec.timeout // empty' <<<"$revision_json")" == "600" \
     || "$(jq -r '.spec.timeoutSeconds // .spec.timeout // empty' <<<"$revision_json")" == "600s" ]] \
    || die "Cloud Run staged revision timeout must be 600s/600 seconds"
  [[ "$(jq -r '.spec.resources.limits.cpu // empty' <<<"$revision_json")" == "$worker_cpu" ]] \
    || die "Cloud Run staged revision CPU contract drifted"
  [[ "$(jq -r '.spec.resources.limits.memory // empty' <<<"$revision_json")" == "$worker_memory" ]] \
    || die "Cloud Run staged revision memory contract drifted"
  for entry in "${secret_ref_entries[@]}"; do
    secret_env="${entry%%|*}"
    remainder="${entry#*|}"
    secret_id="${remainder%%|*}"
    secret_version="${remainder#*|}"
    revision_secret_ref "$secret_env" "$secret_id" "$secret_version" \
      || die "Cloud Run staged revision Secret Manager ref drifted for $secret_env"
  done
}

verify_service_contract() {
  # During an approved stage transition we verify the currently serving
  # revision against its observed stage before deploying the successor.  The
  # second argument allows an active revision to be checked while it is still
  # staged with no traffic.
  local contract_stage="${1:-$stage}"
  local require_traffic="${2:-true}"
  local contract_expansion_canary="false"
  local contract_recovery_enabled="false"
  local contract_max_instances=8
  if [[ "$role" == "preflight" ]]; then
    contract_max_instances=32
  fi
  case "$contract_stage" in
    bootstrap)
      ;;
    initial)
      contract_recovery_enabled="true"
      ;;
    expanded)
      contract_expansion_canary="true"
      contract_recovery_enabled="true"
      if [[ "$role" == "preflight" ]]; then
        contract_max_instances=64
      else
        contract_max_instances=16
      fi
      ;;
    *)
      die "invalid observed capacity stage"
      ;;
  esac
  service_json="$(gcloud run services describe "$service" \
    "--project=$project" "--region=$region" '--format=json')" \
    || die "Cloud Run service could not be observed"
  service_iam_json="$(gcloud run services get-iam-policy "$service" \
    "--project=$project" "--region=$region" '--format=json')" \
    || die "Cloud Run service IAM could not be observed"

  canonical_url="$(canonical_service_url)"
  [[ -n "$canonical_url" ]] || die "Cloud Run service has no canonical status.url/status.uri"
  [[ "${canonical_url%/}" == "${origin%/}" ]] \
    || die "Cloud Run canonical service URL does not match the target origin"
  if [[ "$require_traffic" == "true" ]]; then
    verify_traffic_revision
  fi
  [[ "$(env_value "$project_var")" == "$project" ]] || die "Cloud Run observed project drifted"
  [[ "$(env_value "${prefix}_LOCATION")" == "$location" ]] || die "Cloud Run observed location drifted"
  [[ "$(env_value "$queue_var")" == "$queue" ]] || die "Cloud Run observed queue drifted"
  [[ "$(env_value "$target_var")" == "$target" ]] || die "Cloud Run observed target URL drifted"
  [[ "$(env_value "$audience_var")" == "$audience" ]] || die "Cloud Run observed OIDC audience drifted"
  [[ "$(env_value "$task_sa_var")" == "$task_sa" ]] || die "Cloud Run observed task identity drifted"
  [[ "$(env_value "$maintenance_var")" == "$maintenance" ]] \
    || die "Cloud Run observed maintenance identity drifted"
  [[ "$(env_value "$maintenance_audience_var")" == "$maintenance_audience" ]] \
    || die "Cloud Run observed maintenance audience drifted"
  [[ "$(env_value "$recovery_gate_var")" == "$contract_recovery_enabled" ]] \
    || die "Cloud Run observed recovery gate drifted"
  [[ "$(env_value ANALYSIS_WORKLOAD_ROLE)" == "$role" ]] || die "Cloud Run observed workload role drifted"
  [[ "$(env_value ANALYSIS_CAPACITY_STAGE)" == "$contract_stage" ]] || die "Cloud Run observed capacity stage drifted"
  [[ "$(env_value ANALYSIS_CAPACITY_EXPANSION_CANARY)" == "$contract_expansion_canary" ]] \
    || die "Cloud Run observed expansion canary drifted"
  if [[ "$contract_stage" == "bootstrap" ]]; then
    [[ "$(env_value ANALYSIS_PROVIDER_ADMISSION_ENABLED)" == "false" ]] \
      || die "Cloud Run observed bootstrap admission gate must be false"
    for gate in "${required_gates[@]}"; do
      [[ "$(env_value "$gate")" == "false" ]] || die "Cloud Run observed bootstrap role gate must be false"
    done
  else
    [[ "$(env_value ANALYSIS_PROVIDER_ADMISSION_ENABLED)" == "true" ]] \
      || die "Cloud Run observed admission gate is not true"
    for gate in "${required_gates[@]}"; do
      [[ "$(env_value "$gate")" == "true" ]] || die "Cloud Run observed role enable gate is not true"
    done
  fi
  [[ "$(jq -r '.spec.template.spec.serviceAccountName // empty' <<<"$service_json")" == "$runtime" ]] \
    || die "Cloud Run runtime service account drifted"
  [[ "$(jq -r '.spec.template.spec.containerConcurrency // empty' <<<"$service_json")" == "1" ]] \
    || die "Cloud Run containerConcurrency must be 1"
  [[ "$(number_annotation autoscaling.knative.dev/maxScale)" == "$contract_max_instances" ]] \
    || die "Cloud Run maxScale drifted"
  [[ "$(number_annotation autoscaling.knative.dev/minScale)" == "0" ]] \
    || die "Cloud Run minScale must be 0"
  jq -e '.spec.template.spec.timeout == "600s"
      or .spec.template.spec.timeoutSeconds == 600
      or .spec.template.spec.timeoutSeconds == "600"' <<<"$service_json" >/dev/null \
    || die "Cloud Run timeout must be 600s/600 seconds"
  [[ "$(jq -r '.metadata.labels["analysis-workload-role"] // empty' <<<"$service_json")" == "$role" ]] \
    || die "Cloud Run workload-role label drifted"
  [[ "$(jq -r '.metadata.labels["analysis-capacity-stage"] // empty' <<<"$service_json")" == "$contract_stage" ]] \
    || die "Cloud Run capacity-stage label drifted"
  [[ "$(jq -r --arg key "$PROVENANCE_LABEL_KEY" '.metadata.labels[$key] // empty' <<<"$service_json")" == "$source_sha" ]] \
    || die "Cloud Run source provenance label drifted"
  jq -e '.spec.template.spec.containers[0].image // "" | test("@sha256:[0-9a-f]{64}$")' \
    <<<"$service_json" >/dev/null \
    || die "Cloud Run service image must be an immutable sha256 digest"
  [[ "$(jq -r '.spec.template.spec.resources.limits.cpu // empty' <<<"$service_json")" == "$worker_cpu" ]] \
    || die "Cloud Run CPU contract drifted"
  [[ "$(jq -r '.spec.template.spec.resources.limits.memory // empty' <<<"$service_json")" == "$worker_memory" ]] \
    || die "Cloud Run memory contract drifted"
  while IFS= read -r manifest_key; do
    manifest_expected="$(manifest_value "$env_file" "$manifest_key")"
    [[ "$(env_value "$manifest_key")" == "$manifest_expected" ]] \
      || die "Cloud Run observed environment drifted for $manifest_key"
  done < <(jq -r 'keys[]' "$env_file")
  for entry in "${secret_ref_entries[@]}"; do
    secret_env="${entry%%|*}"
    remainder="${entry#*|}"
    secret_id="${remainder%%|*}"
    secret_version="${remainder#*|}"
    verify_secret_ref "$secret_env" "$secret_id" "$secret_version" \
      || die "Cloud Run required Secret Manager ref drifted for $secret_env"
  done
  if verify_service_iam; then
    :
  elif [[ "$mode" == "apply" && "$reconcile_iam" == "true" ]]; then
    iam_policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-capacity-run-iam.XXXXXX")"
    write_exact_service_iam_policy "$iam_policy_file"
    gcloud run services set-iam-policy "$service" "$iam_policy_file" \
      "--project=$project" "--region=$region" --quiet
    service_iam_json="$(gcloud run services get-iam-policy "$service" \
      "--project=$project" "--region=$region" '--format=json')"
    verify_service_iam \
      || die "exact private Cloud Run invoker IAM was not observable after reconcile"
    rm -f -- "$iam_policy_file"
    iam_policy_file=""
  else
    die "Cloud Run invoker IAM is not private or the role's reviewed identities are missing"
  fi
  printf 'verified: %s worker canonical URL/serving revision, env gates, scaling, labels, runtime, pinned secrets, and private IAM\n' "$role"
}

verify_preflight_maintenance() {
  [[ "$role" == "preflight" ]] || return 0
  local maintenance_script="$(dirname "$0")/configure-analysis-preflight-maintenance.sh"
  local maintenance_args=()
  [[ "$mode" == "dry-run" ]] && maintenance_args+=(--dry-run)
  [[ "$mode" == "check" ]] && maintenance_args+=(--check)
  [[ "$mode" == "apply" ]] && maintenance_args+=(--apply)
  [[ "$reconcile_iam" == "true" ]] && maintenance_args+=(--reconcile-iam)
  [[ "$reconcile_jobs" == "true" ]] && maintenance_args+=(--reconcile-jobs)
  # The process environment has already been checked against the external
  # runtime manifest above.  Pass only role-scoped, non-secret scheduler inputs.
  PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB="${PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB:-analysis-preflight-recovery}" \
  PREFLIGHT_TASKS_RECOVERY_ENABLED="$recovery_enabled" \
  bash "$maintenance_script" "${maintenance_args[@]}"
}

observed_capacity_stage() {
  local observed
  observed="$(jq -r '.metadata.labels["analysis-capacity-stage"] // empty' <<<"$service_json")"
  if [[ -z "$observed" ]]; then
    observed="$(jq -r '[.spec.template.spec.containers[]?.env[]? | select(.name == "ANALYSIS_CAPACITY_STAGE") | .value][0] // empty' <<<"$service_json")"
  fi
  printf '%s\n' "$observed"
}

verify_stage_transition() {
  local observed_stage="$1"
  [[ -n "$observed_stage" ]] || die "Cloud Run observed capacity stage is missing"
  case "$stage:$observed_stage" in
    bootstrap:bootstrap|initial:bootstrap|initial:initial|expanded:initial|expanded:expanded)
      ;;
    *)
      die "unsafe capacity stage transition: observed=$observed_stage target=$stage; bootstrap must precede initial and initial must precede expanded"
      ;;
  esac
}

if [[ "$mode" == "check" ]]; then
  service_exists || die "Cloud Run service does not exist"
  verify_service_contract
  verify_legacy_quiescence
  verify_capacity_activation_readiness
  verify_preflight_maintenance
  exit 0
fi

if [[ "$mode" == "apply" ]]; then
  acquire_deploy_lock
fi

# Existing services are checked against their observed stage before any
# revision is deployed.  Only a missing bootstrap service is allowed to be
# created; an active stage can never bootstrap a missing service or bypass the
# pre-promotion barrier.
if service_exists; then
  service_json="$(gcloud run services describe "$service" \
    "--project=$project" "--region=$region" '--format=json')" \
    || die "Cloud Run service could not be observed for stage transition"
  previous_traffic_json="$(jq -c '.status.traffic // []' <<<"$service_json")"
  previous_traffic_projection="$(traffic_projection "$service_json")"
  previous_traffic_spec="$(traffic_revision_spec "$service_json")"
  [[ -n "$previous_traffic_spec" ]] \
    || die "existing Cloud Run service must expose a non-empty exact traffic allocation"
  previous_ready_revision="$(jq -r '.status.latestReadyRevisionName // empty' <<<"$service_json")"
  observed_stage="$(observed_capacity_stage)"
  verify_stage_transition "$observed_stage"
  verify_service_contract "$observed_stage"
  verify_legacy_quiescence
  verify_capacity_activation_readiness
else
  [[ "$stage" == "bootstrap" ]] \
    || die "active capacity stages require an existing, verified bootstrap service"
  previous_traffic_json='[]'
  previous_traffic_projection='[]'
  previous_traffic_spec=''
  previous_ready_revision=''
  log "bootstrap: Cloud Run service is absent; deploy will create the gates-off service before full verification"
fi

gcloud "${deploy_args[@]}"
if [[ "$stage" == "bootstrap" ]]; then
  verify_service_contract
else
  # The revision is intentionally not serving yet.  Re-read the complete
  # target contract, then perform the authoritative database barrier before
  # atomically promoting exactly the revision just verified.  --to-latest is
  # deliberately forbidden here: a concurrent deploy must not be able to move
  # unverified code into serving traffic.
  verify_service_contract "$stage" false
  staged_revision="$(jq -r '.status.latestCreatedRevisionName // empty' <<<"$service_json")"
  [[ -n "$staged_revision" && "$staged_revision" != "$previous_ready_revision" ]] \
    || die "Cloud Run did not expose a new exact staged ready revision"
  [[ "$(jq -c '.status.traffic // []' <<<"$service_json")" == "$previous_traffic_json" ]] \
    || die "Cloud Run traffic changed while the staged revision was being verified"
  verify_staged_revision "$staged_revision"
  verify_legacy_quiescence
  verify_capacity_activation_readiness
  rollback_armed="true"
  gcloud run services update-traffic "$service" \
    "--project=$project" "--region=$region" "--to-revisions=${staged_revision}=100" --quiet \
    || die "Cloud Run staged revision could not be promoted"
  verify_service_contract "$stage" true
  verify_legacy_quiescence
  verify_capacity_activation_readiness
fi
verify_preflight_maintenance
rollback_armed="false"
