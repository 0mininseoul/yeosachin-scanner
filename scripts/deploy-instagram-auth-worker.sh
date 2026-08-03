#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_REGION="asia-northeast3"
readonly REQUIRED_SERVICE="instagram-auth-worker"
readonly DEFAULT_SESSION_SECRET_ID="instagram-auth-session-settings"
readonly DEFAULT_TIMEOUT_SECONDS="300"
readonly DEFAULT_CONCURRENCY="5"
readonly DEFAULT_MAX_INSTANCES="1"
readonly DEFAULT_MIN_INSTANCES="1"
readonly DEFAULT_DURABLE_STORE_PREFIX="instagram-auth-worker"
readonly DURABLE_STORE_OBJECT_ROLE="roles/storage.objectUser"

mode="apply"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-instagram-auth-worker.sh [--dry-run]

Source-deploys the private, single-instance Instagram authenticated worker.
It never reads or prints Secret Manager payloads. Session settings are supplied
only as a pinned Secret Manager reference.

Required environment variables:
  INSTAGRAM_AUTH_WORKER_PROJECT
  INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
  INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET
  INSTAGRAM_AUTH_WORKER_NETWORK
  INSTAGRAM_AUTH_WORKER_SUBNET
  INSTAGRAM_AUTH_WORKER_NAT_ROUTER
  INSTAGRAM_AUTH_WORKER_NAT_CONFIG
  INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP

Optional environment variables:
  INSTAGRAM_AUTH_WORKER_REGION                 Defaults to asia-northeast3; fixed.
  INSTAGRAM_AUTH_WORKER_SERVICE                Defaults to instagram-auth-worker; fixed.
  INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID      Defaults to instagram-auth-session-settings.
  INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX   Defaults to instagram-auth-worker.

The service always has exactly one warm instance, request concurrency 5, a
300-second timeout, and unauthenticated access disabled. The caller runtime service
account is granted roles/run.invoker on this service. The worker runtime service
account is granted bucket-scoped roles/storage.objectUser only on the configured
durable-state bucket and roles/secretmanager.secretAccessor only on the configured
session secret. Before any mutation, it verifies that the named router, subnet,
NAT configuration, and reserved static IP prove fixed egress. This script never
reads or prints secret payloads.
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

validate_project() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_PROJECT is invalid"
}

validate_service_account_email() {
  local email="$1"
  local label="$2"
  [[ "$email" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]] \
    || die "$label is invalid"
}

validate_secret_id() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID is invalid"
}

validate_secret_version() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION must be a positive numeric Secret Manager version"
}

validate_network_name() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] \
    || die "$label is invalid"
}

validate_compute_resource_name() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$ ]] \
    || die "$label is invalid"
}

validate_bucket_name() {
  local bucket="$1"
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is invalid"
  [[ "$bucket" != *..* && "$bucket" != *goog* ]] \
    || die "INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is invalid"
  [[ ! "$bucket" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET is invalid"
}

validate_durable_store_prefix() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ ]] \
    || die "INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX is invalid"
}

print_command() {
  local argument
  printf '[dry-run]'
  for argument in "$@"; do
    printf ' %q' "$argument"
  done
  printf '\n'
}

run_mutation() {
  if [[ "$mode" == "dry-run" ]]; then
    print_command "$@"
    return 0
  fi
  "$@"
}

expected_compute_resource_url() {
  local scope="$1"
  local resource_type="$2"
  local name="$3"
  printf 'https://www.googleapis.com/compute/v1/projects/%s/%s/%s/%s' \
    "$project" "$scope" "$resource_type" "$name"
}

read_gcloud_value() {
  local label="$1"
  shift
  local value
  if ! value="$(gcloud "$@")"; then
    die "could not verify $label"
  fi
  [[ -n "$value" && "$value" != *$'\n'* ]] \
    || die "could not verify $label"
  printf '%s' "$value"
}

