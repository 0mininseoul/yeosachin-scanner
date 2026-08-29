#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# A deployment shell may inherit xtrace from an operator wrapper. Disable it
# before resolving or passing the GitHub credential to curl.
set +x

readonly expected_workflow_path='.github/workflows/ci.yml'
readonly github_api_url='https://api.github.com/repos/0mininseoul/yeosachin-scanner/actions/workflows/ci.yml/runs'

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

(($# == 1)) || die 'exactly one source SHA argument is required'
source_sha="$1"
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] \
  || die 'source SHA must be one lowercase 40-character Git SHA'

for command_name in curl jq mktemp; do
  command -v "$command_name" >/dev/null 2>&1 \
    || die "$command_name is required"
done

github_token="${GITHUB_TOKEN:-}"
if [[ -z "$github_token" ]]; then
  github_token="${GH_TOKEN:-}"
fi
[[ -n "$github_token" ]] \
  || die 'GITHUB_TOKEN or GH_TOKEN is required'
[[ "$github_token" != *[[:space:]]* ]] \
  && ((${#github_token} <= 512)) \
  || die 'GITHUB_TOKEN or GH_TOKEN is invalid'

escape_curl_config_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

response_file="$(mktemp "${TMPDIR:-/tmp}/require-github-ci-success.XXXXXX")" \
  || die 'could not create a temporary GitHub API response file'
trap 'rm -f "$response_file"' EXIT

escaped_github_token="$(escape_curl_config_value "$github_token")"
request_url="$github_api_url?event=push&branch=main&head_sha=$source_sha&per_page=100"
if ! http_status="$(curl --disable --proto '=https' --tlsv1.2 \
  --max-redirs 0 --connect-timeout 10 --max-time 30 \
  --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --url "$request_url" \
  --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' \
  --config - 2>/dev/null <<EOF
header = "Authorization: Bearer $escaped_github_token"
header = "User-Agent: yeosachin-exact-sha-gate"
EOF
)"; then
  die 'GitHub Actions API request failed'
fi

[[ "$http_status" =~ ^[0-9]{3}$ ]] \
  || die 'GitHub Actions API request failed'
case "$http_status" in
  2[0-9][0-9])
    ;;
  401|403)
    die 'GitHub API authentication/authorization failed'
    ;;
  *)
    die 'GitHub Actions API request failed'
    ;;
esac

if ! jq -e '
  type == "object"
    and (.total_count | type == "number" and . >= 0 and floor == .)
    and (.workflow_runs | type == "array")
    and all(.workflow_runs[]?;
      type == "object"
        and (.path | type == "string")
        and (.head_sha | type == "string" and test("^[0-9a-f]{40}$"))
        and (.event | type == "string")
        and (.head_branch | type == "string")
        and (.status | type == "string")
        and has("conclusion")
        and (
          (.status == "completed" and (.conclusion | type) == "string")
          or (.status != "completed"
            and ((.conclusion == null) or ((.conclusion | type) == "string")))
        )
    )
' "$response_file" >/dev/null 2>&1; then
  die 'GitHub Actions API returned malformed JSON'
fi

ci_state="$(jq -r -e \
  --arg expected_sha "$source_sha" \
  --arg expected_path "$expected_workflow_path" '
    def normalized_ci_path($base):
      if . == $base then
        $base
      elif startswith($base + "@") and length > (($base | length) + 1) then
        $base
      else
        .
      end;

    [.workflow_runs[]
      | select(
          ((.path | normalized_ci_path($expected_path)) == $expected_path)
          and .head_sha == $expected_sha
          and .event == "push"
          and .head_branch == "main"
        )] as $matches
    | if ($matches | length) == 0 then
        "absent"
      elif all($matches[]; .status == "completed" and .conclusion == "success") then
        "success"
      elif any($matches[]; .status != "completed") then
        "pending"
      else
        "failure"
      end
  ' "$response_file" 2>/dev/null)" \
  || die 'GitHub Actions API returned malformed JSON'

case "$ci_state" in
  success)
    printf 'GitHub Actions CI gate passed\n'
    ;;
  pending)
    die 'CI run for source SHA is not completed successfully (pending)'
    ;;
  failure)
    die 'CI run for source SHA is not completed successfully'
    ;;
  absent)
    die 'no completed successful CI run was found for source SHA'
    ;;
  *)
    die 'GitHub Actions API returned malformed JSON'
    ;;
esac
