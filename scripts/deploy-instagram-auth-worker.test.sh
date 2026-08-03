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

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -F -- "$unexpected" "$file" >/dev/null; then
    fail "expected $file not to contain: $unexpected"
  fi
}

mkdir -p "$temp_dir/bin"
cat >"$temp_dir/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_GCLOUD_LOG:?}"

case "$*" in
  "compute routers describe "*)
    case "$*" in
      *"--format=value(network)"*)
        printf 'https://www.googleapis.com/compute/v1/projects/test-project/global/networks/%s\n' "${FAKE_ROUTER_NETWORK:-instagram-egress}"
        ;;
      *"--format=value(region)"*)
        printf 'https://www.googleapis.com/compute/v1/projects/test-project/regions/%s\n' "${FAKE_ROUTER_REGION:-asia-northeast3}"
        ;;
      *) exit 91 ;;
    esac
    ;;
  "compute networks subnets describe "*)
    case "$*" in
      *"--format=value(network)"*)
        printf 'https://www.googleapis.com/compute/v1/projects/test-project/global/networks/%s\n' "${FAKE_SUBNET_NETWORK:-instagram-egress}"
        ;;
      *"--format=value(region)"*)
        printf 'https://www.googleapis.com/compute/v1/projects/test-project/regions/%s\n' "${FAKE_SUBNET_REGION:-asia-northeast3}"
        ;;
      *) exit 92 ;;
    esac
    ;;
  "compute routers nats describe "*)
    case "$*" in
      *"--format=value(natIpAllocateOption)"*) printf '%s\n' "${FAKE_NAT_ALLOCATION:-MANUAL_ONLY}" ;;
      *"--format=value(sourceSubnetworkIpRangesToNat)"*) printf '%s\n' "${FAKE_NAT_SUBNET_MODE:-LIST_OF_SUBNETWORKS}" ;;
      *"--format=value(natIps)"*) printf '%s\n' "${FAKE_NAT_IPS:-https://www.googleapis.com/compute/v1/projects/test-project/regions/asia-northeast3/addresses/instagram-egress-ip}" ;;
      *"--format=value(subnetworks.name)"*) printf 'https://www.googleapis.com/compute/v1/projects/test-project/regions/asia-northeast3/subnetworks/%s\n' "${FAKE_NAT_SUBNET:-instagram-egress-seoul}" ;;
      *) exit 93 ;;
    esac
    ;;
  "compute addresses describe "*)
    case "$*" in
      *"--format=value(addressType)"*) printf '%s\n' "${FAKE_ADDRESS_TYPE:-EXTERNAL}" ;;
      *"--format=value(selfLink)"*) printf 'https://www.googleapis.com/compute/v1/projects/test-project/regions/asia-northeast3/addresses/%s\n' "${FAKE_ADDRESS_NAME:-instagram-egress-ip}" ;;
      *) exit 94 ;;
    esac
    ;;
  *)
    printf 'unexpected fake gcloud command: %s\n' "$*" >&2
    exit 95
    ;;
esac
EOF
chmod +x "$temp_dir/bin/gcloud"

deploy_with_fake() {
  env \
    PATH="$temp_dir/bin:$PATH" \
    FAKE_GCLOUD_LOG="$temp_dir/gcloud.log" \
    INSTAGRAM_AUTH_WORKER_PROJECT=test-project \
    INSTAGRAM_AUTH_WORKER_REGION=asia-northeast3 \
    INSTAGRAM_AUTH_WORKER_SERVICE=instagram-auth-worker \
    INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@test-project.iam.gserviceaccount.com \
    INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@test-project.iam.gserviceaccount.com \
    INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress \
    INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul \
    INSTAGRAM_AUTH_WORKER_NAT_ROUTER=instagram-egress-router \
    INSTAGRAM_AUTH_WORKER_NAT_CONFIG=instagram-egress-nat \
    INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP=instagram-egress-ip \
    INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID=instagram-auth-session-settings \
    INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7 \
    INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET=instagram-auth-worker-state-test \
    INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX=instagram-auth-worker \
    "$@" \
    bash "$script" --dry-run
}

if ! deploy_with_fake >"$temp_dir/dry-run.out" 2>&1; then
  cat "$temp_dir/dry-run.out" >&2
  fail 'valid fixed-egress deployment preflight was rejected'
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
assert_contains "$temp_dir/dry-run.out" 'gcloud secrets add-iam-policy-binding instagram-auth-session-settings'
assert_contains "$temp_dir/dry-run.out" '--role=roles/secretmanager.secretAccessor'
assert_contains "$temp_dir/dry-run.out" 'gcloud run services add-iam-policy-binding instagram-auth-worker'
assert_contains "$temp_dir/dry-run.out" '--member=serviceAccount:analysis-worker@test-project.iam.gserviceaccount.com'
assert_contains "$temp_dir/dry-run.out" '--role=roles/run.invoker'
assert_not_contains "$temp_dir/gcloud.log" 'secrets versions access'
assert_contains "$temp_dir/gcloud.log" 'compute routers describe instagram-egress-router'
assert_contains "$temp_dir/gcloud.log" 'compute routers nats describe instagram-egress-nat'
assert_contains "$temp_dir/gcloud.log" 'compute addresses describe instagram-egress-ip'

if deploy_with_fake FAKE_NAT_IPS=not-a-compute-address >"$temp_dir/malformed-egress.out" 2>&1; then
  fail 'malformed NAT static IP reference was accepted'
fi
assert_contains "$temp_dir/malformed-egress.out" 'NAT configuration must reference exactly the configured reserved static IP'

if deploy_with_fake FAKE_NAT_ALLOCATION=AUTO_ONLY >"$temp_dir/dynamic-egress.out" 2>&1; then
  fail 'dynamic NAT allocation was accepted'
fi
assert_contains "$temp_dir/dynamic-egress.out" 'NAT configuration must use MANUAL_ONLY IP allocation'

if deploy_with_fake FAKE_NAT_IPS='https://www.googleapis.com/compute/v1/projects/test-project/regions/asia-northeast3/addresses/instagram-egress-ip;https://www.googleapis.com/compute/v1/projects/test-project/regions/asia-northeast3/addresses/second-ip' >"$temp_dir/multiple-ip.out" 2>&1; then
  fail 'multiple NAT static IPs were accepted'
fi
assert_contains "$temp_dir/multiple-ip.out" 'NAT configuration must reference exactly one static IP'

if deploy_with_fake FAKE_NAT_SUBNET=wrong-subnet >"$temp_dir/wrong-subnet.out" 2>&1; then
  fail 'NAT configuration for a different subnet was accepted'
fi
assert_contains "$temp_dir/wrong-subnet.out" 'NAT configuration does not include INSTAGRAM_AUTH_WORKER_SUBNET'

if deploy_with_fake INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=latest >"$temp_dir/latest.out" 2>&1; then
  fail 'mutable Secret Manager version was accepted'
fi
assert_contains "$temp_dir/latest.out" 'INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION must be a positive numeric Secret Manager version'

if deploy_with_fake INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET='Invalid Bucket' >"$temp_dir/invalid-bucket.out" 2>&1; then
  fail 'malformed durable-store bucket was accepted'
fi
assert_contains "$temp_dir/invalid-bucket.out" 'INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is invalid'

printf 'PASS: deploy-instagram-auth-worker script contract\n'
