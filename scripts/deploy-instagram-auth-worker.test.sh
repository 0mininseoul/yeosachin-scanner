#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_dir/scripts/deploy-instagram-auth-worker.sh"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/instagram-auth-worker-deploy-test.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -F -- "$expected" "$file" >/dev/null \
    || fail "expected $file to contain: $expected"
}

if ! env \
  INSTAGRAM_AUTH_WORKER_PROJECT=test-project \
  INSTAGRAM_AUTH_WORKER_REGION=asia-northeast3 \
  INSTAGRAM_AUTH_WORKER_SERVICE=instagram-auth-worker \
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress \
  INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul \
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID=instagram-auth-session-settings \
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7 \
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET=instagram-auth-worker-state-test \
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX=instagram-auth-worker \
  bash "$script" --dry-run >"$temp_dir/dry-run.out" 2>&1; then
  cat "$temp_dir/dry-run.out" >&2
  fail 'valid private deployment preflight was rejected'
fi

assert_contains "$temp_dir/dry-run.out" 'gcloud run deploy instagram-auth-worker'
assert_contains "$temp_dir/dry-run.out" '--source='
assert_contains "$temp_dir/dry-run.out" '--service-account=instagram-auth-worker@test-project.iam.gserviceaccount.com'
assert_contains "$temp_dir/dry-run.out" '--concurrency=5'
assert_contains "$temp_dir/dry-run.out" '--max-instances=1'
assert_contains "$temp_dir/dry-run.out" '--min-instances=1'
assert_contains "$temp_dir/dry-run.out" '--timeout=300s'
assert_contains "$temp_dir/dry-run.out" '--no-allow-unauthenticated'
assert_contains "$temp_dir/dry-run.out" '--network=instagram-egress'
assert_contains "$temp_dir/dry-run.out" '--subnet=instagram-egress-seoul'
assert_contains "$temp_dir/dry-run.out" '--vpc-egress=all-traffic'
assert_contains "$temp_dir/dry-run.out" 'IG_DURABLE_STORE_BUCKET=instagram-auth-worker-state-test'
assert_contains "$temp_dir/dry-run.out" 'IG_DURABLE_STORE_PREFIX=instagram-auth-worker'
assert_contains "$temp_dir/dry-run.out" '--set-secrets=IG_SESSION_SETTINGS_BASE64=instagram-auth-session-settings:7'
assert_contains "$temp_dir/dry-run.out" 'gcloud storage buckets add-iam-policy-binding gs://instagram-auth-worker-state-test'
assert_contains "$temp_dir/dry-run.out" '--member=serviceAccount:instagram-auth-worker@test-project.iam.gserviceaccount.com'
assert_contains "$temp_dir/dry-run.out" '--role=roles/storage.objectUser'
assert_contains "$temp_dir/dry-run.out" 'gcloud run services add-iam-policy-binding instagram-auth-worker'
assert_contains "$temp_dir/dry-run.out" '--member=serviceAccount:analysis-worker@test-project.iam.gserviceaccount.com'
assert_contains "$temp_dir/dry-run.out" '--role=roles/run.invoker'
if env \
  INSTAGRAM_AUTH_WORKER_PROJECT=test-project \
  INSTAGRAM_AUTH_WORKER_REGION=asia-northeast3 \
  INSTAGRAM_AUTH_WORKER_SERVICE=instagram-auth-worker \
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress \
  INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul \
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=latest \
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET=instagram-auth-worker-state-test \
  bash "$script" --dry-run >"$temp_dir/latest.out" 2>&1; then
  fail 'mutable Secret Manager version was accepted'
fi
assert_contains "$temp_dir/latest.out" 'INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION must be a positive numeric Secret Manager version'

if env \
  INSTAGRAM_AUTH_WORKER_PROJECT=test-project \
  INSTAGRAM_AUTH_WORKER_REGION=asia-northeast3 \
  INSTAGRAM_AUTH_WORKER_SERVICE=instagram-auth-worker \
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress \
  INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul \
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7 \
  bash "$script" --dry-run >"$temp_dir/missing-bucket.out" 2>&1; then
  fail 'missing durable-store bucket was accepted'
fi
assert_contains "$temp_dir/missing-bucket.out" 'INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is required'

if env \
  INSTAGRAM_AUTH_WORKER_PROJECT=test-project \
  INSTAGRAM_AUTH_WORKER_REGION=asia-northeast3 \
  INSTAGRAM_AUTH_WORKER_SERVICE=instagram-auth-worker \
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@test-project.iam.gserviceaccount.com \
  INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress \
  INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul \
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7 \
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET='Invalid Bucket' \
  bash "$script" --dry-run >"$temp_dir/invalid-bucket.out" 2>&1; then
  fail 'malformed durable-store bucket was accepted'
fi
assert_contains "$temp_dir/invalid-bucket.out" 'INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is invalid'

printf 'PASS: deploy-instagram-auth-worker script contract\n'
