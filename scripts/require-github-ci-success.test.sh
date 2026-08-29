#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

readonly repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly gate="$repo_dir/scripts/require-github-ci-success.sh"
readonly deploy_script="$repo_dir/scripts/deploy-analysis-v2-worker.sh"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/require-github-ci-success.XXXXXX")"
readonly bin_dir="$temp_dir/bin"
readonly command_log="$temp_dir/commands.log"
readonly expected_sha="0123456789abcdef0123456789abcdef01234567"
readonly wrong_sha="fedcba9876543210fedcba9876543210fedcba98"
readonly github_token="github-token-must-not-be-printed"
readonly response_sentinel="github-api-response-must-not-be-printed"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" == *"$needle"* ]] \
    || fail "expected output to contain: $needle"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  [[ "$haystack" != *"$needle"* ]] \
    || fail "output exposed rejected content: $needle"
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  ! grep -Fq -- "$needle" "$file" \
    || fail "$file exposed rejected content: $needle"
}

mkdir -p "$bin_dir"
cat >"$bin_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf 'curl' >>"${FAKE_COMMAND_LOG:?}"
printf ' %q' "$@" >>"${FAKE_COMMAND_LOG:?}"
printf '\n' >>"${FAKE_COMMAND_LOG:?}"

output_file=""
for ((index = 1; index <= $#; index++)); do
  argument="${!index}"
  if [[ "$argument" == '--output' ]]; then
    next_index=$((index + 1))
    output_file="${!next_index}"
  fi
done
[[ -n "$output_file" ]] || exit 91

config="$(cat)"
[[ "$config" == *"Authorization: Bearer ${FAKE_EXPECTED_TOKEN:?}"* ]] || exit 92
[[ "$config" != *'url ='* ]] || exit 93
[[ "$config" != *'Accept: application/json'* ]] || exit 94

printf '%s' "${FAKE_RESPONSE:?}" >"$output_file"
printf '%s' "${FAKE_HTTP_STATUS:-200}"
[[ "${FAKE_CURL_EXIT:-0}" == 0 ]] || exit "${FAKE_CURL_EXIT}"
EOF
chmod +x "$bin_dir/curl"

run_gate() (
  export PATH="$bin_dir:/usr/bin:/bin"
  export FAKE_COMMAND_LOG="$command_log"
  export FAKE_EXPECTED_TOKEN="$github_token"
  export GITHUB_TOKEN="$github_token"
  unset GH_TOKEN
  /bin/bash "$gate" "$expected_sha"
)

run_rejected() {
  local label="$1"
  local expected_message="$2"
  local output
  if output="$(run_gate 2>&1)"; then
    printf '%s\n' "$output" >&2
    fail "$label was accepted"
  fi
  assert_contains "$output" "$expected_message"
  assert_not_contains "$output" "$github_token"
  assert_not_contains "$output" "$response_sentinel"
}

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/ci.yml\",\"head_sha\":\"$expected_sha\",\"status\":\"completed\",\"conclusion\":\"success\"}]}"
: >"$command_log"
if ! output="$(run_gate 2>&1)"; then
  printf '%s\n' "$output" >&2
  fail 'matching completed/success CI run was rejected'
fi
assert_contains "$output" 'GitHub Actions CI gate passed'
assert_not_contains "$output" "$github_token"
assert_not_contains "$output" "$response_sentinel"
assert_file_not_contains "$command_log" "$github_token"
assert_contains "$(<"$command_log")" \
  'https://api.github.com/repos/0mininseoul/yeosachin-scanner/actions/workflows/ci.yml/runs'
assert_contains "$(<"$command_log")" "$expected_sha"
assert_contains "$(<"$command_log")" 'per_page=100'

if PATH="$bin_dir:/usr/bin:/bin" GITHUB_TOKEN="$github_token" GH_TOKEN='' \
  /bin/bash "$gate" "${expected_sha:0:39}" >"$temp_dir/malformed-sha.out" 2>&1; then
  fail 'malformed source SHA was accepted'
fi
assert_contains "$(<"$temp_dir/malformed-sha.out")" \
  'source SHA must be one lowercase 40-character Git SHA'
assert_not_contains "$(<"$temp_dir/malformed-sha.out")" "$github_token"

export FAKE_RESPONSE='{"total_count":0,"workflow_runs":[]}'
run_rejected 'absent CI run' 'no completed successful CI run was found for source SHA'

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/ci.yml\",\"head_sha\":\"$expected_sha\",\"status\":\"in_progress\",\"conclusion\":null}]}"
run_rejected 'pending CI run' 'CI run for source SHA is not completed successfully'

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/ci.yml\",\"head_sha\":\"$expected_sha\",\"status\":\"completed\",\"conclusion\":\"failure\"}]}"
run_rejected 'failed CI run' 'CI run for source SHA is not completed successfully'

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/ci.yml\",\"head_sha\":\"$wrong_sha\",\"status\":\"completed\",\"conclusion\":\"success\"}]}"
run_rejected 'other-SHA CI run' 'no completed successful CI run was found for source SHA'

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/other.yml\",\"head_sha\":\"$expected_sha\",\"status\":\"completed\",\"conclusion\":\"success\"}]}"
run_rejected 'other-workflow CI run' 'no completed successful CI run was found for source SHA'

export FAKE_RESPONSE="{\"message\":\"$response_sentinel\"}"
run_rejected 'malformed API response' 'GitHub Actions API returned malformed JSON'

export FAKE_RESPONSE="{\"total_count\":1,\"workflow_runs\":[{\"path\":\".github/workflows/ci.yml\",\"head_sha\":\"$expected_sha\",\"status\":\"completed\",\"conclusion\":\"success\"}]}"
export FAKE_HTTP_STATUS=500
run_rejected 'API failure' 'GitHub Actions API request failed'

export FAKE_HTTP_STATUS=401
run_rejected 'authentication failure' 'GitHub API authentication/authorization failed'

export FAKE_HTTP_STATUS=000
export FAKE_CURL_EXIT=7
run_rejected 'transport failure' 'GitHub Actions API request failed'
unset FAKE_HTTP_STATUS FAKE_CURL_EXIT

if PATH="$bin_dir:/usr/bin:/bin" GITHUB_TOKEN='' GH_TOKEN='' \
  /bin/bash "$gate" "$expected_sha" >"$temp_dir/missing-token.out" 2>&1; then
  fail 'missing GitHub token was accepted'
fi
assert_contains "$(<"$temp_dir/missing-token.out")" \
  'GITHUB_TOKEN or GH_TOKEN is required'
assert_not_contains "$(<"$temp_dir/missing-token.out")" "$github_token"

if PATH="$bin_dir" GITHUB_TOKEN="$github_token" GH_TOKEN='' \
  /bin/bash "$gate" "$expected_sha" >"$temp_dir/missing-jq.out" 2>&1; then
  fail 'missing jq dependency was accepted'
fi
assert_contains "$(<"$temp_dir/missing-jq.out")" 'jq is required'
assert_not_contains "$(<"$temp_dir/missing-jq.out")" "$github_token"

if PATH="$temp_dir" GITHUB_TOKEN="$github_token" GH_TOKEN='' \
  /bin/bash "$gate" "$expected_sha" >"$temp_dir/missing-curl.out" 2>&1; then
  fail 'missing curl dependency was accepted'
fi
assert_contains "$(<"$temp_dir/missing-curl.out")" 'curl is required'
assert_not_contains "$(<"$temp_dir/missing-curl.out")" "$github_token"

if PATH="$bin_dir" GITHUB_TOKEN="$github_token" GH_TOKEN='' \
  /bin/bash "$gate" "$expected_sha" --skip >"$temp_dir/bypass.out" 2>&1; then
  fail 'unsupported bypass argument was accepted'
fi
assert_contains "$(<"$temp_dir/bypass.out")" 'exactly one source SHA argument is required'

source_sha_line="$(grep -n 'source_commit_sha=.*rev-parse --verify' "$deploy_script" | head -n 1 | cut -d: -f1)"
gate_line="$(grep -n 'require-github-ci-success.sh' "$deploy_script" | head -n 1 | cut -d: -f1)"
gcloud_auth_line="$(grep -n 'gcloud auth list' "$deploy_script" | head -n 1 | cut -d: -f1)"
[[ "$source_sha_line" =~ ^[0-9]+$ && "$gate_line" =~ ^[0-9]+$ && "$gcloud_auth_line" =~ ^[0-9]+$ ]] \
  || fail 'could not locate source SHA, CI gate, and gcloud auth boundaries'
((gate_line > source_sha_line && gate_line < gcloud_auth_line)) \
  || fail 'CI gate is not between source SHA validation and gcloud auth'
sed -n "$((gate_line - 2)),$((gate_line + 2))p" "$deploy_script" \
  | grep -Fq 'if [[ "$mode" == "apply" ]]' \
  || fail 'CI gate is not explicitly restricted to apply mode'

printf 'PASS: exact-SHA GitHub CI gate contract\n'
