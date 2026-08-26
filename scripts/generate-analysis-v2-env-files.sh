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
  PREFLIGHT_APIFY_API_TOKEN_SLOTS=primary,quinary,senary
  ANALYSIS_V2_INSTAGRAM_ROUTE=apify_v1|selfhosted_auth_v1
  ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED=true|false
  BETATEST_FREE_POOL_ENABLED=true|false
  BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS=1..900
  BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS=1..900
  SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED=true
  SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS=750
  SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS=100
  SELFHOSTED_AUTH_ENABLED=true|false
  SCRAPER_FOLLOWERS=apify|selfhosted_auth
  SCRAPER_FOLLOWING=apify|selfhosted_auth
  SCRAPER_LIKERS=apify|selfhosted_auth
  SCRAPER_COMMENTS=apify|selfhosted_auth
  SCRAPER_FALLBACK=true|false

Required only when all four SCRAPER_* selectors above use selfhosted_auth:
  SELFHOSTED_AUTH_WORKER_URL=https://private-worker-origin
  SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE=https://private-worker-origin
  SELFHOSTED_AUTH_WORKER_TIMEOUT_MS=1000..300000

For an all-Apify rollback, set SELFHOSTED_AUTH_ENABLED=false and omit the
worker URL, audience, and timeout keys.

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
const preflightApifyTokenSlots = required('PREFLIGHT_APIFY_API_TOKEN_SLOTS');
const instagramRoute = required('ANALYSIS_V2_INSTAGRAM_ROUTE');
const authorizedTestShardingEnabled = required(
  'ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED',
);
const betaFreePoolEnabled = required('BETATEST_FREE_POOL_ENABLED');
const betaFreePoolMaxSnapshotAgeSeconds = required(
  'BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS',
);
const betaFreePoolRefreshIntervalSeconds = required(
  'BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS',
);
const globalGateEnabled = required('SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED');
const globalMinIntervalMs = required('SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS');
const globalResponseGuardMs = required('SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS');
const selfHostedAuthEnabled = required('SELFHOSTED_AUTH_ENABLED');
const scraperFollowers = required('SCRAPER_FOLLOWERS');
const scraperFollowing = required('SCRAPER_FOLLOWING');
const scraperLikers = required('SCRAPER_LIKERS');
const scraperComments = required('SCRAPER_COMMENTS');
const scraperFallback = required('SCRAPER_FALLBACK');

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
if (!['primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'tenth'].includes(slot)) {
  throw new Error('ANALYSIS_V2_APIFY_API_TOKEN_SLOT must be explicit and valid');
}
if (process.env.PREFLIGHT_APIFY_API_TOKEN_SLOTS !== 'primary,quinary,senary') {
  throw new Error('PREFLIGHT_APIFY_API_TOKEN_SLOTS must be exactly primary,quinary,senary');
}
if (!['apify_v1', 'selfhosted_auth_v1'].includes(instagramRoute)) {
  throw new Error('ANALYSIS_V2_INSTAGRAM_ROUTE must be apify_v1 or selfhosted_auth_v1');
}
if (!['true', 'false'].includes(authorizedTestShardingEnabled)) {
  throw new Error('ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED must be true or false');
}
if (!['true', 'false'].includes(betaFreePoolEnabled)) {
  throw new Error('BETATEST_FREE_POOL_ENABLED must be true or false');
}
for (const [name, value] of [
  ['BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS', betaFreePoolMaxSnapshotAgeSeconds],
  ['BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS', betaFreePoolRefreshIntervalSeconds],
]) {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 900) {
    throw new Error(`${name} must be an integer from 1 through 900`);
  }
}
if (globalGateEnabled !== 'true') {
  throw new Error('SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED must be true');
}
if (globalMinIntervalMs !== '750') {
  throw new Error('SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS must be 750');
}
if (globalResponseGuardMs !== '100') {
  throw new Error('SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS must be 100');
}
if (!['true', 'false'].includes(selfHostedAuthEnabled)) {
  throw new Error('SELFHOSTED_AUTH_ENABLED must be true or false');
}
const privateHttpsOrigin = (value, name) => {
  let parsed;
  try { parsed = new URL(value); } catch {
    throw new Error(`${name} must be a private HTTPS origin`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error(`${name} must be a private HTTPS origin`);
  }
  return parsed.origin;
};
const paidCollectionProviders = [
  scraperFollowers,
  scraperFollowing,
  scraperLikers,
  scraperComments,
];
if (!paidCollectionProviders.every(value => value === 'apify')
  && !paidCollectionProviders.every(value => value === 'selfhosted_auth')) {
  throw new Error('SCRAPER_FOLLOWERS, SCRAPER_FOLLOWING, SCRAPER_LIKERS, and SCRAPER_COMMENTS must select one paid provider');
}
if (!['true', 'false'].includes(scraperFallback)) {
  throw new Error('SCRAPER_FALLBACK must be true or false');
}
if (scraperFollowers === 'selfhosted_auth' && scraperFallback !== 'false') {
  throw new Error('SCRAPER_FALLBACK must be false for selfhosted_auth paid collection');
}
if (instagramRoute === 'selfhosted_auth_v1' && selfHostedAuthEnabled !== 'true') {
  throw new Error('SELFHOSTED_AUTH_ENABLED must be true for selfhosted_auth_v1');
}
let selfHostedAuthWorker: Record<string, string> = {};
if (scraperFollowers === 'selfhosted_auth') {
  if (selfHostedAuthEnabled !== 'true') {
    throw new Error('SELFHOSTED_AUTH_ENABLED must be true for selfhosted_auth paid collection');
  }
  const workerOrigin = privateHttpsOrigin(
    required('SELFHOSTED_AUTH_WORKER_URL'),
    'SELFHOSTED_AUTH_WORKER_URL'
  );
  if (privateHttpsOrigin(
    required('SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE'),
    'SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE'
  ) !== workerOrigin) {
    throw new Error('SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE must match SELFHOSTED_AUTH_WORKER_URL');
  }
  const timeout = required('SELFHOSTED_AUTH_WORKER_TIMEOUT_MS');
  if (!/^[1-9][0-9]*$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 300000) {
    throw new Error('SELFHOSTED_AUTH_WORKER_TIMEOUT_MS must be an integer from 1000 through 300000');
  }
  selfHostedAuthWorker = {
    SELFHOSTED_AUTH_WORKER_URL: workerOrigin,
    SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE: workerOrigin,
    SELFHOSTED_AUTH_WORKER_TIMEOUT_MS: timeout,
  };
} else if (selfHostedAuthEnabled !== 'false') {
  throw new Error('SELFHOSTED_AUTH_ENABLED must be false for Apify paid collection');
}

const runtime = {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  GOOGLE_CLOUD_PROJECT: project,
  GOOGLE_CLOUD_LOCATION: location,
  ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: bucket,
  ANALYSIS_V2_APIFY_API_TOKEN_SLOT: slot,
  PREFLIGHT_APIFY_API_TOKEN_SLOTS: preflightApifyTokenSlots,
  ANALYSIS_V2_INSTAGRAM_ROUTE: instagramRoute,
  ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: authorizedTestShardingEnabled,
  BETATEST_FREE_POOL_ENABLED: betaFreePoolEnabled,
  BETATEST_FREE_POOL_MAX_SNAPSHOT_AGE_SECONDS: betaFreePoolMaxSnapshotAgeSeconds,
  BETATEST_FREE_POOL_REFRESH_INTERVAL_SECONDS: betaFreePoolRefreshIntervalSeconds,
  SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED: globalGateEnabled,
  SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS: globalMinIntervalMs,
  SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS: globalResponseGuardMs,
  SELFHOSTED_AUTH_ENABLED: selfHostedAuthEnabled,
  ...selfHostedAuthWorker,
  SCRAPER_PROFILE: 'selfhosted',
  SCRAPER_PROFILES_BATCH: 'selfhosted',
  SCRAPER_FOLLOWERS: scraperFollowers,
  SCRAPER_FOLLOWING: scraperFollowing,
  SCRAPER_LIKERS: scraperLikers,
  SCRAPER_COMMENTS: scraperComments,
  SCRAPER_FALLBACK: scraperFallback,
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
