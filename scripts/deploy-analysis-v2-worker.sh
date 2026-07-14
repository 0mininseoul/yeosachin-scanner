#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_LOCATION="asia-northeast3"
readonly CLOUD_RUN_API="run.googleapis.com"
readonly CLOUD_BUILD_API="cloudbuild.googleapis.com"
readonly ARTIFACT_REGISTRY_API="artifactregistry.googleapis.com"
readonly SUPABASE_SECRET_ID="ai-baram-v2-supabase-service-role"
readonly IMAGE_SIGNING_SECRET_ID="ai-baram-v2-image-proxy-signing"
readonly DEFAULT_CPU="2"
readonly DEFAULT_MEMORY="2Gi"
readonly DEFAULT_CONCURRENCY="2"
readonly DEFAULT_MAX_INSTANCES="6"
readonly DEFAULT_TIMEOUT_SECONDS="300"

mode="apply"
reconcile_iam="false"
reconcile_jobs="false"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-analysis-v2-worker.sh [--dry-run | --check] [--reconcile-iam] [--reconcile-jobs]

Source-deploys or verifies the private V2 Cloud Run worker, then composes with
configure-analysis-v2-tasks-queue.sh for queue, OIDC, and recovery IAM setup.

Before applying this script, run the infrastructure scripts in this order:
  1. scripts/configure-analysis-v2-worker-identity.sh
  2. scripts/configure-analysis-v2-secrets.sh
  3. scripts/configure-analysis-v2-media-bucket.sh
  4. scripts/deploy-analysis-v2-worker.sh

Required environment variables:
  ANALYSIS_V2_TASKS_PROJECT
  ANALYSIS_V2_TASKS_LOCATION
  ANALYSIS_V2_TASKS_QUEUE
  ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER
  ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION
  ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT

The deprecated ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL alias remains
accepted during migration. If both names are set, they must match exactly.

Required for apply and dry-run source builds:
  ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE
    Outside-source YAML containing exactly non-empty NEXT_PUBLIC_SUPABASE_URL
    and NEXT_PUBLIC_SUPABASE_ANON_KEY. Build secrets are forbidden.

The V2 enqueuer must be a dedicated identity with queue-scoped access. Do not
reuse a V1 enqueuer that still needs project-wide Cloud Tasks access.

Optional deployment environment variables:
  ANALYSIS_V2_WORKER_SOURCE_DIR              Defaults to the repository root.
  ANALYSIS_V2_WORKER_ENV_VARS_FILE           Runtime YAML or ENV file outside source.
  ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE     Optional only for --check source preflight validation.
  ANALYSIS_V2_WORKER_CPU                     Defaults to 2.
  ANALYSIS_V2_WORKER_MEMORY                  Defaults to 2Gi.
  ANALYSIS_V2_WORKER_CONCURRENCY             Defaults to 2; allowed range 1..8.
  ANALYSIS_V2_WORKER_MAX_INSTANCES           Defaults to 6; allowed range 1..24.
  ANALYSIS_V2_WORKER_TIMEOUT_SECONDS         Fixed launch value: 300.
  ANALYSIS_V2_WORKER_ENABLED                 Enables authenticated worker drain; defaults false.
  ANALYSIS_V2_RECOVERY_ENABLED               Enables scheduled recovery; defaults false.

The deployed service uses request-based billing (CPU throttling), scale-to-zero,
second-generation execution, and no VPC connector or Direct VPC network. That
keeps Cloud Run's default dynamic internet egress; it does not guarantee a new
IP address per request. The only roles/run.invoker members are the task OIDC
and maintenance service accounts. Secret values and env-file contents are never printed.

For a first deployment, ANALYSIS_V2_WORKER_ENV_VARS_FILE is required. Runtime
and build env files must both resolve outside ANALYSIS_V2_WORKER_SOURCE_DIR so
source upload cannot include them. The runtime file is non-secret and rejects
all provider and Google credential keys. Updates without it preserve existing
non-secret variables. Every deployment reapplies exactly three numeric pinned
Secret Manager references; `latest` and plaintext secret values are forbidden.

Options:
  --dry-run  Run read-only preflight checks and print required mutations.
  --check    Verify deployed config and composed queue/IAM without changing it.
  --reconcile-iam   Replace reviewed drifted queue/task/Run IAM.
  --reconcile-jobs  Replace reviewed drifted maintenance Scheduler jobs.
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

validate_location() {
  [[ "$1" == "$REQUIRED_LOCATION" ]] \
    || die "$2 must be $REQUIRED_LOCATION"
}

validate_service() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,47}[a-z0-9])?$ ]] \
    || die "ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE is invalid"
}

validate_queue() {
  [[ "$1" =~ ^[a-z]([a-z0-9-]{0,98}[a-z0-9])?$ ]] \
    || die "PREFLIGHT_TASKS_QUEUE is invalid"
}

validate_bucket() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]] \
    || die "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET is invalid"
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

validate_service_account_email() {
  local email="$1"
  local label="$2"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "$label is invalid"
}

service_account_project() {
  local domain="${1#*@}"
  printf '%s\n' "${domain%.iam.gserviceaccount.com}"
}

