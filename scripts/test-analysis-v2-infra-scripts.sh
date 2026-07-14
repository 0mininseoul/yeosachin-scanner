#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "$0")" && pwd)"
readonly temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/analysis-v2-infra-test.XXXXXX")"

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

fail() {
  printf 'test failure: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  if ! LC_ALL=C grep -Fq -- "$expected" "$file"; then
    sed -n '1,160p' "$file" >&2
    fail "expected output to contain: $expected"
  fi
}

assert_not_contains() {
  local file="$1"
  local rejected="$2"
  ! LC_ALL=C grep -Fq -- "$rejected" "$file" \
    || fail "output exposed rejected content: $rejected"
}

mkdir -p "$temp_dir/bin"
cat >"$temp_dir/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command_line="$*"
state="${FAKE_GCLOUD_STATE:-missing}"
if [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" \
  && -f "$FAKE_GCLOUD_STATE_FILE" ]]; then
  state="$(<"$FAKE_GCLOUD_STATE_FILE")"
fi
identity_ready="false"
vertex_ready="false"
build_identity_ready="false"
build_role_ready="false"
runtime_operator_ready="false"
build_operator_ready="false"
enqueuer_identity_ready="false"
bucket_ready="false"
infra_ready="false"
case "$state" in
  runtime_account_created)
    identity_ready="true"
    ;;
  runtime_ready)
    identity_ready="true"
    vertex_ready="true"
    ;;
  build_account_created)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    ;;
  build_role_ready)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    ;;
  runtime_operator_ready)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    ;;
  build_operator_ready_state)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    ;;
  identity_ready)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    ;;
  ready)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    bucket_ready="true"
    infra_ready="true"
    ;;
  prerequisites_ready)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    bucket_ready="true"
    ;;
  bucket_legacy|bucket_exact|bucket_retention|bucket_requester_pays)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    bucket_ready="true"
    ;;
  broad|storage_broad|secret_broad|vertex_admin|keyed|build_broad|build_keyed|enqueuer_broad|enqueuer_keyed|failed_latest|old_traffic|runtime_env_drift|runtime_admission_env|runtime_legacy_gate_env|credential_override|credential_key_base64|plaintext_secret|secret_ref_drift|slot_drift|runtime_sidecar|runtime_placement|runtime_duplicate_env)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    if [[ "$state" == "failed_latest" || "$state" == "old_traffic" \
      || "$state" == "runtime_env_drift" || "$state" == "credential_override" \
      || "$state" == "credential_key_base64" || "$state" == "plaintext_secret" \
      || "$state" == "secret_ref_drift" || "$state" == "slot_drift" \
      || "$state" == "runtime_sidecar" || "$state" == "runtime_placement" \
      || "$state" == "runtime_duplicate_env" || "$state" == "runtime_admission_env" \
      || "$state" == "runtime_legacy_gate_env" ]]; then
      bucket_ready="true"
      infra_ready="true"
    fi
    ;;
esac

