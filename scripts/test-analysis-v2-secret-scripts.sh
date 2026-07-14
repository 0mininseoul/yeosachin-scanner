#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "$0")" && pwd)"
readonly repo_dir="$(cd "$script_dir/.." && pwd)"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-secret-test.XXXXXX")"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  printf 'test failure: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! LC_ALL=C grep -Fq -- "$expected" "$file"; then
    sed -n '1,180p' "$file" >&2
    fail "expected output to contain: $expected"
  fi
}

assert_not_contains() {
  local file="$1"
  local rejected="$2"
  ! LC_ALL=C grep -Fq -- "$rejected" "$file" \
    || fail "output or generated file exposed rejected content: $rejected"
}

mkdir -p "$temp_dir/bin" "$temp_dir/state" "$temp_dir/generated"
cat >"$temp_dir/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

state_dir="${FAKE_GCLOUD_STATE_DIR:?}"
command_line="$*"
project_number="${FAKE_GCLOUD_PROJECT_NUMBER:-123456789012}"

secret_path() {
  printf '%s/secrets/%s\n' "$state_dir" "$1"
}

case "$command_line" in
  "auth list"*)
    printf 'operator@example.test\n'
    ;;
  "projects describe"*)
    printf '%s\n' "$project_number"
    ;;
  "projects get-iam-policy"*)
    if [[ -f "$state_dir/project-secret-role" ]]; then
      printf 'roles/secretmanager.secretAccessor\n'
    fi
    ;;
  "iam service-accounts describe"*)
    printf 'false\n'
    ;;
  "services list"*)
    [[ -f "$state_dir/api-enabled" ]] \
      && printf 'secretmanager.googleapis.com\n'
    ;;
  "services enable"*)
    touch "$state_dir/api-enabled"
    ;;
  "secrets describe"*)
    secret_id="$3"
    path="$(secret_path "$secret_id")"
    [[ -f "$path/metadata.json" ]] || exit 1
    [[ ! -f "$path/describe-always-invisible" ]] || exit 1
    if [[ -f "$path/describe-invisible-count" ]]; then
      remaining="$(<"$path/describe-invisible-count")"
      if ((remaining > 0)); then
        printf '%s\n' "$((remaining - 1))" >"$path/describe-invisible-count"
        exit 1
      fi
    fi
    cat "$path/metadata.json"
    ;;
  "secrets create"*)
    secret_id="$3"
    path="$(secret_path "$secret_id")"
    if [[ -f "$path/metadata.json" ]]; then
      count=0
      [[ ! -f "$state_dir/create-conflict-count" ]] \
        || count="$(<"$state_dir/create-conflict-count")"
      printf '%s\n' "$((count + 1))" >"$state_dir/create-conflict-count"
      printf 'fake gcloud: secret %s already exists\n' "$secret_id" >&2
      exit 9
    fi
    mkdir -p "$path/versions"
    jq -nc \
      --arg name "projects/$project_number/secrets/$secret_id" \
      '{name: $name, replication: {userManaged: {replicas: [{location: "asia-northeast3"}]}}}' \
      >"$path/metadata.json"
    printf '%s\n' '{"version":1,"etag":"fixture","bindings":[]}' >"$path/policy.json"
    printf '0\n' >"$path/version-counter"
    if [[ -n "${FAKE_GCLOUD_HIDE_DESCRIBE_AFTER_CREATE_COUNT:-}" ]]; then
      printf '%s\n' "$FAKE_GCLOUD_HIDE_DESCRIBE_AFTER_CREATE_COUNT" \
        >"$path/describe-invisible-count"
    fi
    ;;
  "secrets versions add"*)
    secret_id="$4"
    path="$(secret_path "$secret_id")"
    [[ -f "$path/metadata.json" ]] || exit 1
    payload="$(cat)"
    [[ -n "$payload" ]] || exit 91
    if [[ -n "${FAKE_GCLOUD_FAIL_VERSION_ADD_ONCE_FILE:-}" \
      && ! -f "$FAKE_GCLOUD_FAIL_VERSION_ADD_ONCE_FILE" ]]; then
      touch "$FAKE_GCLOUD_FAIL_VERSION_ADD_ONCE_FILE"
      exit 96
    fi
    case "$secret_id" in
      ai-baram-v2-supabase-service-role)
        [[ "$payload" == "SUPABASE_SECRET_SENTINEL_0123456789" ]] || exit 92
        ;;
      ai-baram-v2-apify-quinary)
        [[ "$payload" == "APIFY_QUINARY_SECRET_SENTINEL_0123456789" ]] || exit 93
        ;;
      ai-baram-v2-image-proxy-signing)
        [[ "$payload" == "IMAGE_SIGNING_SECRET_SENTINEL_01234567890123456789" ]] || exit 94
        ;;
      *) exit 95 ;;
    esac
    version=$(( $(<"$path/version-counter") + 1 ))
    printf '%s\n' "$version" >"$path/version-counter"
    jq -nc \
      --arg name "projects/$project_number/secrets/$secret_id/versions/$version" \
      '{name: $name, state: "ENABLED"}' >"$path/versions/$version.json"
    printf 'projects/%s/secrets/%s/versions/%s\n' \
      "$project_number" "$secret_id" "$version"
    ;;
  "secrets versions describe"*)
    version="$4"
    secret_id=""
    for argument in "$@"; do
      [[ "$argument" == --secret=* ]] && secret_id="${argument#--secret=}"
    done
    path="$(secret_path "$secret_id")"
    [[ -f "$path/versions/$version.json" ]] || exit 1
    cat "$path/versions/$version.json"
    ;;
  "secrets versions list"*)
    secret_id="$4"
    [[ -n "$secret_id" && "$secret_id" != --* ]] || exit 97
    filter_enabled="false"
    for argument in "$@"; do
      [[ "$argument" != --secret=* ]] || exit 98
      [[ "$argument" == --filter=state=ENABLED ]] && filter_enabled="true"
    done
    path="$(secret_path "$secret_id")"
    [[ -d "$path/versions" ]] || exit 1
    for version_file in "$path"/versions/*.json; do
      [[ -f "$version_file" ]] || continue
      if [[ "$filter_enabled" == "true" ]]; then
        jq -r 'select(.state == "ENABLED") | .name' "$version_file"
      else
        jq -r '.name' "$version_file"
      fi
    done
    ;;
  "secrets get-iam-policy"*)
    secret_id="$3"
    path="$(secret_path "$secret_id")"
    [[ -f "$path/policy.json" ]] || exit 1
    cat "$path/policy.json"
    ;;
  "secrets set-iam-policy"*)
    secret_id="$3"
    policy_file="$4"
    path="$(secret_path "$secret_id")"
    jq -e '
      (.bindings | length) == 1
      and .bindings[0].role == "roles/secretmanager.secretAccessor"
      and .bindings[0].members == ["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]
    ' "$policy_file" >/dev/null
    cp "$policy_file" "$path/policy.json"
    ;;
  *)
    printf 'unexpected fake gcloud command: %s\n' "$command_line" >&2
    exit 90
    ;;
esac
EOF
chmod +x "$temp_dir/bin/gcloud"
cat >"$temp_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_GCLOUD_STATE_DIR:?}/sleep-calls"
EOF
chmod +x "$temp_dir/bin/sleep"

cat >"$temp_dir/source.env" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://fixture.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=PUBLIC_ANON_SENTINEL_0123456789
GOOGLE_CLOUD_PROJECT=test-project
GOOGLE_CLOUD_LOCATION=global
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=test-project-analysis-v2-media
ANALYSIS_V2_APIFY_API_TOKEN_SLOT=quinary
SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SECRET_SENTINEL_0123456789
APIFY_QUINARY_API_TOKEN=APIFY_QUINARY_SECRET_SENTINEL_0123456789
IMAGE_PROXY_SIGNING_SECRET=IMAGE_SIGNING_SECRET_SENTINEL_01234567890123456789
EOF

secret_env=(
  "PATH=$temp_dir/bin:$PATH"
  "FAKE_GCLOUD_STATE_DIR=$temp_dir/state"
  'ANALYSIS_V2_TASKS_PROJECT=test-project'
  'ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=analysis-recovery@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=quinary'
  "ANALYSIS_V2_SECRET_SOURCE_ENV_FILE=$temp_dir/source.env"
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$repo_dir"
)

touch "$temp_dir/state/api-enabled"
if env "${secret_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/missing-check.out" 2>&1; then
  fail "missing Secret Manager resources were accepted in check mode"
fi
assert_contains "$temp_dir/missing-check.out" \
  "Secret Manager resource ai-baram-v2-supabase-service-role does not exist"

rm "$temp_dir/state/api-enabled"
env "${secret_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --dry-run \
  >"$temp_dir/missing-dry-run.out"
assert_contains "$temp_dir/missing-dry-run.out" \
  "gcloud services enable secretmanager.googleapis.com"
assert_contains "$temp_dir/missing-dry-run.out" \
  "gcloud secrets create ai-baram-v2-supabase-service-role"
assert_contains "$temp_dir/missing-dry-run.out" \
  "would stream allowlisted APIFY_QUINARY_API_TOKEN directly"
for sentinel in \
  SUPABASE_SECRET_SENTINEL_0123456789 \
  APIFY_QUINARY_SECRET_SENTINEL_0123456789 \
  IMAGE_SIGNING_SECRET_SENTINEL_01234567890123456789; do
  assert_not_contains "$temp_dir/missing-dry-run.out" "$sentinel"
done

mkdir -p "$temp_dir/recovery-state"
recovery_env=(
  "${secret_env[@]}"
  "FAKE_GCLOUD_STATE_DIR=$temp_dir/recovery-state"
)
if env "${recovery_env[@]}" \
  "FAKE_GCLOUD_FAIL_VERSION_ADD_ONCE_FILE=$temp_dir/recovery-failed-once" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/create-only-interruption.out" 2>&1; then
  fail "injected interruption after secret creation unexpectedly succeeded"
fi
[[ -f "$temp_dir/recovery-state/secrets/ai-baram-v2-supabase-service-role/metadata.json" ]] \
  || fail "interruption fixture did not leave the created secret resource"
[[ "$(<"$temp_dir/recovery-state/secrets/ai-baram-v2-supabase-service-role/version-counter")" == "0" ]] \
  || fail "interruption fixture unexpectedly created a secret version"

if env "${recovery_env[@]}" \
  'ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=1' \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/create-only-pinned.out" 2>&1; then
  fail "create-only interrupted secret accepted a nonexistent explicit pin"
fi
assert_contains "$temp_dir/create-only-pinned.out" \
  "pinned version 1 for ai-baram-v2-supabase-service-role does not exist"

env "${recovery_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/create-only-resume.out"
assert_contains "$temp_dir/create-only-resume.out" \
  "resuming interrupted initial version creation for ai-baram-v2-supabase-service-role"
assert_contains "$temp_dir/create-only-resume.out" \
  "pin: ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=1"
for secret_id in \
  ai-baram-v2-supabase-service-role \
  ai-baram-v2-apify-quinary \
  ai-baram-v2-image-proxy-signing; do
  [[ -f "$temp_dir/recovery-state/secrets/$secret_id/versions/1.json" ]] \
    || fail "interrupted apply recovery did not create version 1 for $secret_id"
done

env "${secret_env[@]}" \
  'FAKE_GCLOUD_HIDE_DESCRIBE_AFTER_CREATE_COUNT=2' \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/missing-apply.out"
[[ -f "$temp_dir/state/api-enabled" ]] \
  || fail "initial apply did not enable Secret Manager API"
assert_contains "$temp_dir/missing-apply.out" \
  "pin: ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=1"
assert_contains "$temp_dir/missing-apply.out" \
  "pin: ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=1"
assert_contains "$temp_dir/missing-apply.out" \
  "pin: ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION=1"
for secret_id in \
  ai-baram-v2-supabase-service-role \
  ai-baram-v2-apify-quinary \
  ai-baram-v2-image-proxy-signing; do
  [[ -f "$temp_dir/state/secrets/$secret_id/versions/1.json" ]] \
    || fail "initial apply did not create version 1 for $secret_id"
  jq -e \
    --arg expected "projects/123456789012/secrets/$secret_id" \
    '.name == $expected' \
    "$temp_dir/state/secrets/$secret_id/metadata.json" >/dev/null \
    || fail "initial apply did not accept the canonical numeric project resource name for $secret_id"
  jq -e '
    (.bindings | length) == 1
    and .bindings[0].role == "roles/secretmanager.secretAccessor"
    and .bindings[0].members == ["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]
  ' "$temp_dir/state/secrets/$secret_id/policy.json" >/dev/null \
    || fail "initial apply did not create exact IAM for $secret_id"
done
[[ "$(wc -l <"$temp_dir/state/sleep-calls" | tr -d ' ')" == "6" ]] \
  || fail "post-create visibility retry was not bounded to the injected transient failures"
for sentinel in \
  SUPABASE_SECRET_SENTINEL_0123456789 \
  APIFY_QUINARY_SECRET_SENTINEL_0123456789 \
  IMAGE_SIGNING_SECRET_SENTINEL_01234567890123456789; do
  assert_not_contains "$temp_dir/missing-apply.out" "$sentinel"
done

pinned_env=(
  'ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=1'
  'ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=1'
  'ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION=1'
)
env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/ready-check.out"
assert_contains "$temp_dir/ready-check.out" \
  "Analysis V2 Secret Manager configuration verified"

conflict_sleep_count_before="$(wc -l <"$temp_dir/state/sleep-calls" | tr -d ' ')"
printf '3\n' \
  >"$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/describe-invisible-count"
env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/create-conflict-recovery.out" 2>&1
assert_contains "$temp_dir/create-conflict-recovery.out" \
  "became observable after create returned an error"
[[ "$(<"$temp_dir/state/create-conflict-count")" == "1" ]] \
  || fail "transient describe invisibility did not exercise create-conflict recovery"
conflict_sleep_count_after="$(wc -l <"$temp_dir/state/sleep-calls" | tr -d ' ')"
[[ "$((conflict_sleep_count_after - conflict_sleep_count_before))" == "2" ]] \
  || fail "create-conflict recovery did not retry until the existing secret became observable"
[[ "$(<"$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/version-counter")" == "1" ]] \
  || fail "create-conflict recovery unexpectedly added a secret version"

cp -R "$temp_dir/state" "$temp_dir/retry-exhaustion-state"
rm -f "$temp_dir/retry-exhaustion-state/sleep-calls"
touch "$temp_dir/retry-exhaustion-state/secrets/ai-baram-v2-supabase-service-role/describe-always-invisible"
retry_exhaustion_env=(
  "${secret_env[@]}"
  "FAKE_GCLOUD_STATE_DIR=$temp_dir/retry-exhaustion-state"
)
if env "${retry_exhaustion_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/retry-exhaustion.out" 2>&1; then
  fail "permanently invisible Secret Manager resource was accepted"
fi
assert_contains "$temp_dir/retry-exhaustion.out" \
  "create failed and the resource was not observable after bounded retry"
[[ "$(wc -l <"$temp_dir/retry-exhaustion-state/sleep-calls" | tr -d ' ')" == "5" ]] \
  || fail "Secret Manager visibility retry did not stop at the bounded attempt limit"

cp -R "$temp_dir/state" "$temp_dir/disabled-history-state"
jq '.state = "DISABLED"' \
  "$temp_dir/disabled-history-state/secrets/ai-baram-v2-supabase-service-role/versions/1.json" \
  >"$temp_dir/disabled-supabase-version.json"
mv "$temp_dir/disabled-supabase-version.json" \
  "$temp_dir/disabled-history-state/secrets/ai-baram-v2-supabase-service-role/versions/1.json"
disabled_history_env=(
  "${secret_env[@]}"
  "FAKE_GCLOUD_STATE_DIR=$temp_dir/disabled-history-state"
)
if env "${disabled_history_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/disabled-history-apply.out" 2>&1; then
  fail "disabled-only secret version history was silently reinitialized"
fi
assert_contains "$temp_dir/disabled-history-apply.out" \
  "has version history but no enabled version; use explicit --rotate supabase"

env "${disabled_history_env[@]}" \
  'ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=1' \
  'ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION=1' \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --rotate supabase \
  >"$temp_dir/disabled-history-rotate.out"
assert_contains "$temp_dir/disabled-history-rotate.out" \
  "pin: ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=2"
[[ -f "$temp_dir/disabled-history-state/secrets/ai-baram-v2-supabase-service-role/versions/2.json" ]] \
  || fail "explicit rotation did not recover disabled-only version history"

cp "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/metadata.json" \
  "$temp_dir/supabase-metadata.json"
jq '.name = "projects/test-project/secrets/ai-baram-v2-supabase-service-role"' \
  "$temp_dir/supabase-metadata.json" \
  >"$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/metadata.json"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/ownership-drift.out" 2>&1; then
  fail "Secret Manager project-ID resource name was accepted instead of the canonical numeric name"
fi
assert_contains "$temp_dir/ownership-drift.out" "unexpected replication or ownership"
cp "$temp_dir/supabase-metadata.json" \
  "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/metadata.json"

jq '.replication.userManaged.replicas[0].location = "us-central1"' \
  "$temp_dir/supabase-metadata.json" \
  >"$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/metadata.json"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/replication-drift.out" 2>&1; then
  fail "Secret Manager replication drift was accepted"
fi
assert_contains "$temp_dir/replication-drift.out" "unexpected replication or ownership"
cp "$temp_dir/supabase-metadata.json" \
  "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/metadata.json"

cp "$temp_dir/state/secrets/ai-baram-v2-image-proxy-signing/policy.json" \
  "$temp_dir/image-policy.json"
jq '.bindings += [{"role":"roles/secretmanager.viewer","members":["user:unexpected@example.test"]}]' \
  "$temp_dir/image-policy.json" \
  >"$temp_dir/state/secrets/ai-baram-v2-image-proxy-signing/policy.json"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/secret-iam-drift.out" 2>&1; then
  fail "unexpected secret IAM was accepted"
fi
assert_contains "$temp_dir/secret-iam-drift.out" "has unexpected IAM bindings"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" \
  >"$temp_dir/secret-iam-drift-apply.out" 2>&1; then
  fail "ordinary apply reconciled unexpected secret IAM without approval"
fi
assert_contains "$temp_dir/secret-iam-drift-apply.out" \
  "inspect or use --reconcile-iam"
jq -e '
  any(.bindings[]?;
    .role == "roles/secretmanager.viewer"
    and .members == ["user:unexpected@example.test"])
' "$temp_dir/state/secrets/ai-baram-v2-image-proxy-signing/policy.json" >/dev/null \
  || fail "ordinary apply mutated the drifted secret IAM policy"

env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --reconcile-iam \
  >"$temp_dir/secret-iam-reconcile.out"
jq -e '
  (.bindings | length) == 1
  and .bindings[0].role == "roles/secretmanager.secretAccessor"
  and .bindings[0].members == ["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]
' "$temp_dir/state/secrets/ai-baram-v2-image-proxy-signing/policy.json" >/dev/null \
  || fail "explicit secret IAM reconciliation did not restore the exact policy"

touch "$temp_dir/state/project-secret-role"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/project-secret-role.out" 2>&1; then
  fail "project-wide Secret Manager access was accepted"
fi
assert_contains "$temp_dir/project-secret-role.out" \
  "forbidden project-wide Secret Manager role"
rm "$temp_dir/state/project-secret-role"

cp "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/versions/1.json" \
  "$temp_dir/supabase-version.json"
jq '.state = "DISABLED"' "$temp_dir/supabase-version.json" \
  >"$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/versions/1.json"
if env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/disabled-version.out" 2>&1; then
  fail "disabled pinned secret version was accepted"
fi
assert_contains "$temp_dir/disabled-version.out" "is not enabled or exact"
cp "$temp_dir/supabase-version.json" \
  "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/versions/1.json"

env "${secret_env[@]}" "${pinned_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --rotate apify \
  >"$temp_dir/rotate-apify.out"
assert_contains "$temp_dir/rotate-apify.out" \
  "pin: ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=2"
[[ -f "$temp_dir/state/secrets/ai-baram-v2-apify-quinary/versions/2.json" ]] \
  || fail "explicit Apify rotation did not add version 2"
[[ ! -f "$temp_dir/state/secrets/ai-baram-v2-supabase-service-role/versions/2.json" ]] \
  || fail "Apify rotation unexpectedly rotated the Supabase secret"
assert_not_contains "$temp_dir/rotate-apify.out" \
  "APIFY_QUINARY_SECRET_SENTINEL_0123456789"

if env "${secret_env[@]}" \
  bash "$script_dir/configure-analysis-v2-secrets.sh" --check \
  >"$temp_dir/nonunique-discovery.out" 2>&1; then
  fail "non-unique enabled-version discovery was accepted"
fi
assert_contains "$temp_dir/nonunique-discovery.out" \
  "requires an explicit numeric version pin"

env \
  "PATH=$PATH" \
  "ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE=$temp_dir/source.env" \
  "ANALYSIS_V2_ENV_OUTPUT_DIR=$temp_dir/generated" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$repo_dir" \
  bash "$script_dir/generate-analysis-v2-env-files.sh" \
  >"$temp_dir/generator.out"

runtime_file="$temp_dir/generated/analysis-v2-runtime.yaml"
build_file="$temp_dir/generated/analysis-v2-build.yaml"
[[ "$(stat -f '%Lp' "$runtime_file")" == "600" ]] \
  || fail "generated runtime manifest mode is not 0600"
[[ "$(stat -f '%Lp' "$build_file")" == "600" ]] \
  || fail "generated build manifest mode is not 0600"
runtime_keys="$(sed -n 's/^\([A-Z0-9_]*\):.*/\1/p' "$runtime_file" | sort)"
expected_runtime_keys="$(printf '%s\n' \
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT \
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET \
  GOOGLE_CLOUD_LOCATION \
  GOOGLE_CLOUD_PROJECT \
  NEXT_PUBLIC_SUPABASE_URL \
  SCRAPER_FALLBACK \
  SCRAPER_FOLLOWERS \
  SCRAPER_FOLLOWING \
  SCRAPER_PROFILE \
  SCRAPER_PROFILES_BATCH | sort)"
