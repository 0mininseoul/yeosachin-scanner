#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/generate-analysis-v2-env-files.sh

Generates the two allowlist-only YAML manifests used by the Analysis V2 Cloud
Run source deployment. The source dotenv and output directory must both resolve
outside the worker source tree. Secret values are never copied to either file.

Required environment variables:
  ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE
  ANALYSIS_V2_ENV_OUTPUT_DIR

Optional environment variable:
  ANALYSIS_V2_WORKER_SOURCE_DIR   Defaults to the repository root.

Required source dotenv keys:
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  GOOGLE_CLOUD_PROJECT
  GOOGLE_CLOUD_LOCATION
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT

Generated files:
  analysis-v2-runtime.yaml  Non-secret worker runtime manifest.
  analysis-v2-build.yaml    Exactly the two public Supabase build values.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

required_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

validate_outside_source() {
  local path="$1"
  local label="$2"
  local resolved
  resolved="$(realpath "$path")" || die "$label could not be resolved"
  case "$resolved" in
    "$worker_source_dir"|"$worker_source_dir"/*)
      die "$label must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"
      ;;
  esac
}

while (($# > 0)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

required_env ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE
required_env ANALYSIS_V2_ENV_OUTPUT_DIR

command -v node >/dev/null 2>&1 \
  || die "Node.js with --env-file support is required"
command -v realpath >/dev/null 2>&1 \
  || die "realpath is required to validate manifest boundaries"

script_dir="$(cd "$(dirname "$0")" && pwd)"
worker_source_input="${ANALYSIS_V2_WORKER_SOURCE_DIR:-$script_dir/..}"
[[ -d "$worker_source_input" ]] \
  || die "ANALYSIS_V2_WORKER_SOURCE_DIR must be a directory"
readonly worker_source_dir="$(cd -P "$worker_source_input" && pwd -P)"

[[ -f "$ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE" ]] \
  || die "ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE must be a regular file"
[[ -d "$ANALYSIS_V2_ENV_OUTPUT_DIR" ]] \
  || die "ANALYSIS_V2_ENV_OUTPUT_DIR must already exist"
validate_outside_source "$ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE" \
  ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE
validate_outside_source "$ANALYSIS_V2_ENV_OUTPUT_DIR" \
  ANALYSIS_V2_ENV_OUTPUT_DIR

readonly output_dir="$(cd -P "$ANALYSIS_V2_ENV_OUTPUT_DIR" && pwd -P)"
readonly runtime_file="$output_dir/analysis-v2-runtime.yaml"
readonly build_file="$output_dir/analysis-v2-build.yaml"

umask 077
env -i HOME="${HOME:-}" PATH="$PATH" \
  node --env-file="$ANALYSIS_V2_MANIFEST_SOURCE_ENV_FILE" - \
  "$runtime_file" "$build_file" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const runtimePath = process.argv[2];
const buildPath = process.argv[3];

const required = (name) => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new Error(`required manifest value is missing or invalid: ${name}`);
  }
  return value.trim();
};

const supabaseUrl = required('NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = required('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const project = required('GOOGLE_CLOUD_PROJECT');
const location = required('GOOGLE_CLOUD_LOCATION');
const bucket = required('ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET');
const slot = required('ANALYSIS_V2_APIFY_API_TOKEN_SLOT');

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL must be an HTTPS Supabase project URL');
}
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
  throw new Error('GOOGLE_CLOUD_PROJECT is invalid');
}
if (location !== 'global') {
  throw new Error('GOOGLE_CLOUD_LOCATION must be global');
}
if (!/^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/.test(bucket)) {
  throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET is invalid');
}
if (!['primary', 'secondary', 'tertiary', 'quaternary', 'quinary'].includes(slot)) {
  throw new Error('ANALYSIS_V2_APIFY_API_TOKEN_SLOT must be explicit and valid');
}

const runtime = {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  GOOGLE_CLOUD_PROJECT: project,
  GOOGLE_CLOUD_LOCATION: location,
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: bucket,
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT: slot,
  SCRAPER_PROFILE: 'selfhosted',
  SCRAPER_PROFILES_BATCH: 'selfhosted',
  SCRAPER_FOLLOWERS: 'apify',
  SCRAPER_FOLLOWING: 'apify',
  SCRAPER_FALLBACK: 'true',
};

const build = {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey,
};

const yaml = (values) => Object.entries(values)
  .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  .join('\n') + '\n';

const writeAtomic = (destination, contents) => {
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.tmp`,
  );
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
};

writeAtomic(runtimePath, yaml(runtime));
writeAtomic(buildPath, yaml(build));
NODE

printf 'generated non-secret runtime manifest: %s\n' "$runtime_file"
printf 'generated public-only build manifest: %s\n' "$build_file"