case "$command_line" in
  "auth list"*)
    printf 'operator@example.test\n'
    ;;
  "projects describe"*)
    printf '123456789012\n'
    ;;
  "projects get-iam-policy"*)
    filter=""
    for argument in "$@"; do
      [[ "$argument" == --filter=* ]] && filter="${argument#--filter=}"
    done
    if [[ "$command_line" == *"format=value(bindings.role)"* ]]; then
      if [[ "$identity_ready" == "true" \
        && "$filter" == *"analysis-recovery@test-project.iam.gserviceaccount.com"* ]]; then
        if [[ "$vertex_ready" == "true" ]]; then
          printf '%s\n' 'roles/aiplatform.user'
        fi
        [[ "$state" != "broad" ]] || printf 'roles/editor\n'
        [[ "$state" != "storage_broad" ]] || printf 'roles/storage.admin\n'
        [[ "$state" != "secret_broad" ]] || printf 'roles/secretmanager.secretAccessor\n'
        [[ "$state" != "vertex_admin" ]] || printf 'roles/aiplatform.admin\n'
      elif [[ "$build_identity_ready" == "true" \
        && "$filter" == *"analysis-build@test-project.iam.gserviceaccount.com"* ]]; then
        [[ "$build_role_ready" != "true" ]] || printf 'roles/run.builder\n'
        [[ "$state" != "build_broad" ]] || printf 'roles/editor\n'
      elif [[ "$enqueuer_identity_ready" == "true" \
        && "$filter" == *"runtime-user@test-project.iam.gserviceaccount.com"* ]]; then
        [[ "$state" != "enqueuer_broad" ]] || printf 'roles/cloudtasks.enqueuer\n'
      elif [[ "$filter" == *"analysis-task@test-project.iam.gserviceaccount.com"* \
        && "${FAKE_GCLOUD_TASK_PROJECT_ROLE:-false}" == "true" ]]; then
        printf 'roles/editor\n'
      fi
    elif [[ "$command_line" == *"format=csv"* ]]; then
      role="${filter#bindings.role=}"
      role="${role%% AND*}"
      member="${filter##*bindings.members=}"
      if [[ "$role" == "roles/aiplatform.user" \
        && "$member" == "serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com" \
        && "$vertex_ready" == "true" ]]; then
        printf '%s,%s,\n' "$role" "$member"
      elif [[ "$role" == "roles/run.builder" \
        && "$member" == "serviceAccount:analysis-build@test-project.iam.gserviceaccount.com" \
        && "$build_role_ready" == "true" ]]; then
        printf '%s,%s,\n' "$role" "$member"
      elif [[ "$role" == "roles/cloudtasks.serviceAgent" \
        && "$infra_ready" == "true" ]]; then
        printf '%s,%s,\n' "$role" "$member"
      elif [[ "$member" == "serviceAccount:runtime-user@test-project.iam.gserviceaccount.com" \
        && "${FAKE_GCLOUD_PROJECT_ENQUEUER_BROAD:-false}" == "true" \
        && "$role" == "roles/cloudtasks.enqueuer" ]]; then
        printf '%s,%s,\n' "$role" "$member"
      elif [[ "$member" == "serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com" \
        && "${FAKE_GCLOUD_PROJECT_RECOVERY_BROAD:-false}" == "true" \
        && ( "$role" == "roles/cloudtasks.enqueuer" \
          || "$role" == "roles/cloudtasks.viewer" ) ]]; then
        printf '%s,%s,\n' "$role" "$member"
      fi
    fi
    ;;
  "iam service-accounts describe"*)
    email=""
    for argument in "$@"; do
      [[ "$argument" == *@*.iam.gserviceaccount.com ]] && email="$argument"
    done
    if [[ "$email" == "analysis-recovery@test-project.iam.gserviceaccount.com" \
      && "$identity_ready" != "true" ]]; then
      exit 1
    elif [[ "$email" == "analysis-build@test-project.iam.gserviceaccount.com" \
      && "$build_identity_ready" != "true" ]]; then
      exit 1
    elif [[ "$email" == "runtime-user@test-project.iam.gserviceaccount.com" \
      && "$enqueuer_identity_ready" != "true" ]]; then
      exit 1
    elif [[ ( "$email" == "analysis-task@test-project.iam.gserviceaccount.com" \
        || "$email" == "analysis-maintenance@test-project.iam.gserviceaccount.com" ) \
      && "$identity_ready" != "true" ]]; then
      exit 1
    elif [[ "$command_line" == *"format=json"* ]]; then
      printf '{"email":"%s","disabled":false}\n' "$email"
    elif [[ "$command_line" == *"value(email)"* ]]; then
      printf '%s\n' "$email"
    else
      printf 'false\n'
    fi
    ;;
  "iam service-accounts create"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] \
      || exit 90
    if [[ "$command_line" == *" analysis-recovery "* ]]; then
      printf 'runtime_account_created\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$command_line" == *" analysis-build "* ]]; then
      printf 'build_account_created\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$command_line" == *" runtime-user "* ]]; then
      printf 'identity_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$command_line" == *" analysis-task "* \
      || "$command_line" == *" analysis-maintenance "* ]]; then
      printf 'identity_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      exit 90
    fi
    ;;
  "iam service-accounts keys list"*)
    if [[ "$state" == "keyed" \
      && "$command_line" == *"analysis-recovery"* ]]; then
      printf 'projects/test-project/serviceAccounts/runtime/keys/user-key\n'
    elif [[ "$state" == "build_keyed" \
      && "$command_line" == *"analysis-build"* ]]; then
      printf 'projects/test-project/serviceAccounts/build/keys/user-key\n'
    elif [[ "$state" == "enqueuer_keyed" \
      && "$command_line" == *"runtime-user"* ]]; then
      printf 'projects/test-project/serviceAccounts/enqueuer/keys/user-key\n'
    elif [[ "${FAKE_GCLOUD_TASK_KEYED:-false}" == "true" \
      && "$command_line" == *"analysis-task"* ]]; then
      printf 'projects/test-project/serviceAccounts/task/keys/user-key\n'
    fi
    ;;
  "iam service-accounts list"*)
    if [[ "$infra_ready" == "true" ]]; then
      printf '%s\n' \
        'analysis-task@test-project.iam.gserviceaccount.com' \
        'runtime-user@test-project.iam.gserviceaccount.com' \
        'analysis-recovery@test-project.iam.gserviceaccount.com' \
        'analysis-build@test-project.iam.gserviceaccount.com'
    fi
    ;;
  "iam service-accounts get-iam-policy"*)
    target_account="$4"
    if [[ "$command_line" == *"format=json"* ]]; then
      if [[ "$target_account" == "analysis-recovery@test-project.iam.gserviceaccount.com" \
        || "$target_account" == "analysis-build@test-project.iam.gserviceaccount.com" \
        || "$target_account" == "analysis-maintenance@test-project.iam.gserviceaccount.com" ]]; then
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/iam.serviceAccountUser","members":["user:operator@example.test"]}]}'
      elif [[ "$target_account" == "analysis-task@test-project.iam.gserviceaccount.com" \
        && "$infra_ready" == "true" ]]; then
        if [[ "${FAKE_GCLOUD_TASK_IAM_EXTRA:-false}" == "true" ]]; then
          printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/iam.serviceAccountUser","members":["serviceAccount:runtime-user@test-project.iam.gserviceaccount.com","serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com","serviceAccount:service-123456789012@gcp-sa-cloudtasks.iam.gserviceaccount.com"]},{"role":"roles/iam.serviceAccountTokenCreator","members":["serviceAccount:legacy-runtime@test-project.iam.gserviceaccount.com"]}]}'
        else
          printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/iam.serviceAccountUser","members":["serviceAccount:runtime-user@test-project.iam.gserviceaccount.com","serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com","serviceAccount:service-123456789012@gcp-sa-cloudtasks.iam.gserviceaccount.com"]}]}'
        fi
      else
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[]}'
      fi
    elif [[ "$target_account" == "analysis-build@test-project.iam.gserviceaccount.com" \
      && "$build_operator_ready" == "true" ]]; then
      printf 'roles/iam.serviceAccountUser,user:operator@example.test,\n'
    elif [[ "$target_account" == "analysis-recovery@test-project.iam.gserviceaccount.com" \
      && "$runtime_operator_ready" == "true" ]]; then
      printf 'roles/iam.serviceAccountUser,user:operator@example.test,\n'
    elif [[ "$infra_ready" == "true" ]]; then
      filter=""
      for argument in "$@"; do
        [[ "$argument" == --filter=* ]] && filter="${argument#--filter=}"
      done
      member="${filter##*bindings.members=}"
      printf 'roles/iam.serviceAccountUser,%s,\n' "$member"
    fi
    ;;
  "iam service-accounts set-iam-policy"*)
    target_account="$4"
    if [[ -z "${FAKE_GCLOUD_STATE_FILE:-}" ]]; then
      exit 90
    elif [[ "$target_account" == "analysis-recovery@test-project.iam.gserviceaccount.com" ]]; then
      printf 'runtime_operator_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$target_account" == "analysis-build@test-project.iam.gserviceaccount.com" ]]; then
      printf 'build_operator_ready_state\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$target_account" == "analysis-maintenance@test-project.iam.gserviceaccount.com" \
      || "$target_account" == "analysis-task@test-project.iam.gserviceaccount.com" ]]; then
      printf 'identity_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      exit 90
    fi
    ;;
  "services list"*)
    for argument in "$@"; do
      if [[ "$argument" == --filter=config.name=* ]]; then
        printf '%s\n' "${argument#--filter=config.name=}"
        exit 0
      fi
    done
    exit 1
    ;;
  "beta services identity create"*)
    ;;
  "secrets describe"*)
    [[ "$identity_ready" == "true" ]] || exit 1
    secret_id="$3"
    jq -nc \
      --arg name "projects/test-project/secrets/$secret_id" \
      '{name: $name, replication: {userManaged: {replicas: [{location: "asia-northeast3"}]}}}'
    ;;
  "secrets versions describe"*)
    [[ "$identity_ready" == "true" ]] || exit 1
    version="$4"
    secret_id=""
    for argument in "$@"; do
      [[ "$argument" == --secret=* ]] && secret_id="${argument#--secret=}"
    done
    jq -nc \
      --arg name "projects/test-project/secrets/$secret_id/versions/$version" \
      '{name: $name, state: "ENABLED"}'
    ;;
  "secrets versions list"*)
    [[ "$identity_ready" == "true" ]] || exit 1
    secret_id=""
    for argument in "$@"; do
      [[ "$argument" == --secret=* ]] && secret_id="${argument#--secret=}"
    done
    printf 'projects/test-project/secrets/%s/versions/7\n' "$secret_id"
    ;;
  "secrets get-iam-policy"*)
    [[ "$identity_ready" == "true" ]] || exit 1
    printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
    ;;
  "projects add-iam-policy-binding"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] \
      || exit 90
    if [[ "$command_line" == *"--role=roles/aiplatform.user"* ]]; then
      printf 'runtime_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$command_line" == *"--role=roles/run.builder"* ]]; then
      printf 'build_role_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      exit 90
    fi
    ;;
  "iam service-accounts add-iam-policy-binding"*)
    target_account="$4"
    if [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" \
      && "$target_account" == "analysis-build@test-project.iam.gserviceaccount.com" ]]; then
      printf 'build_operator_ready_state\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" \
      && "$target_account" == "analysis-recovery@test-project.iam.gserviceaccount.com" ]]; then
      printf 'runtime_operator_ready\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      exit 90
    fi
    ;;
  "iam roles describe"*)
    if [[ "$bucket_ready" == "true" ]]; then
      printf '%s\n' '{"deleted":false,"stage":"GA","includedPermissions":["storage.objects.get","storage.objects.create","storage.objects.delete"]}'
    else
      exit 1
    fi
    ;;
  "iam roles list"*)
    printf '[]\n'
    ;;
  "storage buckets describe"*)
    if [[ "$bucket_ready" == "true" ]]; then
      if [[ "$state" == "bucket_retention" ]]; then
        printf '%s\n' '{"location":"ASIA-NORTHEAST3","projectNumber":"123456789012","iamConfiguration":{"uniformBucketLevelAccess":{"enabled":true},"publicAccessPrevention":"enforced"},"versioning":{"enabled":false},"retentionPolicy":{"retentionPeriod":"86400"},"defaultEventBasedHold":true,"softDeletePolicy":{"retentionDurationSeconds":"0"},"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}}'
      elif [[ "$state" == "bucket_requester_pays" ]]; then
        printf '%s\n' '{"location":"ASIA-NORTHEAST3","projectNumber":"123456789012","iamConfiguration":{"uniformBucketLevelAccess":{"enabled":true},"publicAccessPrevention":"enforced"},"billing":{"requesterPays":true},"versioning":{"enabled":false},"defaultEventBasedHold":false,"softDeletePolicy":{"retentionDurationSeconds":"0"},"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}}'
      else
        printf '%s\n' '{"location":"ASIA-NORTHEAST3","projectNumber":"123456789012","iamConfiguration":{"uniformBucketLevelAccess":{"enabled":true},"publicAccessPrevention":"enforced"},"versioning":{"enabled":false},"defaultEventBasedHold":false,"softDeletePolicy":{"retentionDurationSeconds":"0"},"lifecycle":{"rule":[{"action":{"type":"Delete"},"condition":{"age":1}}]}}'
      fi
    else
      exit 1
    fi
    ;;
  "storage buckets get-iam-policy"*)
    if [[ "$bucket_ready" == "true" ]]; then
      if [[ "$state" == "bucket_legacy" ]]; then
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/storage.legacyBucketOwner","members":["projectEditor:test-project","projectOwner:test-project"]},{"role":"roles/storage.legacyBucketReader","members":["projectViewer:test-project"]},{"role":"roles/storage.legacyObjectOwner","members":["projectEditor:test-project","projectOwner:test-project"]},{"role":"roles/storage.legacyObjectReader","members":["projectViewer:test-project"]},{"role":"projects/test-project/roles/analysisV2MediaArtifactWorker","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      else
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"projects/test-project/roles/analysisV2MediaArtifactWorker","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      fi
    else
      exit 1
    fi
    ;;
  "storage buckets set-iam-policy"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] \
      || exit 90
    policy_file="$5"
    jq -e '
      (.bindings | length) == 1
      and .bindings[0].role == "projects/test-project/roles/analysisV2MediaArtifactWorker"
      and .bindings[0].members == ["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]
    ' "$policy_file" >/dev/null
    printf 'bucket_exact\n' >"$FAKE_GCLOUD_STATE_FILE"
    ;;
  "run services describe"*)
    if [[ "$infra_ready" != "true" ]]; then
      exit 1
    elif [[ "$command_line" == *"format=json"* ]]; then
      latest_created='analysis-worker-00002'
      latest_ready='analysis-worker-00002'
      traffic_revision='analysis-worker-00002'
      runtime_queue='analysis-v2-pipeline'
      credential_name=''
      runtime_slot='quinary'
      apify_secret_version='7'
      supabase_plaintext='false'
      sidecar='false'
      placement='false'
      duplicate_env='false'
      admission_env='false'
      legacy_gate_env='false'
      [[ "$state" != "failed_latest" ]] || latest_ready='analysis-worker-00001'
      [[ "$state" != "old_traffic" ]] || traffic_revision='analysis-worker-00001'
      [[ "$state" != "runtime_env_drift" ]] || runtime_queue='wrong-v2-queue'
      [[ "$state" != "credential_override" ]] || credential_name='GOOGLE_APPLICATION_CREDENTIALS'
      [[ "$state" != "credential_key_base64" ]] || credential_name='GOOGLE_SERVICE_ACCOUNT_KEY_BASE64'
      [[ "$state" != "slot_drift" ]] || runtime_slot='primary'
      [[ "$state" != "secret_ref_drift" ]] || apify_secret_version='latest'
      [[ "$state" != "plaintext_secret" ]] || supabase_plaintext='true'
      [[ "$state" != "runtime_sidecar" ]] || sidecar='true'
      [[ "$state" != "runtime_placement" ]] || placement='true'
      [[ "$state" != "runtime_duplicate_env" ]] || duplicate_env='true'
      [[ "$state" != "runtime_admission_env" ]] || admission_env='true'
      [[ "$state" != "runtime_legacy_gate_env" ]] || legacy_gate_env='true'
      jq -nc \
        --arg latest_created "$latest_created" \
        --arg latest_ready "$latest_ready" \
        --arg traffic_revision "$traffic_revision" \
        --arg runtime_queue "$runtime_queue" \
        --arg credential_name "$credential_name" \
        --arg runtime_slot "$runtime_slot" \
        --arg apify_secret_version "$apify_secret_version" \
        --argjson supabase_plaintext "$supabase_plaintext" \
        --argjson sidecar "$sidecar" \
        --argjson placement "$placement" \
        --argjson duplicate_env "$duplicate_env" \
        --argjson admission_env "$admission_env" \
        --argjson legacy_gate_env "$legacy_gate_env" '
        {
          metadata: {
            name: "analysis-worker",
            annotations: {
              "run.googleapis.com/ingress": "all",
              "run.googleapis.com/invoker-iam-disabled": "false",
              "run.googleapis.com/minScale": "0",
              "run.googleapis.com/maxScale": "6"
            }
          },
          spec: {template: {
            metadata: {annotations: {
              "run.googleapis.com/execution-environment": "gen2",
              "run.googleapis.com/cpu-throttling": "true",
              "run.googleapis.com/startup-cpu-boost": "true",
              "autoscaling.knative.dev/maxScale": "6"
            }},
            spec: {
              serviceAccountName: "analysis-recovery@test-project.iam.gserviceaccount.com",
              timeoutSeconds: 300,
              containerConcurrency: 2,
              containers: ([{
                resources: {limits: {cpu: "2", memory: "2Gi"}},
                env: ([
                  {name: "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET", value: "test-project-analysis-v2-media"},
                  {name: "ANALYSIS_V2_TASKS_ENABLED", value: "true"},
                  {name: "ANALYSIS_V2_WORKER_ENABLED", value: "false"},
                  {name: "ANALYSIS_V2_RECOVERY_ENABLED", value: "false"},
                  {name: "ANALYSIS_V2_TASKS_PROJECT", value: "test-project"},
                  {name: "ANALYSIS_V2_TASKS_LOCATION", value: "asia-northeast3"},
                  {name: "ANALYSIS_V2_TASKS_QUEUE", value: $runtime_queue},
                  {name: "ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL", value: "analysis-task@test-project.iam.gserviceaccount.com"},
                  {name: "ANALYSIS_V2_TASKS_CALLER_AUTH_MODE", value: "adc"},
                  {name: "ANALYSIS_V2_APIFY_API_TOKEN_SLOT", value: $runtime_slot},
                  {name: "ANALYSIS_V2_TASKS_TARGET_URL", value: "https://analysis-worker-test.asia-northeast3.run.app/api/analysis/v2/worker"},
                  {name: "ANALYSIS_V2_TASKS_OIDC_AUDIENCE", value: "https://analysis-worker-test.asia-northeast3.run.app"},
                  {name: "PREFLIGHT_TASKS_ENABLED", value: "true"},
                  {name: "PREFLIGHT_TASKS_PROJECT", value: "test-project"},
                  {name: "PREFLIGHT_TASKS_LOCATION", value: "asia-northeast3"},
                  {name: "PREFLIGHT_TASKS_QUEUE", value: "analysis-preflight"},
                  {name: "PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL", value: "analysis-task@test-project.iam.gserviceaccount.com"},
                  {name: "PREFLIGHT_TASKS_CALLER_AUTH_MODE", value: "adc"},
                  {name: "PREFLIGHT_TASKS_TARGET_URL", value: "https://analysis-worker-test.asia-northeast3.run.app/api/analysis/preflight/worker"},
                  {name: "PREFLIGHT_TASKS_OIDC_AUDIENCE", value: "https://analysis-worker-test.asia-northeast3.run.app"},
                  {name: "PREFLIGHT_LOCAL_AFTER_ENABLED", value: "false"},
                  {name: "ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL", value: "analysis-maintenance@test-project.iam.gserviceaccount.com"},
                  {name: "ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE", value: "https://analysis-worker-test.asia-northeast3.run.app"},
                  (if $supabase_plaintext then
                    {name: "SUPABASE_SERVICE_ROLE_KEY", value: "PLAINTEXT_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"}
                  else
                    {name: "SUPABASE_SERVICE_ROLE_KEY", valueFrom: {secretKeyRef: {name: "ai-baram-v2-supabase-service-role", key: "7"}}}
                  end),
                  {name: "APIFY_QUINARY_API_TOKEN", valueFrom: {secretKeyRef: {name: "ai-baram-v2-apify-quinary", key: $apify_secret_version}}},
                  {name: "IMAGE_PROXY_SIGNING_SECRET", valueFrom: {secretKeyRef: {name: "ai-baram-v2-image-proxy-signing", key: "7"}}}
                ]
                  + if $credential_name == "" then [] else
                    [{name: $credential_name, value: "fixture-path"}] end
                  + if $placement then [{name: "VERCEL", value: "1"}] else [] end
                  + if $duplicate_env then [{name: "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET", value: "test-project-analysis-v2-media"}] else [] end
                  + if $admission_env then [{name: "ANALYSIS_V2_ADMISSION_ENABLED", value: "true"}] else [] end
                  + if $legacy_gate_env then [{name: "ANALYSIS_V2_WORKER_EXECUTION_ENABLED", value: "true"}] else [] end)
              }] + if $sidecar then [{name: "unexpected-sidecar", env: []}] else [] end)
            }
          }},
          status: {
            url: "https://analysis-worker-test.asia-northeast3.run.app",
            latestCreatedRevisionName: $latest_created,
            latestReadyRevisionName: $latest_ready,
            conditions: [{type: "Ready", status: "True"}],
            traffic: [{revisionName: $traffic_revision, percent: 100}]
          }
        }'
    elif [[ "$command_line" == *"serviceAccountName"* ]]; then
      printf 'analysis-recovery@test-project.iam.gserviceaccount.com\n'
    else
      printf 'analysis-worker\n'
    fi
    ;;
  "run services get-iam-policy"*)
    if [[ "$infra_ready" == "true" ]]; then
      if [[ "$command_line" == *"format=csv"* ]]; then
        printf '%s\n' 'roles/run.invoker,serviceAccount:analysis-task@test-project.iam.gserviceaccount.com,'
      else
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/run.invoker","members":["serviceAccount:analysis-maintenance@test-project.iam.gserviceaccount.com","serviceAccount:analysis-task@test-project.iam.gserviceaccount.com"]}]}'
      fi
    else
      exit 1
    fi
    ;;
  "tasks queues list"*)
    [[ "$infra_ready" == "true" ]] \
      && printf '%s\n' \
        'analysis-v2-pipeline' \
        'analysis-preflight' \
        'analysis-pipeline'
    ;;
  "tasks queues describe"*)
    if [[ "$infra_ready" != "true" ]]; then
      exit 1
    elif [[ "$command_line" == *"format=csv"* ]]; then
      if [[ "$command_line" == *" analysis-preflight "* ]]; then
        printf '2.0,2,8,1800s,40s,300s,4\n'
      else
        printf '10.0,12,8,3600s,40s,300s,4\n'
      fi
    elif [[ "$command_line" == *"format=value(state)"* ]]; then
      printf 'RUNNING\n'
    else
      printf 'state: RUNNING\n'
    fi
    ;;
  "tasks queues get-iam-policy"*)
    [[ "$infra_ready" == "true" ]] || exit 1
    if [[ "${FAKE_GCLOUD_QUEUE_IAM_MISSING:-false}" == "true" ]]; then
      printf '{"version":1,"bindings":[]}\n'
    elif [[ "$command_line" == *" analysis-v2-pipeline "* ]]; then
      if [[ "${FAKE_GCLOUD_QUEUE_IAM_EXTRA:-false}" == "true" ]]; then
        printf '%s\n' '{"version":1,"bindings":[{"role":"roles/cloudtasks.enqueuer","members":["serviceAccount:runtime-user@test-project.iam.gserviceaccount.com","serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com","serviceAccount:legacy-runtime@test-project.iam.gserviceaccount.com"]},{"role":"roles/cloudtasks.viewer","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      else
        printf '%s\n' '{"version":1,"bindings":[{"role":"roles/cloudtasks.enqueuer","members":["serviceAccount:runtime-user@test-project.iam.gserviceaccount.com","serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]},{"role":"roles/cloudtasks.viewer","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      fi
    elif [[ "$command_line" == *" analysis-preflight "* ]]; then
      printf '%s\n' '{"version":1,"bindings":[{"role":"roles/cloudtasks.enqueuer","members":["serviceAccount:runtime-user@test-project.iam.gserviceaccount.com"]}]}'
    elif [[ "$command_line" == *" analysis-pipeline "* ]]; then
      printf '%s\n' '{"version":1,"bindings":[{"role":"roles/cloudtasks.enqueuer","members":["serviceAccount:legacy-runtime@test-project.iam.gserviceaccount.com"]}]}'
    else
      exit 90
    fi
    ;;
  "tasks queues add-iam-policy-binding"*)
    [[ "$command_line" != *"--condition"* ]] || {
      printf 'unsupported queue IAM --condition flag\n' >&2
      exit 91
    }
    [[ "$command_line" == *" analysis-v2-pipeline "* \
      || "$command_line" == *" analysis-preflight "* ]] \
      || exit 92
    [[ -n "${FAKE_GCLOUD_QUEUE_MUTATION_STATE_FILE:-}" ]] \
      || exit 90
    printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_QUEUE_MUTATION_STATE_FILE"
    ;;
  "scheduler jobs describe"*)
    [[ "$infra_ready" == "true" ]] || exit 1
    [[ "${FAKE_GCLOUD_SCHEDULER_MISSING:-false}" != "true" ]] || exit 1
    job="$4"
    if [[ "$job" == "analysis-v2-recovery" ]]; then
      schedule='* * * * *'
      uri='https://analysis-worker-test.asia-northeast3.run.app/api/analysis/v2/recover'
      deadline='300s'
    elif [[ "$job" == "analysis-v2-preflight-retention" ]]; then
      schedule='*/5 * * * *'
      uri='https://analysis-worker-test.asia-northeast3.run.app/api/analysis/preflight/retention'
      deadline='60s'
    else
      exit 90
    fi
    audience='https://analysis-worker-test.asia-northeast3.run.app'
    [[ "${FAKE_GCLOUD_SCHEDULER_DRIFT:-false}" != "true" ]] \
      || audience='https://wrong.example.test'
    jq -nc --arg schedule "$schedule" --arg uri "$uri" --arg deadline "$deadline" --arg audience "$audience" '{
      schedule: $schedule,
      timeZone: "Etc/UTC",
      state: "ENABLED",
      attemptDeadline: $deadline,
      httpTarget: {
        uri: $uri,
        httpMethod: "POST",
        headers: {"Content-Type": "application/json"},
        body: "e30=",
        oidcToken: {
          serviceAccountEmail: "analysis-maintenance@test-project.iam.gserviceaccount.com",
          audience: $audience
        }
      },
      retryConfig: {
        retryCount: 3,
        maxRetryDuration: "300s",
        minBackoffDuration: "10s",
        maxBackoffDuration: "60s",
        maxDoublings: 3
      }
    }'
    ;;
  *)
    printf 'unexpected fake gcloud command: %s\n' "$command_line" >&2
    exit 90
    ;;
