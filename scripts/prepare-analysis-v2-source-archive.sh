#!/usr/bin/env bash
set -euo pipefail

[[ $# == 2 ]] || {
  printf 'usage: %s SOURCE_REPOSITORY EMPTY_DESTINATION\n' "$0" >&2
  exit 1
}

source_input="$1"
destination_input="$2"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v realpath >/dev/null 2>&1 || die "realpath is required"

[[ -d "$source_input" ]] || die "source repository is not a directory"
[[ -d "$destination_input" ]] || die "archive destination is not a directory"
source_dir="$(cd -P "$source_input" && pwd -P)"
destination_dir="$(cd -P "$destination_input" && pwd -P)"
repository_root="$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null)" \
  || die "source directory is not a Git worktree"
repository_root="$(cd -P "$repository_root" && pwd -P)"
[[ "$source_dir" == "$repository_root" ]] \
  || die "source directory must be the Git worktree root"
[[ "$destination_dir" != "$source_dir" && "$destination_dir" != "$source_dir"/* ]] \
  || die "archive destination must be outside the source worktree"
[[ -z "$(find "$destination_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] \
  || die "archive destination must be empty"

dirty="$(git -C "$source_dir" status --porcelain=v1 --untracked-files=all)"
[[ -z "$dirty" ]] \
  || die "source worktree must be clean; commit or remove tracked and untracked changes"
git -C "$source_dir" rev-parse --verify HEAD^{commit} >/dev/null \
  || die "source worktree has no deployable commit"

git -C "$source_dir" archive --format=tar HEAD | tar -xf - -C "$destination_dir"
[[ -f "$destination_dir/package.json" ]] \
  || die "tracked source archive does not contain package.json"
if find "$destination_dir" -type l -print -quit | grep -q .; then
  die "tracked source archive contains a symbolic link"
fi
source_ignore_policy="$destination_dir/scripts/analysis-v2-source.gcloudignore"
[[ -f "$source_ignore_policy" ]] \
  || die "tracked source archive does not contain the Cloud Run ignore policy"
cp "$source_ignore_policy" "$destination_dir/.gcloudignore"

printf '%s\n' "$destination_dir"