verify_fixed_egress() {
  local expected_network_url expected_region_url expected_subnet_url expected_static_ip_url
  local router_network router_region subnet_network subnet_region nat_allocation nat_subnet_mode nat_ips nat_subnets static_ip_type static_ip_url

  expected_network_url="$(expected_compute_resource_url global networks "$network")"
  expected_region_url="https://www.googleapis.com/compute/v1/projects/$project/regions/$region"
  expected_subnet_url="$(expected_compute_resource_url "regions/$region" subnetworks "$subnet")"
  expected_static_ip_url="$(expected_compute_resource_url "regions/$region" addresses "$nat_static_ip")"

  router_network="$(read_gcloud_value 'NAT router network' compute routers describe "$nat_router" \
    "--project=$project" "--region=$region" '--format=value(network)')"
  [[ "$router_network" == "$expected_network_url" ]] \
    || die "NAT router network does not match INSTAGRAM_AUTH_WORKER_NETWORK"

  router_region="$(read_gcloud_value 'NAT router region' compute routers describe "$nat_router" \
    "--project=$project" "--region=$region" '--format=value(region)')"
  [[ "$router_region" == "$expected_region_url" ]] \
    || die "NAT router region does not match INSTAGRAM_AUTH_WORKER_REGION"

  subnet_network="$(read_gcloud_value 'worker subnet network' compute networks subnets describe "$subnet" \
    "--project=$project" "--region=$region" '--format=value(network)')"
  [[ "$subnet_network" == "$expected_network_url" ]] \
    || die "worker subnet network does not match INSTAGRAM_AUTH_WORKER_NETWORK"

  subnet_region="$(read_gcloud_value 'worker subnet region' compute networks subnets describe "$subnet" \
    "--project=$project" "--region=$region" '--format=value(region)')"
  [[ "$subnet_region" == "$expected_region_url" ]] \
    || die "worker subnet region does not match INSTAGRAM_AUTH_WORKER_REGION"

  nat_allocation="$(read_gcloud_value 'NAT IP allocation' compute routers nats describe "$nat_config" \
    "--router=$nat_router" "--project=$project" "--region=$region" '--format=value(natIpAllocateOption)')"
  [[ "$nat_allocation" == 'MANUAL_ONLY' ]] \
    || die "NAT configuration must use MANUAL_ONLY IP allocation"

  nat_subnet_mode="$(read_gcloud_value 'NAT subnet mode' compute routers nats describe "$nat_config" \
    "--router=$nat_router" "--project=$project" "--region=$region" '--format=value(sourceSubnetworkIpRangesToNat)')"
  [[ "$nat_subnet_mode" == 'LIST_OF_SUBNETWORKS' ]] \
    || die "NAT configuration must explicitly include INSTAGRAM_AUTH_WORKER_SUBNET"

  nat_subnets="$(read_gcloud_value 'NAT subnet list' compute routers nats describe "$nat_config" \
    "--router=$nat_router" "--project=$project" "--region=$region" '--format=value(subnetworks.name)')"
  case "$nat_subnets" in
    "$expected_subnet_url"|"$expected_subnet_url;"*|*";$expected_subnet_url"|*";$expected_subnet_url;"*|"$expected_subnet_url,"*|*",$expected_subnet_url"|*",$expected_subnet_url,"*) ;;
    *) die "NAT configuration does not include INSTAGRAM_AUTH_WORKER_SUBNET" ;;
  esac

  nat_ips="$(read_gcloud_value 'NAT static IPs' compute routers nats describe "$nat_config" \
    "--router=$nat_router" "--project=$project" "--region=$region" '--format=value(natIps)')"
  [[ "$nat_ips" != *';'* && "$nat_ips" != *','* && "$nat_ips" != *' '* ]] \
    || die "NAT configuration must reference exactly one static IP"

  static_ip_type="$(read_gcloud_value 'reserved static IP type' compute addresses describe "$nat_static_ip" \
    "--project=$project" "--region=$region" '--format=value(addressType)')"
  [[ "$static_ip_type" == 'EXTERNAL' ]] \
    || die "configured NAT static IP must be an EXTERNAL reserved address"

  static_ip_url="$(read_gcloud_value 'reserved static IP' compute addresses describe "$nat_static_ip" \
    "--project=$project" "--region=$region" '--format=value(selfLink)')"
  [[ "$static_ip_url" == "$expected_static_ip_url" ]] \
    || die "could not verify configured reserved static IP"
  [[ "$nat_ips" == "$static_ip_url" ]] \
    || die "NAT configuration must reference exactly the configured reserved static IP"
}