esac
EOF
chmod +x "$temp_dir/bin/gcloud"

if "$temp_dir/bin/gcloud" tasks queues add-iam-policy-binding analysis-v2-pipeline \
  --location=asia-northeast3 \
  --member=serviceAccount:fixture@test-project.iam.gserviceaccount.com \
  --role=roles/cloudtasks.enqueuer \
  --condition=None >"$temp_dir/unsupported-queue-condition.out" 2>&1; then
  fail "fake gcloud accepted the unsupported queue IAM --condition flag"
fi
assert_contains "$temp_dir/unsupported-queue-condition.out" \
  "unsupported queue IAM --condition flag"

cat >"$temp_dir/runtime.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="quinary"
EOF

cat >"$temp_dir/runtime-provider-secret.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="quinary"
APIFY_QUINARY_API_TOKEN="SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/runtime-wrong-slot.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="primary"
EOF

cat >"$temp_dir/runtime-secondary-slot.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="secondary"
EOF

cat >"$temp_dir/build.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: "PUBLIC_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/build-secret.yaml" <<'EOF'
SUPABASE_SERVICE_ROLE_KEY: "SECRET_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
EOF
cat >"$temp_dir/build-extra.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon"
NEXT_PUBLIC_APP_URL: "https://unexpected.example.test"
EOF
cat >"$temp_dir/build-empty.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: ""
EOF
cp "$temp_dir/build.yaml" "$temp_dir/build.env"

