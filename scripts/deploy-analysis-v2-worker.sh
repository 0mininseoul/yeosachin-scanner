#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_LOCATION="asia-northeast3"
readonly CLOUD_RUN_API="run.googleapis.com"
readonly CLOUD_BUILD_API="cloudbuild.googleapis.com"
readonly ARTIFACT_REGISTRY_API="artifactregistry.googleapis.com"
readonly SUPABASE_SECRET_ID="ai-baram-v2-supabase-service-role"
readonly IMAGE_SIGNING_SECRET_ID="ai-baram-v2-image-proxy-signing"
readonly PREFLIGHT_IDENTITY_HMAC_SECRET_ID="ai-baram-v2-preflight-identity-hmac"
readonly DEFAULT_CPU="2"
readonly DEFAULT_MEMORY="2Gi"
readonly DEFAULT_CONCURRENCY="8"
readonly DEFAULT_MAX_INSTANCES="1"
readonly DEFAULT_TIMEOUT_SECONDS="300"
readonly PROVENANCE_LABEL_KEY="analysis-v2-source-commit"
readonly SERVICE_JSON_NOT_FOUND_STATUS="44"
readonly REVISION_OBSERVATION_MAX_ATTEMPTS="5"
readonly -a APIFY_TOKEN_SLOTS=(
  primary
  secondary
  tertiary
  quaternary
  quinary
)

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
  4. scripts/configure-analysis-v2-deploy-lock.sh
  5. scripts/deploy-analysis-v2-worker.sh

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
    or ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET
  ANALYSIS_V2_DEPLOY_LOCK_BUCKET
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION
  ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION
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
  ANALYSIS_V2_WORKER_CONCURRENCY             Defaults to 8; allowed range 1..8.
  ANALYSIS_V2_WORKER_MAX_INSTANCES           Fixed at 1 while Gemini concurrency is process-local.
  ANALYSIS_V2_WORKER_TIMEOUT_SECONDS         Fixed launch value: 300.
  ANALYSIS_V2_WORKER_ENABLED                 Enables authenticated worker drain; defaults false.
  ANALYSIS_V2_RECOVERY_ENABLED               Enables scheduled recovery; defaults false.
  ANALYSIS_V2_DEPLOY_REVISION_NONCE          Optional 5-character lowercase test/deploy nonce.

The deployed service uses request-based billing (CPU throttling), scale-to-zero,
second-generation execution, and no VPC connector or Direct VPC network. That
keeps Cloud Run's default dynamic internet egress; it does not guarantee a new
IP address per request. The only roles/run.invoker members are the task OIDC
and maintenance service accounts. Secret values and env-file contents are never printed.

For a first deployment, ANALYSIS_V2_WORKER_ENV_VARS_FILE is required. Runtime
and build env files must both resolve outside ANALYSIS_V2_WORKER_SOURCE_DIR so
source upload cannot include them. The runtime file is non-secret and rejects
all provider and Google credential keys. Updates without it preserve existing
non-secret variables. Every deployment reapplies numeric pinned Secret Manager
references for Supabase, image signing, preflight identity HMAC, the selected Apify slot, and any valid
Apify slot references retained solely to recover older provider runs. `latest`
and plaintext secret values are forbidden.

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

normalize_v1_enqueuer_identity() {
  local legacy_identity="${ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:-}"
  local explicitly_unconfigured="${ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED:-}"
  if [[ -n "$legacy_identity" && "$explicitly_unconfigured" == "true" ]]; then
    die "ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL and ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED are mutually exclusive"
  fi
  if [[ -n "$legacy_identity" ]]; then
    export ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=false
    return 0
  fi
  [[ "$explicitly_unconfigured" == "true" ]] \
    || die "ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL is required unless ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true"
  export ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true
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
  local bucket="$1"
  local label="$2"
  [[ "$bucket" =~ ^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$ ]] \
    || die "$label is invalid"
}

validate_deploy_lock_bucket() {
  local bucket="$1"
  local random_suffix="${bucket##*-}"
  validate_bucket "$bucket" "ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
  [[ "$random_suffix" =~ ^[a-f0-9]{32}$ ]] \
    || die "ANALYSIS_V2_DEPLOY_LOCK_BUCKET must end with a persistent 128-bit lowercase hexadecimal suffix"
}

validate_slot() {
  local allowed
  for allowed in "${APIFY_TOKEN_SLOTS[@]}"; do
    [[ "$1" != "$allowed" ]] || return 0
  done
  die "ANALYSIS_V2_APIFY_API_TOKEN_SLOT must be primary, secondary, tertiary, quaternary, or quinary"
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
  [[ "$worker_max_instances" == "$DEFAULT_MAX_INSTANCES" ]] \
    || die "ANALYSIS_V2_WORKER_MAX_INSTANCES must remain 1 while Gemini concurrency is process-local"
  [[ "$worker_timeout_seconds" == "$DEFAULT_TIMEOUT_SECONDS" ]] \
    || die "ANALYSIS_V2_WORKER_TIMEOUT_SECONDS must remain 300 at launch"

  local capacity=$((10#$worker_concurrency * 10#$worker_max_instances))
  local queue_rate="${ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND:-8}"
  local queue_concurrency="${ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES:-8}"
  [[ "$queue_rate" == "8" ]] \
    || die "ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND must remain 8 during early access"
  [[ "$queue_concurrency" == "8" ]] \
    || die "ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES must remain 8 during early access"
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

report_cloud_run_lookup_failure() {
  local operation="$1"
  local status="$2"
  local diagnostic_file="$3"
  local category="unknown"
  if grep -Eqi 'PERMISSION_DENIED|permission|forbidden' "$diagnostic_file"; then
    category="permission-denied"
  elif grep -Eqi 'UNAUTHENTICATED|authentication|credential|login' "$diagnostic_file"; then
    category="authentication-failed"
  elif grep -Eqi 'API.*(disabled|not enabled)|SERVICE_DISABLED' "$diagnostic_file"; then
    category="api-disabled"
  elif grep -Eqi 'network|connection|timeout|timed out|unavailable' "$diagnostic_file"; then
    category="transport-unavailable"
  elif grep -Eqi 'NOT_FOUND|not found' "$diagnostic_file"; then
    category="not-found-race"
  elif [[ ! -s "$diagnostic_file" ]]; then
    category="no-diagnostic"
  fi
  printf 'Cloud Run service %s failed (category=%s, gcloud_status=%s); provider diagnostic was securely classified and suppressed\n' \
    "$operation" "$category" "$status" >&2
}

service_json() {
  local diagnostic_file
  local list_json
  local list_count
  local describe_json
  local status
  diagnostic_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-service-lookup.XXXXXX")"

  if list_json="$(gcloud run services list \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--filter=metadata.name=$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    --format=json 2>"$diagnostic_file")"; then
    :
  else
    status="$?"
    report_cloud_run_lookup_failure "list" "$status" "$diagnostic_file"
    rm -f "$diagnostic_file"
    return 1
  fi
  : >"$diagnostic_file"

  list_count="$(jq -er \
    --arg service "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" '
      if type == "array"
        and all(.[]; type == "object" and .metadata.name == $service)
      then length
      else error("invalid service list")
      end
    ' <<<"$list_json")" || {
      printf 'Cloud Run service list returned invalid or non-exact JSON; refusing to infer absence\n' >&2
      rm -f "$diagnostic_file"
      return 1
    }
  if [[ "$list_count" == "0" ]]; then
    rm -f "$diagnostic_file"
    return "$SERVICE_JSON_NOT_FOUND_STATUS"
  fi
  if [[ "$list_count" != "1" ]]; then
    printf 'Cloud Run service list returned %s exact matches; refusing ambiguous deployment state\n' \
      "$list_count" >&2
    rm -f "$diagnostic_file"
    return 1
  fi

  if describe_json="$(gcloud run services describe "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json 2>"$diagnostic_file")"; then
    :
  else
    status="$?"
    report_cloud_run_lookup_failure "describe" "$status" "$diagnostic_file"
    rm -f "$diagnostic_file"
    return 1
  fi
  rm -f "$diagnostic_file"
  jq -ce --arg service "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" '
    select(type == "object" and .metadata.name == $service)
  ' <<<"$describe_json" || {
    printf 'Cloud Run service describe returned invalid or mismatched JSON\n' >&2
    return 1
  }
}