validate_positive_integer_range() {
  local value="$1"
  local min="$2"
  local max="$3"
  local label="$4"
  [[ "$value" =~ ^[0-9]+$ ]] \
    && ((10#$value >= min && 10#$value <= max)) \
    || die "$label must be an integer from $min through $max"
}

validate_runtime_tuning() {
  [[ "$worker_cpu" =~ ^(1|2|4)$ ]] \
    || die "ANALYSIS_V2_WORKER_CPU must be 1, 2, or 4"
  [[ "$worker_memory" =~ ^([1-9][0-9]*)(Mi|Gi)$ ]] \
    || die "ANALYSIS_V2_WORKER_MEMORY must use Mi or Gi units"
  validate_positive_integer_range "$worker_concurrency" 1 8 \
    "ANALYSIS_V2_WORKER_CONCURRENCY"
  validate_positive_integer_range "$worker_max_instances" 1 24 \
    "ANALYSIS_V2_WORKER_MAX_INSTANCES"
  [[ "$worker_timeout_seconds" == "$DEFAULT_TIMEOUT_SECONDS" ]] \
    || die "ANALYSIS_V2_WORKER_TIMEOUT_SECONDS must remain 300 at launch"

  local capacity=$((10#$worker_concurrency * 10#$worker_max_instances))
  local queue_concurrency="${ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES:-12}"
  validate_positive_integer_range "$queue_concurrency" 1 100 \
    "ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES"
  ((capacity >= 10#$queue_concurrency)) \
    || die "Cloud Run capacity must cover ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES"
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

validate_service_account() {
  local email="$1"
  local label="$2"
  local disabled
  disabled="$(gcloud iam service-accounts describe "$email" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    '--format=value(disabled)')" \
    || die "$label must already exist"
  [[ "$disabled" != "true" && "$disabled" != "True" ]] \
    || die "$label is disabled"
}

verify_no_project_wide_invoker() {
  local members
  members="$(gcloud projects get-iam-policy "$ANALYSIS_V2_TASKS_PROJECT" \
    --flatten=bindings[].members \
    '--filter=bindings.role=roles/run.invoker' \
    '--format=value(bindings.members)')"
  [[ -z "$members" ]] \
    || die "project-wide roles/run.invoker defeats the task-only service policy"
  log "verified: no project-wide Cloud Run invoker binding"
}

service_json() {
  gcloud run services describe "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json 2>/dev/null
}

service_runtime_matches() {
  local config="$1"
  jq -e \
    --arg runtime_sa "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    --arg bucket "$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    --arg slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    --arg apify_env_key "$apify_env_key" \
    --arg supabase_secret "$SUPABASE_SECRET_ID" \
    --arg supabase_version "$supabase_secret_version" \
    --arg apify_secret "$apify_secret_id" \
    --arg apify_version "$apify_secret_version" \
    --arg image_secret "$IMAGE_SIGNING_SECRET_ID" \
    --arg image_version "$image_signing_secret_version" \
    --arg cpu "$worker_cpu" \
    --arg memory "$worker_memory" \
    --arg concurrency "$worker_concurrency" \
    --arg max_instances "$worker_max_instances" \
    --arg timeout "$worker_timeout_seconds" '
      def annotations:
        [(.metadata.annotations // {}), (.spec.template.metadata.annotations // {})];
      def annotation_values($key): [annotations[][$key] // empty];
      def env: (.spec.template.spec.containers[0].env // []);
      def env_names: [env[]?.name];
      def value($name): [env[] | select(.name == $name) | .value];
      def secret_ref($env_name; $secret_name; $version):
        [env[] | select(.name == $env_name)] as $entries
        | ($entries | length) == 1
          and ($entries[0] | has("value") | not)
          and $entries[0].valueFrom.secretKeyRef.name == $secret_name
          and ($entries[0].valueFrom.secretKeyRef.key | tostring) == $version;
      def forbidden_plaintext_names:
        [env[]
          | select(.name != "SUPABASE_SERVICE_ROLE_KEY")
          | select(.name != $apify_env_key)
          | select(.name != "IMAGE_PROXY_SIGNING_SECRET")
          | select(.name | test("(^|_)(SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|API_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|OIDC_TOKEN|TOKEN|KEY_BASE64)$"))
          | .name];
      (.spec.template.spec.containers | length) == 1
        and .spec.template.spec.serviceAccountName == $runtime_sa
        and ((.spec.template.spec.timeoutSeconds | tostring) == $timeout)
        and ((.spec.template.spec.containerConcurrency | tostring) == $concurrency)
        and ((.spec.template.spec.containers[0].resources.limits.cpu | tostring) == $cpu)
        and (.spec.template.spec.containers[0].resources.limits.memory == $memory)
        and ([.spec.template.spec.containers[0].env[]? |
          select(.name == "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET") | .value] == [$bucket])
        and value("ANALYSIS_V2_APIFY_API_TOKEN_SLOT") == [$slot]
        and secret_ref("SUPABASE_SERVICE_ROLE_KEY"; $supabase_secret; $supabase_version)
        and secret_ref($apify_env_key; $apify_secret; $apify_version)
        and secret_ref("IMAGE_PROXY_SIGNING_SECRET"; $image_secret; $image_version)
        and ([env[] | select(.name | test("^APIFY_.*_API_TOKEN$"))] | length) == 1
        and (forbidden_plaintext_names | length) == 0
        and (env_names | length) == (env_names | unique | length)
        and ([env_names[] | select(
          . == "VERCEL"
          or . == "VERCEL_ENV"
          or . == "GCP_VERCEL_WIF_PROVIDER_RESOURCE"
          or . == "VERCEL_OIDC_TEAM_SLUG"
          or . == "VERCEL_OIDC_TEAM_ID"
          or . == "VERCEL_OIDC_PROJECT_ID"
          or test("_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL$")
        )] | length) == 0
        and (annotation_values("run.googleapis.com/ingress") | any(. == "all"))
        and (annotation_values("run.googleapis.com/execution-environment") | any(. == "gen2"))
        and (annotation_values("run.googleapis.com/cpu-throttling") | any(. == "true"))
        and (annotation_values("run.googleapis.com/startup-cpu-boost") | any(. == "true"))
        and ((annotation_values("autoscaling.knative.dev/maxScale")
          + annotation_values("run.googleapis.com/maxScale")) as $max_values
          | ($max_values | length) >= 1
            and ($max_values | all(. == $max_instances)))
        and (annotation_values("autoscaling.knative.dev/minScale")
          + annotation_values("run.googleapis.com/minScale") | all(. == "0"))
        and (annotation_values("run.googleapis.com/vpc-access-connector") | length) == 0
        and (annotation_values("run.googleapis.com/vpc-access-egress") | length) == 0
        and (annotation_values("run.googleapis.com/network-interfaces") | length) == 0
        and (annotation_values("run.googleapis.com/invoker-iam-disabled")
          | all(. == "false"))
        and (env_names | index("GOOGLE_APPLICATION_CREDENTIALS")) == null
        and (env_names | index("GOOGLE_SERVICE_ACCOUNT_KEY_BASE64")) == null
        and ([.status.conditions[]? |
          select(.type == "Ready" and .status == "True")] | length) == 1
        and (.status.latestCreatedRevisionName // "") != ""
        and .status.latestCreatedRevisionName == .status.latestReadyRevisionName
        and (.status.latestReadyRevisionName as $latest
          | [.status.traffic[]? | select((.percent // 0) > 0)] as $traffic
          | ($traffic | length) == 1
            and $traffic[0].revisionName == $latest
            and ($traffic[0].percent | tonumber) == 100)' \
    <<<"$config" >/dev/null
}

service_has_forbidden_plaintext_credential() {
  local config="$1"
  jq -e \
    --arg apify_env_key "$apify_env_key" '
    [.spec.template.spec.containers[]?.env[]?
      | select(
          (.name == "SUPABASE_SERVICE_ROLE_KEY"
            or .name == $apify_env_key
            or .name == "IMAGE_PROXY_SIGNING_SECRET")
          and has("value")
        )
      | .name] as $plaintext_secret_refs
    | [.spec.template.spec.containers[]?.env[]?
        | select(.name | test("(^|_)(SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|API_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|OIDC_TOKEN|TOKEN|KEY_BASE64)$"))
        | select(.name != "SUPABASE_SERVICE_ROLE_KEY")
        | select(.name != $apify_env_key)
        | select(.name != "IMAGE_PROXY_SIGNING_SECRET")
        | .name] as $other_credentials
    | ($plaintext_secret_refs | length) > 0 or ($other_credentials | length) > 0
  ' <<<"$config" >/dev/null
}

service_origin() {
  local config="$1"
  jq -er '.status.url // .status.address.url' <<<"$config"
}

worker_endpoint_env_matches() {
  local config="$1"
  local origin="$2"
  jq -e \
    --arg v2_target "$origin/api/analysis/v2/worker" \
    --arg preflight_target "$origin/api/analysis/preflight/worker" \
    --arg audience "$origin" \
    --arg project "$ANALYSIS_V2_TASKS_PROJECT" \
    --arg location "$ANALYSIS_V2_TASKS_LOCATION" \
    --arg v2_queue "$ANALYSIS_V2_TASKS_QUEUE" \
    --arg preflight_queue "$preflight_queue" \
    --arg task_sa "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
    --arg maintenance_sa "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
    --arg slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    --arg worker_enabled "$worker_enabled" \
    --arg recovery_enabled "$recovery_enabled" '
      def value($name):
        [.spec.template.spec.containers[0].env[]? |
          select(.name == $name) | .value];
      (.spec.template.spec.containers[0].env // []) as $env
      | ([$env[] | select(.name == "ANALYSIS_V2_TASKS_TARGET_URL") | .value]
          == [$v2_target])
        and ([$env[] | select(.name == "ANALYSIS_V2_TASKS_OIDC_AUDIENCE") | .value]
          == [$audience])
        and ([$env[] | select(.name == "PREFLIGHT_TASKS_TARGET_URL") | .value]
          == [$preflight_target])
        and ([$env[] | select(.name == "PREFLIGHT_TASKS_OIDC_AUDIENCE") | .value]
          == [$audience])
        and value("ANALYSIS_V2_TASKS_ENABLED") == ["true"]
        and value("ANALYSIS_V2_WORKER_ENABLED") == [$worker_enabled]
        and value("ANALYSIS_V2_RECOVERY_ENABLED") == [$recovery_enabled]
        and value("ANALYSIS_V2_ADMISSION_ENABLED") == []
        and value("ANALYSIS_V2_WORKER_EXECUTION_ENABLED") == []
        and value("ANALYSIS_V2_TASKS_PROJECT") == [$project]
        and value("ANALYSIS_V2_TASKS_LOCATION") == [$location]
        and value("ANALYSIS_V2_TASKS_QUEUE") == [$v2_queue]
        and value("ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL") == [$task_sa]
        and value("ANALYSIS_V2_TASKS_CALLER_AUTH_MODE") == ["adc"]
        and value("ANALYSIS_V2_APIFY_API_TOKEN_SLOT") == [$slot]
        and value("PREFLIGHT_TASKS_ENABLED") == ["true"]
        and value("PREFLIGHT_TASKS_PROJECT") == [$project]
        and value("PREFLIGHT_TASKS_LOCATION") == [$location]
        and value("PREFLIGHT_TASKS_QUEUE") == [$preflight_queue]
        and value("PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL") == [$task_sa]
        and value("PREFLIGHT_TASKS_CALLER_AUTH_MODE") == ["adc"]
        and value("PREFLIGHT_LOCAL_AFTER_ENABLED") == ["false"]
        and value("ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL") == [$maintenance_sa]
        and value("ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE") == [$audience]' \
    <<<"$config" >/dev/null
}

ensure_worker_endpoint_env() {
  local config
  local origin
  if ! config="$(service_json)"; then
    [[ "$mode" == "dry-run" ]] \
      || die "Cloud Run worker is unavailable for endpoint configuration"
    log "[dry-run] canonical Cloud Run task targets will be set after source deployment"
    return 0
  fi
  origin="$(service_origin "$config")" \
    || die "Cloud Run worker has no canonical HTTPS URL"
  [[ "$origin" =~ ^https://[a-z0-9.-]+$ ]] \
    || die "Cloud Run worker returned an invalid canonical URL"

  if worker_endpoint_env_matches "$config" "$origin"; then
    log "verified: V2 and preflight tasks target the canonical private worker URL"
    return 0
  fi
  [[ "$mode" != "check" ]] \
    || die "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"
  run_mutation gcloud run services update \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--update-env-vars=ANALYSIS_V2_TASKS_ENABLED=true,ANALYSIS_V2_WORKER_ENABLED=$worker_enabled,ANALYSIS_V2_RECOVERY_ENABLED=$recovery_enabled,ANALYSIS_V2_TASKS_PROJECT=$ANALYSIS_V2_TASKS_PROJECT,ANALYSIS_V2_TASKS_LOCATION=$ANALYSIS_V2_TASKS_LOCATION,ANALYSIS_V2_TASKS_QUEUE=$ANALYSIS_V2_TASKS_QUEUE,ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL,ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=adc,ANALYSIS_V2_APIFY_API_TOKEN_SLOT=$ANALYSIS_V2_APIFY_API_TOKEN_SLOT,ANALYSIS_V2_TASKS_TARGET_URL=$origin/api/analysis/v2/worker,ANALYSIS_V2_TASKS_OIDC_AUDIENCE=$origin,PREFLIGHT_TASKS_ENABLED=true,PREFLIGHT_TASKS_PROJECT=$ANALYSIS_V2_TASKS_PROJECT,PREFLIGHT_TASKS_LOCATION=$ANALYSIS_V2_TASKS_LOCATION,PREFLIGHT_TASKS_QUEUE=$preflight_queue,PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL,PREFLIGHT_TASKS_CALLER_AUTH_MODE=adc,PREFLIGHT_TASKS_TARGET_URL=$origin/api/analysis/preflight/worker,PREFLIGHT_TASKS_OIDC_AUDIENCE=$origin,PREFLIGHT_LOCAL_AFTER_ENABLED=false,ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL,ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE=$origin" \
    '--remove-env-vars=ANALYSIS_V2_ADMISSION_ENABLED,ANALYSIS_V2_WORKER_EXECUTION_ENABLED' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    config="$(service_json)" || die "Cloud Run worker was unavailable after endpoint update"
    service_runtime_matches "$config" \
      || die "Cloud Run worker became unready after canonical runtime env update"
    worker_endpoint_env_matches "$config" "$origin" \
      || die "canonical Cloud Tasks worker targets were not applied"
  fi
}

runtime_env_file_has_bucket() {
  local env_file="$1"
  local expected="$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET"
  awk -v expected="$expected" '
    /^[[:space:]]*ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET[[:space:]]*[:=]/ {
      line = $0
      sub(/^[^:=]*[:=][[:space:]]*/, "", line)
      sub(/[[:space:]]*#.*$/, "", line)
      gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "", line)
      if (line == expected) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$env_file"
}

env_file_key_names() {
  awk '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      if (line ~ /^[A-Za-z_][A-Za-z0-9_]*[[:space:]]*[:=]/) {
        sub(/[[:space:]]*[:=].*$/, "", line)
        print line
      }
    }
  ' "$1"
}

env_file_has_nonempty_value() {
  local env_file="$1"
  local expected_key="$2"
  awk -v expected_key="$expected_key" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      if (line ~ ("^" expected_key "[[:space:]]*[:=]")) {
        sub(/^[^:=]*[:=][[:space:]]*/, "", line)
        sub(/[[:space:]]*#.*$/, "", line)
        gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "", line)
        if (length(line) > 0) found++
      }
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$env_file"
}

env_file_value_equals() {
  local env_file="$1"
  local expected_key="$2"
  local expected_value="$3"
  awk -v expected_key="$expected_key" -v expected_value="$expected_value" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/^export[[:space:]]+/, "", line)
      if (line ~ ("^" expected_key "[[:space:]]*[:=]")) {
        sub(/^[^:=]*[:=][[:space:]]*/, "", line)
        sub(/[[:space:]]*#.*$/, "", line)
        gsub(/^[[:space:]\047\"]+|[[:space:]\047\"]+$/, "", line)
        if (line == expected_value) found++
      }
    }
    END { exit(found == 1 ? 0 : 1) }
  ' "$env_file"
}

validate_runtime_env_keys() {
  local env_file="$1"
  local key
  local duplicate
  duplicate="$(env_file_key_names "$env_file" | sort | uniq -d | head -n 1)"
  [[ -z "$duplicate" ]] || die "runtime env file contains a duplicate key: $duplicate"
  while IFS= read -r key; do
    case "$key" in
      VERCEL|VERCEL_ENV|GCP_VERCEL_WIF_PROVIDER_RESOURCE|VERCEL_OIDC_TEAM_SLUG|VERCEL_OIDC_TEAM_ID|VERCEL_OIDC_PROJECT_ID|*_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL|ANALYSIS_V2_ADMISSION_ENABLED|ANALYSIS_V2_WORKER_EXECUTION_ENABLED)
        die "runtime env file contains a forbidden placement, gate, or WIF bootstrap key: $key"
        ;;
      SUPABASE_SERVICE_ROLE_KEY|IMAGE_PROXY_SIGNING_SECRET|APIFY_API_TOKEN|APIFY_*_API_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_SERVICE_ACCOUNT_KEY_BASE64|*_API_KEY|*_SECRET|*_PASSWORD|*_CREDENTIAL|*_CREDENTIALS|*_PRIVATE_KEY|*_KEY_BASE64|*_ACCESS_TOKEN|*_REFRESH_TOKEN|*_OIDC_TOKEN|*_TOKEN)
        die "runtime env file must not contain plaintext provider or credential key: $key"
        ;;
    esac
  done < <(env_file_key_names "$env_file")
}

validate_build_env_keys() {
  local env_file="$1"
  local key
  local duplicate
  case "$env_file" in
    *.yaml|*.yml) ;;
    *) die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be a YAML file" ;;
  esac
  duplicate="$(env_file_key_names "$env_file" | sort | uniq -d | head -n 1)"
  [[ -z "$duplicate" ]] || die "build env file contains a duplicate key: $duplicate"
  local key_count=0
  while IFS= read -r key; do
    key_count=$((key_count + 1))
    case "$key" in
      NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY)
        ;;
      *) die "build env file contains a non-public or unsupported key: $key" ;;
    esac
  done < <(env_file_key_names "$env_file")
  [[ "$key_count" == "2" ]] \
    || die "build env file must contain exactly the two public Supabase keys"
  env_file_has_nonempty_value "$env_file" NEXT_PUBLIC_SUPABASE_URL \
    || die "build env file must set one non-empty NEXT_PUBLIC_SUPABASE_URL"
  env_file_has_nonempty_value "$env_file" NEXT_PUBLIC_SUPABASE_ANON_KEY \
    || die "build env file must set one non-empty NEXT_PUBLIC_SUPABASE_ANON_KEY"
}

validate_env_file_upload_boundary() {
  local env_file="$1"
  local label="$2"
  local env_dir
  local env_path
  local resolved_path
  command -v realpath >/dev/null 2>&1 \
    || die "realpath is required to validate env-file source boundaries"
  env_dir="$(cd -P "$(dirname "$env_file")" && pwd -P)"
  env_path="$env_dir/$(basename "$env_file")"
  resolved_path="$(realpath "$env_file")" \
    || die "$label could not be resolved"
  for candidate in "$env_path" "$resolved_path"; do
    case "$candidate" in
      "$worker_source_dir"|"$worker_source_dir"/*)
        die "$label must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"
        ;;
    esac
  done
}

verify_worker_prerequisites() {
  local identity_script="$script_dir/configure-analysis-v2-worker-identity.sh"
  local secrets_script="$script_dir/configure-analysis-v2-secrets.sh"
  local bucket_script="$script_dir/configure-analysis-v2-media-bucket.sh"
  [[ -f "$identity_script" ]] \
    || die "configure-analysis-v2-worker-identity.sh is missing"
  [[ -f "$secrets_script" ]] \
    || die "configure-analysis-v2-secrets.sh is missing"
  [[ -f "$bucket_script" ]] \
    || die "configure-analysis-v2-media-bucket.sh is missing"

  log "verifying prerequisite order: worker identity -> secrets -> media bucket -> worker deploy"
  bash "$identity_script" --check
  bash "$secrets_script" --check
  bash "$bucket_script" --check
}

build_deploy_args() {
  deploy_args=(
    gcloud run deploy "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
    "--project=$ANALYSIS_V2_TASKS_PROJECT"
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
    "--source=$worker_deploy_source_dir"
    "--service-account=$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
    '--execution-environment=gen2'
    "--cpu=$worker_cpu"
    "--memory=$worker_memory"
    "--concurrency=$worker_concurrency"
    "--max=$worker_max_instances"
    "--max-instances=$worker_max_instances"
    '--min=0'
    '--min-instances=0'
    "--timeout=${worker_timeout_seconds}s"
    '--port=8080'
    '--cpu-throttling'
    '--cpu-boost'
    '--clear-vpc-connector'
    '--clear-network'
    '--ingress=all'
    '--no-session-affinity'
    '--invoker-iam-check'
    '--no-allow-unauthenticated'
    '--deploy-health-check'
    '--description=Private durable Analysis V2 Cloud Tasks worker'
    "--set-secrets=SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SECRET_ID:$supabase_secret_version,$apify_env_key=$apify_secret_id:$apify_secret_version,IMAGE_PROXY_SIGNING_SECRET=$IMAGE_SIGNING_SECRET_ID:$image_signing_secret_version"
    '--quiet'
  )

  if [[ -n "$worker_env_file" ]]; then
    deploy_args+=("--env-vars-file=$worker_env_file")
  else
    deploy_args+=("--update-env-vars=ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET")
  fi
  deploy_args+=("--build-env-vars-file=$worker_build_env_file")
  if [[ -n "$worker_build_service_account" ]]; then
    deploy_args+=("--build-service-account=$worker_build_service_account_resource")
  fi
}

deploy_or_verify_service() {
  local existing="false"
  local config=""
  if config="$(service_json)"; then
    existing="true"
    service_has_forbidden_plaintext_credential "$config" \
      && die "deployed worker contains a forbidden plaintext provider or credential value"
  fi

  if [[ "$mode" == "check" ]]; then
    [[ "$existing" == "true" ]] || die "Cloud Run worker does not exist"
    service_runtime_matches "$config" \
      || die "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
    log "verified: private worker runtime, bounded scaling, and default dynamic egress"
    if [[ -n "$worker_build_env_file" ]]; then
      log "verified: supplied source-build manifest contains exactly the two public Supabase values"
    else
      log "check note: Cloud Run does not expose prior source-build env; no build manifest was supplied for source preflight validation"
    fi
    return 0
  fi

  if [[ "$existing" == "false" && -z "$worker_env_file" ]]; then
    die "ANALYSIS_V2_WORKER_ENV_VARS_FILE is required for the first deployment"
  fi

  build_deploy_args
  run_mutation "${deploy_args[@]}"

  if [[ "$mode" == "apply" ]]; then
    config="$(service_json)" || die "Cloud Run worker was not observable after deployment"
    service_runtime_matches "$config" \
      || die "Cloud Run worker runtime configuration was not applied"
  fi
}

configure_queue_and_oidc() {
  local queue_script
  local preflight_script
  queue_script="$(dirname "$0")/configure-analysis-v2-tasks-queue.sh"
  preflight_script="$(dirname "$0")/configure-preflight-tasks-queue.sh"
  [[ -f "$queue_script" ]] || die "configure-analysis-v2-tasks-queue.sh is missing"
  [[ -f "$preflight_script" ]] || die "configure-preflight-tasks-queue.sh is missing"

  if [[ "$mode" == "dry-run" ]] && ! service_json >/dev/null; then
    print_command bash "$queue_script" --dry-run
    print_command bash "$preflight_script" --dry-run
    log "[dry-run] V2 and preflight queue/OIDC checks will run after the worker service exists"
    return 0
  fi
  queue_mode_args=()
  [[ "$mode" == "dry-run" ]] && queue_mode_args+=(--dry-run)
  [[ "$mode" == "check" ]] && queue_mode_args+=(--check)
  [[ "$reconcile_iam" == "true" ]] && queue_mode_args+=(--reconcile-iam)
  if ((${#queue_mode_args[@]} == 0)); then
    bash "$queue_script"
  else
    bash "$queue_script" "${queue_mode_args[@]}"
  fi

  export PREFLIGHT_TASKS_PROJECT="$ANALYSIS_V2_TASKS_PROJECT"
  export PREFLIGHT_TASKS_LOCATION="$ANALYSIS_V2_TASKS_LOCATION"
  export PREFLIGHT_TASKS_QUEUE="$preflight_queue"
  export PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
  export PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
  export PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL="$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
  export PREFLIGHT_TASKS_CLOUD_RUN_SERVICE="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
  export PREFLIGHT_TASKS_CLOUD_RUN_REGION="$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
  if ((${#queue_mode_args[@]} == 0)); then
    bash "$preflight_script"
  else
    bash "$preflight_script" "${queue_mode_args[@]}"
  fi
}

service_iam_policy() {
  gcloud run services get-iam-policy \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json
}

service_iam_matches() {
  local policy="$1"
  jq -e \
    --arg task_member "$task_member" \
    --arg maintenance_member "$maintenance_member" '
      ([.bindings[]? |
        select(.role == "roles/run.invoker")] | length) == 1
      and ([.bindings[]? |
        select(.role == "roles/run.invoker"
          and (.condition? == null)
          and ((.members | sort)
            == ([$task_member, $maintenance_member] | sort)))] | length) == 1' \
    <<<"$policy" >/dev/null
}

write_exact_service_policy() {
  local current_policy="$1"
  service_policy_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-run-iam.XXXXXX")"
  jq \
    --arg task_member "$task_member" \
    --arg maintenance_member "$maintenance_member" '
      .bindings = (
        [(.bindings // [])[] | select(.role != "roles/run.invoker")]
        + [{
          "role": "roles/run.invoker",
          "members": ([$task_member, $maintenance_member] | sort)
        }]
      )' \
    <<<"$current_policy" >"$service_policy_file"
}

ensure_exact_invoker() {
  local policy
  if [[ "$mode" == "dry-run" ]] && ! policy="$(service_iam_policy 2>/dev/null)"; then
    log "[dry-run] roles/run.invoker will contain only task and maintenance OIDC identities"
    return 0
  fi
  policy="${policy:-$(service_iam_policy)}"
  if service_iam_matches "$policy"; then
    log "verified: task and maintenance OIDC identities are the only Cloud Run invokers"
    return 0
  fi

  [[ "$mode" != "check" ]] || die "Cloud Run invoker policy has drifted"
  local invoker_count
  invoker_count="$(jq -r '[.bindings[]? | select(.role == "roles/run.invoker")] | length' \
    <<<"$policy")"
  if [[ "$invoker_count" != "0" && "$reconcile_iam" != "true" ]]; then
    die "Cloud Run invoker policy has unexpected principals; inspect or use --reconcile-iam"
  fi
  write_exact_service_policy "$policy"
  run_mutation gcloud run services set-iam-policy \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "$service_policy_file" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    policy="$(service_iam_policy)"
    service_iam_matches "$policy" \
      || die "exact Cloud Run invoker policy was not applied"
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

normalize_worker_runtime_identity

for name in \
  ANALYSIS_V2_TASKS_PROJECT \
  ANALYSIS_V2_TASKS_LOCATION \
  ANALYSIS_V2_TASKS_QUEUE \
  ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_DEPLOYER_IAM_MEMBER \
  ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION \
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET \
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT \
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION \
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION \
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION; do
  required_env "$name"
done
required_env ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT
if [[ "$mode" != "check" ]]; then
  required_env ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE
fi

readonly script_dir="$(cd "$(dirname "$0")" && pwd)"
worker_source_dir_input="${ANALYSIS_V2_WORKER_SOURCE_DIR:-$script_dir/..}"
[[ -d "$worker_source_dir_input" ]] \
  || die "ANALYSIS_V2_WORKER_SOURCE_DIR must be a directory"
readonly worker_source_dir="$(cd -P "$worker_source_dir_input" && pwd -P)"
worker_deploy_source_dir="$worker_source_dir"
readonly worker_env_file="${ANALYSIS_V2_WORKER_ENV_VARS_FILE:-}"
readonly worker_build_env_file="${ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE:-}"
readonly worker_build_service_account="$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
readonly worker_build_service_account_resource="projects/$ANALYSIS_V2_TASKS_PROJECT/serviceAccounts/$worker_build_service_account"
readonly worker_cpu="${ANALYSIS_V2_WORKER_CPU:-$DEFAULT_CPU}"
readonly worker_memory="${ANALYSIS_V2_WORKER_MEMORY:-$DEFAULT_MEMORY}"
readonly worker_concurrency="${ANALYSIS_V2_WORKER_CONCURRENCY:-$DEFAULT_CONCURRENCY}"
readonly worker_max_instances="${ANALYSIS_V2_WORKER_MAX_INSTANCES:-$DEFAULT_MAX_INSTANCES}"
readonly worker_timeout_seconds="${ANALYSIS_V2_WORKER_TIMEOUT_SECONDS:-$DEFAULT_TIMEOUT_SECONDS}"
readonly worker_enabled="${ANALYSIS_V2_WORKER_ENABLED:-false}"
readonly recovery_enabled="${ANALYSIS_V2_RECOVERY_ENABLED:-false}"
readonly preflight_queue="${PREFLIGHT_TASKS_QUEUE:-analysis-preflight}"
readonly task_member="serviceAccount:$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
readonly maintenance_member="serviceAccount:$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
readonly slot_upper="$(printf '%s' "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" | tr '[:lower:]' '[:upper:]')"
readonly apify_env_key="APIFY_${slot_upper}_API_TOKEN"
readonly apify_secret_id="ai-baram-v2-apify-$ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
readonly supabase_secret_version="$ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION"
readonly apify_secret_version="$ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION"
readonly image_signing_secret_version="$ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION"

[[ -z "${ANALYSIS_V2_WORKER_EXECUTION_ENABLED:-}" ]] \
  || die "ANALYSIS_V2_WORKER_EXECUTION_ENABLED was removed; set ANALYSIS_V2_WORKER_ENABLED and ANALYSIS_V2_RECOVERY_ENABLED separately"

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_location "$ANALYSIS_V2_TASKS_LOCATION" "ANALYSIS_V2_TASKS_LOCATION"
validate_location "$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
  "ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
validate_service "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
validate_queue "$preflight_queue"
validate_bucket "$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET"
validate_slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
validate_numeric_version "$supabase_secret_version" \
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
validate_numeric_version "$apify_secret_version" \
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
validate_numeric_version "$image_signing_secret_version" \
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION
[[ "$worker_enabled" == "true" || "$worker_enabled" == "false" ]] \
  || die "ANALYSIS_V2_WORKER_ENABLED must be true or false"
[[ "$recovery_enabled" == "true" || "$recovery_enabled" == "false" ]] \
  || die "ANALYSIS_V2_RECOVERY_ENABLED must be true or false"
validate_service_account_email "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
  "ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL"
[[ "$(service_account_project "$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "task OIDC service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker runtime service account must belong to ANALYSIS_V2_TASKS_PROJECT"
[[ "$(service_account_project "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "maintenance service account must belong to ANALYSIS_V2_TASKS_PROJECT"
validate_runtime_tuning

[[ -d "$worker_source_dir" && -f "$worker_source_dir/package.json" ]] \
  || die "ANALYSIS_V2_WORKER_SOURCE_DIR must contain package.json"
if [[ -n "$worker_env_file" ]]; then
  [[ -f "$worker_env_file" ]] || die "ANALYSIS_V2_WORKER_ENV_VARS_FILE does not exist"
  validate_env_file_upload_boundary "$worker_env_file" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE"
  validate_runtime_env_keys "$worker_env_file"
  runtime_env_file_has_bucket "$worker_env_file" \
    || die "runtime env file must set ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET to the configured bucket"
  env_file_value_equals "$worker_env_file" ANALYSIS_V2_APIFY_API_TOKEN_SLOT \
    "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    || die "runtime env file must set the exact selected ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
fi
if [[ -n "$worker_build_env_file" ]]; then
  [[ -f "$worker_build_env_file" ]] \
    || die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE does not exist"
  validate_env_file_upload_boundary "$worker_build_env_file" \
    "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE"
  validate_build_env_keys "$worker_build_env_file"
fi
validate_service_account_email "$worker_build_service_account" \
  "ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
[[ "$(service_account_project "$worker_build_service_account")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker build service account must belong to ANALYSIS_V2_TASKS_PROJECT"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
[[ -n "$active_account" ]] || die "gcloud has no active authenticated account"
gcloud projects describe "$ANALYSIS_V2_TASKS_PROJECT" \
  '--format=value(projectNumber)' | grep -Eq '^[0-9]+$' \
  || die "could not resolve the GCP project number"

validate_service_account "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
  "worker runtime service account; run configure-analysis-v2-worker-identity.sh first"
validate_service_account "$worker_build_service_account" \
  "dedicated build service account; run configure-analysis-v2-worker-identity.sh first"
validate_service_account "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" \
  "dedicated maintenance service account; run configure-analysis-v2-worker-identity.sh first"

service_policy_file=""
source_archive_dir=""
cleanup() {
  [[ -z "$service_policy_file" ]] || rm -f "$service_policy_file"
  [[ -z "$source_archive_dir" ]] || rm -rf "$source_archive_dir"
}
trap cleanup EXIT

verify_no_project_wide_invoker
verify_worker_prerequisites
ensure_api "$CLOUD_RUN_API"
ensure_api "$CLOUD_BUILD_API"
ensure_api "$ARTIFACT_REGISTRY_API"
if [[ "$mode" == "apply" ]]; then
  source_archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-source.XXXXXX")"
  bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
    "$worker_source_dir" "$source_archive_dir" >/dev/null
  worker_deploy_source_dir="$source_archive_dir"
  log "verified: source deploy uses a clean tracked commit archive"
fi
deploy_or_verify_service
ensure_worker_endpoint_env
configure_queue_and_oidc
ensure_exact_invoker

maintenance_script="$script_dir/configure-analysis-v2-maintenance.sh"
[[ -f "$maintenance_script" ]] || die "configure-analysis-v2-maintenance.sh is missing"
maintenance_args=()
[[ "$mode" == "dry-run" ]] && maintenance_args+=(--dry-run)
[[ "$mode" == "check" ]] && maintenance_args+=(--check)
[[ "$reconcile_jobs" == "true" ]] && maintenance_args+=(--reconcile-jobs)
if [[ "$mode" == "dry-run" ]] && ! service_json >/dev/null; then
  print_command bash "$maintenance_script" "${maintenance_args[@]}"
  log "[dry-run] maintenance scheduler checks will run after the worker service exists"
else
  if ((${#maintenance_args[@]} == 0)); then
    bash "$maintenance_script"
  else
    bash "$maintenance_script" "${maintenance_args[@]}"
  fi
fi

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 Cloud Run worker and Cloud Tasks integration verified"
fi