while (($# > 0)); do
  case "$1" in
    --dry-run) mode="dry-run" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

required_env INSTAGRAM_AUTH_WORKER_PROJECT
required_env INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL
required_env INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL
required_env INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION
required_env INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET
required_env INSTAGRAM_AUTH_WORKER_NETWORK
required_env INSTAGRAM_AUTH_WORKER_SUBNET
required_env INSTAGRAM_AUTH_WORKER_NAT_ROUTER
required_env INSTAGRAM_AUTH_WORKER_NAT_CONFIG
required_env INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP

project="$INSTAGRAM_AUTH_WORKER_PROJECT"
region="${INSTAGRAM_AUTH_WORKER_REGION:-$REQUIRED_REGION}"
service="${INSTAGRAM_AUTH_WORKER_SERVICE:-$REQUIRED_SERVICE}"
runtime_service_account="$INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
caller_service_account="$INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL"
session_secret_id="${INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID:-$DEFAULT_SESSION_SECRET_ID}"
session_secret_version="$INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION"
durable_store_bucket="$INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET"
durable_store_prefix="${INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX:-$DEFAULT_DURABLE_STORE_PREFIX}"
network="$INSTAGRAM_AUTH_WORKER_NETWORK"
subnet="$INSTAGRAM_AUTH_WORKER_SUBNET"
nat_router="$INSTAGRAM_AUTH_WORKER_NAT_ROUTER"
nat_config="$INSTAGRAM_AUTH_WORKER_NAT_CONFIG"
nat_static_ip="$INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_dir/services/instagram-auth-worker"

validate_project "$project"
[[ "$region" == "$REQUIRED_REGION" ]] \
  || die "INSTAGRAM_AUTH_WORKER_REGION must be $REQUIRED_REGION"
[[ "$service" == "$REQUIRED_SERVICE" ]] \
  || die "INSTAGRAM_AUTH_WORKER_SERVICE must remain $REQUIRED_SERVICE"
validate_service_account_email "$runtime_service_account" \
  "INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL"
validate_service_account_email "$caller_service_account" \
  "INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL"
validate_secret_id "$session_secret_id"
validate_secret_version "$session_secret_version"
validate_bucket_name "$durable_store_bucket"
validate_durable_store_prefix "$durable_store_prefix"
validate_network_name "$network" "INSTAGRAM_AUTH_WORKER_NETWORK"
validate_network_name "$subnet" "INSTAGRAM_AUTH_WORKER_SUBNET"
validate_compute_resource_name "$nat_router" "INSTAGRAM_AUTH_WORKER_NAT_ROUTER"
validate_compute_resource_name "$nat_config" "INSTAGRAM_AUTH_WORKER_NAT_CONFIG"
validate_compute_resource_name "$nat_static_ip" "INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP"
[[ -f "$source_dir/requirements.txt" && -f "$source_dir/app/main.py" ]] \
  || die "instagram authenticated worker source is incomplete"

command -v gcloud >/dev/null 2>&1 || die "gcloud CLI is required"
verify_fixed_egress

run_mutation gcloud secrets add-iam-policy-binding "$session_secret_id" \
  "--project=$project" \
  "--member=serviceAccount:$runtime_service_account" \
  "--role=roles/secretmanager.secretAccessor" \
  --quiet

run_mutation gcloud storage buckets add-iam-policy-binding "gs://$durable_store_bucket" \
  "--project=$project" \
  "--member=serviceAccount:$runtime_service_account" \
  "--role=$DURABLE_STORE_OBJECT_ROLE" \
  --quiet

run_mutation gcloud run deploy "$service" \
  "--project=$project" \
  "--region=$region" \
  "--source=$source_dir" \
  "--service-account=$runtime_service_account" \
  "--port=8080" \
  "--command=uvicorn" \
  "--args=app.main:app,--host=0.0.0.0,--port=8080" \
  "--concurrency=$DEFAULT_CONCURRENCY" \
  "--max-instances=$DEFAULT_MAX_INSTANCES" \
  "--min-instances=$DEFAULT_MIN_INSTANCES" \
  "--timeout=${DEFAULT_TIMEOUT_SECONDS}s" \
  "--no-allow-unauthenticated" \
  "--network=$network" \
  "--subnet=$subnet" \
  "--vpc-egress=all-traffic" \
  "--set-env-vars=IG_MAX_IN_FLIGHT=5,IG_QUEUE_TIMEOUT_SECONDS=240,IG_RATE_LIMIT_COOLDOWN_SECONDS=900,IG_DURABLE_STORE_BUCKET=$durable_store_bucket,IG_DURABLE_STORE_PREFIX=$durable_store_prefix" \
  "--set-secrets=IG_SESSION_SETTINGS_BASE64=$session_secret_id:$session_secret_version" \
  --quiet

run_mutation gcloud run services add-iam-policy-binding "$service" \
  "--project=$project" \
  "--region=$region" \
  "--member=serviceAccount:$caller_service_account" \
  "--role=roles/run.invoker" \
  --quiet

printf 'configured private authenticated Instagram worker service %s\n' "$service"
