#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap '
  if [[ "${KEEP_TEST_ARTIFACTS:-0}" == "1" ]]; then
    printf "WIF test artifacts retained at %s\n" "$temp_dir" >&2
  else
    rm -rf "$temp_dir"
  fi
' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq -- "$expected" "$file" \
    || fail "$file does not contain: $expected"
}

assert_not_contains() {
  local file="$1"
  local unexpected="$2"
  if grep -Fq -- "$unexpected" "$file"; then
    fail "$file unexpectedly contains: $unexpected"
  fi
}

mkdir -p "$temp_dir/bin"
cat >"$temp_dir/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

scenario="${FAKE_GCLOUD_SCENARIO:-ready}"
state_dir="${FAKE_GCLOUD_STATE_DIR:?}"
mutation_log="${FAKE_GCLOUD_MUTATION_LOG:?}"
mkdir -p "$state_dir"
command_line="$*"

is_mutation="false"
case "$command_line" in
  services\ enable*|iam\ workload-identity-pools\ create*|iam\ workload-identity-pools\ update*|iam\ workload-identity-pools\ providers\ create-oidc*|iam\ workload-identity-pools\ providers\ update-oidc*|iam\ service-accounts\ add-iam-policy-binding*)
    is_mutation="true"
    printf '%s\n' "$command_line" >>"$mutation_log"
    ;;
esac

if [[ "$1 $2" == "auth list" ]]; then
  printf 'operator@example.com\n'
  exit 0
fi

if [[ "$1 $2" == "projects describe" ]]; then
  if [[ "$scenario" == "wrong_project_number" ]]; then
    printf '999999999999\n'
  else
    printf '123456789012\n'
  fi
  exit 0
fi

if [[ "$1 $2" == "services list" ]]; then
  api=""
  for arg in "$@"; do
    [[ "$arg" == --filter=config.name=* ]] \
      && api="${arg#--filter=config.name=}"
  done
  if [[ "$scenario" != "missing" || -f "$state_dir/api-$api" ]]; then
    printf '%s\n' "$api"
  fi
  exit 0
fi

if [[ "$1 $2" == "services enable" ]]; then
  touch "$state_dir/api-$3"
  exit 0
fi

if [[ "$1 $2 $3" == "iam service-accounts describe" ]]; then
  [[ "$scenario" != "missing_enqueuer" ]] || exit 1
  printf '{"email":"analysis-v2-enqueuer@example-project.iam.gserviceaccount.com","disabled":false}\n'
  exit 0
fi

if [[ "$1 $2 $3 $4" == "iam service-accounts keys list" ]]; then
  if [[ "$scenario" == "keyed" ]]; then
    printf 'projects/example-project/serviceAccounts/enqueuer/keys/user-key\n'
  fi
  exit 0
fi

if [[ "$1 $2" == "projects get-iam-policy" ]]; then
  if [[ "$scenario" == "broad" ]]; then
    printf 'roles/cloudtasks.enqueuer\n'
  fi
  exit 0
fi

pool_json() {
  if [[ "$scenario" == "disabled_pool" && ! -f "$state_dir/pool-ready" ]]; then
    printf '{"state":"ACTIVE","disabled":true}\n'
  else
    printf '{"state":"ACTIVE","disabled":false}\n'
  fi
}

provider_json() {
  local issuer="https://oidc.vercel.com/test-team"
  local condition="assertion.owner_id=='team_12345678abc'&&assertion.project_id=='prj_12345678abc'&&assertion.environment=='production'"
  local jwks=""
  if [[ "$scenario" == "provider_drift" && ! -f "$state_dir/provider-ready" ]]; then
    issuer="https://oidc.vercel.com/wrong-team"
  fi
  if [[ "$scenario" == "jwks" ]]; then
    jwks='{"keys":[]}'
  fi
  jq -cn \
    --arg issuer "$issuer" \
    --arg condition "$condition" \
    --arg jwks "$jwks" '{
      state: "ACTIVE",
      disabled: false,
      oidc: {
        issuerUri: $issuer,
        allowedAudiences: [],
        jwksJson: $jwks
      },
      attributeCondition: $condition,
      attributeMapping: {
        "google.subject": "assertion.project_id+\u0027:\u0027+assertion.environment",
        "attribute.owner_id": "assertion.owner_id",
        "attribute.project_id": "assertion.project_id",
        "attribute.environment": "assertion.environment"
      }
    }'
}