service_runtime_config_matches() {
  local config="$1"
  # A ready --no-traffic revision advances latestCreated but not service-level latestReady.
  # The exact staged revision readiness and provenance are verified separately below.
  jq -e \
    --arg runtime_sa "$ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL" \
    --arg bucket "$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
    --arg slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    --arg apify_env_key "$apify_env_key" \
    --arg supabase_secret "$SUPABASE_SECRET_ID" \
    --arg supabase_version "$supabase_secret_version" \
    --arg apify_secret "$apify_secret_id" \
    --arg apify_version "$apify_secret_version" \
    --argjson expected_apify_refs "$expected_apify_secret_refs_json" \
    --arg image_secret "$IMAGE_SIGNING_SECRET_ID" \
    --arg image_version "$image_signing_secret_version" \
    --arg identity_hmac_secret "$PREFLIGHT_IDENTITY_HMAC_SECRET_ID" \
    --arg identity_hmac_version "$preflight_identity_hmac_secret_version" \
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
      def apify_specs: [
        {env: "APIFY_PRIMARY_API_TOKEN", secret: "ai-baram-v2-apify-primary"},
        {env: "APIFY_SECONDARY_API_TOKEN", secret: "ai-baram-v2-apify-secondary"},
        {env: "APIFY_TERTIARY_API_TOKEN", secret: "ai-baram-v2-apify-tertiary"},
        {env: "APIFY_QUATERNARY_API_TOKEN", secret: "ai-baram-v2-apify-quaternary"},
        {env: "APIFY_QUINARY_API_TOKEN", secret: "ai-baram-v2-apify-quinary"}
      ];
      def apify_env_names: [apify_specs[].env];
      def apify_refs:
        [env[]
          | select(.name as $name | apify_env_names | index($name))
          | {
              env: .name,
              secret: (.valueFrom.secretKeyRef.name // ""),
              version: ((.valueFrom.secretKeyRef.key // "") | tostring)
            }]
        | sort_by(.env);
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
          | select(.name as $name | apify_env_names | index($name) | not)
          | select(.name != "IMAGE_PROXY_SIGNING_SECRET")
          | select(.name != "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET")
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
        and secret_ref("ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET"; $identity_hmac_secret; $identity_hmac_version)
        and (apify_refs == ($expected_apify_refs | sort_by(.env)))
        and (apify_refs | length) >= 1
        and (apify_refs | length) <= 5
        and ([env[]
          | select(.name as $name | apify_env_names | index($name))
          | select(has("value"))] | length) == 0
        and (apify_refs | all(.version | test("^[1-9][0-9]*$")))
        and (apify_refs | all(
          . as $ref | apify_specs | any(
            .env == $ref.env and .secret == $ref.secret
          )
        ))
        and ([env[] | select(.name | test("^APIFY_.*_API_TOKEN$"))] | length)
          == (apify_refs | length)
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
        and (.status.latestCreatedRevisionName // "") != ""' \
    <<<"$config" >/dev/null
}

service_traffic_matches_revision() {
  local config="$1"
  local revision="$2"
  jq -e --arg revision "$revision" '
    [.status.traffic[]?] as $all_traffic
    | [$all_traffic[] | select(has("tag") and .tag != null and .tag != "")] as $tags
    | [$all_traffic[] | select((.percent // 0) > 0)] as $traffic
    | ($tags | length) == 0
      and ($traffic | length) == 1
      and $traffic[0].revisionName == $revision
      and ($traffic[0].percent | tonumber) == 100
  ' <<<"$config" >/dev/null
}

service_has_no_traffic_tags() {
  local config="$1"
  jq -e '
    [.status.traffic[]?
      | select(has("tag") and .tag != null and .tag != "")]
    | length == 0
  ' <<<"$config" >/dev/null
}

service_runtime_matches() {
  local config="$1"
  local latest_created
  local latest_ready
  latest_created="$(jq -er '.status.latestCreatedRevisionName' <<<"$config")" \
    || return 1
  latest_ready="$(jq -er '.status.latestReadyRevisionName' <<<"$config")" \
    || return 1
  [[ "$latest_created" == "$latest_ready" ]] \
    && service_runtime_config_matches "$config" \
    && service_traffic_matches_revision "$config" "$latest_ready"
}

service_has_forbidden_plaintext_credential() {
  local config="$1"
  jq -e '
    def containers: (.spec.template.spec.containers // .spec.containers // []);
    def allowed_apify_env_names: [
      "APIFY_PRIMARY_API_TOKEN",
      "APIFY_SECONDARY_API_TOKEN",
      "APIFY_TERTIARY_API_TOKEN",
      "APIFY_QUATERNARY_API_TOKEN",
      "APIFY_QUINARY_API_TOKEN"
    ];
    [containers[]?.env[]?
      | select(
          (.name == "SUPABASE_SERVICE_ROLE_KEY"
            or (.name as $name | allowed_apify_env_names | index($name))
            or .name == "IMAGE_PROXY_SIGNING_SECRET"
            or .name == "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET")
          and has("value")
        )
      | .name] as $plaintext_secret_refs
    | [containers[]?.env[]?
        | select(.name | test("(^|_)(SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|API_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|OIDC_TOKEN|TOKEN|KEY_BASE64)$"))
        | select(.name != "SUPABASE_SERVICE_ROLE_KEY")
        | select(.name as $name | allowed_apify_env_names | index($name) | not)
        | select(.name != "IMAGE_PROXY_SIGNING_SECRET")
        | select(.name != "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET")
        | .name] as $other_credentials
    | ($plaintext_secret_refs | length) > 0 or ($other_credentials | length) > 0
  ' <<<"$config" >/dev/null
}

verify_existing_preflight_identity_hmac_ref() {
  local config="$1"
  local surface="$2"
  jq -e \
    --arg secret "$PREFLIGHT_IDENTITY_HMAC_SECRET_ID" \
    --arg version "$preflight_identity_hmac_secret_version" '
      def containers: (.spec.template.spec.containers // .spec.containers // []);
      [containers[]?.env[]?
        | select(.name == "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET")] as $entries
      | ($entries | length) == 1
          and ($entries[0] | has("value") | not)
          and $entries[0].valueFrom.secretKeyRef.name == $secret
          and (($entries[0].valueFrom.secretKeyRef.key | tostring) | test("^[1-9][0-9]*$"))
          and ($entries[0].valueFrom.secretKeyRef.key | tostring) == $version
    ' <<<"$config" >/dev/null \
    || die "$surface existing preflight identity HMAC reference is invalid or its numeric version changed; it must be exactly one canonical ref at the requested numeric version; production in-place rotation is blocked until a DB-backed drain audit path exists"
}

apify_identity_for_existing_config() {
  local config="$1"
  jq -ce \
    '
      def containers: (.spec.template.spec.containers // .spec.containers // []);
      def env: (containers[0].env // []);
      def specs: [
        {slot: "primary", env: "APIFY_PRIMARY_API_TOKEN", secret: "ai-baram-v2-apify-primary"},
        {slot: "secondary", env: "APIFY_SECONDARY_API_TOKEN", secret: "ai-baram-v2-apify-secondary"},
        {slot: "tertiary", env: "APIFY_TERTIARY_API_TOKEN", secret: "ai-baram-v2-apify-tertiary"},
        {slot: "quaternary", env: "APIFY_QUATERNARY_API_TOKEN", secret: "ai-baram-v2-apify-quaternary"},
        {slot: "quinary", env: "APIFY_QUINARY_API_TOKEN", secret: "ai-baram-v2-apify-quinary"}
      ];
      [env[] | select(.name | test("^APIFY_.*_API_TOKEN$"))] as $entries
      | [$entries[].name] as $names
      | [env[] | select(.name == "ANALYSIS_V2_APIFY_API_TOKEN_SLOT") | .value]
          as $runtime_slots
      | ($runtime_slots[0] // "") as $runtime_slot
      | [specs[] | select(.slot == $runtime_slot)] as $runtime_specs
      | [$entries[] | select(.name == ($runtime_specs[0].env // ""))]
          as $runtime_refs
      | if (containers | length) != 1 then error("invalid container count")
        elif ($entries | length) < 1 or ($entries | length) > 5
          then error("invalid Apify ref count")
        elif ($names | length) != ($names | unique | length)
          then error("duplicate Apify ref")
        elif ($runtime_slots | length) != 1 or ($runtime_specs | length) != 1
          then error("invalid active Apify slot")
        elif ($entries | all(
          . as $entry
          | ($entry | has("value") | not)
            and (($entry.valueFrom.secretKeyRef.key // "" | tostring) | test("^[1-9][0-9]*$"))
            and ([specs[]
              | select(.env == $entry.name)
              | .secret] == [($entry.valueFrom.secretKeyRef.name // "")])
        ) | not) then error("invalid Apify ref")
        elif ($runtime_refs | length) != 1
          then error("active Apify slot has no exact ref")
        else {
          runtimeSlot: $runtime_slot,
          refs: ([$entries[] | {
            env: .name,
            secret: .valueFrom.secretKeyRef.name,
            version: (.valueFrom.secretKeyRef.key | tostring)
          }] | sort_by(.env))
        }
        end
    ' <<<"$config"
}

verify_existing_service_secret_identity() {
  local latest_config="$1"
  local active_config="$2"
  local latest_identity
  local active_identity

  service_has_forbidden_plaintext_credential "$latest_config" \
    && die "deployed worker contains a forbidden plaintext provider or credential value in the latest Cloud Run service template"
  service_has_forbidden_plaintext_credential "$active_config" \
    && die "deployed worker contains a forbidden plaintext provider or credential value in the active known-good Cloud Run revision"
  verify_existing_preflight_identity_hmac_ref "$latest_config" \
    "latest Cloud Run service template"
  verify_existing_preflight_identity_hmac_ref "$active_config" \
    "active known-good Cloud Run revision"

  latest_identity="$(apify_identity_for_existing_config "$latest_config")" \
    || die "existing worker Apify references are invalid or the selected slot version changed in the latest Cloud Run service template; active and latest identities must agree, and same-slot overwrite can strand unresolved runs and account identity"
  active_identity="$(apify_identity_for_existing_config "$active_config")" \
    || die "existing worker Apify references are invalid or the selected slot version changed in the active known-good Cloud Run revision; active and latest identities must agree, and same-slot overwrite can strand unresolved runs and account identity"
  jq -ne \
    --arg requested_slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    --arg requested_env "$apify_env_key" \
    --arg requested_secret "$apify_secret_id" \
    --arg requested_version "$apify_secret_version" \
    --argjson latest "$latest_identity" \
    --argjson active "$active_identity" '
      def requested_ref($identity):
        [$identity.refs[] | select(.env == $requested_env)];
      def requested_ref_is_exact($identity):
        requested_ref($identity) == [{
          env: $requested_env,
          secret: $requested_secret,
          version: $requested_version
        }];
      ([$active.refs[]
          | select(. as $ref | $latest.refs | index($ref) | not)] | length) == 0
        and ($latest.runtimeSlot == $active.runtimeSlot
          or $latest.runtimeSlot == $requested_slot)
        and (requested_ref($latest) | length) <= 1
        and ((requested_ref($latest) | length) == 0
          or requested_ref_is_exact($latest))
        and ($latest.runtimeSlot != $requested_slot
          or requested_ref_is_exact($latest))
        and ($active.runtimeSlot != $requested_slot
          or requested_ref_is_exact($active))
    ' >/dev/null \
    || die "existing worker Apify references are invalid or the selected slot version changed; active and latest identities must agree, latest may not drop an active recovery reference, and same-slot overwrite can strand unresolved runs and account identity"
}

prepare_apify_secret_assignments() {
  local config="${1:-}"
  local retained_refs='[]'
  if [[ -n "$config" ]]; then
    retained_refs="$(jq -ce \
      --arg selected_slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
      --arg selected_version "$apify_secret_version" '
        . as $config
        | def env: ($config.spec.template.spec.containers[0].env // []);
        def specs: [
          {slot: "primary", env: "APIFY_PRIMARY_API_TOKEN", secret: "ai-baram-v2-apify-primary"},
          {slot: "secondary", env: "APIFY_SECONDARY_API_TOKEN", secret: "ai-baram-v2-apify-secondary"},
          {slot: "tertiary", env: "APIFY_TERTIARY_API_TOKEN", secret: "ai-baram-v2-apify-tertiary"},
          {slot: "quaternary", env: "APIFY_QUATERNARY_API_TOKEN", secret: "ai-baram-v2-apify-quaternary"},
          {slot: "quinary", env: "APIFY_QUINARY_API_TOKEN", secret: "ai-baram-v2-apify-quinary"}
        ];
        def entries($name): [env[] | select(.name == $name)];
        if (specs | all(entries(.env) | length <= 1)) then
          (specs[] | select(.slot == $selected_slot)) as $selected
          | if (entries($selected.env) | length) == 0 then .
            elif (entries($selected.env) | length) == 1
              and (entries($selected.env)[0] | has("value") | not)
              and entries($selected.env)[0].valueFrom.secretKeyRef.name == $selected.secret
              and ((entries($selected.env)[0].valueFrom.secretKeyRef.key | tostring) == $selected_version)
            then .
            else error("selected Apify slot version is immutable")
            end
          |
          [specs[]
            | select(.slot != $selected_slot)
            | . as $spec
            | entries($spec.env)[]
            | select(
                (has("value") | not)
                and .valueFrom.secretKeyRef.name == $spec.secret
                and ((.valueFrom.secretKeyRef.key | tostring) | test("^[1-9][0-9]*$"))
              )
            | {
                env: $spec.env,
                secret: $spec.secret,
                version: (.valueFrom.secretKeyRef.key | tostring)
              }
          ] as $valid
          | ([specs[]
              | select(.slot != $selected_slot)
              | select((entries(.env) | length) == 1)] | length) == ($valid | length)
            or error("invalid recovery reference")
          | $valid
        else error("duplicate Apify token environment variable")
        end
      ' <<<"$config")" \
      || die "existing worker Apify references are invalid or the selected slot version changed; same-slot overwrite can strand unresolved runs and account identity"
  fi

  expected_apify_secret_refs_json="$(jq -cn \
    --arg selected_env "$apify_env_key" \
    --arg selected_secret "$apify_secret_id" \
    --arg selected_version "$apify_secret_version" \
    --argjson retained "$retained_refs" '
      ($retained + [{
        env: $selected_env,
        secret: $selected_secret,
        version: $selected_version
      }]) | sort_by(.env)
    ')"
  apify_secret_assignments="$(jq -r '
      map("\(.env)=\(.secret):\(.version)") | join(",")
    ' <<<"$expected_apify_secret_refs_json")"
}

service_origin() {
  local config="$1"
  jq -er '.status.url // .status.address.url' <<<"$config"
}

revision_json() {
  local revision="$1"
  gcloud run revisions describe "$revision" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    --format=json 2>/dev/null
}

revision_is_ready_with_provenance() {
  local config="$1"
  local revision="$2"
  local expected_sha="${3:-}"
  jq -e \
    --arg revision "$revision" \
    --arg label_key "$PROVENANCE_LABEL_KEY" \
    --arg expected_sha "$expected_sha" '
      .metadata.name == $revision
        and ((.metadata.labels // {})[$label_key] // "" | test("^[0-9a-f]{40}$"))
        and ($expected_sha == ""
          or (.metadata.labels // {})[$label_key] == $expected_sha)
        and ([.status.conditions[]?
          | select(.type == "Ready" and .status == "True")] | length) == 1
    ' <<<"$config" >/dev/null
}

revision_is_ready() {
  local config="$1"
  local revision="$2"
  jq -e --arg revision "$revision" '
    .metadata.name == $revision
      and ([.status.conditions[]?
        | select(.type == "Ready" and .status == "True")] | length) == 1
  ' <<<"$config" >/dev/null
}

bootstrap_revision_is_execution_disabled() {
  local config="$1"
  jq -e '
    def containers: (.spec.containers // .spec.template.spec.containers // []);
    def values($name):
      [containers[0].env[]? | select(.name == $name) | .value];
    def disabled($name):
      (values($name) == [] or values($name) == ["false"]);
    disabled("ANALYSIS_V2_TASKS_ENABLED")
      and disabled("ANALYSIS_V2_WORKER_ENABLED")
      and disabled("ANALYSIS_V2_RECOVERY_ENABLED")
      and disabled("PREFLIGHT_TASKS_ENABLED")
      and disabled("PREFLIGHT_LOCAL_AFTER_ENABLED")
  ' <<<"$config" >/dev/null
}

verify_revision_provenance() {
  local revision="$1"
  local expected_sha="${2:-}"
  local attempt
  local attempt_label="attempts"
  local config=""
  local max_attempts="1"
  [[ "$mode" != "apply" ]] \
    || max_attempts="$REVISION_OBSERVATION_MAX_ATTEMPTS"
  verified_revision_config=""
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    config=""
    if config="$(revision_json "$revision")" \
      && revision_is_ready_with_provenance \
        "$config" "$revision" "$expected_sha"; then
      verified_revision_config="$config"
      log "verified: ready Cloud Run revision provenance: $revision"
      return 0
    fi
    if ((attempt < max_attempts)); then
      sleep "$attempt"
    fi
  done
  [[ "$max_attempts" != "1" ]] || attempt_label="attempt"
  die "Cloud Run revision was unobservable, unready, or missing exact commit provenance after $max_attempts $attempt_label: $revision"
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
  local -a staging_args=(--no-traffic)
  if [[ "$mode" == "dry-run" && "$initial_deployment" == "true" ]]; then
    log "[dry-run] canonical Cloud Run task targets will be set after source deployment"
    return 0
  fi
  config="$(service_json)" \
    || die "Cloud Run worker is unavailable for endpoint configuration"
  origin="$(service_origin "$config")" \
    || die "Cloud Run worker has no canonical HTTPS URL"
  [[ "$origin" =~ ^https://[a-z0-9.-]+$ ]] \
    || die "Cloud Run worker returned an invalid canonical URL"

  if [[ "$mode" == "check" ]]; then
    worker_endpoint_env_matches "$config" "$origin" \
      || die "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"
    log "verified: V2 and preflight tasks target the canonical private worker URL"
    return 0
  fi

  if [[ "$mode" == "apply" ]]; then
    [[ "$build_revision_image" =~ @sha256:[0-9a-f]{64}$ ]] \
      || die "source-build revision did not expose an immutable image digest"
    staging_args+=("--image=$build_revision_image")
  else
    log "[dry-run] final revision will pin the immutable image digest from the staged source-build revision"
  fi

  run_mutation gcloud run services update \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "${staging_args[@]}" \
    "--revision-suffix=$final_revision_suffix" \
    "--update-labels=$PROVENANCE_LABEL_KEY=$source_commit_sha" \
    "--update-env-vars=ANALYSIS_V2_TASKS_ENABLED=true,ANALYSIS_V2_WORKER_ENABLED=$worker_enabled,ANALYSIS_V2_RECOVERY_ENABLED=$recovery_enabled,ANALYSIS_V2_TASKS_PROJECT=$ANALYSIS_V2_TASKS_PROJECT,ANALYSIS_V2_TASKS_LOCATION=$ANALYSIS_V2_TASKS_LOCATION,ANALYSIS_V2_TASKS_QUEUE=$ANALYSIS_V2_TASKS_QUEUE,ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL,ANALYSIS_V2_TASKS_CALLER_AUTH_MODE=adc,ANALYSIS_V2_APIFY_API_TOKEN_SLOT=$ANALYSIS_V2_APIFY_API_TOKEN_SLOT,ANALYSIS_V2_TASKS_TARGET_URL=$origin/api/analysis/v2/worker,ANALYSIS_V2_TASKS_OIDC_AUDIENCE=$origin,PREFLIGHT_TASKS_ENABLED=true,PREFLIGHT_TASKS_PROJECT=$ANALYSIS_V2_TASKS_PROJECT,PREFLIGHT_TASKS_LOCATION=$ANALYSIS_V2_TASKS_LOCATION,PREFLIGHT_TASKS_QUEUE=$preflight_queue,PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL,PREFLIGHT_TASKS_CALLER_AUTH_MODE=adc,PREFLIGHT_TASKS_TARGET_URL=$origin/api/analysis/preflight/worker,PREFLIGHT_TASKS_OIDC_AUDIENCE=$origin,PREFLIGHT_LOCAL_AFTER_ENABLED=false,ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL=$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL,ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE=$origin" \
    '--remove-env-vars=ANALYSIS_V2_ADMISSION_ENABLED,ANALYSIS_V2_WORKER_EXECUTION_ENABLED' \
    --quiet

  if [[ "$mode" == "apply" ]]; then
    config="$(service_json)" || die "Cloud Run worker was unavailable after endpoint update"
    staged_revision="$(jq -er '.status.latestCreatedRevisionName' <<<"$config")" \
      || die "staged Cloud Run revision name was not observable"
    [[ "$staged_revision" == "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE-$final_revision_suffix" ]] \
      || die "Cloud Run staged an unexpected final revision"
    service_runtime_config_matches "$config" \
      || die "Cloud Run worker became unready after canonical runtime env update"
    worker_endpoint_env_matches "$config" "$origin" \
      || die "canonical Cloud Tasks worker targets were not applied"
    if [[ -n "$known_good_revision" ]]; then
      service_traffic_matches_revision "$config" "$known_good_revision" \
        || die "staging changed live traffic before promotion"
    fi
    verify_revision_provenance "$staged_revision" "$source_commit_sha"
    config="$verified_revision_config"
    [[ "$(jq -er '.spec.containers[0].image' <<<"$config")" \
      == "$build_revision_image" ]] \
      || die "staged final revision does not use the verified source-build image digest"
    log "verified: final worker revision is staged without receiving live traffic"
  else
    staged_revision="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE-$final_revision_suffix"
  fi
}

env_json_has_bucket() {
  local env_json="$1"
  local expected="$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET"
  jq -e --arg expected "$expected" \
    '.ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET == $expected' \
    <<<"$env_json" >/dev/null
}

parse_env_file_json() {
  local env_file="$1"
  local validator="$script_dir/validate-analysis-v2-env-file.mjs"
  [[ -f "$validator" ]] || die "structured env manifest validator is missing"
  node "$validator" "$env_file"
}

write_env_snapshot() {
  local env_json="$1"
  local name="$2"
  local output_variable="$3"
  local snapshot
  if [[ -z "$manifest_snapshot_dir" ]]; then
    manifest_snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-env-snapshot.XXXXXX")"
    chmod 700 "$manifest_snapshot_dir"
  fi
  snapshot="$manifest_snapshot_dir/$name.yaml"
  (umask 077 && printf '%s\n' "$env_json" >"$snapshot")
  chmod 400 "$snapshot"
  printf -v "$output_variable" '%s' "$snapshot"
}

env_json_has_nonempty_value() {
  local env_json="$1"
  local expected_key="$2"
  jq -e --arg expected_key "$expected_key" \
    'has($expected_key) and (.[$expected_key] | length > 0)' \
    <<<"$env_json" >/dev/null
}

env_json_value_equals() {
  local env_json="$1"
  local expected_key="$2"
  local expected_value="$3"
  jq -e --arg expected_key "$expected_key" --arg expected_value "$expected_value" \
    '.[$expected_key] == $expected_value' \
    <<<"$env_json" >/dev/null
}

validate_runtime_env_keys() {
  local env_json="$1"
  local key
  while IFS= read -r key; do
    case "$key" in
      VERCEL|VERCEL_ENV|GCP_VERCEL_WIF_PROVIDER_RESOURCE|VERCEL_OIDC_TEAM_SLUG|VERCEL_OIDC_TEAM_ID|VERCEL_OIDC_PROJECT_ID|*_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL|ANALYSIS_V2_ADMISSION_ENABLED|ANALYSIS_V2_WORKER_EXECUTION_ENABLED|ANALYSIS_V2_TASKS_ENABLED|ANALYSIS_V2_WORKER_ENABLED|ANALYSIS_V2_RECOVERY_ENABLED|PREFLIGHT_TASKS_ENABLED|PREFLIGHT_LOCAL_AFTER_ENABLED)
        die "runtime env file contains a forbidden placement, gate, or WIF bootstrap key: $key"
        ;;
      SUPABASE_SERVICE_ROLE_KEY|IMAGE_PROXY_SIGNING_SECRET|APIFY_API_TOKEN|APIFY_*_API_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_SERVICE_ACCOUNT_KEY_BASE64|*_API_KEY|*_SECRET|*_PASSWORD|*_CREDENTIAL|*_CREDENTIALS|*_PRIVATE_KEY|*_KEY_BASE64|*_ACCESS_TOKEN|*_REFRESH_TOKEN|*_OIDC_TOKEN|*_TOKEN)
        die "runtime env file must not contain plaintext provider or credential key: $key"
        ;;
    esac
  done < <(jq -r 'keys[]' <<<"$env_json")
}

validate_build_env_keys() {
  local env_file="$1"
  local env_json="$2"
  local key
  case "$env_file" in
    *.yaml|*.yml) ;;
    *) die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be a YAML file" ;;
  esac
  local key_count=0
  while IFS= read -r key; do
    key_count=$((key_count + 1))
    case "$key" in
      NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY)
        ;;
      *) die "build env file contains a non-public or unsupported key: $key" ;;
    esac
  done < <(jq -r 'keys[]' <<<"$env_json")
  [[ "$key_count" == "2" ]] \
    || die "build env file must contain exactly the two public Supabase keys"
  env_json_has_nonempty_value "$env_json" NEXT_PUBLIC_SUPABASE_URL \
    || die "build env file must set one non-empty NEXT_PUBLIC_SUPABASE_URL"
  env_json_has_nonempty_value "$env_json" NEXT_PUBLIC_SUPABASE_ANON_KEY \
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
  local deploy_lock_script="$script_dir/configure-analysis-v2-deploy-lock.sh"
  [[ -f "$identity_script" ]] \
    || die "configure-analysis-v2-worker-identity.sh is missing"
  [[ -f "$secrets_script" ]] \
    || die "configure-analysis-v2-secrets.sh is missing"
  [[ -f "$bucket_script" ]] \
    || die "configure-analysis-v2-media-bucket.sh is missing"
  [[ -f "$deploy_lock_script" ]] \
    || die "configure-analysis-v2-deploy-lock.sh is missing"

  log "verifying prerequisite order: worker identity -> secrets -> media bucket -> worker deploy"
  bash "$identity_script" --check
  bash "$secrets_script" --check
  bash "$bucket_script" --check
  log "deploy-lock bucket metadata and IAM are audited separately by an admin; this deploy verifies object access while acquiring the generation-bound lock"
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
    "--revision-suffix=$build_revision_suffix"
    "--update-labels=$PROVENANCE_LABEL_KEY=$source_commit_sha"
    '--description=Private durable Analysis V2 Cloud Tasks worker'
    "--set-secrets=SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SECRET_ID:$supabase_secret_version,$apify_secret_assignments,IMAGE_PROXY_SIGNING_SECRET=$IMAGE_SIGNING_SECRET_ID:$image_signing_secret_version,ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET=$PREFLIGHT_IDENTITY_HMAC_SECRET_ID:$preflight_identity_hmac_secret_version"
    '--quiet'
  )

  if [[ -n "$worker_env_deploy_file" ]]; then
    deploy_args+=("--env-vars-file=$worker_env_deploy_file")
  else
    deploy_args+=("--update-env-vars=ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET,ANALYSIS_V2_APIFY_API_TOKEN_SLOT=$ANALYSIS_V2_APIFY_API_TOKEN_SLOT")
  fi
  if [[ "$initial_deployment" != "true" ]]; then
    deploy_args+=('--no-traffic')
  fi
  deploy_args+=("--build-env-vars-file=$worker_build_env_deploy_file")
  if [[ -n "$worker_build_service_account" ]]; then
    deploy_args+=("--build-service-account=$worker_build_service_account_resource")
  fi
}

resolve_known_good_service_revision() {
  local config="$1"
  known_good_revision="$(jq -er '
    [.status.traffic[]? | select((.percent // 0) > 0)] as $traffic
    | if (($traffic | length) == 1
        and ($traffic[0].percent | tonumber) == 100
        and ($traffic[0].revisionName // "") != "")
      then $traffic[0].revisionName
      else error("ambiguous traffic")
      end
  ' <<<"$config")" \
    || die "existing Cloud Run traffic must be one known-good revision at 100% before deployment"
  known_good_config="$(revision_json "$known_good_revision")" \
    || die "known-good Cloud Run revision was not observable"
  revision_is_ready "$known_good_config" "$known_good_revision" \
    || die "known-good Cloud Run traffic revision is not Ready"
  if bootstrap_revision_is_execution_disabled "$known_good_config"; then
    known_good_is_bootstrap="true"
    log "active known-good revision is an execution-disabled bootstrap rollback revision"
  fi
  known_good_recovery_enabled="$(jq -r '
    def containers: (.spec.containers // .spec.template.spec.containers // []);
    [containers[0].env[]?
      | select(.name == "ANALYSIS_V2_RECOVERY_ENABLED") | .value][0] // "false"
  ' <<<"$known_good_config")"
  [[ "$known_good_recovery_enabled" == "true" \
    || "$known_good_recovery_enabled" == "false" ]] \
    || die "known-good revision has an invalid recovery gate"
  log "recorded known-good rollback revision: $known_good_revision"
}

deploy_or_verify_service() {
  local existing="false"
  local config=""
  local latest_ready=""
  local lookup_status="0"
  if config="$(service_json)"; then
    existing="true"
    service_has_no_traffic_tags "$config" \
      || die "Cloud Run traffic tags are forbidden while Gemini concurrency is process-local"
    resolve_known_good_service_revision "$config"
    verify_existing_service_secret_identity "$config" "$known_good_config"
    prepare_apify_secret_assignments "$config"
  else
    lookup_status="$?"
    if [[ "$lookup_status" == "$SERVICE_JSON_NOT_FOUND_STATUS" ]]; then
      initial_deployment="true"
      prepare_apify_secret_assignments
    else
      die "Cloud Run worker lookup failed; refusing to infer a first deployment"
    fi
  fi

  if [[ "$mode" == "check" ]]; then
    [[ "$existing" == "true" ]] || die "Cloud Run worker does not exist"
    service_runtime_matches "$config" \
      || die "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
    latest_ready="$(jq -er '.status.latestReadyRevisionName' <<<"$config")" \
      || die "Cloud Run worker has no ready revision"
    verify_revision_provenance "$latest_ready" "$source_commit_sha"
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
  if [[ "$existing" == "false" \
    && ( "$worker_enabled" != "false" || "$recovery_enabled" != "false" ) ]]; then
    die "first deployment requires both worker gates false because no known-good rollback revision exists"
  fi

  if [[ "$existing" == "true" ]]; then
    if [[ "$known_good_is_bootstrap" == "true" ]]; then
      log "manual rollback step 1: pause recovery and retention Scheduler jobs"
      log "manual rollback step 2: gcloud run services update-traffic $ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE --project=$ANALYSIS_V2_TASKS_PROJECT --region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION --to-revisions=$known_good_revision=100"
    elif [[ "$known_good_recovery_enabled" == "false" ]]; then
      log "manual rollback step 1: pause the recovery Scheduler job"
      log "manual rollback step 2: gcloud run services update-traffic $ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE --project=$ANALYSIS_V2_TASKS_PROJECT --region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION --to-revisions=$known_good_revision=100"
    else
      log "manual rollback step 1: gcloud run services update-traffic $ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE --project=$ANALYSIS_V2_TASKS_PROJECT --region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION --to-revisions=$known_good_revision=100"
      log "manual rollback step 2: resume the recovery Scheduler job"
    fi
  else
    log "first deployment has no prior traffic revision; both execution gates remain closed"
  fi

  build_deploy_args
  run_mutation "${deploy_args[@]}"

  if [[ "$mode" == "apply" ]]; then
    config="$(service_json)" || die "Cloud Run worker was not observable after deployment"
    build_revision="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE-$build_revision_suffix"
    [[ "$(jq -er '.status.latestCreatedRevisionName' <<<"$config")" == "$build_revision" ]] \
      || die "Cloud Run staged an unexpected source-build revision"
    service_runtime_config_matches "$config" \
      || die "Cloud Run worker runtime configuration was not applied"
    if [[ -n "$known_good_revision" ]]; then
      service_traffic_matches_revision "$config" "$known_good_revision" \
        || die "source deployment changed live traffic before promotion"
    fi
    verify_revision_provenance "$build_revision" "$source_commit_sha"
    known_good_config="$verified_revision_config"
    build_revision_image="$(jq -er '.spec.containers[0].image' \
      <<<"$known_good_config")" \
      || die "source-build Cloud Run revision image was not observable"
    [[ "$build_revision_image" =~ @sha256:[0-9a-f]{64}$ ]] \
      || die "source-build Cloud Run revision image is not an immutable digest"
    if [[ -n "$known_good_revision" ]]; then
      log "verified: source-build revision staged without live traffic"
    else
      service_traffic_matches_revision "$config" "$build_revision" \
        || die "first deployment did not expose a single disabled bootstrap rollback revision"
      bootstrap_revision_is_execution_disabled "$known_good_config" \
        || die "first-deployment bootstrap revision is not fully execution-disabled"
      known_good_revision="$build_revision"
      known_good_recovery_enabled="false"
      known_good_is_bootstrap="true"
      log "recorded execution-disabled bootstrap rollback revision: $known_good_revision"
      log "manual rollback step 1: pause recovery and retention Scheduler jobs"
      log "manual rollback step 2: gcloud run services update-traffic $ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE --project=$ANALYSIS_V2_TASKS_PROJECT --region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION --to-revisions=$known_good_revision=100"
    fi
  fi
}

configure_queue_and_oidc() {
  local operation_mode="${1:-$mode}"
  local queue_script
  local preflight_script
  queue_script="$(dirname "$0")/configure-analysis-v2-tasks-queue.sh"
  preflight_script="$(dirname "$0")/configure-preflight-tasks-queue.sh"
  [[ -f "$queue_script" ]] || die "configure-analysis-v2-tasks-queue.sh is missing"
  [[ -f "$preflight_script" ]] || die "configure-preflight-tasks-queue.sh is missing"

  if [[ "$operation_mode" == "dry-run" && "$initial_deployment" == "true" ]]; then
    print_command bash "$queue_script" --dry-run
    print_command bash "$preflight_script" --dry-run
    log "[dry-run] V2 and preflight queue/OIDC checks will run after the worker service exists"
    return 0
  fi
  queue_mode_args=()
  [[ "$operation_mode" == "dry-run" ]] && queue_mode_args+=(--dry-run)
  [[ "$operation_mode" == "check" ]] && queue_mode_args+=(--check)
  [[ "$reconcile_iam" == "true" && "$operation_mode" != "check" ]] \
    && queue_mode_args+=(--reconcile-iam)
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

verify_exact_invoker_only() {
  local policy
  policy="$(service_iam_policy)" \
    || die "Cloud Run invoker policy was not observable after promotion"
  service_iam_matches "$policy" \
    || die "Cloud Run invoker policy drifted after promotion"
  log "verified: post-promotion Cloud Run invoker policy remains exact"
}

configure_maintenance() {
  local operation_mode="${1:-$mode}"
  local gate_value="${2:-$recovery_enabled}"
  local maintenance_script="$script_dir/configure-analysis-v2-maintenance.sh"
  local -a maintenance_args=()
  [[ -f "$maintenance_script" ]] \
    || die "configure-analysis-v2-maintenance.sh is missing"
  [[ "$operation_mode" == "dry-run" ]] && maintenance_args+=(--dry-run)
  [[ "$operation_mode" == "check" ]] && maintenance_args+=(--check)
  [[ "$reconcile_jobs" == "true" && "$operation_mode" != "check" ]] \
    && maintenance_args+=(--reconcile-jobs)
  if [[ "$operation_mode" == "dry-run" && "$initial_deployment" == "true" ]]; then
    print_command env "ANALYSIS_V2_RECOVERY_ENABLED=$gate_value" \
      bash "$maintenance_script" "${maintenance_args[@]}"
    log "[dry-run] maintenance scheduler checks will run after the worker service exists"
  elif ((${#maintenance_args[@]} == 0)); then
    env "ANALYSIS_V2_RECOVERY_ENABLED=$gate_value" bash "$maintenance_script"
  else
    env "ANALYSIS_V2_RECOVERY_ENABLED=$gate_value" \
      bash "$maintenance_script" "${maintenance_args[@]}"
  fi
}

recovery_scheduler_config_is_exact() {
  local config="$1"
  local run_config
  local origin
  run_config="$(service_json)" || return 1
  origin="$(service_origin "$run_config")" || return 1
  jq -e \
    --arg uri "$origin/api/analysis/v2/recover" \
    --arg audience "$origin" \
    --arg service_account "$ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL" '
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

restore_recovery_scheduler_gate() {
  local action
  local config
  local current_state
  local desired_state="PAUSED"
  local job="${ANALYSIS_V2_RECOVERY_SCHEDULER_JOB:-analysis-v2-recovery}"
  local location="${ANALYSIS_V2_MAINTENANCE_LOCATION:-$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION}"
  [[ "$known_good_recovery_enabled" != "true" ]] || desired_state="ENABLED"
  config="$(gcloud scheduler jobs describe "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --format=json)" || return 1
  current_state="$(jq -r '.state // "ENABLED"' <<<"$config")"
  if [[ "$desired_state" == "ENABLED" ]] \
    && ! recovery_scheduler_config_is_exact "$config"; then
    if [[ "$current_state" == "ENABLED" ]]; then
      gcloud scheduler jobs pause "$job" \
        "--project=$ANALYSIS_V2_TASKS_PROJECT" \
        "--location=$location" \
        --quiet || return 1
      config="$(gcloud scheduler jobs describe "$job" \
        "--project=$ANALYSIS_V2_TASKS_PROJECT" \
        "--location=$location" \
        --format=json)" || return 1
      [[ "$(jq -r '.state // "ENABLED"' <<<"$config")" == "PAUSED" ]] \
        || return 1
    elif [[ "$current_state" != "PAUSED" ]]; then
      return 1
    fi
    printf 'critical: refusing to resume a structurally drifted recovery Scheduler job\n' >&2
    return 1
  fi
  if [[ "$current_state" == "$desired_state" ]]; then
    return 0
  elif [[ "$current_state" == "ENABLED" && "$desired_state" == "PAUSED" ]]; then
    action="pause"
  elif [[ "$current_state" == "PAUSED" && "$desired_state" == "ENABLED" ]]; then
    action="resume"
  else
    return 1
  fi
  gcloud scheduler jobs "$action" \
    "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --quiet || return 1
  config="$(gcloud scheduler jobs describe "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --format=json)" || return 1
  [[ "$(jq -r '.state // "ENABLED"' <<<"$config")" == "$desired_state" ]] \
    && { [[ "$desired_state" != "ENABLED" ]] \
      || recovery_scheduler_config_is_exact "$config"; }
}

pause_scheduler_job_if_present() {
  local job="$1"
  local config
  local current_state
  local location="${ANALYSIS_V2_MAINTENANCE_LOCATION:-$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION}"
  if ! config="$(gcloud scheduler jobs describe "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --format=json 2>/dev/null)"; then
    local listed_jobs
    local listed_job
    listed_jobs="$(gcloud scheduler jobs list \
      "--project=$ANALYSIS_V2_TASKS_PROJECT" \
      "--location=$location" \
      '--format=value(name)')" || return 1
    while IFS= read -r listed_job; do
      [[ -z "$listed_job" || "${listed_job##*/}" != "$job" ]] || return 1
    done <<<"$listed_jobs"
    return 0
  fi
  current_state="$(jq -r '.state // "ENABLED"' <<<"$config")"
  if [[ "$current_state" == "PAUSED" ]]; then
    return 0
  elif [[ "$current_state" != "ENABLED" ]]; then
    return 1
  fi
  gcloud scheduler jobs pause "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --quiet || return 1
  config="$(gcloud scheduler jobs describe "$job" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--location=$location" \
    --format=json)" || return 1
  [[ "$(jq -r '.state // "ENABLED"' <<<"$config")" == "PAUSED" ]]
}

rollback_live_traffic() {
  local config
  if [[ -z "$known_good_revision" ]]; then
    printf 'rollback unavailable: first deployment has no recorded known-good revision; execution gates were required to remain false\n' >&2
    return 1
  fi

  config="$(service_json)" || return 1
  if ! service_traffic_matches_revision "$config" "$known_good_revision" \
    && { [[ -z "$staged_revision" ]] \
      || ! service_traffic_matches_revision "$config" "$staged_revision"; }; then
    printf 'critical: refusing stale rollback because live traffic is owned by another deployment\n' >&2
    return 1
  fi

  if [[ "$known_good_is_bootstrap" == "true" ]]; then
    printf 'rollback: pausing maintenance Schedulers before restoring the execution-disabled bootstrap revision\n' >&2
    if ! pause_scheduler_job_if_present \
      "${ANALYSIS_V2_RECOVERY_SCHEDULER_JOB:-analysis-v2-recovery}" \
      || ! pause_scheduler_job_if_present \
        "${ANALYSIS_V2_RETENTION_SCHEDULER_JOB:-analysis-v2-preflight-retention}"; then
      printf 'critical: maintenance Schedulers could not be paused before bootstrap traffic rollback\n' >&2
      return 1
    fi
  elif [[ "$known_good_recovery_enabled" == "false" ]]; then
    printf 'rollback: pausing recovery Scheduler before restoring the recovery-disabled revision\n' >&2
    if ! restore_recovery_scheduler_gate; then
      printf 'critical: recovery Scheduler could not be paused before traffic rollback\n' >&2
      return 1
    fi
  fi

  printf 'rollback: restoring Cloud Run traffic to %s\n' "$known_good_revision" >&2
  gcloud run services update-traffic \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--to-revisions=$known_good_revision=100" \
    --quiet \
    || return 1
  config="$(service_json)" || return 1
  service_traffic_matches_revision "$config" "$known_good_revision" \
    || return 1
  if [[ "$known_good_is_bootstrap" != "true" \
    && "$known_good_recovery_enabled" == "true" ]] \
    && ! restore_recovery_scheduler_gate; then
    printf 'critical: traffic rollback succeeded but recovery Scheduler could not be resumed\n' >&2
    return 1
  fi
  printf 'rollback verified: %s serves 100%% of traffic\n' "$known_good_revision" >&2
}

promote_staged_revision() {
  local config
  if [[ "$mode" == "check" ]]; then
    return 0
  fi
  if [[ "$mode" == "dry-run" ]]; then
    if [[ -n "$staged_revision" ]]; then
      print_command gcloud run services update-traffic \
        "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
        "--project=$ANALYSIS_V2_TASKS_PROJECT" \
        "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
        "--to-revisions=$staged_revision=100" \
        --quiet
    else
      log "[dry-run] the exact ready revision will be resolved and promoted after no-traffic staging"
    fi
    return 0
  fi

  [[ -n "$staged_revision" ]] || die "no staged Cloud Run revision is available for promotion"
  config="$(service_json)" \
    || die "Cloud Run service was not observable immediately before promotion"
  service_traffic_matches_revision "$config" "$known_good_revision" \
    || die "live traffic changed after staging; refusing a concurrent promotion"
  rollback_armed="true"
  gcloud run services update-traffic \
    "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE" \
    "--project=$ANALYSIS_V2_TASKS_PROJECT" \
    "--region=$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
    "--to-revisions=$staged_revision=100" \
    --quiet \
    || die "Cloud Run revision promotion failed"
  config="$(service_json)" || die "Cloud Run service was not observable after promotion"
  service_runtime_config_matches "$config" \
    || die "promoted Cloud Run runtime configuration is not exact"
  worker_endpoint_env_matches "$config" "$(service_origin "$config")" \
    || die "promoted Cloud Run endpoint configuration is not exact"
  service_traffic_matches_revision "$config" "$staged_revision" \
    || die "promoted Cloud Run revision does not serve exactly 100% of traffic"
  verify_revision_provenance "$staged_revision" "$source_commit_sha"
  log "promoted verified revision: $staged_revision (commit $source_commit_sha)"
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
normalize_v1_enqueuer_identity

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
  ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE \
  ANALYSIS_V2_TASKS_CLOUD_RUN_REGION \
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET \
  ANALYSIS_V2_DEPLOY_LOCK_BUCKET \
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT \
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION \
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION \
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION \
  ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION; do
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
manifest_snapshot_dir=""
worker_env_deploy_file=""
worker_build_env_deploy_file=""
trap '[[ -z "${manifest_snapshot_dir:-}" ]] || rm -rf "$manifest_snapshot_dir"' EXIT
readonly worker_build_service_account="$ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
readonly worker_build_service_account_resource="projects/$ANALYSIS_V2_TASKS_PROJECT/serviceAccounts/$worker_build_service_account"
readonly deploy_lock_bucket="$ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
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
readonly preflight_identity_hmac_secret_version="$ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION"

[[ -z "${ANALYSIS_V2_WORKER_EXECUTION_ENABLED:-}" ]] \
  || die "ANALYSIS_V2_WORKER_EXECUTION_ENABLED was removed; set ANALYSIS_V2_WORKER_ENABLED and ANALYSIS_V2_RECOVERY_ENABLED separately"

validate_project "$ANALYSIS_V2_TASKS_PROJECT"
validate_location "$ANALYSIS_V2_TASKS_LOCATION" "ANALYSIS_V2_TASKS_LOCATION"
validate_location "$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION" \
  "ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
validate_service "$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
validate_queue "$preflight_queue"
validate_bucket "$ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET" \
  "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET"
validate_deploy_lock_bucket "$ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
validate_slot "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
validate_numeric_version "$supabase_secret_version" \
  ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION
validate_numeric_version "$apify_secret_version" \
  ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION
validate_numeric_version "$image_signing_secret_version" \
  ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION
validate_numeric_version "$preflight_identity_hmac_secret_version" \
  ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION
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
command -v node >/dev/null 2>&1 || die "node is required for structured env manifest validation"
command -v jq >/dev/null 2>&1 || die "jq is required"
if [[ -n "$worker_env_file" ]]; then
  runtime_env_json=""
  [[ -f "$worker_env_file" ]] || die "ANALYSIS_V2_WORKER_ENV_VARS_FILE does not exist"
  validate_env_file_upload_boundary "$worker_env_file" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE"
  runtime_env_json="$(parse_env_file_json "$worker_env_file")" \
    || die "runtime env file must be a valid, duplicate-free YAML or ENV mapping"
  validate_runtime_env_keys "$runtime_env_json"
  env_json_has_bucket "$runtime_env_json" \
    || die "runtime env file must set ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET to the configured bucket"
  env_json_value_equals "$runtime_env_json" ANALYSIS_V2_APIFY_API_TOKEN_SLOT \
    "$ANALYSIS_V2_APIFY_API_TOKEN_SLOT" \
    || die "runtime env file must set the exact selected ANALYSIS_V2_APIFY_API_TOKEN_SLOT"
  write_env_snapshot "$runtime_env_json" runtime worker_env_deploy_file
fi
if [[ -n "$worker_build_env_file" ]]; then
  build_env_json=""
  [[ -f "$worker_build_env_file" ]] \
    || die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE does not exist"
  validate_env_file_upload_boundary "$worker_build_env_file" \
    "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE"
  case "$worker_build_env_file" in
    *.yaml|*.yml) ;;
    *) die "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be a YAML file" ;;
  esac
  build_env_json="$(parse_env_file_json "$worker_build_env_file")" \
    || die "build env file must be a valid, duplicate-free YAML mapping"
  validate_build_env_keys "$worker_build_env_file" "$build_env_json"
  write_env_snapshot "$build_env_json" build worker_build_env_deploy_file
fi
validate_service_account_email "$worker_build_service_account" \
  "ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT"
[[ "$(service_account_project "$worker_build_service_account")" \
  == "$ANALYSIS_V2_TASKS_PROJECT" ]] \
  || die "worker build service account must belong to ANALYSIS_V2_TASKS_PROJECT"

command -v git >/dev/null 2>&1 || die "git is required to record source provenance"
readonly source_commit_sha="$(git -C "$worker_source_dir" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)"
[[ "$source_commit_sha" =~ ^[0-9a-f]{40}$ ]] \
  || die "ANALYSIS_V2_WORKER_SOURCE_DIR must have a valid Git commit"
revision_nonce="${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
if [[ -z "$revision_nonce" ]]; then
  printf -v revision_nonce '%05d' "$(( (RANDOM * 32768 + RANDOM) % 100000 ))"
fi
[[ "$revision_nonce" =~ ^[a-z0-9]{5}$ ]] \
  || die "ANALYSIS_V2_DEPLOY_REVISION_NONCE must be exactly five lowercase letters or digits"
readonly revision_nonce
readonly build_revision_suffix="b${source_commit_sha:0:6}${revision_nonce}"
readonly final_revision_suffix="f${source_commit_sha:0:6}${revision_nonce}"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
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
known_good_revision=""
known_good_config=""
known_good_recovery_enabled="false"
known_good_is_bootstrap="false"
initial_deployment="false"
build_revision=""
build_revision_image=""
staged_revision=""
verified_revision_config=""
rollback_armed="false"
deploy_lock_acquired="false"
deploy_lock_generation=""
deploy_lock_payload_file=""
deploy_lock_url=""
observed_lock_generation=""
observed_lock_owner=""

observe_deploy_lock_generation_owner() {
  local attempt
  local candidate_generation
  local candidate_owner
  observed_lock_generation=""
  observed_lock_owner=""
  for attempt in 1 2 3; do
    candidate_generation="$(gcloud storage objects describe "$deploy_lock_url" \
      '--format=value(generation)' 2>/dev/null)" || candidate_generation=""
    if [[ "$candidate_generation" =~ ^[1-9][0-9]*$ ]]; then
      candidate_owner="$(gcloud storage cat \
        "$deploy_lock_url#$candidate_generation" 2>/dev/null)" \
        || candidate_owner=""
      if [[ -n "$candidate_owner" ]]; then
        observed_lock_generation="$candidate_generation"
        observed_lock_owner="$candidate_owner"
        return 0
      fi
    fi
    [[ "$attempt" == "3" ]] || sleep "$attempt"
  done
  return 1
}

acquire_deploy_lock() {
  local create_reported_success="true"
  local owner_token
  deploy_lock_payload_file="$(mktemp "${TMPDIR:-/tmp}/analysis-v2-deploy-lock.XXXXXX")"
  deploy_lock_url="gs://$deploy_lock_bucket/$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION/$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE.lock"
  owner_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')" \
    || die "could not generate a deploy-lock owner token"
  [[ "$owner_token" =~ ^[a-f0-9]{32}$ ]] \
    || die "deploy-lock owner token generation returned an invalid value"
  printf '%s %s %s\n' "$source_commit_sha" "$revision_nonce" "$owner_token" \
    >"$deploy_lock_payload_file"
  if ! gcloud storage cp "$deploy_lock_payload_file" "$deploy_lock_url" \
    --if-generation-match=0 --quiet >/dev/null; then
    create_reported_success="false"
  fi
  if ! observe_deploy_lock_generation_owner; then
    if [[ "$create_reported_success" == "true" ]]; then
      die "deploy lock was created but its generation owner was not observable after bounded retries; inspect before manually removing $deploy_lock_url"
    fi
    die "deploy lock creation outcome is ambiguous and no owner was observable after bounded retries; inspect before manually removing $deploy_lock_url"
  fi
  if [[ "$observed_lock_owner" != "$(<"$deploy_lock_payload_file")" ]]; then
    if [[ "$create_reported_success" == "false" ]]; then
      die "another deployment holds the Cloud Storage deploy lock: $deploy_lock_url"
    fi
    die "deploy lock generation owner does not match this deployment"
  fi
  deploy_lock_generation="$observed_lock_generation"
  deploy_lock_acquired="true"
  if [[ "$create_reported_success" == "false" ]]; then
    log "adopted this deployment's generation-bound lock after an ambiguous create response"
  fi
  log "acquired exclusive deploy lock: $deploy_lock_url (generation $deploy_lock_generation)"
}

release_deploy_lock() {
  [[ "$deploy_lock_acquired" == "true" ]] || return 0
  [[ "$deploy_lock_generation" =~ ^[1-9][0-9]*$ ]] || return 1
  gcloud storage rm "$deploy_lock_url" \
    "--if-generation-match=$deploy_lock_generation" --quiet >/dev/null \
    || return 1
  deploy_lock_acquired="false"
  log "released exclusive deploy lock: $deploy_lock_url"
}

cleanup() {
  local status=0
  if ! release_deploy_lock; then
    printf 'critical: deploy lock release failed; inspect before removing %s manually\n' "$deploy_lock_url" >&2
    status=1
  fi
  [[ -z "$service_policy_file" ]] || rm -f "$service_policy_file"
  [[ -z "$source_archive_dir" ]] || rm -rf "$source_archive_dir"
  [[ -z "$deploy_lock_payload_file" ]] || rm -f "$deploy_lock_payload_file"
  [[ -z "$manifest_snapshot_dir" ]] || rm -rf "$manifest_snapshot_dir"
  return "$status"
}
on_exit() {
  local status="$?"
  local cleanup_status=0
  trap - EXIT
  if [[ "$status" != "0" && "$rollback_armed" == "true" ]]; then
    rollback_live_traffic \
      || printf 'critical: automatic rollback contract could not be fully verified; use the recorded manual rollback commands\n' >&2
  fi
  cleanup || cleanup_status="$?"
  if [[ "$status" == "0" && "$cleanup_status" != "0" ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap on_exit EXIT

verify_no_project_wide_invoker
verify_worker_prerequisites
ensure_api "$CLOUD_RUN_API"
ensure_api "$CLOUD_BUILD_API"
ensure_api "$ARTIFACT_REGISTRY_API"
if [[ "$mode" == "apply" ]]; then
  acquire_deploy_lock
  source_archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-source.XXXXXX")"
  bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
    "$worker_source_dir" "$source_archive_dir" >/dev/null
  [[ "$(git -C "$worker_source_dir" rev-parse --verify 'HEAD^{commit}')" \
    == "$source_commit_sha" ]] \
    || die "source commit changed while the deployment archive was prepared"
  worker_deploy_source_dir="$source_archive_dir"
  log "verified: source deploy uses a clean tracked commit archive"
fi
deploy_or_verify_service
ensure_worker_endpoint_env
configure_queue_and_oidc "$mode"
ensure_exact_invoker
prepromotion_recovery_enabled="$recovery_enabled"
if [[ "$mode" == "apply" ]]; then
  prepromotion_recovery_enabled="false"
  if [[ "$recovery_enabled" == "true" && -n "$known_good_revision" ]]; then
    prepromotion_recovery_enabled="$known_good_recovery_enabled"
  fi
fi
if [[ "$mode" == "apply" && "$known_good_is_bootstrap" == "true" ]]; then
  log "execution-disabled bootstrap traffic defers Scheduler reconciliation until the final gated revision is promoted"
else
  if [[ "$mode" == "apply" ]]; then
    rollback_armed="true"
  fi
  configure_maintenance "$mode" "$prepromotion_recovery_enabled"
fi
promote_staged_revision

if [[ "$mode" == "apply" ]]; then
  configure_maintenance apply "$recovery_enabled"
  configure_queue_and_oidc check
  verify_exact_invoker_only
  configure_maintenance check "$recovery_enabled"
  final_config="$(service_json)" \
    || die "Cloud Run service disappeared during post-promotion verification"
  service_runtime_config_matches "$final_config" \
    && worker_endpoint_env_matches "$final_config" "$(service_origin "$final_config")" \
    && service_traffic_matches_revision "$final_config" "$staged_revision" \
    || die "post-promotion Cloud Run configuration or traffic verification failed"
  verify_revision_provenance "$staged_revision" "$source_commit_sha"
  rollback_armed="false"
  log "verified: post-promotion queue, IAM, Scheduler, runtime, and traffic contracts"
fi

if [[ "$mode" == "dry-run" ]]; then
  log "dry-run complete: no mutations were applied"
else
  log "Analysis V2 Cloud Run worker and Cloud Tasks integration verified"
fi
