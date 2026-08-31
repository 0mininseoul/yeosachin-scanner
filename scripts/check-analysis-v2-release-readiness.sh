#!/usr/bin/env bash
set -euo pipefail

readonly repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly expected_progress_migration_version='20260829120000'
readonly progress_migration_path="$repo_dir/supabase/migrations/${expected_progress_migration_version}_add_analysis_v2_progress_signals_history.sql"
readonly cloud_run_provenance_label='analysis-v2-source-commit'
readonly image_proxy_probe_script="$repo_dir/scripts/check-image-proxy-signing-secret-compatibility.ts"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "missing required environment variable: $name"
}

validate_sha() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] \
    || die "$name must be one lowercase 40-character Git SHA"
}

validate_identifier() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z0-9_-]{1,128}$ ]] \
    || die "$name contains unsupported characters"
}

for command_name in jq gcloud curl supabase npx; do
  command -v "$command_name" >/dev/null 2>&1 \
    || die "$command_name CLI is required"
done

required_env ANALYSIS_V2_EXPECTED_GIT_SHA
required_env ANALYSIS_V2_TASKS_PROJECT
required_env ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE
required_env ANALYSIS_V2_TASKS_CLOUD_RUN_REGION
required_env VERCEL_PROJECT_ID
required_env VERCEL_TOKEN
required_env IMAGE_PROXY_SIGNING_SECRET
required_env ANALYSIS_V2_IMAGE_PROXY_PROBE_BASE_URL
required_env ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL
required_env ANALYSIS_CAPACITY_LEGACY_TARGET_URL
required_env ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE

expected_sha="$ANALYSIS_V2_EXPECTED_GIT_SHA"
cloud_project="$ANALYSIS_V2_TASKS_PROJECT"
cloud_service="$ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE"
cloud_region="$ANALYSIS_V2_TASKS_CLOUD_RUN_REGION"
vercel_project_id="$VERCEL_PROJECT_ID"
vercel_token="$VERCEL_TOKEN"
validate_sha ANALYSIS_V2_EXPECTED_GIT_SHA "$expected_sha"
validate_identifier VERCEL_PROJECT_ID "$vercel_project_id"
[[ "$vercel_token" != *[[:space:]]* ]] \
  && ((${#vercel_token} >= 8 && ${#vercel_token} <= 512)) \
  || die 'VERCEL_TOKEN must be a non-empty token without whitespace'
[[ "$cloud_project" =~ ^[a-z][a-z0-9.-]{4,28}[a-z0-9]$ ]] \
  || die 'ANALYSIS_V2_TASKS_PROJECT is invalid'
[[ "$cloud_service" =~ ^[a-z][a-z0-9-]{0,48}$ ]] \
  || die 'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE is invalid'
[[ "$cloud_region" =~ ^[a-z]+-[a-z]+[0-9]$ ]] \
  || die 'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION is invalid'
[[ -f "$image_proxy_probe_script" ]] \
  || die 'image proxy signing compatibility probe is missing'
[[ "$ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL" =~ ^https://[^[:space:]]+/api/analysis/capacity/readiness$ ]] \
  || die 'ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL must be the exact read-only public freeze endpoint'
[[ "$ANALYSIS_CAPACITY_LEGACY_TARGET_URL" =~ ^https://[^[:space:]]+/api/analysis/(start|step|run)$ ]] \
  || die 'ANALYSIS_CAPACITY_LEGACY_TARGET_URL must be one exact public V1 route'
[[ -n "$ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE" \
   && ${#ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE} -le 256 \
   && "$ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE" != *[!A-Za-z0-9._:/@-]* ]] \
  || die 'ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE is invalid'

[[ -f "$progress_migration_path" ]] \
  || die "expected DB progress migration is missing: $expected_progress_migration_version"
while IFS= read -r marker; do
  grep -Fq -- "$marker" "$progress_migration_path" \
    || die "expected DB progress contract marker is missing: $marker"
done <<'EOF'
CREATE FUNCTION public.checkpoint_analysis_v2_progress(
analysis_v2_progress_stage_rank
analysis_v2_progress_canonical_tracks
analysis_v2_progress_snapshot_fingerprint
v_canonical_progress_bp
ANALYSIS_V2_PROGRESS_FENCE_MISMATCH
EOF

if ! service_json="$(gcloud run services describe "$cloud_service" \
  "--project=$cloud_project" \
  "--region=$cloud_region" \
  --format=json 2>/dev/null)"; then
  die 'Cloud Run service describe failed'
fi

if ! active_revision="$(jq -er '
  [(.status.traffic // [])[]?
    | {revision: (.revisionName // ""), percent: ((.percent // 0) | tostring | tonumber)}
    | select(.percent > 0)]
  | if length == 1 and .[0].percent == 100 and .[0].revision != ""
    then .[0].revision
    else error("expected exactly one active revision at 100% traffic")
    end
' <<<"$service_json" 2>/dev/null)"; then
  die 'Cloud Run service must have exactly one active revision at 100% traffic'
fi
[[ "$active_revision" =~ ^[a-z][a-z0-9-]{0,62}$ ]] \
  || die 'Cloud Run active revision name is invalid'

if ! revision_json="$(gcloud run revisions describe "$active_revision" \
  "--project=$cloud_project" \
  "--region=$cloud_region" \
  --format=json 2>/dev/null)"; then
  die 'Cloud Run active revision describe failed'
fi
jq -e --arg revision "$active_revision" '
  .metadata.name == $revision
    and ([.status.conditions[]?
      | select(.type == "Ready" and ((.status | tostring) == "True"))] | length) == 1
' <<<"$revision_json" >/dev/null 2>&1 \
  || die 'Cloud Run active revision is not Ready'

if ! cloud_sha="$(jq -er --arg label "$cloud_run_provenance_label" \
  '.metadata.labels[$label] // empty' <<<"$revision_json" 2>/dev/null)"; then
  die 'Cloud Run active revision has no source provenance label'
fi
validate_sha 'Cloud Run source provenance' "$cloud_sha"
[[ "$cloud_sha" == "$expected_sha" ]] \
  || die "Cloud Run provenance SHA mismatch (expected $expected_sha)"

vercel_api_base="${VERCEL_API_BASE_URL:-https://api.vercel.com}"
[[ "$vercel_api_base" =~ ^https://[^[:space:]]+$ ]] \
  || die 'VERCEL_API_BASE_URL must be an HTTPS origin'
vercel_api_base="${vercel_api_base%/}"
vercel_url="$vercel_api_base/v6/deployments?projectId=$vercel_project_id&target=production&limit=20"
if [[ -n "${VERCEL_TEAM_ID:-}" ]]; then
  validate_identifier VERCEL_TEAM_ID "$VERCEL_TEAM_ID"
  vercel_url="$vercel_url&teamId=$VERCEL_TEAM_ID"
fi

escape_curl_config_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

# Keep only the bearer token in curl's stdin config. A command-line header
# exposes the token to process listings while the request itself is otherwise
# read-only; the validated, non-sensitive Vercel URL remains a normal argv.
escaped_vercel_token="$(escape_curl_config_value "$vercel_token")"
if ! vercel_json="$(curl --disable --proto '=https' --tlsv1.2 \
  --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --fail --silent --show-error \
  --url "$vercel_url" \
  --header 'Accept: application/json' \
  --config - 2>/dev/null <<EOF
header = "Authorization: Bearer $escaped_vercel_token"
EOF
)"; then
  die 'Vercel production deployment lookup failed'
fi
if ! vercel_deployment_json="$(jq -cer '
  [ .deployments[]?
    | select((.target // "") == "production")
    | select((.readyState // .state // "") == "READY")
  ]
  | first // empty
' <<<"$vercel_json" 2>/dev/null)"; then
  die 'Vercel has no ready production deployment record'
fi
if ! vercel_deployment_id="$(jq -er '(.uid // .id // empty) | strings' <<<"$vercel_deployment_json" 2>/dev/null)"; then
  die 'selected Vercel production deployment has no immutable uid/id'
fi
[[ "$vercel_deployment_id" =~ ^[A-Za-z0-9_-]{1,128}$ ]] \
  || die 'selected Vercel deployment uid/id is invalid'
if ! vercel_sha="$(jq -er '
  (.meta.githubCommitSha // .meta.gitCommitSha // .gitSource.sha // empty)
' <<<"$vercel_deployment_json" 2>/dev/null)"; then
  die 'Vercel has no ready production deployment Git SHA'
fi
validate_sha 'Vercel production source provenance' "$vercel_sha"
[[ "$vercel_sha" == "$expected_sha" ]] \
  || die "Vercel production SHA mismatch (expected $expected_sha)"

origin_from_public_url() {
  local url="$1"
  if [[ "$url" =~ ^https://([A-Za-z0-9.-]+)(:[0-9]+)?(/|$) ]]; then
    printf 'https://%s%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]:-}"
    return 0
  fi
  return 1
}

public_freeze_origin="$(origin_from_public_url "$ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL")" \
  || die 'public freeze readiness URL has no canonical HTTPS origin'
legacy_target_origin="$(origin_from_public_url "$ANALYSIS_CAPACITY_LEGACY_TARGET_URL")" \
  || die 'legacy V1 target URL has no canonical HTTPS origin'
[[ "$public_freeze_origin" == "$legacy_target_origin" ]] \
  || die 'public readiness and legacy V1 target URLs must share the exact same origin'

# Vercel's deployment API returns the immutable deployment URL separately from
# optional production aliases.  The public origin must match one of those
# observed names; a caller-supplied readiness host is never trusted alone.
vercel_origin_match='false'
while IFS= read -r vercel_host; do
  [[ -n "$vercel_host" ]] || continue
  if [[ "$vercel_host" =~ ^https:// ]]; then
    observed_vercel_origin="$(origin_from_public_url "$vercel_host" || true)"
  else
    observed_vercel_origin="$(origin_from_public_url "https://$vercel_host" || true)"
  fi
  if [[ "$observed_vercel_origin" == "$public_freeze_origin" ]]; then
    vercel_origin_match='true'
    break
  fi
done < <(jq -r '(.url // empty)' <<<"$vercel_deployment_json")

# Do not infer custom production aliases from optional v6 list fields.  Read
# the aliases for the exact selected deployment under the same bearer/team
# context, then validate every returned hostname before using it as evidence.
vercel_alias_url="$vercel_api_base/v2/deployments/$vercel_deployment_id/aliases"
if [[ -n "${VERCEL_TEAM_ID:-}" ]]; then
  vercel_alias_url="$vercel_alias_url?teamId=$VERCEL_TEAM_ID"
fi
if ! vercel_aliases_json="$(curl --disable --proto '=https' --tlsv1.2 \
  --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --fail --silent --show-error \
  --url "$vercel_alias_url" \
  --header 'Accept: application/json' \
  --config - 2>/dev/null <<EOF
header = "Authorization: Bearer $escaped_vercel_token"
EOF
)"; then
  die 'selected Vercel deployment aliases lookup failed'
fi
jq -e '
  type == "object"
  and (.aliases | type == "array")
  and all(.aliases[];
    type == "object"
    and (.domain | type == "string")
    and (.domain | test("^[A-Za-z0-9.-]+$"))
    and (.domain | test("(^|\\.)[A-Za-z0-9-]+\\.[A-Za-z]{2,}$"))
    and ((.deploymentId? // .deployment_id? // .uid? // .id? // null) == null
      or ((.deploymentId? // .deployment_id? // .uid? // .id?) | tostring) == $deployment_id)
  )
' --arg deployment_id "$vercel_deployment_id" <<<"$vercel_aliases_json" >/dev/null 2>&1 \
  || die 'selected Vercel deployment aliases response is malformed or belongs to another deployment'
while IFS= read -r vercel_host; do
  [[ -n "$vercel_host" ]] || continue
  observed_vercel_origin="$(origin_from_public_url "https://$vercel_host" || true)"
  if [[ "$observed_vercel_origin" == "$public_freeze_origin" ]]; then
    vercel_origin_match='true'
    break
  fi
done < <(jq -r '.aliases[]?.domain' <<<"$vercel_aliases_json")
[[ "$vercel_origin_match" == 'true' ]] \
  || die 'public freeze origin does not match the selected READY Vercel deployment URL or exact alias'

# This is an independent read-only observation from the public Next/Vercel
# process that owns /analysis/start, /step, and /run.  A private Cloud Run
# worker manifest cannot prove that those public producers are frozen.
if ! public_freeze_json="$(curl --disable --proto '=https' --tlsv1.2 \
  --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --fail --silent --show-error \
  --request GET \
  --url "$ANALYSIS_CAPACITY_PUBLIC_FREEZE_READINESS_URL" \
  --header 'Accept: application/json' 2>/dev/null)"; then
  die 'public V1 freeze readiness observation failed'
fi
jq -e --arg expected_sha "$expected_sha" \
  --arg expected_resource "$ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE" '
  (keys | sort) == ["freezeMode", "legacyTargetResource", "publicFreezeEnabled", "ready", "routes", "schemaVersion", "sourceSha", "stage"]
  and .schemaVersion == "analysis-public-freeze-readiness-v1"
  and .ready == true
  and (.stage == "initial" or .stage == "expanded")
  and .freezeMode == "drain-and-block"
  and .publicFreezeEnabled == true
  and .sourceSha == $expected_sha
  and .legacyTargetResource == $expected_resource
  and ((.routes | keys | sort) == ["/api/analysis/run", "/api/analysis/start", "/api/analysis/step"])
  and ([.routes[] | select(.gateState == "frozen" and .expectedStatus == 410 and .gateBeforeRuntime == true)] | length) == 3
' <<<"$public_freeze_json" >/dev/null 2>&1 \
  || die 'public V1 freeze readiness is not an exact active gate-before-runtime contract'

probe_legacy_route() {
  local route="$1"
  local response
  local status
  local body
  response="$(curl --disable --proto '=https' --tlsv1.2 \
    --max-redirs 0 --connect-timeout 10 --max-time 30 \
    --silent --show-error \
    --request POST \
    --header 'Accept: application/json' \
    --header 'Content-Type: application/json' \
    --data-binary '{}' \
    --write-out '\n%{http_code}' \
    --url "${public_freeze_origin}${route}" 2>/dev/null)" \
    || die "public V1 freeze probe failed for $route"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  [[ "$status" == '410' ]] \
    || die "public V1 freeze probe for $route returned HTTP $status, expected 410"
  jq -e 'type == "object" and (keys | sort) == ["code"] and .code == "LEGACY_ANALYSIS_FROZEN"' <<<"$body" >/dev/null 2>&1 \
    || die "public V1 freeze probe for $route did not return exact LEGACY_ANALYSIS_FROZEN JSON"
}

for legacy_route in /api/analysis/start /api/analysis/step /api/analysis/run; do
  probe_legacy_route "$legacy_route"
done

supabase_workdir="${ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR:-$repo_dir}"
[[ -d "$supabase_workdir" ]] \
  || die 'ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR must be an existing directory'
if ! migration_list="$(supabase --workdir "$supabase_workdir" migration list \
  --linked --output-format json 2>/dev/null)"; then
  die "Supabase linked migration history lookup failed for $expected_progress_migration_version"
fi
jq -e --arg version "$expected_progress_migration_version" '
  def version_of:
    if type == "object" and has("local") then
      if (.remote? | type) == "string" then .remote
      elif (.remote? | type) == "object" then
        (.remote.version // .remote.migration_version // .remote.migration // .remote.id // "")
      else ""
      end
    elif type == "object" and (.remote? | type) == "string" then .remote
    elif type == "object" and (.remote? | type) == "object" then
      (.remote.version // .remote.migration_version // .remote.migration // .remote.id // "")
    else
      (.version // .migration_version // .migration // .id // "")
    end | tostring;
  def applied_rows:
    if type == "array" then .
    elif type == "object" and (.remote? | type) == "array" then .remote
    elif type == "object" and (.remoteMigrations? | type) == "array" then .remoteMigrations
    elif type == "object" and (.migrations? | type) == "array" then .migrations
    else []
    end;
  any(applied_rows[]?; type == "object" and version_of == $version)
' <<<"$migration_list" >/dev/null 2>&1 \
  || die "DB progress migration $expected_progress_migration_version is not applied"

if ! image_proxy_probe_output="$(
  cd "$repo_dir"
  npx --no-install tsx "$image_proxy_probe_script" 2>/dev/null
)"; then
  die 'IMAGE_PROXY_SIGNING_SECRET compatibility probe failed'
fi
case "$image_proxy_probe_output" in
  'PASS: image-proxy-signing compatibility signature_accepted_200' \
  | 'PASS: image-proxy-signing compatibility signature_accepted_503_retryable')
    ;;
  *)
    die 'IMAGE_PROXY_SIGNING_SECRET compatibility probe returned an invalid result'
    ;;
esac

printf 'release readiness passed for expected SHA %s (Cloud Run, Vercel production, DB progress contract, image proxy signing compatibility)\n' \
  "$expected_sha"