if [[ "$1 $2 $3" == "iam workload-identity-pools describe" ]]; then
  if [[ "$scenario" == "missing" && ! -f "$state_dir/pool-ready" ]]; then
    exit 1
  fi
  pool_json
  exit 0
fi

if [[ "$1 $2 $3" == "iam workload-identity-pools create" \
  || "$1 $2 $3" == "iam workload-identity-pools update" ]]; then
  touch "$state_dir/pool-ready"
  exit 0
fi

if [[ "$1 $2 $3 $4" == "iam workload-identity-pools providers describe" ]]; then
  if [[ "$scenario" == "missing" && ! -f "$state_dir/provider-ready" ]]; then
    exit 1
  fi
  [[ "$scenario" != "configured_deleted" ]] || exit 1
  provider_json
  exit 0
fi

if [[ "$1 $2 $3 $4" == "iam workload-identity-pools providers list" ]]; then
  expected="projects/123456789012/locations/global/workloadIdentityPools/vercel-production/providers/ai-baram-detector"
  if [[ "$scenario" == "missing" && ! -f "$state_dir/provider-ready" ]]; then
    printf '[]\n'
  elif [[ "$scenario" == "extra_provider" ]]; then
    jq -cn --arg expected "$expected" '[
      {name: $expected, state: "ACTIVE"},
      {name: "projects/123456789012/locations/global/workloadIdentityPools/vercel-production/providers/unexpected", state: "ACTIVE"}
    ]'
  elif [[ "$scenario" == "deleted_extra_provider" ]]; then
    jq -cn --arg expected "$expected" '[
      {name: $expected, state: "ACTIVE"},
      {name: "projects/123456789012/locations/global/workloadIdentityPools/vercel-production/providers/deleted", state: "DELETED"}
    ]'
  elif [[ "$scenario" == "configured_deleted" ]]; then
    jq -cn --arg expected "$expected" '[{name: $expected, state: "DELETED"}]'
  else
    jq -cn --arg expected "$expected" '[{name: $expected, state: "ACTIVE"}]'
  fi
  exit 0
fi

if [[ "$1 $2 $3 $4" == "iam workload-identity-pools providers create-oidc" \
  || "$1 $2 $3 $4" == "iam workload-identity-pools providers update-oidc" ]]; then
  touch "$state_dir/provider-ready"
  exit 0
fi

if [[ "$1 $2 $3" == "iam service-accounts get-iam-policy" ]]; then
  member="principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-production/subject/prj_12345678abc:production"
  if [[ "$scenario" == "extra_principal" ]]; then
    jq -cn --arg member "$member" '{
      version: 1,
      bindings: [{
        role: "roles/iam.workloadIdentityUser",
        members: [$member, "principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/vercel-production/subject/unexpected:production"]
      }]
    }'
  elif [[ "$scenario" == "token_creator" \
    || "$scenario" == "openid_token_creator" \
    || "$scenario" == "service_account_user" ]]; then
    extra_role=""
    case "$scenario" in
      token_creator) extra_role="roles/iam.serviceAccountTokenCreator" ;;
      openid_token_creator) extra_role="roles/iam.serviceAccountOpenIdTokenCreator" ;;
      service_account_user) extra_role="roles/iam.serviceAccountUser" ;;
    esac
    jq -cn --arg member "$member" --arg extra_role "$extra_role" '{
      version: 1,
      bindings: [
        {
          role: "roles/iam.workloadIdentityUser",
          members: [$member]
        },
        {
          role: $extra_role,
          members: ["user:unexpected@example.com"]
        }
      ]
    }'
  elif [[ "$scenario" != "missing" || -f "$state_dir/binding-ready" ]]; then
    jq -cn --arg member "$member" '{
      version: 1,
      bindings: [{
        role: "roles/iam.workloadIdentityUser",
        members: [$member]
      }]
    }'
  else
    printf '{"version":1,"bindings":[]}\n'
  fi
  exit 0
