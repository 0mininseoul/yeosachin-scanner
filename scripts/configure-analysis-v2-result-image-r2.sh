#!/usr/bin/env bash
set -euo pipefail

readonly API_ROOT="https://api.cloudflare.com/client/v4"
readonly R2_JURISDICTION="default"
readonly R2_LOCATION="apac"
readonly R2_STORAGE_CLASS="Standard"
readonly OBJECT_PREFIX="v1/"
readonly RETENTION_SECONDS="2592000"
readonly LIFECYCLE_RULE_ID="analysis-v2-result-images-v1-30d"
readonly WRITER_PERMISSION="Workers R2 Storage Bucket Item Write"
readonly READER_PERMISSION="Workers R2 Storage Bucket Item Read"

mode="dry-run"
reconcile_lifecycle="false"
bucket_created="false"

usage() {
  cat <<'USAGE'
Usage: configure-analysis-v2-result-image-r2.sh [--dry-run | --check | --apply] [--reconcile-lifecycle]

Dry-run is the default and performs no network calls.

Required environment variables:
  CLOUDFLARE_ACCOUNT_ID
  ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET

Required for --check and --apply:
  CLOUDFLARE_API_TOKEN
    Bootstrap token with Workers R2 Storage Write and Account API Tokens
    Read/Write. Keep this token out of application runtimes.
  CLOUDFLARE_R2_WRITER_CREDENTIALS_FILE
  CLOUDFLARE_R2_READER_CREDENTIALS_FILE
    Absolute paths outside the repository. Newly created S3 credentials are
    written once with mode 0600 and are never printed.

Optional:
  CLOUDFLARE_R2_WRITER_TOKEN_NAME
  CLOUDFLARE_R2_READER_TOKEN_NAME

The script creates or verifies one private Standard R2 bucket in APAC, disables
r2.dev, rejects custom domains, applies one exact v1/ Age=2592000 lifecycle
rule, and creates separate bucket-scoped writer and reader account tokens.

Existing non-empty lifecycle drift is never replaced unless
--reconcile-lifecycle is explicitly supplied. Existing tokens are never
rotated, overwritten, or deleted by this script.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "missing required environment variable: $name"
}

validate_account_id() {
  [[ "$1" =~ ^[a-f0-9]{32}$ ]] \
    || die "CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hexadecimal characters"
}

validate_bucket() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9.-]{1,61}[a-z0-9])$ ]] \
    || die "ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET is invalid"
}

