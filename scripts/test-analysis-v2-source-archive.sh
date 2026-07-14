#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-source-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  printf 'test failure: %s\n' "$*" >&2
  exit 1
}

repo="$temp_dir/repo"
mkdir -p "$repo" "$temp_dir/archive-clean"
git -C "$temp_dir" init -q repo
git -C "$repo" config user.email test@example.test
git -C "$repo" config user.name Test
mkdir -p "$repo/scripts"
printf '{"private":true}\n' >"$repo/package.json"
printf 'tracked\n' >"$repo/tracked.txt"
printf '.env.local\n' >"$repo/.gitignore"
cat >"$repo/scripts/analysis-v2-source.gcloudignore" <<'EOF'
.gcloudignore
.env*
!.env.example
EOF
git -C "$repo" add .gitignore package.json scripts tracked.txt
git -C "$repo" commit -qm initial

bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
  "$repo" "$temp_dir/archive-clean" >/dev/null
[[ "$(<"$temp_dir/archive-clean/tracked.txt")" == "tracked" ]] \
  || fail "tracked file was not archived"
[[ ! -e "$temp_dir/archive-clean/.git" ]] || fail ".git was archived"
cmp -s \
  "$temp_dir/archive-clean/scripts/analysis-v2-source.gcloudignore" \
  "$temp_dir/archive-clean/.gcloudignore" \
  || fail "tracked Cloud Run ignore policy was not installed at the archive root"

printf 'IGNORED_SECRET_SENTINEL\n' >"$repo/.env.local"
mkdir "$temp_dir/archive-ignored-secret"
bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
  "$repo" "$temp_dir/archive-ignored-secret" >/dev/null
[[ ! -e "$temp_dir/archive-ignored-secret/.env.local" ]] \
  || fail "ignored untracked secret was archived"
if grep -R -Fq -- 'IGNORED_SECRET_SENTINEL' "$temp_dir/archive-ignored-secret"; then
  fail "ignored untracked secret content was archived"
fi
rm "$repo/.env.local"

mkdir "$temp_dir/archive-untracked"
printf '{"private_key":"SECRET_SENTINEL"}\n' >"$repo/service-account.json"
if bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
  "$repo" "$temp_dir/archive-untracked" >"$temp_dir/untracked.out" 2>&1; then
  fail "untracked credential file was accepted"
fi
grep -Fq "source worktree must be clean" "$temp_dir/untracked.out" \
  || fail "untracked rejection was not explicit"
[[ -z "$(find "$temp_dir/archive-untracked" -mindepth 1 -print -quit)" ]] \
  || fail "a rejected worktree wrote upload content"
rm "$repo/service-account.json"

printf 'modified\n' >"$repo/tracked.txt"
mkdir "$temp_dir/archive-dirty"
if bash "$script_dir/prepare-analysis-v2-source-archive.sh" \
  "$repo" "$temp_dir/archive-dirty" >"$temp_dir/dirty.out" 2>&1; then
  fail "dirty tracked source was accepted"
fi
grep -Fq "source worktree must be clean" "$temp_dir/dirty.out" \
  || fail "dirty tracked rejection was not explicit"

printf 'Analysis V2 clean source archive tests passed\n'