fi

if [[ "$1 $2 $3" == "iam service-accounts add-iam-policy-binding" ]]; then
  touch "$state_dir/binding-ready"
  exit 0
fi

if [[ "$is_mutation" == "true" ]]; then
  exit 0
fi
printf 'unhandled fake gcloud command: %s\n' "$command_line" >&2
exit 64
EOF
chmod +x "$temp_dir/bin/gcloud"

common_env=(
  "PATH=$temp_dir/bin:$PATH"
  "ANALYSIS_V2_TASKS_PROJECT=example-project"
  "ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=analysis-v2-enqueuer@example-project.iam.gserviceaccount.com"
  "GCP_VERCEL_WIF_PROVIDER_RESOURCE=projects/123456789012/locations/global/workloadIdentityPools/vercel-production/providers/ai-baram-detector"
  "VERCEL_OIDC_TEAM_SLUG=test-team"
  "VERCEL_OIDC_TEAM_ID=team_12345678abc"
  "VERCEL_OIDC_PROJECT_ID=prj_12345678abc"
)

run_script() {
  local scenario="$1"
  local state_dir="$2"
  local mutation_log="$3"
  local output="$4"
  shift 4
  mkdir -p "$state_dir"
  : >"$mutation_log"
  if ! env "${common_env[@]}" \
    "FAKE_GCLOUD_SCENARIO=$scenario" \
    "FAKE_GCLOUD_STATE_DIR=$state_dir" \
    "FAKE_GCLOUD_MUTATION_LOG=$mutation_log" \
    bash "$script_dir/configure-analysis-v2-vercel-wif.sh" "$@" \
    >"$output" 2>&1; then
    if [[ "${SHOW_EXPECTED_FAILURES:-0}" == "1" ]]; then
      printf '%s\n' "--- $scenario output ---" >&2
      sed 's/^/  /' "$output" >&2
    fi
    return 1
  fi
}

bash -n "$script_dir/configure-analysis-v2-vercel-wif.sh"

run_script missing \
  "$temp_dir/dry-state" \
  "$temp_dir/dry-mutations" \
  "$temp_dir/dry.out" \
  --dry-run
[[ ! -s "$temp_dir/dry-mutations" ]] \
  || fail "dry-run invoked a fake mutation"
assert_contains "$temp_dir/dry.out" "[dry-run] gcloud services enable"
assert_contains "$temp_dir/dry.out" "workload-identity-pools create"
assert_contains "$temp_dir/dry.out" "providers create-oidc"
assert_contains "$temp_dir/dry.out" "add-iam-policy-binding"
assert_contains "$temp_dir/dry.out" "dry-run complete: no mutations were applied"

run_script missing \
  "$temp_dir/apply-state" \
  "$temp_dir/apply-mutations" \
  "$temp_dir/apply.out"
assert_contains "$temp_dir/apply.out" \
  "Vercel production Workload Identity Federation configuration verified"
assert_contains "$temp_dir/apply-mutations" "services enable iam.googleapis.com"
assert_contains "$temp_dir/apply-mutations" "workload-identity-pools create vercel-production"
assert_contains "$temp_dir/apply-mutations" "providers create-oidc ai-baram-detector"
assert_contains "$temp_dir/apply-mutations" \
  "assertion.owner_id=='team_12345678abc'"
assert_contains "$temp_dir/apply-mutations" \
  "subject/prj_12345678abc:production"
assert_not_contains "$temp_dir/apply-mutations" "keys create"

run_script missing \
  "$temp_dir/apply-state" \
  "$temp_dir/recheck-mutations" \
  "$temp_dir/recheck.out" \
  --check
[[ ! -s "$temp_dir/recheck-mutations" ]] \
  || fail "idempotent check invoked a fake mutation"
assert_contains "$temp_dir/recheck.out" \
  "only the exact Vercel production subject can impersonate the enqueuer"

run_script ready \
  "$temp_dir/ready-state" \
  "$temp_dir/ready-mutations" \
  "$temp_dir/ready.out" \
  --check
[[ ! -s "$temp_dir/ready-mutations" ]] \
  || fail "ready check invoked a fake mutation"