validate_token_name() {
  [[ -n "$1" && ${#1} -le 120 && ! "$1" =~ [[:cntrl:]] ]] \
    || die "R2 token name is invalid"
}

validate_credentials_file() {
  local path="$1"
  [[ "$path" == /* ]] || die "credential file paths must be absolute"
  [[ -d "$(dirname "$path")" ]] || die "credential file parent directory does not exist"
  [[ ! -L "$path" ]] || die "credential file must not be a symbolic link"
}

api_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local args=(
    --silent
    --show-error
    --fail-with-body
    --request "$method"
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
    --header "cf-r2-jurisdiction: $R2_JURISDICTION"
    "$API_ROOT$path"
  )
  if [[ -n "$body" ]]; then
    args+=(--header 'Content-Type: application/json' --data "$body")
  fi
  curl "${args[@]}"
}

assert_api_success() {
  local response="$1"
  local operation="$2"
  if ! jq -e '.success == true' <<<"$response" >/dev/null; then
    local codes
    codes="$(jq -r '[.errors[]?.code | tostring] | join(",")' <<<"$response" 2>/dev/null || true)"
    die "$operation failed${codes:+ (Cloudflare error codes: $codes)}"
  fi
}

bucket_response() {
  api_request GET \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET"
}

bucket_is_exact() {
  local response="$1"
  jq -e \
    --arg name "$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET" \
    --arg jurisdiction "$R2_JURISDICTION" \
    --arg location "$R2_LOCATION" \
    --arg storage_class "$R2_STORAGE_CLASS" '
      .success == true
        and .result.name == $name
        and ((.result.jurisdiction // "default") | ascii_downcase) == $jurisdiction
        and ((.result.location // "") | ascii_downcase) == $location
        and .result.storage_class == $storage_class
    ' <<<"$response" >/dev/null
}

ensure_bucket() {
  local response=""
  if response="$(bucket_response 2>/dev/null)" && bucket_is_exact "$response"; then
    log "verified: private R2 bucket identity, location, and Standard storage class"
    return 0
  fi
  if [[ -n "$response" ]] && jq -e '.success == true' <<<"$response" >/dev/null; then
    die "existing R2 bucket identity, jurisdiction, location, or storage class has drifted"
  fi
  [[ "$mode" == "apply" ]] || die "R2 bucket does not exist or is not visible"

  response="$(api_request POST \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets" \
    "$(jq -cn \
      --arg name "$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET" \
      --arg location "$R2_LOCATION" \
      --arg storage_class "$R2_STORAGE_CLASS" \
      '{name: $name, locationHint: $location, storageClass: $storage_class}')")"
  assert_api_success "$response" "R2 bucket creation"
  bucket_created="true"
  response="$(bucket_response)"
  bucket_is_exact "$response" || die "R2 bucket was not exact after creation"
  log "applied: private Standard R2 bucket in APAC"
}

managed_domain_response() {
  api_request GET \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET/domains/managed"
}

ensure_managed_domain_disabled() {
  local response
  response="$(managed_domain_response)"
  assert_api_success "$response" "r2.dev domain inspection"
  if jq -e '.result.enabled == false' <<<"$response" >/dev/null; then
    log "verified: r2.dev public access is disabled"
    return 0
  fi
  [[ "$mode" == "apply" ]] || die "r2.dev public access is enabled"
  response="$(api_request PUT \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET/domains/managed" \
    '{"enabled":false}')"
  assert_api_success "$response" "r2.dev public access disable"
  response="$(managed_domain_response)"
  jq -e '.success == true and .result.enabled == false' <<<"$response" >/dev/null \
    || die "r2.dev public access remained enabled"
  log "applied: r2.dev public access disabled"
}

ensure_no_custom_domains() {
  local response
  response="$(api_request GET \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET/domains/custom")"
  assert_api_success "$response" "custom domain inspection"
  jq -e '(.result.domains // []) | length == 0' <<<"$response" >/dev/null \
    || die "R2 bucket has a custom domain; remove it after explicit review"
  log "verified: R2 bucket has no custom domains"
}

desired_lifecycle() {
  jq -cn \
    --arg id "$LIFECYCLE_RULE_ID" \
    --arg prefix "$OBJECT_PREFIX" \
    --argjson max_age "$RETENTION_SECONDS" '{
      rules: [{
        id: $id,
        enabled: true,
        conditions: {prefix: $prefix},
        deleteObjectsTransition: {
          condition: {type: "Age", maxAge: $max_age}
        }
      }]
    }'
}

lifecycle_is_exact() {
  local response="$1"
  jq -e \
    --arg id "$LIFECYCLE_RULE_ID" \
    --arg prefix "$OBJECT_PREFIX" \
    --argjson max_age "$RETENTION_SECONDS" '
      .success == true
        and (.result.rules | length) == 1
        and .result.rules[0].id == $id
        and .result.rules[0].enabled == true
        and .result.rules[0].conditions == {prefix: $prefix}
        and .result.rules[0].deleteObjectsTransition.condition
          == {type: "Age", maxAge: $max_age}
        and ((.result.rules[0] | keys | sort) == [
          "conditions", "deleteObjectsTransition", "enabled", "id"
        ])
    ' <<<"$response" >/dev/null
}

ensure_lifecycle() {
  local path="/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET/lifecycle"
  local response
  response="$(api_request GET "$path")"
  assert_api_success "$response" "R2 lifecycle inspection"
  if lifecycle_is_exact "$response"; then
    log "verified: v1/ objects expire after exactly 30 days"
    return 0
  fi
  [[ "$mode" == "apply" ]] || die "R2 lifecycle configuration has drifted"
  local existing_count
  existing_count="$(jq -r '(.result.rules // []) | length' <<<"$response")"
  if [[ "$bucket_created" != "true" && "$existing_count" != "0" \
    && "$reconcile_lifecycle" != "true" ]]; then
    die "existing lifecycle rules require review; rerun with --reconcile-lifecycle"
  fi
  response="$(api_request PUT "$path" "$(desired_lifecycle)")"
  assert_api_success "$response" "R2 lifecycle update"
  response="$(api_request GET "$path")"
  lifecycle_is_exact "$response" || die "R2 lifecycle was not exact after apply"
  log "applied: exact 30-day v1/ object lifecycle"
}

permission_group_id() {
  local name="$1"
  local response
  response="$(api_request GET \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/permission_groups")"
  assert_api_success "$response" "token permission group inspection"
  local count
  count="$(jq -r --arg name "$name" '
    [.result[] | select(
      .name == $name
      and (.scopes | index("com.cloudflare.edge.r2.bucket")) != null
    )] | length
  ' <<<"$response")"
  [[ "$count" == "1" ]] || die "expected exactly one bucket permission group named: $name"
  jq -r --arg name "$name" '
    .result[] | select(
      .name == $name
      and (.scopes | index("com.cloudflare.edge.r2.bucket")) != null
    ) | .id
  ' <<<"$response"
}

token_list_response() {
  api_request GET \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens?per_page=50&page=1"
}

token_is_exact() {
  local token="$1"
  local permission_id="$2"
  local resource="$3"
  jq -e \
    --arg permission_id "$permission_id" \
    --arg resource "$resource" '
      .status == "active"
        and (.policies | length) == 1
        and .policies[0].effect == "allow"
        and .policies[0].resources == {($resource): "*"}
        and (.policies[0].permission_groups | length) == 1
        and .policies[0].permission_groups[0].id == $permission_id
    ' <<<"$token" >/dev/null
}

credentials_file_has_token() {
  local file="$1"
  local token_id="$2"
  [[ -f "$file" ]] || return 1
  [[ "$(stat -f '%Lp' "$file" 2>/dev/null || stat -c '%a' "$file")" == "600" ]] \
    || return 1
  grep -Fqx "ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID=$token_id" "$file" \
    && grep -Eq '^ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY=[a-f0-9]{64}$' "$file"
}

write_credentials_file() {
  local file="$1"
  local access_key_id="$2"
  local secret_access_key="$3"
  [[ ! -e "$file" ]] || die "refusing to overwrite existing credential file: $file"
  local temp_file
  temp_file="$(mktemp "$(dirname "$file")/.analysis-v2-r2-credentials.XXXXXX")"
  chmod 600 "$temp_file"
  {
    printf 'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT=https://%s.r2.cloudflarestorage.com\n' \
      "$CLOUDFLARE_ACCOUNT_ID"
    printf 'ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET=%s\n' \
      "$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET"
    printf 'ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID=%s\n' "$access_key_id"
    printf 'ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY=%s\n' "$secret_access_key"
  } >"$temp_file"
  if ! ln "$temp_file" "$file"; then
    rm -f -- "$temp_file"
    die "refusing to overwrite existing credential file: $file"
  fi
  rm -f -- "$temp_file"
}

ensure_scoped_token() {
  local name="$1"
  local permission_id="$2"
  local credentials_file="$3"
  local resource="$4"
  local response
  response="$(token_list_response)"
  assert_api_success "$response" "account token inspection"
  local total_count
  total_count="$(jq -r '.result_info.total_count // (.result | length)' <<<"$response")"
  [[ "$total_count" -le 50 ]] \
    || die "account has more than 50 tokens; inspect the named token manually"

  local matches
  matches="$(jq -c --arg name "$name" '[.result[] | select(.name == $name)]' <<<"$response")"
  local count
  count="$(jq -r 'length' <<<"$matches")"
  [[ "$count" -le 1 ]] || die "duplicate account tokens exist for: $name"
  if [[ "$count" == "1" ]]; then
    local token
    token="$(jq -c '.[0]' <<<"$matches")"
    token_is_exact "$token" "$permission_id" "$resource" \
      || die "existing account token policy has drifted: $name"
    local token_id
    token_id="$(jq -r '.id' <<<"$token")"
    credentials_file_has_token "$credentials_file" "$token_id" \
      || die "existing token is exact but its mode-0600 credential file is unavailable: $name"
    log "verified: bucket-scoped token and local credential handoff for $name"
    return 0
  fi

  [[ "$mode" == "apply" ]] || die "missing bucket-scoped account token: $name"
  [[ ! -e "$credentials_file" ]] \
    || die "credential file exists but its corresponding token is missing: $credentials_file"
  local body
  body="$(jq -cn \
    --arg name "$name" \
    --arg permission_id "$permission_id" \
    --arg resource "$resource" '{
      name: $name,
      policies: [{
        effect: "allow",
        resources: {($resource): "*"},
        permission_groups: [{id: $permission_id}]
      }]
    }')"
  response="$(api_request POST \
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens" "$body")"
  assert_api_success "$response" "account token creation"
  local token_id
  local token_value
  token_id="$(jq -r '.result.id // empty' <<<"$response")"
  token_value="$(jq -r '.result.value // empty' <<<"$response")"
  [[ "$token_id" =~ ^[a-f0-9]{32}$ && ${#token_value} -ge 40 ]] \
    || die "Cloudflare did not return one-time token credentials"
  local secret_access_key
  secret_access_key="$(printf '%s' "$token_value" | shasum -a 256 | awk '{print $1}')"
  token_value=""
  write_credentials_file "$credentials_file" "$token_id" "$secret_access_key"
  secret_access_key=""
  log "applied: bucket-scoped token created; credentials written without disclosure for $name"
}

print_dry_run() {
  log "[dry-run] create or verify private Standard R2 bucket: $ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET"
  log "[dry-run] jurisdiction=$R2_JURISDICTION location=$R2_LOCATION managed-r2.dev=disabled custom-domains=none"
  log "[dry-run] lifecycle: prefix=$OBJECT_PREFIX delete-after-seconds=$RETENTION_SECONDS exact-rule-count=1"
  log "[dry-run] writer token: permission=\"$WRITER_PERMISSION\" scope=exact-bucket"
  log "[dry-run] reader token: permission=\"$READER_PERMISSION\" scope=exact-bucket"
  log "[dry-run] credentials are written only on --apply to separate mode-0600 files and are never printed"
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      [[ "$mode" == "dry-run" ]] || die "choose only one mode"
      ;;
    --check)
      [[ "$mode" == "dry-run" ]] || die "choose only one mode"
      mode="check"
      ;;
    --apply)
      [[ "$mode" == "dry-run" ]] || die "choose only one mode"
      mode="apply"
      ;;
    --reconcile-lifecycle)
      reconcile_lifecycle="true"
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

required_env CLOUDFLARE_ACCOUNT_ID
required_env ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET
validate_account_id "$CLOUDFLARE_ACCOUNT_ID"
validate_bucket "$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET"

writer_token_name="${CLOUDFLARE_R2_WRITER_TOKEN_NAME:-$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET-analysis-v2-writer}"
reader_token_name="${CLOUDFLARE_R2_READER_TOKEN_NAME:-$ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET-analysis-v2-reader}"
validate_token_name "$writer_token_name"
validate_token_name "$reader_token_name"
[[ "$writer_token_name" != "$reader_token_name" ]] || die "writer and reader token names must differ"

if [[ "$mode" == "dry-run" ]]; then
  print_dry_run
  exit 0
fi

required_env CLOUDFLARE_API_TOKEN
required_env CLOUDFLARE_R2_WRITER_CREDENTIALS_FILE
required_env CLOUDFLARE_R2_READER_CREDENTIALS_FILE
validate_credentials_file "$CLOUDFLARE_R2_WRITER_CREDENTIALS_FILE"
validate_credentials_file "$CLOUDFLARE_R2_READER_CREDENTIALS_FILE"
[[ "$CLOUDFLARE_R2_WRITER_CREDENTIALS_FILE" != "$CLOUDFLARE_R2_READER_CREDENTIALS_FILE" ]] \
  || die "writer and reader credential files must differ"
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required"
command -v shasum >/dev/null || die "shasum is required"

ensure_bucket
ensure_managed_domain_disabled
ensure_no_custom_domains
ensure_lifecycle

bucket_resource="com.cloudflare.edge.r2.bucket.${CLOUDFLARE_ACCOUNT_ID}_${R2_JURISDICTION}_${ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET}"
writer_permission_id="$(permission_group_id "$WRITER_PERMISSION")"
reader_permission_id="$(permission_group_id "$READER_PERMISSION")"
ensure_scoped_token \
  "$writer_token_name" \
  "$writer_permission_id" \
  "$CLOUDFLARE_R2_WRITER_CREDENTIALS_FILE" \
  "$bucket_resource"
ensure_scoped_token \
  "$reader_token_name" \
  "$reader_permission_id" \
  "$CLOUDFLARE_R2_READER_CREDENTIALS_FILE" \
  "$bucket_resource"

log "verified: result-image R2 infrastructure is exact"