cat >"$temp_dir/runtime-credential.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
GOOGLE_APPLICATION_CREDENTIALS="RUNTIME_CREDENTIAL_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/runtime-admission.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="quinary"
ANALYSIS_V2_ADMISSION_ENABLED="true"
EOF

cat >"$temp_dir/runtime-legacy-gate.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="quinary"
ANALYSIS_V2_WORKER_EXECUTION_ENABLED="true"
EOF

common_env=(
  "PATH=$temp_dir/bin:$PATH"
  'ANALYSIS_V2_TASKS_PROJECT=test-project'
  'ANALYSIS_V2_TASKS_LOCATION=asia-northeast3'
  'ANALYSIS_V2_TASKS_QUEUE=analysis-v2-pipeline'
  'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-task@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=runtime-user@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=analysis-recovery@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL=analysis-maintenance@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_DEPLOYER_IAM_MEMBER=user:operator@example.test'
  'ANALYSIS_V1_TASKS_SERVICE_ACCOUNT_EMAIL=legacy-task@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=legacy-runtime@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_WORKER_BUILD_SERVICE_ACCOUNT=analysis-build@test-project.iam.gserviceaccount.com'
  'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE=analysis-worker'
  'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION=asia-northeast3'
  'ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=test-project-analysis-v2-media'
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=quinary'
  'ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=7'
  'ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=7'
  'ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION=7'
  'ANALYSIS_V2_WORKER_ENABLED=false'
  'ANALYSIS_V2_RECOVERY_ENABLED=false'
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml"
)

