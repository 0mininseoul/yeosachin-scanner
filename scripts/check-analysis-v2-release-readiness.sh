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
if ! vercel_sha="$(jq -er '
  [ .deployments[]?
    | select((.target // "") == "production")
    | select((.readyState // .state // "") == "READY")
  ]
  | first // {}
  | (.meta.githubCommitSha // .meta.gitCommitSha // .gitSource.sha // empty)
' <<<"$vercel_json" 2>/dev/null)"; then
  die 'Vercel has no ready production deployment Git SHA'
fi
validate_sha 'Vercel production source provenance' "$vercel_sha"
[[ "$vercel_sha" == "$expected_sha" ]] \
  || die "Vercel production SHA mismatch (expected $expected_sha)"

supabase_workdir="${ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR:-$repo_dir}"
[[ -d "$supabase_workdir" ]] \
  || die 'ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR must be an existing directory'
if ! migration_list="$(supabase --workdir "$supabase_workdir" migration list \
  --linked --output-format json 2>/dev/null)"; then
  die "Supabase linked migration history lookup failed for $expected_progress_migration_version"
fi
jq -e --arg version "$expected_progress_migration_version" '
  def version_of:
    (.version // .migration_version // .migration // .id // "") | tostring;
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