if run_script provider_drift \
  "$temp_dir/drift-check-state" \
  "$temp_dir/drift-check-mutations" \
  "$temp_dir/drift-check.out" \
  --check; then
  fail "provider drift passed check mode"
fi
assert_contains "$temp_dir/drift-check.out" "provider configuration has drifted"

if run_script provider_drift \
  "$temp_dir/drift-apply-state" \
  "$temp_dir/drift-apply-mutations" \
  "$temp_dir/drift-apply.out"; then
  fail "provider drift was automatically reconciled"
fi
assert_contains "$temp_dir/drift-apply.out" "manual review is required"
assert_not_contains "$temp_dir/drift-apply-mutations" "providers update-oidc"

for scenario in extra_provider deleted_extra_provider; do
  if run_script "$scenario" \
    "$temp_dir/$scenario-state" \
    "$temp_dir/$scenario-mutations" \
    "$temp_dir/$scenario.out"; then
    fail "$scenario in the WIF pool was accepted"
  fi
  assert_contains "$temp_dir/$scenario.out" \
    "unexpected active, disabled, or soft-deleted provider"
  [[ ! -s "$temp_dir/$scenario-mutations" ]] \
    || fail "$scenario invoked a mutation"
done

if run_script configured_deleted \
  "$temp_dir/configured-deleted-state" \
  "$temp_dir/configured-deleted-mutations" \
  "$temp_dir/configured-deleted.out"; then
  fail "the configured soft-deleted WIF provider was accepted"
fi
assert_contains "$temp_dir/configured-deleted.out" \
  "configured workload identity provider is disabled or soft-deleted"
[[ ! -s "$temp_dir/configured-deleted-mutations" ]] \
  || fail "configured soft-deleted provider invoked a mutation"

if run_script extra_principal \
  "$temp_dir/extra-state" \
  "$temp_dir/extra-mutations" \
  "$temp_dir/extra.out"; then
  fail "unexpected WIF principal was accepted"
fi
assert_contains "$temp_dir/extra.out" \
  "unexpected service-account resource IAM bindings or principals"
assert_not_contains "$temp_dir/extra-mutations" \
  "add-iam-policy-binding"

for scenario in token_creator openid_token_creator service_account_user; do
  if run_script "$scenario" \
    "$temp_dir/$scenario-state" \
    "$temp_dir/$scenario-mutations" \
    "$temp_dir/$scenario.out"; then
    fail "$scenario service-account resource binding was accepted"
  fi
  assert_contains "$temp_dir/$scenario.out" \
    "unexpected service-account resource IAM bindings or principals"
  assert_not_contains "$temp_dir/$scenario-mutations" \
    "add-iam-policy-binding"
done

if run_script keyed \
  "$temp_dir/keyed-state" \
  "$temp_dir/keyed-mutations" \
  "$temp_dir/keyed.out" \
  --check; then
  fail "user-managed enqueuer key was accepted"
fi
assert_contains "$temp_dir/keyed.out" "user-managed credential key"

if run_script broad \
  "$temp_dir/broad-state" \
  "$temp_dir/broad-mutations" \
  "$temp_dir/broad.out" \
  --check; then
  fail "project-wide enqueuer role was accepted"
fi
assert_contains "$temp_dir/broad.out" "must have no project-wide role"

if run_script jwks \
  "$temp_dir/jwks-state" \
  "$temp_dir/jwks-mutations" \
  "$temp_dir/jwks.out"; then
  fail "uploaded provider JWKs were accepted"
fi
assert_contains "$temp_dir/jwks.out" "provider has uploaded JWKs"
assert_not_contains "$temp_dir/jwks-mutations" "providers update-oidc"

if run_script wrong_project_number \
  "$temp_dir/project-state" \
  "$temp_dir/project-mutations" \
  "$temp_dir/project.out" \
  --check; then
  fail "mismatched provider project number was accepted"
fi
assert_contains "$temp_dir/project.out" "project number does not match"
[[ ! -s "$temp_dir/project-mutations" ]] \
  || fail "project mismatch invoked a fake mutation"

printf 'Analysis V2 Vercel WIF infrastructure script tests passed\n'