[[ "$runtime_keys" == "$expected_runtime_keys" ]] \
  || fail "generated runtime manifest key allowlist drifted"
build_keys="$(sed -n 's/^\([A-Z0-9_]*\):.*/\1/p' "$build_file" | sort)"
expected_build_keys="$(printf '%s\n' \
  NEXT_PUBLIC_SUPABASE_ANON_KEY \
  NEXT_PUBLIC_SUPABASE_URL | sort)"
[[ "$build_keys" == "$expected_build_keys" ]] \
  || fail "generated build manifest must contain exactly two public Supabase keys"
for sentinel in \
  SUPABASE_SECRET_SENTINEL_0123456789 \
  APIFY_QUINARY_SECRET_SENTINEL_0123456789 \
  IMAGE_SIGNING_SECRET_SENTINEL_01234567890123456789; do
  assert_not_contains "$runtime_file" "$sentinel"
  assert_not_contains "$build_file" "$sentinel"
  assert_not_contains "$temp_dir/generator.out" "$sentinel"
done

if env \
  "PATH=$PATH" \
  "ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE=$repo_dir/.env.local" \
  "ANALYSIS_V2_ENV_OUTPUT_DIR=$temp_dir/generated" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$repo_dir" \
  bash "$script_dir/generate-analysis-v2-env-files.sh" \
  >"$temp_dir/generator-source-boundary.out" 2>&1; then
  fail "manifest source dotenv inside the worker source was accepted"
fi
assert_contains "$temp_dir/generator-source-boundary.out" \
  "ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"

printf 'Analysis V2 Secret Manager and manifest generator tests passed\n'