legacy_runtime_env=()
for item in "${common_env[@]}"; do
  [[ "$item" == ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=* ]] \
    || legacy_runtime_env+=("$item")
done
legacy_runtime_env+=(
  'ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL=analysis-recovery@test-project.iam.gserviceaccount.com'
)

env "${legacy_runtime_env[@]}" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-legacy-runtime-alias.out"
assert_contains "$temp_dir/identity-legacy-runtime-alias.out" \
  "gcloud iam service-accounts create analysis-recovery"

if env "${common_env[@]}" \
  'ANALYSIS_V2_TASKS_RECOVERY_SERVICE_ACCOUNT_EMAIL=different-runtime@test-project.iam.gserviceaccount.com' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-runtime-name-conflict.out" 2>&1; then
  fail "conflicting canonical and legacy runtime identities were accepted"
fi
assert_contains "$temp_dir/identity-runtime-name-conflict.out" \
  "must match when both are set"

env "${common_env[@]}" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity.out"
assert_contains "$temp_dir/identity.out" "gcloud iam service-accounts create analysis-recovery"
assert_contains "$temp_dir/identity.out" "gcloud iam service-accounts create analysis-build"
assert_contains "$temp_dir/identity.out" "gcloud iam service-accounts create runtime-user"
assert_contains "$temp_dir/identity.out" "gcloud iam service-accounts create analysis-task"
assert_contains "$temp_dir/identity.out" "gcloud iam service-accounts create analysis-maintenance"
assert_contains "$temp_dir/identity.out" "--role=roles/aiplatform.user"
assert_contains "$temp_dir/identity.out" "--role=roles/run.builder"
assert_contains "$temp_dir/identity.out" "new runtime identity will be created without credential keys"
assert_not_contains "$temp_dir/identity.out" "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" \
  'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=legacy-task@test-project.iam.gserviceaccount.com' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-v1-reuse.out" 2>&1; then
  fail "V1 task identity was reused by V2"
fi
assert_contains "$temp_dir/identity-v1-reuse.out" \
  "V2 identities must not reuse a V1 task or enqueuer identity"

if env "${common_env[@]}" \
  'ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL=analysis-recovery@test-project.iam.gserviceaccount.com' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-maintenance-reuse.out" 2>&1; then
  fail "maintenance identity reused the runtime identity"
fi
assert_contains "$temp_dir/identity-maintenance-reuse.out" \
  "all V2 task, enqueuer, runtime, maintenance, and build identities must be distinct"

if env "${common_env[@]}" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-missing-check.out" 2>&1; then
  fail "missing worker identity was accepted in check mode"
fi
assert_contains "$temp_dir/identity-missing-check.out" \
  "worker runtime service account does not exist"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-check.out"
assert_contains "$temp_dir/identity-check.out" \
  "worker runtime service account has no user-managed credential keys"
assert_contains "$temp_dir/identity-check.out" \
  "worker identity has only the required Vertex AI runtime role"
assert_contains "$temp_dir/identity-check.out" \
  "worker runtime service account IAM contains only the declared deployer actAs binding"
assert_contains "$temp_dir/identity-check.out" \
  "worker build service account IAM contains only the declared deployer actAs binding"
assert_contains "$temp_dir/identity-check.out" \
  "dedicated V2 enqueuer is keyless and has no project-wide role"
assert_contains "$temp_dir/identity-check.out" \
  "V2 maintenance identity is keyless and project-role-free"
