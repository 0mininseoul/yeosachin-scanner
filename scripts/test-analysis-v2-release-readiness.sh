#!/usr/bin/env bash
set -euo pipefail

readonly repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly gate="$repo_dir/scripts/check-analysis-v2-release-readiness.sh"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-release-readiness.XXXXXX")"
readonly bin_dir="$temp_dir/bin"
readonly command_log="$temp_dir/commands.log"
readonly expected_sha="0123456789abcdef0123456789abcdef01234567"
readonly vercel_token="token-must-not-be-printed"
readonly image_proxy_secret="image-proxy-secret-must-not-be-printed-0123456789"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

mkdir -p "$bin_dir"
: >"$command_log"

cat >"$bin_dir/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'gcloud' >>"${FAKE_COMMAND_LOG:?}"
printf ' %q' "$@" >>"${FAKE_COMMAND_LOG:?}"
printf '\n' >>"${FAKE_COMMAND_LOG:?}"

case "$*" in
  'run services describe '* )
    printf '%s\n' "${FAKE_SERVICE_JSON:?}"
    ;;
  'run revisions describe '* )
    printf '%s\n' "${FAKE_REVISION_JSON:?}"
    ;;
  *)
    printf 'unexpected gcloud command\n' >&2
    exit 91
    ;;
esac
EOF

cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'curl' >>"${FAKE_COMMAND_LOG:?}"
printf ' %q' "$@" >>"${FAKE_COMMAND_LOG:?}"
printf '\n' >>"${FAKE_COMMAND_LOG:?}"

case "$*" in
  *' -X '*|*' POST '*|*' PATCH '*|*' DELETE '*)
    printf 'unexpected mutating HTTP method\n' >&2
    exit 92
    ;;
esac

expected_vercel_url='https://api.vercel.com/v6/deployments?projectId=prj_existing_analysis_v2&target=production&limit=20'
url_is_argv=false
accept_is_argv=false
for arg in "$@"; do
  [[ "$arg" == "$expected_vercel_url" ]] && url_is_argv=true
  [[ "$arg" == 'Accept: application/json' ]] && accept_is_argv=true
done
[[ "$url_is_argv" == true ]] || exit 96
[[ "$accept_is_argv" == true ]] || exit 97
curl_config="$(cat)"
[[ "$curl_config" == *'header = "Authorization: Bearer '* ]] || exit 98
[[ "$curl_config" != *'url ='* ]] || exit 99
[[ "$curl_config" != *'Accept: application/json'* ]] || exit 100
printf '%s\n' "${FAKE_VERCEL_JSON:?}"
EOF

cat >"$bin_dir/supabase" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'supabase' >>"${FAKE_COMMAND_LOG:?}"
printf ' %q' "$@" >>"${FAKE_COMMAND_LOG:?}"
printf '\n' >>"${FAKE_COMMAND_LOG:?}"

[[ "$*" == *'migration list'* ]] || exit 93
[[ "$*" == *'--linked'* ]] || exit 94
[[ "$*" == *'--output-format'* ]] || exit 95
printf '%s\n' "${FAKE_SUPABASE_JSON:?}"
EOF

cat >"$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'npx' >>"${FAKE_COMMAND_LOG:?}"
printf ' %q' "$@" >>"${FAKE_COMMAND_LOG:?}"
printf '\n' >>"${FAKE_COMMAND_LOG:?}"

case "${FAKE_IMAGE_PROXY_PROBE_RESULT:-pass}" in
  pass)
    printf 'PASS: image-proxy-signing compatibility signature_accepted_503_retryable\n'
    ;;
  reject)
    printf 'FAIL: image-proxy-signing compatibility signature_rejected_403\n'
    exit 1
    ;;
  unexpected)
    printf 'NOT-A-PROBE-RESULT\n'
    ;;
  *)
    printf 'unexpected fake probe scenario\n' >&2
    exit 96
    ;;
esac
EOF

chmod +x "$bin_dir/gcloud" "$bin_dir/curl" "$bin_dir/supabase" "$bin_dir/npx"

export FAKE_COMMAND_LOG="$command_log"
export FAKE_SERVICE_JSON='{"status":{"traffic":[{"revisionName":"analysis-worker-active","percent":100}]}}'
export FAKE_REVISION_JSON="{\"metadata\":{\"name\":\"analysis-worker-active\",\"labels\":{\"analysis-v2-source-commit\":\"$expected_sha\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}"
export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"$expected_sha\"}}]}"
export FAKE_SUPABASE_JSON='[{"version":"20260829120000","name":"add_analysis_v2_progress_signals_history"}]'
export VERCEL_TOKEN="$vercel_token"
export IMAGE_PROXY_SIGNING_SECRET="$image_proxy_secret"
export ANALYSIS_V2_IMAGE_PROXY_PROBE_BASE_URL='https://yeosachin.com'

