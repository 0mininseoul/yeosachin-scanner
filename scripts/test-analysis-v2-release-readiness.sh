#!/usr/bin/env bash
set -euo pipefail

readonly repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly gate="$repo_dir/scripts/check-analysis-v2-release-readiness.sh"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-release-readiness.XXXXXX")"
readonly bin_dir="$temp_dir/bin"
readonly command_log="$temp_dir/commands.log"
readonly expected_sha="0123456789abcdef0123456789abcdef01234567"
readonly vercel_token="token-must-not-be-printed"

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

chmod +x "$bin_dir/gcloud" "$bin_dir/curl" "$bin_dir/supabase"

export FAKE_COMMAND_LOG="$command_log"
export FAKE_SERVICE_JSON='{"status":{"traffic":[{"revisionName":"analysis-worker-active","percent":100}]}}'
export FAKE_REVISION_JSON="{\"metadata\":{\"name\":\"analysis-worker-active\",\"labels\":{\"analysis-v2-source-commit\":\"$expected_sha\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}"
export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"$expected_sha\"}}]}"
export FAKE_SUPABASE_JSON='[{"version":"20260829120000","name":"add_analysis_v2_progress_signals_history"}]'
export VERCEL_TOKEN="$vercel_token"

run_gate() {
  env "PATH=$bin_dir:/usr/bin:/bin" \
    ANALYSIS_V2_EXPECTED_GIT_SHA="$expected_sha" \
    ANALYSIS_V2_TASKS_PROJECT='ai-baram-prod' \
    ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE='analysis-worker' \
    ANALYSIS_V2_TASKS_CLOUD_RUN_REGION='asia-northeast3' \
    VERCEL_PROJECT_ID='prj_existing_analysis_v2' \
    VERCEL_TOKEN="$VERCEL_TOKEN" \
    ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR="$repo_dir" \
    FAKE_COMMAND_LOG="$FAKE_COMMAND_LOG" \
    FAKE_SERVICE_JSON="$FAKE_SERVICE_JSON" \
    FAKE_REVISION_JSON="$FAKE_REVISION_JSON" \
    FAKE_VERCEL_JSON="$FAKE_VERCEL_JSON" \
    FAKE_SUPABASE_JSON="$FAKE_SUPABASE_JSON" \
    bash "$gate"
}

assert_no_token() {
  local output="$1"
  [[ "$output" != *"$vercel_token"* ]] \
    || fail 'Vercel token appeared in release-readiness output'
}

if ! output="$(run_gate 2>&1)"; then
  printf '%s\n' "$output" >&2
  fail 'matching release provenance was rejected'
fi
assert_no_token "$output"
[[ "$output" == *"release readiness passed"* ]] \
  || fail 'successful release readiness did not report a pass'

export FAKE_REVISION_JSON="{\"metadata\":{\"name\":\"analysis-worker-active\",\"labels\":{\"analysis-v2-source-commit\":\"$expected_sha\"}},\"status\":{\"conditions\":[{\"type\":\"Ready\",\"status\":\"True\"}]}}"
export FAKE_SERVICE_JSON='{"status":{"traffic":[{"revisionName":"analysis-worker-active","percent":100}]}}'
export FAKE_REVISION_JSON="${FAKE_REVISION_JSON/$expected_sha/ffffffffffffffffffffffffffffffffffffffff}"
if output="$(run_gate 2>&1)"; then
  fail 'stale Cloud Run provenance was accepted'
fi
assert_no_token "$output"
[[ "$output" == *'Cloud Run provenance SHA mismatch'* ]] \
  || fail 'Cloud Run mismatch was not classified explicitly'

export FAKE_REVISION_JSON="${FAKE_REVISION_JSON/ffffffffffffffffffffffffffffffffffffffff/$expected_sha}"
export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"ffffffffffffffffffffffffffffffffffffffff\"}}]}"
if output="$(run_gate 2>&1)"; then
  fail 'stale Vercel provenance was accepted'
fi
assert_no_token "$output"
[[ "$output" == *'Vercel production SHA mismatch'* ]] \
  || fail 'Vercel mismatch was not classified explicitly'

export FAKE_VERCEL_JSON="{\"deployments\":[{\"target\":\"production\",\"readyState\":\"READY\",\"meta\":{\"githubCommitSha\":\"$expected_sha\"}}]}"
export FAKE_SUPABASE_JSON='[{"version":"20260828000000","name":"older_migration"}]'
if output="$(run_gate 2>&1)"; then
  fail 'missing DB migration provenance was accepted'
fi
assert_no_token "$output"
[[ "$output" == *'DB progress migration 20260829120000 is not applied'* ]] \
  || fail 'DB migration mismatch was not classified explicitly'

if grep -Eiq -- '(^|[[:space:]])(deploy|create|apply|push|repair|up|down|post|patch|delete)([[:space:]]|$)' "$command_log"; then
  fail 'release readiness issued a mutating command'
fi

printf 'PASS: analysis V2 release readiness script contract\n'