assert_contains "$temp_dir/identity-check.out" \
  "Analysis V2 keyless worker identity configuration verified"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" \
  >"$temp_dir/identity-apply-ready.out"
assert_contains "$temp_dir/identity-apply-ready.out" \
  "Analysis V2 keyless worker identity configuration verified"

printf 'missing\n' >"$temp_dir/identity-state"
env "${common_env[@]}" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/identity-state" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" \
  >"$temp_dir/identity-apply-missing.out"
assert_contains "$temp_dir/identity-apply-missing.out" \
  "Analysis V2 keyless worker identity configuration verified"
[[ "$(<"$temp_dir/identity-state")" == "identity_ready" ]] \
  || fail "identity apply did not create the account and Vertex binding"
env "${common_env[@]}" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/identity-state" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-after-apply-check.out"
assert_contains "$temp_dir/identity-after-apply-check.out" \
  "Analysis V2 keyless worker identity configuration verified"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=broad' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-broad.out" 2>&1; then
  fail "broad worker project role was accepted"
fi
assert_contains "$temp_dir/identity-broad.out" \
  "forbidden broad project role: roles/editor"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=storage_broad' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-storage-broad.out" 2>&1; then
  fail "project-wide storage role on the worker was accepted"
fi
assert_contains "$temp_dir/identity-storage-broad.out" \
  "forbidden broad project role: roles/storage.admin"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=secret_broad' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-secret-broad.out" 2>&1; then
  fail "project-wide Secret Manager role on the worker was accepted"
fi
assert_contains "$temp_dir/identity-secret-broad.out" \
  "forbidden broad project role: roles/secretmanager.secretAccessor"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=vertex_admin' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-vertex-admin.out" 2>&1; then
  fail "elevated Vertex AI role on the worker was accepted"
fi
assert_contains "$temp_dir/identity-vertex-admin.out" \
  "elevated or unexpected Vertex AI role: roles/aiplatform.admin"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=build_broad' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-build-broad.out" 2>&1; then
  fail "broad build identity project role was accepted"
fi
assert_contains "$temp_dir/identity-build-broad.out" \
  "worker build identity has a forbidden project role: roles/editor"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=keyed' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-keyed.out" 2>&1; then
  fail "user-managed worker credential key was accepted"
fi
assert_contains "$temp_dir/identity-keyed.out" \
  "has a user-managed credential key"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=build_keyed' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-build-keyed.out" 2>&1; then
  fail "user-managed build credential key was accepted"
fi
assert_contains "$temp_dir/identity-build-keyed.out" \
  "worker build service account has a user-managed credential key"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=enqueuer_broad' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-enqueuer-broad.out" 2>&1; then
  fail "project-wide role on the dedicated V2 enqueuer was accepted"
fi
assert_contains "$temp_dir/identity-enqueuer-broad.out" \
  "dedicated V2 enqueuer must have no project-wide role"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=enqueuer_keyed' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --check \
  >"$temp_dir/identity-enqueuer-keyed.out" 2>&1; then
  fail "user-managed V2 enqueuer credential key was accepted"
fi
assert_contains "$temp_dir/identity-enqueuer-keyed.out" \
  "dedicated V2 enqueuer has a user-managed credential key"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --dry-run \
  >"$temp_dir/bucket.out"
assert_contains "$temp_dir/bucket.out" "gcloud iam roles create"
assert_contains "$temp_dir/bucket.out" "gcloud storage buckets create"
assert_contains "$temp_dir/bucket.out" "gcloud storage buckets update"
assert_contains "$temp_dir/bucket.out" "dry-run complete: no mutations were applied"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker.out"
assert_contains "$temp_dir/worker.out" "gcloud run deploy analysis-worker"
assert_contains "$temp_dir/worker.out" "--concurrency=2"
assert_contains "$temp_dir/worker.out" "--max=6"
assert_contains "$temp_dir/worker.out" "--cpu-throttling"
assert_contains "$temp_dir/worker.out" "--clear-network"
assert_contains "$temp_dir/worker.out" \
  "--build-service-account=projects/test-project/serviceAccounts/analysis-build@test-project.iam.gserviceaccount.com"
assert_contains "$temp_dir/worker.out" \
  "--set-secrets=SUPABASE_SERVICE_ROLE_KEY=ai-baram-v2-supabase-service-role:7\\,APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:7\\,IMAGE_PROXY_SIGNING_SECRET=ai-baram-v2-image-proxy-signing:7"
assert_contains "$temp_dir/worker.out" "roles/run.invoker will contain only task and maintenance OIDC identities"
assert_not_contains "$temp_dir/worker.out" "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
assert_not_contains "$temp_dir/worker.out" "PUBLIC_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
assert_contains "$temp_dir/worker.out" \
  "verifying prerequisite order: worker identity -> secrets -> media bucket -> worker deploy"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_WORKER_ENABLED=true' \
  'ANALYSIS_V2_RECOVERY_ENABLED=false' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-independent-gates.out"
assert_contains "$temp_dir/worker-independent-gates.out" \
  "ANALYSIS_V2_WORKER_ENABLED=true\\,ANALYSIS_V2_RECOVERY_ENABLED=false"
assert_contains "$temp_dir/worker-independent-gates.out" \
  "--remove-env-vars=ANALYSIS_V2_ADMISSION_ENABLED\\,ANALYSIS_V2_WORKER_EXECUTION_ENABLED"
assert_not_contains "$temp_dir/worker-independent-gates.out" \
  "ANALYSIS_V2_WORKER_ENABLED=true\\,ANALYSIS_V2_RECOVERY_ENABLED=true"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_WORKER_EXECUTION_ENABLED=true' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/removed-worker-gate.out" 2>&1; then
  fail "removed ANALYSIS_V2_WORKER_EXECUTION_ENABLED was accepted"
fi
assert_contains "$temp_dir/removed-worker-gate.out" \
  "ANALYSIS_V2_WORKER_EXECUTION_ENABLED was removed"

for invalid_gate in ANALYSIS_V2_WORKER_ENABLED ANALYSIS_V2_RECOVERY_ENABLED; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
    "$invalid_gate=enabled" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/invalid-$invalid_gate.out" 2>&1; then
    fail "non-boolean deployment gate was accepted: $invalid_gate"
  fi
  assert_contains "$temp_dir/invalid-$invalid_gate.out" \
    "$invalid_gate must be true or false"
done

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-secondary-slot.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-secondary-slot.out"
assert_contains "$temp_dir/worker-secondary-slot.out" \
  "APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:7"
assert_not_contains "$temp_dir/worker-secondary-slot.out" \
  "APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:7"

mkdir -p "$temp_dir/source"
printf '{}\n' >"$temp_dir/source/package.json"
cp "$temp_dir/runtime.env" "$temp_dir/source/runtime.env"
cp "$temp_dir/runtime.env" "$temp_dir/source/build.env"
ln -s "$temp_dir/source/runtime.env" "$temp_dir/runtime-link.env"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$temp_dir/source" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/source/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-inside-source.out" 2>&1; then
  fail "runtime env file inside the source tree was accepted"
fi
assert_contains "$temp_dir/runtime-inside-source.out" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"
assert_not_contains "$temp_dir/runtime-inside-source.out" \
  "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$temp_dir/source" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/source/build.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-inside-source.out" 2>&1; then
  fail "build env file inside the source tree was accepted"