run_gate() (
  export PATH="$bin_dir:/usr/bin:/bin"
  export ANALYSIS_V2_EXPECTED_GIT_SHA="$expected_sha"
  export ANALYSIS_V2_TASKS_PROJECT='ai-baram-prod'
  export ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE='analysis-worker'
  export ANALYSIS_V2_TASKS_CLOUD_RUN_REGION='asia-northeast3'
  export VERCEL_PROJECT_ID='prj_existing_analysis_v2'
  export VERCEL_TOKEN
  export IMAGE_PROXY_SIGNING_SECRET
  export ANALYSIS_V2_IMAGE_PROXY_PROBE_BASE_URL
  export ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR="$repo_dir"
  export FAKE_COMMAND_LOG
  export FAKE_SERVICE_JSON
  export FAKE_REVISION_JSON
  export FAKE_VERCEL_JSON
  export FAKE_SUPABASE_JSON
  export FAKE_IMAGE_PROXY_PROBE_RESULT
  bash "$gate"
)

assert_no_token() {
  local output="$1"
  [[ "$output" != *"$vercel_token"* ]] \
    || fail 'Vercel token appeared in release-readiness output'
}

assert_no_sensitive_probe_value() {
  local output="$1"
  [[ "$output" != *"$image_proxy_secret"* ]] \
    || fail 'image proxy signing secret appeared in release-readiness output'
  [[ "$(<"$command_log")" != *"$image_proxy_secret"* ]] \
    || fail 'image proxy signing secret appeared in a release-readiness command argv'
}

if ! output="$(run_gate 2>&1)"; then
  printf '%s\n' "$output" >&2
  fail 'matching release provenance was rejected'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *"release readiness passed"* ]] \
  || fail 'successful release readiness did not report a pass'
[[ "$(<"$command_log")" != *"$vercel_token"* ]] \
  || fail 'Vercel token appeared in a release-readiness command argv'

export FAKE_REVISION_JSON="{\"metadata\":{\"name\":\"analysis-worker-active\",\"labels\":{\"analysis-v2-source-commit\":\"$expected_sha\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}"
export FAKE_SERVICE_JSON='{"status":{"traffic":[{"revisionName":"analysis-worker-active","percent":100}]}}'
export FAKE_REVISION_JSON="${FAKE_REVISION_JSON/$expected_sha/ffffffffffffffffffffffffffffffffffffffff}"
if output="$(run_gate 2>&1)"; then
  fail 'stale Cloud Run provenance was accepted'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *'Cloud Run provenance SHA mismatch'* ]] \
  || fail 'Cloud Run mismatch was not classified explicitly'

export FAKE_REVISION_JSON="${FAKE_REVISION_JSON/ffffffffffffffffffffffffffffffffffffffff/$expected_sha}"
export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"ffffffffffffffffffffffffffffffffffffffff\"}}]}"
if output="$(run_gate 2>&1)"; then
  fail 'stale Vercel provenance was accepted'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *'Vercel production SHA mismatch'* ]] \
  || fail 'Vercel mismatch was not classified explicitly'

export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"$expected_sha\"}}]}"
export FAKE_SUPABASE_JSON='[{"version":"20260828000000","name":"older_migration"}]'
if output="$(run_gate 2>&1)"; then
  fail 'missing DB migration provenance was accepted'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *'DB progress migration 20260829120000 is not applied'* ]] \
  || fail 'DB migration mismatch was not classified explicitly'

export FAKE_SUPABASE_JSON='[{"version":"20260829120000","name":"add_analysis_v2_progress_signals_history"}]'
export FAKE_IMAGE_PROXY_PROBE_RESULT='reject'
if output="$(run_gate 2>&1)"; then
  fail 'a rejected image proxy signing secret was accepted'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *'IMAGE_PROXY_SIGNING_SECRET compatibility probe failed'* ]] \
  || fail '403 image proxy probe failure was not classified explicitly'

export FAKE_IMAGE_PROXY_PROBE_RESULT='unexpected'
if output="$(run_gate 2>&1)"; then
  fail 'an invalid image proxy probe result was accepted'
fi
assert_no_token "$output"
assert_no_sensitive_probe_value "$output"
[[ "$output" == *'IMAGE_PROXY_SIGNING_SECRET compatibility probe returned an invalid result'* ]] \
  || fail 'invalid image proxy probe output was not classified explicitly'

if grep -Eiq -- '(^|[[:space:]])(deploy|create|apply|push|repair|up|down|post|patch|delete)([[:space:]]|$)' "$command_log"; then
  fail 'release readiness issued a mutating command'
fi

printf 'PASS: analysis V2 release readiness script contract\n'