fi
assert_contains "$temp_dir/build-inside-source.out" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"
assert_not_contains "$temp_dir/build-inside-source.out" \
  "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$temp_dir/source" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-link.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-symlink-source.out" 2>&1; then
  fail "runtime env symlink resolving inside the source tree was accepted"
fi
assert_contains "$temp_dir/runtime-symlink-source.out" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE must be outside ANALYSIS_V2_WORKER_SOURCE_DIR"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-credential.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-credential.out" 2>&1; then
  fail "runtime attached-identity credential override was accepted"
fi
assert_contains "$temp_dir/runtime-credential.out" \
  "runtime env file must not contain plaintext provider or credential key: GOOGLE_APPLICATION_CREDENTIALS"
assert_not_contains "$temp_dir/runtime-credential.out" \
  "RUNTIME_CREDENTIAL_SENTINEL_MUST_NOT_BE_PRINTED"

for forbidden_gate in admission legacy-gate; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-$forbidden_gate.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/runtime-$forbidden_gate.out" 2>&1; then
    fail "runtime manifest accepted a Vercel-only or removed gate: $forbidden_gate"
  fi
  assert_contains "$temp_dir/runtime-$forbidden_gate.out" \
    "runtime env file contains a forbidden placement, gate, or WIF bootstrap key"
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-provider-secret.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-provider-secret.out" 2>&1; then
  fail "plaintext provider token in the runtime manifest was accepted"
fi
assert_contains "$temp_dir/runtime-provider-secret.out" \
  "runtime env file must not contain plaintext provider or credential key: APIFY_QUINARY_API_TOKEN"
assert_not_contains "$temp_dir/runtime-provider-secret.out" \
  "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-wrong-slot.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-wrong-slot.out" 2>&1; then
  fail "runtime manifest Apify slot drift was accepted"
fi
assert_contains "$temp_dir/runtime-wrong-slot.out" \
  "runtime env file must set the exact selected ANALYSIS_V2_APIFY_API_TOKEN_SLOT"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build-secret.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-secret.out" 2>&1; then
  fail "secret build env key was accepted"
fi
assert_contains "$temp_dir/build-secret.out" \
  "build env file contains a non-public or unsupported key: SUPABASE_SERVICE_ROLE_KEY"
assert_not_contains "$temp_dir/build-secret.out" \
  "SECRET_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  'ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-missing.out" 2>&1; then
  fail "missing source-build manifest was accepted for dry-run"
fi
assert_contains "$temp_dir/build-missing.out" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE is required"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build-extra.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-extra.out" 2>&1; then
  fail "extra public build key was accepted"
fi
assert_contains "$temp_dir/build-extra.out" \
  "build env file contains a non-public or unsupported key: NEXT_PUBLIC_APP_URL"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build-empty.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-empty.out" 2>&1; then
  fail "empty public Supabase build value was accepted"
fi
assert_contains "$temp_dir/build-empty.out" \
  "build env file must set one non-empty NEXT_PUBLIC_SUPABASE_ANON_KEY"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-not-yaml.out" 2>&1; then
  fail "non-YAML build env file was accepted"
fi
assert_contains "$temp_dir/build-not-yaml.out" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE must be a YAML file"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=latest' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/latest-secret-version.out" 2>&1; then
  fail "latest Secret Manager version alias was accepted"
fi
assert_contains "$temp_dir/latest-secret-version.out" \
  "must be an exact positive numeric version; latest is forbidden"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --check \
  >"$temp_dir/bucket-check.out"
assert_contains "$temp_dir/bucket-check.out" \
  "Analysis V2 media artifact bucket configuration verified"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=bucket_legacy' \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --check \
  >"$temp_dir/bucket-legacy-check.out" 2>&1; then
  fail "default legacy bucket IAM bindings were accepted"
fi
assert_contains "$temp_dir/bucket-legacy-check.out" \
  "bucket IAM must contain exactly the worker custom-role binding"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=bucket_retention' \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --check \
  >"$temp_dir/bucket-retention-check.out" 2>&1; then
  fail "bucket retention/default hold drift was accepted"
fi
assert_contains "$temp_dir/bucket-retention-check.out" \
  "bucket retention policy and default event-based hold must be absent before launch"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=bucket_requester_pays' \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --check \
  >"$temp_dir/bucket-requester-pays.out" 2>&1; then
  fail "Requester Pays bucket drift was accepted"
fi
assert_contains "$temp_dir/bucket-requester-pays.out" \
  "media artifact bucket security controls have drifted"

printf 'bucket_legacy\n' >"$temp_dir/bucket-state"
if env "${common_env[@]}" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/bucket-state" \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" \
  >"$temp_dir/bucket-legacy-apply-closed.out" 2>&1; then
  fail "bucket IAM drift was reconciled without explicit approval"
fi
assert_contains "$temp_dir/bucket-legacy-apply-closed.out" \
  "bucket IAM has unexpected bindings; inspect or use --reconcile-iam"
env "${common_env[@]}" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/bucket-state" \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --reconcile-iam \
  >"$temp_dir/bucket-legacy-apply.out"
[[ "$(<"$temp_dir/bucket-state")" == "bucket_exact" ]] \
  || fail "bucket apply did not remove default legacy IAM bindings"
env "${common_env[@]}" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/bucket-state" \
  bash "$script_dir/configure-analysis-v2-media-bucket.sh" --check \
  >"$temp_dir/bucket-exact-check.out"
assert_contains "$temp_dir/bucket-exact-check.out" \
  "bucket is non-public and worker IAM is least-privilege"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-check.out"
assert_contains "$temp_dir/worker-check.out" \
  "verified: queue rate and retry policy"
assert_contains "$temp_dir/worker-check.out" \
  "verified: task and maintenance OIDC identities are the only Cloud Run invokers"
assert_contains "$temp_dir/worker-check.out" \
  "Analysis V2 Cloud Run worker and Cloud Tasks integration verified"
assert_contains "$temp_dir/worker-check.out" \
  "queue IAM has only the declared V2 principals and roles"
assert_contains "$temp_dir/worker-check.out" \
  "task OIDC identity has exact actAs principals and no token-creator role"
assert_contains "$temp_dir/worker-check.out" \
  "Analysis V2 recovery and preflight retention schedulers verified"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_DRIFT=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" --check \
  >"$temp_dir/scheduler-drift-check.out" 2>&1; then
  fail "scheduler audience drift was accepted"
fi
assert_contains "$temp_dir/scheduler-drift-check.out" "scheduler job has drifted"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_DRIFT=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
  >"$temp_dir/scheduler-drift-apply.out" 2>&1; then
  fail "scheduler drift was replaced without explicit approval"
fi
assert_contains "$temp_dir/scheduler-drift-apply.out" "inspect or use --reconcile-jobs"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_MISSING=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" --dry-run \
  >"$temp_dir/scheduler-create-dry-run.out"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "gcloud scheduler jobs create http analysis-v2-recovery"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "gcloud scheduler jobs create http analysis-v2-preflight-retention"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-check-without-build-manifest.out"
assert_contains "$temp_dir/worker-check-without-build-manifest.out" \
  "Cloud Run does not expose prior source-build env; no build manifest was supplied"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_QUEUE_IAM_MISSING=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --dry-run \
  >"$temp_dir/v2-queue-iam-dry-run.out"
assert_contains "$temp_dir/v2-queue-iam-dry-run.out" \
  "gcloud tasks queues set-iam-policy analysis-v2-pipeline"
assert_not_contains "$temp_dir/v2-queue-iam-dry-run.out" \
  "gcloud tasks queues add-iam-policy-binding analysis-pipeline"
assert_not_contains "$temp_dir/v2-queue-iam-dry-run.out" "--condition"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_QUEUE_IAM_MISSING=true' \
  'PREFLIGHT_TASKS_PROJECT=test-project' \
  'PREFLIGHT_TASKS_LOCATION=asia-northeast3' \
  'PREFLIGHT_TASKS_QUEUE=analysis-preflight' \
  'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-task@test-project.iam.gserviceaccount.com' \
  'PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=runtime-user@test-project.iam.gserviceaccount.com' \
  'PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL=analysis-recovery@test-project.iam.gserviceaccount.com' \
  'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE=analysis-worker' \
  'PREFLIGHT_TASKS_CLOUD_RUN_REGION=asia-northeast3' \
  bash "$script_dir/configure-preflight-tasks-queue.sh" --dry-run \
  >"$temp_dir/preflight-queue-iam-dry-run.out"
assert_contains "$temp_dir/preflight-queue-iam-dry-run.out" \
  "gcloud tasks queues set-iam-policy analysis-preflight"
assert_not_contains "$temp_dir/preflight-queue-iam-dry-run.out" \
  "gcloud tasks queues add-iam-policy-binding analysis-pipeline"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_PROJECT_ENQUEUER_BROAD=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-enqueuer-broad.out" 2>&1; then
  fail "project-wide V2 enqueuer binding was accepted"
fi
assert_contains "$temp_dir/v2-enqueuer-broad.out" \
  "configured enqueuer can enqueue every queue in the project"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_PROJECT_RECOVERY_BROAD=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-recovery-broad.out" 2>&1; then
  fail "project-wide V2 recovery task binding was accepted"
fi
assert_contains "$temp_dir/v2-recovery-broad.out" \
  "runtime can enqueue every queue in the project"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_QUEUE_IAM_EXTRA=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-queue-extra.out" 2>&1; then
  fail "extra V1 principal on the V2 queue was accepted"
fi
assert_contains "$temp_dir/v2-queue-extra.out" "queue IAM has drifted"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_QUEUE_IAM_EXTRA=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" \
  >"$temp_dir/v2-queue-extra-apply.out" 2>&1; then
  fail "extra V2 queue principal was removed without explicit approval"
fi
assert_contains "$temp_dir/v2-queue-extra-apply.out" "inspect or use --reconcile-iam"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_TASK_IAM_EXTRA=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-task-extra.out" 2>&1; then
  fail "extra token creator on the V2 task identity was accepted"
fi
assert_contains "$temp_dir/v2-task-extra.out" "task OIDC identity IAM has drifted"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_TASK_KEYED=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-task-keyed.out" 2>&1; then
  fail "user-managed key on the V2 task identity was accepted"
fi
assert_contains "$temp_dir/v2-task-keyed.out" "task OIDC identity has a user-managed key"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_TASK_PROJECT_ROLE=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --check \
  >"$temp_dir/v2-task-project-role.out" 2>&1; then
  fail "project role on the V2 task identity was accepted"
fi
assert_contains "$temp_dir/v2-task-project-role.out" \
  "task OIDC identity must have no project-wide role"

for drift_state in failed_latest old_traffic; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$drift_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$drift_state.out" 2>&1; then
    fail "Cloud Run service drift was accepted: $drift_state"
  fi
  assert_contains "$temp_dir/worker-$drift_state.out" \
    "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
done

for boundary_state in runtime_sidecar runtime_placement runtime_duplicate_env; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$boundary_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$boundary_state.out" 2>&1; then
    fail "Cloud Run container/env boundary drift was accepted: $boundary_state"
  fi
  assert_contains "$temp_dir/worker-$boundary_state.out" \
    "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
done

for credential_state in credential_override credential_key_base64; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$credential_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$credential_state.out" 2>&1; then
    fail "deployed attached-identity credential override was accepted: $credential_state"
  fi
  assert_contains "$temp_dir/worker-$credential_state.out" \
    "deployed worker contains a forbidden plaintext provider or credential value"
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=plaintext_secret' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-plaintext-secret.out" 2>&1; then
  fail "deployed plaintext Secret Manager value was accepted"
fi
assert_contains "$temp_dir/worker-plaintext-secret.out" \
  "deployed worker contains a forbidden plaintext provider or credential value"
assert_not_contains "$temp_dir/worker-plaintext-secret.out" \
  "PLAINTEXT_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

for secret_drift_state in secret_ref_drift slot_drift; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$secret_drift_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$secret_drift_state.out" 2>&1; then
    fail "Cloud Run exact secret mapping drift was accepted: $secret_drift_state"
  fi
  assert_contains "$temp_dir/worker-$secret_drift_state.out" \
    "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=runtime_env_drift' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-runtime-env-drift.out" 2>&1; then
  fail "Cloud Run queue runtime env drift was accepted"
fi
assert_contains "$temp_dir/worker-runtime-env-drift.out" \
  "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_WORKER_ENABLED=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-gate-drift.out" 2>&1; then
  fail "Cloud Run worker gate drift was accepted"
fi
assert_contains "$temp_dir/worker-gate-drift.out" \
  "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/recovery-gate-drift.out" 2>&1; then
  fail "Cloud Run recovery gate drift was accepted"
fi
assert_contains "$temp_dir/recovery-gate-drift.out" \
  "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"

for forbidden_runtime_gate in runtime_admission_env runtime_legacy_gate_env; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$forbidden_runtime_gate" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$forbidden_runtime_gate.out" 2>&1; then
    fail "Cloud Run retained a forbidden admission or legacy gate: $forbidden_runtime_gate"
  fi
  assert_contains "$temp_dir/worker-$forbidden_runtime_gate.out" \
    "Cloud Run worker queue, gate, target, or OIDC runtime configuration has drifted"
done

if env "${common_env[@]}" \
  'ANALYSIS_V2_WORKER_CONCURRENCY=2' \
  'ANALYSIS_V2_WORKER_MAX_INSTANCES=1' \
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=12' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/capacity.out" 2>&1; then
  fail "under-provisioned Cloud Run capacity was accepted"
fi
assert_contains "$temp_dir/capacity.out" \
  "Cloud Run capacity must cover ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES"

if env \
  'ANALYSIS_TASKS_PROJECT=test-project' \
  'ANALYSIS_TASKS_LOCATION=asia-northeast3' \
  'ANALYSIS_TASKS_QUEUE=analysis-v1-pipeline' \
  'ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-task@test-project.iam.gserviceaccount.com' \
  'ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=runtime-user@test-project.iam.gserviceaccount.com' \
  'ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES=0' \
  bash "$script_dir/configure-analysis-tasks-queue.sh" --dry-run \
  >"$temp_dir/queue-bound.out" 2>&1; then
  fail "invalid generic queue override was accepted"
fi
assert_contains "$temp_dir/queue-bound.out" \
  "ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES must be an integer from 1 through 100"

for portable_mktemp_script in \
  configure-analysis-v2-worker-identity.sh \
  configure-analysis-v2-media-bucket.sh \
  configure-analysis-tasks-queue.sh \
  deploy-analysis-v2-worker.sh; do
  if grep -Eq 'mktemp .+XXXXXX\.[A-Za-z0-9]' \
    "$script_dir/$portable_mktemp_script"; then
    fail "non-portable mktemp suffix found: $portable_mktemp_script"
  fi
done

printf 'Analysis V2 infrastructure script dry-run tests passed\n'
