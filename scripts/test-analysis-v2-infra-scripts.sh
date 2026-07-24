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
  ready|staged_build|staged_build_inherited_slot|staged_final|promoted|rolled_back|rolled_back_bootstrap|foreign_promoted|service_list_failure|service_describe_failure|service_describe_invalid_json|service_list_invalid_json|service_list_duplicate)
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
  broad|storage_broad|secret_broad|vertex_admin|keyed|build_broad|build_keyed|enqueuer_broad|enqueuer_keyed|failed_latest|old_traffic|unpromoted_latest|runtime_env_drift|runtime_admission_env|runtime_legacy_gate_env|runtime_selfhosted_global_gate_drift|runtime_selfhosted_global_interval_drift|runtime_selfhosted_response_guard_drift|credential_override|credential_key_base64|plaintext_secret|secret_ref_drift|slot_drift|runtime_sidecar|runtime_placement|runtime_duplicate_env)
    identity_ready="true"
    vertex_ready="true"
    build_identity_ready="true"
    build_role_ready="true"
    runtime_operator_ready="true"
    build_operator_ready="true"
    enqueuer_identity_ready="true"
    if [[ "$state" == "failed_latest" || "$state" == "old_traffic" \
      || "$state" == "unpromoted_latest" \
      || "$state" == "runtime_env_drift" || "$state" == "credential_override" \
      || "$state" == "credential_key_base64" || "$state" == "plaintext_secret" \
      || "$state" == "secret_ref_drift" || "$state" == "slot_drift" \
      || "$state" == "runtime_sidecar" || "$state" == "runtime_placement" \
      || "$state" == "runtime_duplicate_env" || "$state" == "runtime_admission_env" \
      || "$state" == "runtime_legacy_gate_env" \
      || "$state" == "runtime_selfhosted_global_gate_drift" \
      || "$state" == "runtime_selfhosted_global_interval_drift" \
      || "$state" == "runtime_selfhosted_response_guard_drift" ]]; then
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
      --arg name "projects/123456789012/secrets/$secret_id" \
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
      --arg name "projects/123456789012/secrets/$secret_id/versions/$version" \
      '{name: $name, state: "ENABLED"}'
    ;;
  "secrets versions list"*)
    [[ "$identity_ready" == "true" ]] || exit 1
    secret_id="$4"
    [[ -n "$secret_id" && "$secret_id" != --* ]] || exit 90
    for argument in "$@"; do
      [[ "$argument" != --secret=* ]] || exit 90
    done
    printf 'projects/123456789012/secrets/%s/versions/7\n' "$secret_id"
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
      if [[ "$command_line" == *"gs://analysis-v2-lock-0123456789abcdef0123456789abcdef"* ]]; then
        [[ "${FAKE_GCLOUD_LOCK_BUCKET_ADMIN_READ_DENIED:-false}" != "true" ]] \
          || exit 1
        jq -nc \
          --arg location "${FAKE_GCLOUD_LOCK_BUCKET_LOCATION:-ASIA-NORTHEAST3}" \
          --arg project_number "${FAKE_GCLOUD_LOCK_BUCKET_PROJECT_NUMBER:-123456789012}" '
          {
            location: $location,
            projectNumber: $project_number,
            iamConfiguration: {
              uniformBucketLevelAccess: {enabled: true},
              publicAccessPrevention: "enforced"
            },
            versioning: {enabled: false},
            defaultEventBasedHold: false,
            softDeletePolicy: {retentionDurationSeconds: "0"},
            lifecycle: {rule: [{action: {type: "Delete"}, condition: {age: 1}}]}
          }'
      elif [[ "$state" == "bucket_retention" ]]; then
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
      if [[ "$command_line" == *"gs://analysis-v2-lock-0123456789abcdef0123456789abcdef"* ]]; then
        [[ "${FAKE_GCLOUD_LOCK_BUCKET_ADMIN_READ_DENIED:-false}" != "true" ]] \
          || exit 1
        if [[ "${FAKE_GCLOUD_LOCK_IAM_RUNTIME:-false}" == "true" ]]; then
          printf '%s\n' '{"version":1,"etag":"lock-fixture","bindings":[{"role":"roles/storage.objectUser","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
        else
          printf '%s\n' '{"version":1,"etag":"lock-fixture","bindings":[{"role":"roles/storage.objectUser","members":["user:operator@example.test"]}]}'
        fi
      elif [[ "$state" == "bucket_legacy" ]]; then
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"roles/storage.legacyBucketOwner","members":["projectEditor:test-project","projectOwner:test-project"]},{"role":"roles/storage.legacyBucketReader","members":["projectViewer:test-project"]},{"role":"roles/storage.legacyObjectOwner","members":["projectEditor:test-project","projectOwner:test-project"]},{"role":"roles/storage.legacyObjectReader","members":["projectViewer:test-project"]},{"role":"projects/test-project/roles/analysisV2MediaArtifactWorker","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      else
        printf '%s\n' '{"version":1,"etag":"fixture","bindings":[{"role":"projects/test-project/roles/analysisV2MediaArtifactWorker","members":["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]}]}'
      fi
    else
      exit 1
    fi
    ;;
  "storage buckets create"*|"storage buckets update"*)
    if [[ -n "${FAKE_GCLOUD_STORAGE_MUTATION_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_STORAGE_MUTATION_LOG"
    fi
    ;;
  "storage buckets set-iam-policy"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] \
      || exit 90
    policy_file="$5"
    if [[ "$command_line" == *"gs://analysis-v2-lock-0123456789abcdef0123456789abcdef"* ]]; then
      jq -e '
        (.bindings | length) == 1
        and .bindings[0].role == "roles/storage.objectUser"
        and .bindings[0].members == ["user:operator@example.test"]
      ' "$policy_file" >/dev/null
    else
      jq -e '
        (.bindings | length) == 1
        and .bindings[0].role == "projects/test-project/roles/analysisV2MediaArtifactWorker"
        and .bindings[0].members == ["serviceAccount:analysis-recovery@test-project.iam.gserviceaccount.com"]
      ' "$policy_file" >/dev/null
    fi
    printf 'bucket_exact\n' >"$FAKE_GCLOUD_STATE_FILE"
    ;;
  "run deploy"*)
    deploy_source=''
    deploy_source_count=0
    runtime_manifest=''
    build_manifest=''
    source_runtime_env=''
    for argument in "$@"; do
      case "$argument" in
        --ignore-file|--ignore-file=*)
          printf 'unsupported Cloud Run deploy --ignore-file flag\n' >&2
          exit 91
          ;;
        --source=*)
          deploy_source="${argument#--source=}"
          deploy_source_count=$((deploy_source_count + 1))
          ;;
        --env-vars-file=*) runtime_manifest="${argument#--env-vars-file=}" ;;
        --update-env-vars=*) source_runtime_env="${argument#--update-env-vars=}" ;;
        --build-env-vars-file=*) build_manifest="${argument#--build-env-vars-file=}" ;;
      esac
    done
    [[ "$deploy_source_count" -eq 1 ]] || exit 92
    [[ -n "$deploy_source" && -d "$deploy_source" ]] || exit 92
    case "$deploy_source" in
      "${TMPDIR:-/tmp}"/analysis-v2-source.*) ;;
      *) exit 92 ;;
    esac
    [[ -f "$deploy_source/package.json" ]] || exit 93
    [[ -f "$build_manifest" ]] || exit 93
    [[ "$build_manifest" != "${ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE:-}" \
      && ! -w "$build_manifest" ]] || exit 93
    source_runtime_slot_applied='false'
    if [[ -n "$runtime_manifest" ]]; then
      [[ -f "$runtime_manifest" \
        && "$runtime_manifest" != "${ANALYSIS_V2_WORKER_ENV_VARS_FILE:-}" \
        && ! -w "$runtime_manifest" ]] || exit 93
      jq -e --arg slot "${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-}" '
        .ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET == "test-project-analysis-v2-media"
          and .ANALYSIS_V2_APIFY_API_TOKEN_SLOT == $slot
          and .SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED == "true"
          and .SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS == "750"
          and .SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS == "100"
          and .ANALYSIS_V2_RESULT_IMAGES_ENABLED == "false"
          and (keys | all(test("(TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY)$") | not))
      ' "$runtime_manifest" >/dev/null || exit 93
      source_runtime_slot_applied='true'
    else
      [[ ",$source_runtime_env," == *",ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=test-project-analysis-v2-media,"* ]] \
        || exit 93
      if [[ ",$source_runtime_env," == *",ANALYSIS_V2_APIFY_API_TOKEN_SLOT=${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-},"* ]]; then
        source_runtime_slot_applied='true'
      fi
    fi
    jq -e '
      (keys | sort) == ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL"]
        and ([.[] | select(length == 0)] | length) == 0
    ' "$build_manifest" >/dev/null || exit 93
    [[ -f "$deploy_source/.gcloudignore" ]] || exit 94
    grep -Fxq '.env*' "$deploy_source/.gcloudignore" || exit 95
    [[ ! -e "$deploy_source/.git" && ! -e "$deploy_source/.env.local" ]] || exit 96
    if find "$deploy_source" -type l -print -quit | grep -q .; then
      exit 96
    fi
    if grep -R -Fq -- 'UNTRACKED_DEPLOY_SECRET_SENTINEL' "$deploy_source"; then
      exit 97
    fi
    if [[ -n "${ANALYSIS_V2_WORKER_SOURCE_DIR:-}" ]]; then
      [[ "$(cd -P "$deploy_source" && pwd -P)" \
        != "$(cd -P "$ANALYSIS_V2_WORKER_SOURCE_DIR" && pwd -P)" ]] || exit 98
    fi
    if [[ -n "${FAKE_GCLOUD_DEPLOY_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >"$FAKE_GCLOUD_DEPLOY_LOG"
    fi
    if [[ -n "${FAKE_GCLOUD_DEPLOY_SOURCE_MANIFEST:-}" ]]; then
      (cd "$deploy_source" && find . -type f -print | LC_ALL=C sort) \
        >"$FAKE_GCLOUD_DEPLOY_SOURCE_MANIFEST"
    fi
    if [[ -n "${FAKE_GCLOUD_DEPLOY_SOURCE_PATH:-}" ]]; then
      printf '%s\n' "$deploy_source" >"$FAKE_GCLOUD_DEPLOY_SOURCE_PATH"
    fi
    if [[ "${FAKE_GCLOUD_FIRST_DEPLOY:-false}" == "true" ]]; then
      [[ "$command_line" != *"--no-traffic"* ]] || exit 98
    else
      [[ "$command_line" == *"--no-traffic"* ]] || exit 98
    fi
    source_commit="${FAKE_GCLOUD_SOURCE_COMMIT:-}"
    [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || exit 98
    [[ "$command_line" == *"--update-labels=analysis-v2-source-commit=$source_commit"* ]] \
      || exit 98
    [[ "$command_line" == *"--revision-suffix=b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"* ]] \
      || exit 98
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] || exit 99
    if [[ "$source_runtime_slot_applied" == "true" ]]; then
      printf 'staged_build\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      printf 'staged_build_inherited_slot\n' >"$FAKE_GCLOUD_STATE_FILE"
    fi
    ;;
  "run services update-traffic"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] || exit 99
    source_commit="${FAKE_GCLOUD_SOURCE_COMMIT:-}"
    target=''
    for argument in "$@"; do
      [[ "$argument" == --to-revisions=* ]] && target="${argument#--to-revisions=}"
    done
    if [[ "$target" == "analysis-worker-f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}=100" ]]; then
      printf 'promoted\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$target" == 'analysis-worker-00002=100' ]]; then
      printf 'rolled_back\n' >"$FAKE_GCLOUD_STATE_FILE"
    elif [[ "$target" == "analysis-worker-b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}=100" ]]; then
      printf 'rolled_back_bootstrap\n' >"$FAKE_GCLOUD_STATE_FILE"
    else
      exit 98
    fi
    if [[ -n "${FAKE_GCLOUD_TRAFFIC_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_TRAFFIC_LOG"
    fi
    if [[ -n "${FAKE_GCLOUD_EVENT_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_EVENT_LOG"
    fi
    ;;
  "run services update"*)
    [[ -n "${FAKE_GCLOUD_STATE_FILE:-}" ]] || exit 99
    source_commit="${FAKE_GCLOUD_SOURCE_COMMIT:-}"
    expected_image='asia-northeast3-docker.pkg.dev/test-project/cloud-run-source-deploy/analysis-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    [[ "$command_line" == *"--no-traffic"* ]] || exit 98
    [[ "$command_line" == *"--image=$expected_image"* ]] || exit 98
    [[ "$command_line" == *"--update-labels=analysis-v2-source-commit=$source_commit"* ]] \
      || exit 98
    [[ "$command_line" == *"--revision-suffix=f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"* ]] \
      || exit 98
    if [[ -n "${FAKE_GCLOUD_ENDPOINT_UPDATE_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >"$FAKE_GCLOUD_ENDPOINT_UPDATE_LOG"
    fi
    printf 'staged_final\n' >"$FAKE_GCLOUD_STATE_FILE"
    ;;
  "run services list"*)
    [[ "$command_line" == *"--project=test-project"* \
      && "$command_line" == *"--region=asia-northeast3"* \
      && "$command_line" == *"--filter=metadata.name=analysis-worker"* \
      && "$command_line" == *"--format=json"* ]] || exit 98
    if [[ "$state" == "service_list_failure" ]]; then
      printf 'PERMISSION_DENIED SECRET_SERVICE_LOOKUP_SENTINEL_MUST_NOT_BE_PRINTED\n' >&2
      exit 73
    elif [[ "$state" == "service_list_invalid_json" ]]; then
      printf '{not-json\n'
    elif [[ "$state" == "service_list_duplicate" ]]; then
      printf '[{"metadata":{"name":"analysis-worker"}},{"metadata":{"name":"analysis-worker"}}]\n'
    elif [[ "$infra_ready" == "true" ]]; then
      printf '[{"metadata":{"name":"analysis-worker"}}]\n'
    else
      printf '[]\n'
    fi
    ;;
  "run services describe"*)
    if [[ "$state" == "service_describe_failure" ]]; then
      printf 'UNAVAILABLE SECRET_SERVICE_DESCRIBE_SENTINEL_MUST_NOT_BE_PRINTED\n' >&2
      exit 74
    elif [[ "$state" == "service_describe_invalid_json" ]]; then
      printf '{invalid-describe-json\n'
      exit 0
    fi
    if [[ "$infra_ready" != "true" ]]; then
      exit 1
    elif [[ "$command_line" == *"format=json"* ]]; then
      latest_created='analysis-worker-00002'
      latest_ready='analysis-worker-00002'
      traffic_revision='analysis-worker-00002'
      # Match Cloud Run: no-traffic staging leaves latestReady on the serving revision.
      source_commit="${FAKE_GCLOUD_SOURCE_COMMIT:-0000000000000000000000000000000000000000}"
      if [[ "$state" == "staged_build" \
        || "$state" == "staged_build_inherited_slot" ]]; then
        latest_created="analysis-worker-b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        if [[ "${FAKE_GCLOUD_FIRST_DEPLOY:-false}" == "true" \
          || "${FAKE_GCLOUD_ACTIVE_BOOTSTRAP:-false}" == "true" ]]; then
          latest_ready="$latest_created"
          traffic_revision="$latest_created"
        fi
      elif [[ "$state" == "staged_final" ]]; then
        latest_created="analysis-worker-f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        if [[ "${FAKE_GCLOUD_FIRST_DEPLOY:-false}" == "true" \
          || "${FAKE_GCLOUD_ACTIVE_BOOTSTRAP:-false}" == "true" ]]; then
          latest_ready="analysis-worker-b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
          traffic_revision="analysis-worker-b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        fi
      elif [[ "$state" == "promoted" ]]; then
        latest_created="analysis-worker-f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        latest_ready="$latest_created"
        traffic_revision="$latest_created"
      elif [[ "$state" == "rolled_back" ]]; then
        latest_created="analysis-worker-f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        latest_ready="$latest_created"
      elif [[ "$state" == "rolled_back_bootstrap" ]]; then
        latest_created="analysis-worker-f${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
        latest_ready="$latest_created"
        traffic_revision="analysis-worker-b${source_commit:0:6}${ANALYSIS_V2_DEPLOY_REVISION_NONCE:-}"
      elif [[ "$state" == "foreign_promoted" ]]; then
        latest_created='analysis-worker-foreign'
        latest_ready="$latest_created"
        traffic_revision="$latest_created"
      fi
      runtime_queue='analysis-v2-pipeline'
      credential_name=''
      runtime_slot="${FAKE_GCLOUD_RUNTIME_SLOT:-quinary}"
      worker_gate='false'
      recovery_gate='false'
      selfhosted_global_gate='true'
      selfhosted_global_interval='750'
      selfhosted_response_guard='100'
      apify_secret_slots="${FAKE_GCLOUD_APIFY_SECRET_SLOTS:-quinary}"
      apify_secret_version="${FAKE_GCLOUD_APIFY_SECRET_VERSION:-7}"
      apify_plaintext_slot="${FAKE_GCLOUD_APIFY_PLAINTEXT_SLOT:-}"
      apify_bad_ref_slot="${FAKE_GCLOUD_APIFY_BAD_REF_SLOT:-}"
      identity_hmac_mode="${FAKE_GCLOUD_IDENTITY_HMAC_MODE:-canonical}"
      identity_hmac_version="${FAKE_GCLOUD_IDENTITY_HMAC_VERSION:-7}"
      supabase_plaintext='false'
      sidecar='false'
      placement='false'
      duplicate_env='false'
      admission_env='false'
      legacy_gate_env='false'
      [[ "$state" != "failed_latest" ]] || latest_ready='analysis-worker-00001'
      [[ "$state" != "old_traffic" ]] || traffic_revision='analysis-worker-00001'
      [[ "$state" != "unpromoted_latest" ]] || latest_created='analysis-worker-unpromoted'
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
      [[ "$state" != "runtime_selfhosted_global_gate_drift" ]] \
        || selfhosted_global_gate='false'
      [[ "$state" != "runtime_selfhosted_global_interval_drift" ]] \
        || selfhosted_global_interval='749'
      [[ "$state" != "runtime_selfhosted_response_guard_drift" ]] \
        || selfhosted_response_guard='101'
      if [[ "$state" == "staged_build" || "$state" == "staged_final" \
        || "$state" == "promoted" || "$state" == "rolled_back" \
        || "$state" == "rolled_back_bootstrap" ]]; then
        runtime_slot="${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-quinary}"
      fi
      if [[ "$state" == "staged_build" \
        || "$state" == "staged_build_inherited_slot" \
        || "$state" == "staged_final" || "$state" == "promoted" \
        || "$state" == "rolled_back" || "$state" == "rolled_back_bootstrap" ]]; then
        case ",$apify_secret_slots," in
          *",${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-quinary},"*) ;;
          *) apify_secret_slots="$apify_secret_slots,${ANALYSIS_V2_APIFY_API_TOKEN_SLOT:-quinary}" ;;
        esac
      fi
      if [[ "$state" == "staged_final" || "$state" == "promoted" \
        || "$state" == "rolled_back" || "$state" == "rolled_back_bootstrap" ]]; then
        worker_gate="${ANALYSIS_V2_WORKER_ENABLED:-false}"
        recovery_gate="${ANALYSIS_V2_RECOVERY_ENABLED:-false}"
      fi
      jq -nc \
        --arg latest_created "$latest_created" \
        --arg latest_ready "$latest_ready" \
        --arg traffic_revision "$traffic_revision" \
        --arg source_commit "$source_commit" \
        --arg runtime_queue "$runtime_queue" \
        --arg credential_name "$credential_name" \
        --arg runtime_slot "$runtime_slot" \
        --arg worker_gate "$worker_gate" \
        --arg recovery_gate "$recovery_gate" \
        --arg selfhosted_global_gate "$selfhosted_global_gate" \
        --arg selfhosted_global_interval "$selfhosted_global_interval" \
        --arg selfhosted_response_guard "$selfhosted_response_guard" \
        --arg apify_secret_slots "$apify_secret_slots" \
        --arg apify_secret_version "$apify_secret_version" \
        --arg apify_plaintext_slot "$apify_plaintext_slot" \
        --arg apify_bad_ref_slot "$apify_bad_ref_slot" \
        --arg identity_hmac_mode "$identity_hmac_mode" \
        --arg identity_hmac_version "$identity_hmac_version" \
        --argjson supabase_plaintext "$supabase_plaintext" \
        --argjson sidecar "$sidecar" \
        --argjson placement "$placement" \
      --argjson duplicate_env "$duplicate_env" \
      --argjson admission_env "$admission_env" \
      --argjson legacy_gate_env "$legacy_gate_env" \
      --argjson traffic_tagged "${FAKE_GCLOUD_TRAFFIC_TAGGED:-false}" '
        {
          metadata: {
            name: "analysis-worker",
            labels: {"analysis-v2-source-commit": $source_commit},
            annotations: {
              "run.googleapis.com/ingress": "all",
              "run.googleapis.com/invoker-iam-disabled": "false",
              "run.googleapis.com/minScale": "0",
              "run.googleapis.com/maxScale": "1"
            }
          },
          spec: {template: {
            metadata: {
              labels: {"analysis-v2-source-commit": $source_commit},
              annotations: {
                "run.googleapis.com/execution-environment": "gen2",
                "run.googleapis.com/cpu-throttling": "true",
                "run.googleapis.com/startup-cpu-boost": "true",
                "autoscaling.knative.dev/maxScale": "1"
              }
            },
            spec: {
              serviceAccountName: "analysis-recovery@test-project.iam.gserviceaccount.com",
              timeoutSeconds: 300,
              containerConcurrency: 8,
              containers: ([{
                resources: {limits: {cpu: "2", memory: "2Gi"}},
                env: ([
                  {name: "ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET", value: "test-project-analysis-v2-media"},
                  {name: "SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED", value: $selfhosted_global_gate},
                  {name: "SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS", value: $selfhosted_global_interval},
                  {name: "SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS", value: $selfhosted_response_guard},
                  {name: "ANALYSIS_V2_RESULT_IMAGES_ENABLED", value: "false"},
                  {name: "ANALYSIS_V2_TASKS_ENABLED", value: "true"},
                  {name: "ANALYSIS_V2_WORKER_ENABLED", value: $worker_gate},
                  {name: "ANALYSIS_V2_RECOVERY_ENABLED", value: $recovery_gate},
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
                  ($apify_secret_slots
                    | split(",")
                    | map(select(length > 0))
                    | map(. as $slot | {
                        name: ("APIFY_" + ($slot | ascii_upcase) + "_API_TOKEN"),
                        valueFrom: {secretKeyRef: {
                          name: (if $slot == $apify_bad_ref_slot
                            then "unexpected-apify-secret"
                            else "ai-baram-v2-apify-" + $slot
                            end),
                          key: $apify_secret_version
                        }}
                      }
                      | if $slot == $apify_plaintext_slot then
                          {name: .name, value: "APIFY_PLAINTEXT_SENTINEL_MUST_NOT_BE_PRINTED"}
                        else . end)),
                  {name: "IMAGE_PROXY_SIGNING_SECRET", valueFrom: {secretKeyRef: {name: "ai-baram-v2-image-proxy-signing", key: "7"}}},
                  (if $identity_hmac_mode == "absent" then []
                   elif $identity_hmac_mode == "plaintext" then [{
                     name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
                     value: "PLAINTEXT_HMAC_SENTINEL_MUST_NOT_BE_PRINTED"
                   }]
                   elif $identity_hmac_mode == "wrong-secret" then [{
                     name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
                     valueFrom: {secretKeyRef: {name: "wrong-preflight-hmac", key: $identity_hmac_version}}
                   }]
                   elif $identity_hmac_mode == "duplicate" then [{
                     name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
                     valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $identity_hmac_version}}
                   }, {
                     name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
                     valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $identity_hmac_version}}
                   }]
                   else [{
                     name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
                     valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $identity_hmac_version}}
                   }] end)
                ]
                  | flatten
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
            traffic: ([{revisionName: $traffic_revision, percent: 100}]
              + if $traffic_tagged then [{
                  revisionName: "analysis-worker-tagged",
                  percent: 0,
                  tag: "debug"
                }] else [] end)
          }
        }'
    elif [[ "$command_line" == *"serviceAccountName"* ]]; then
      printf 'analysis-recovery@test-project.iam.gserviceaccount.com\n'
    else
      printf 'analysis-worker\n'
    fi
    ;;
  "run revisions describe"*)
    revision="$4"
    source_commit="${FAKE_GCLOUD_SOURCE_COMMIT:-0000000000000000000000000000000000000000}"
    revision_ready='True'
    observe_revision='false'
    case "${FAKE_GCLOUD_REVISION_OBSERVATION_TARGET:-source-build}" in
      source-build)
        [[ "$revision" != analysis-worker-b* ]] || observe_revision='true'
        ;;
      all)
        observe_revision='true'
        ;;
      *)
        exit 98
        ;;
    esac
    if [[ "$observe_revision" == "true" \
      && -n "${FAKE_GCLOUD_REVISION_OBSERVATION_MODE:-}" ]]; then
      [[ -n "${FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE:-}" ]] || exit 98
      revision_observation_count='0'
      if [[ -f "$FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE" ]]; then
        revision_observation_count="$(<"$FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE")"
      fi
      [[ "$revision_observation_count" =~ ^[0-9]+$ ]] || exit 98
      revision_observation_count=$((10#$revision_observation_count + 1))
      printf '%s\n' "$revision_observation_count" \
        >"$FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE"
      case "$FAKE_GCLOUD_REVISION_OBSERVATION_MODE" in
        transient)
          if [[ "$revision_observation_count" == "1" ]]; then
            exit 75
          elif [[ "$revision_observation_count" == "2" ]]; then
            source_commit='ffffffffffffffffffffffffffffffffffffffff'
            revision_ready='False'
          fi
          ;;
        permanent_mismatch)
          source_commit='ffffffffffffffffffffffffffffffffffffffff'
          ;;
        *)
          exit 98
          ;;
      esac
    fi
    known_good_recovery="${FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED:-false}"
    active_runtime_slot="${FAKE_GCLOUD_ACTIVE_RUNTIME_SLOT:-quinary}"
    active_apify_secret_slots="${FAKE_GCLOUD_ACTIVE_APIFY_SECRET_SLOTS:-${FAKE_GCLOUD_APIFY_SECRET_SLOTS:-quinary}}"
    active_apify_secret_version="${FAKE_GCLOUD_ACTIVE_APIFY_SECRET_VERSION:-${FAKE_GCLOUD_APIFY_SECRET_VERSION:-7}}"
    active_identity_hmac_mode="${FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_MODE:-${FAKE_GCLOUD_IDENTITY_HMAC_MODE:-canonical}}"
    active_identity_hmac_version="${FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_VERSION:-${FAKE_GCLOUD_IDENTITY_HMAC_VERSION:-7}}"
    revision_image='asia-northeast3-docker.pkg.dev/test-project/cloud-run-source-deploy/analysis-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    bootstrap_revision='false'
    if [[ "$revision" == analysis-worker-b* \
      || "${FAKE_GCLOUD_ACTIVE_BOOTSTRAP:-false}" == "true" ]]; then
      bootstrap_revision='true'
    fi
    jq -nc \
      --arg revision "$revision" \
      --arg source_commit "$source_commit" \
      --arg known_good_recovery "$known_good_recovery" \
      --arg active_runtime_slot "$active_runtime_slot" \
      --arg active_apify_secret_slots "$active_apify_secret_slots" \
      --arg active_apify_secret_version "$active_apify_secret_version" \
      --arg active_identity_hmac_mode "$active_identity_hmac_mode" \
      --arg active_identity_hmac_version "$active_identity_hmac_version" \
      --arg revision_image "$revision_image" \
      --arg revision_ready "$revision_ready" \
      --argjson bootstrap_revision "$bootstrap_revision" '{
      metadata: {
        name: $revision,
        labels: {"analysis-v2-source-commit": $source_commit}
      },
      spec: {
        containers: [{image: $revision_image, env: ((
          if $bootstrap_revision then [
            {name: "ANALYSIS_V2_RECOVERY_ENABLED", value: "false"},
            {name: "ANALYSIS_V2_APIFY_API_TOKEN_SLOT", value: $active_runtime_slot}
          ] else [
            {name: "ANALYSIS_V2_TASKS_ENABLED", value: "true"},
            {name: "ANALYSIS_V2_WORKER_ENABLED", value: "false"},
            {name: "ANALYSIS_V2_RECOVERY_ENABLED", value: $known_good_recovery},
            {name: "ANALYSIS_V2_APIFY_API_TOKEN_SLOT", value: $active_runtime_slot},
            {name: "PREFLIGHT_TASKS_ENABLED", value: "true"},
            {name: "PREFLIGHT_LOCAL_AFTER_ENABLED", value: "false"}
          ] end)
          + ($active_apify_secret_slots
            | split(",")
            | map(select(length > 0))
            | map(. as $slot | {
                name: ("APIFY_" + ($slot | ascii_upcase) + "_API_TOKEN"),
                valueFrom: {secretKeyRef: {
                  name: ("ai-baram-v2-apify-" + $slot),
                  key: $active_apify_secret_version
                }}
              }))
          + (if $active_identity_hmac_mode == "absent" then []
             elif $active_identity_hmac_mode == "plaintext" then [{
               name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
               value: "PLAINTEXT_ACTIVE_HMAC_SENTINEL_MUST_NOT_BE_PRINTED"
             }]
             elif $active_identity_hmac_mode == "wrong-secret" then [{
               name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
               valueFrom: {secretKeyRef: {name: "wrong-preflight-hmac", key: $active_identity_hmac_version}}
             }]
             elif $active_identity_hmac_mode == "duplicate" then [{
               name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
               valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $active_identity_hmac_version}}
             }, {
               name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
               valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $active_identity_hmac_version}}
             }]
             else [{
               name: "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET",
               valueFrom: {secretKeyRef: {name: "ai-baram-v2-preflight-identity-hmac", key: $active_identity_hmac_version}}
             }] end))
        }]
      },
      status: {conditions: [{type: "Ready", status: $revision_ready}]}
    }'
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
    if [[ "$infra_ready" == "true" ]]; then
      [[ "${FAKE_GCLOUD_V2_QUEUE_MISSING:-false}" == "true" ]] \
        || printf '%s\n' 'analysis-v2-pipeline'
      printf '%s\n' 'analysis-preflight' 'analysis-pipeline'
    fi
    ;;
  "tasks queues describe"*)
    if [[ "$infra_ready" != "true" ]]; then
      exit 1
    elif [[ "${FAKE_GCLOUD_V2_QUEUE_MISSING:-false}" == "true" \
      && "$command_line" == *" analysis-v2-pipeline "* ]]; then
      exit 1
    elif [[ "${FAKE_GCLOUD_CONCURRENT_PROMOTION_ON_FAILURE:-false}" == "true" \
      && "$state" == "promoted" ]]; then
      printf 'foreign_promoted\n' >"$FAKE_GCLOUD_STATE_FILE"
      exit 1
    elif [[ "${FAKE_GCLOUD_POST_PROMOTION_QUEUE_FAILURE:-false}" == "true" \
      && "$state" == "promoted" ]]; then
      exit 1
    elif [[ "$command_line" == *"format=csv"* ]]; then
      if [[ "$command_line" == *" analysis-preflight "* ]]; then
        printf '2.0,2,8,1800s,40s,300s,4\n'
      else
        printf '8.0,8,8,3600s,40s,300s,4\n'
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
  "scheduler jobs list"*)
    [[ "${FAKE_GCLOUD_SCHEDULER_LIST_ERROR:-false}" != "true" ]] || exit 1
    if [[ "${FAKE_GCLOUD_SCHEDULER_MISSING:-false}" != "true" ]]; then
      printf '%s\n' \
        'projects/test-project/locations/asia-northeast3/jobs/analysis-v2-recovery' \
        'projects/test-project/locations/asia-northeast3/jobs/analysis-v2-preflight-retention'
    fi
    ;;
  "scheduler jobs describe"*)
    [[ "$infra_ready" == "true" ]] || exit 1
    [[ "${FAKE_GCLOUD_SCHEDULER_MISSING:-false}" != "true" ]] || exit 1
    if [[ "${FAKE_GCLOUD_POST_PROMOTION_FAILURE:-false}" == "true" \
      && "$state" == "promoted" ]]; then
      exit 1
    fi
    job="$4"
    if [[ "$job" == "analysis-v2-recovery" ]]; then
      schedule='* * * * *'
      uri='https://analysis-worker-test.asia-northeast3.run.app/api/analysis/v2/recover'
      deadline='300s'
      scheduler_state=''
      if [[ -n "${FAKE_GCLOUD_SCHEDULER_STATE_FILE:-}" \
        && -f "$FAKE_GCLOUD_SCHEDULER_STATE_FILE" ]]; then
        scheduler_state="$(<"$FAKE_GCLOUD_SCHEDULER_STATE_FILE")"
      fi
      if [[ -z "$scheduler_state" ]]; then
        if [[ "${ANALYSIS_V2_RECOVERY_ENABLED:-false}" == "true" ]]; then
          scheduler_state='ENABLED'
        else
          scheduler_state='PAUSED'
        fi
      fi
    elif [[ "$job" == "analysis-v2-preflight-retention" ]]; then
      schedule='*/5 * * * *'
      uri='https://analysis-worker-test.asia-northeast3.run.app/api/analysis/preflight/retention'
      deadline='60s'
      scheduler_state=''
      if [[ -n "${FAKE_GCLOUD_RETENTION_STATE_FILE:-}" \
        && -f "$FAKE_GCLOUD_RETENTION_STATE_FILE" ]]; then
        scheduler_state="$(<"$FAKE_GCLOUD_RETENTION_STATE_FILE")"
      fi
      scheduler_state="${scheduler_state:-ENABLED}"
    else
      exit 90
    fi
    audience='https://analysis-worker-test.asia-northeast3.run.app'
    recovery_drift="${FAKE_GCLOUD_RECOVERY_DRIFT:-false}"
    if [[ "${FAKE_GCLOUD_RECOVERY_DRIFT_ON_ROLLBACK:-false}" == "true" \
      && "$state" == "rolled_back" ]]; then
      recovery_drift='true'
    fi
    [[ "${FAKE_GCLOUD_SCHEDULER_DRIFT:-false}" != "true" \
      && !( "$job" == "analysis-v2-preflight-retention" \
        && "${FAKE_GCLOUD_RETENTION_DRIFT:-false}" == "true" ) \
      && !( "$job" == "analysis-v2-recovery" \
        && "$recovery_drift" == "true" ) ]] \
      || audience='https://wrong.example.test'
    jq -nc --arg schedule "$schedule" --arg uri "$uri" --arg deadline "$deadline" --arg audience "$audience" --arg scheduler_state "$scheduler_state" '{
      schedule: $schedule,
      timeZone: "Etc/UTC",
      state: $scheduler_state,
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
  "scheduler jobs pause"*)
    job="$4"
    if [[ -n "${FAKE_GCLOUD_SCHEDULER_MUTATION_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_SCHEDULER_MUTATION_LOG"
    fi
    if [[ "$job" == "analysis-v2-recovery" \
      && -n "${FAKE_GCLOUD_SCHEDULER_STATE_FILE:-}" ]]; then
      printf 'PAUSED\n' >"$FAKE_GCLOUD_SCHEDULER_STATE_FILE"
    elif [[ "$job" == "analysis-v2-preflight-retention" \
      && -n "${FAKE_GCLOUD_RETENTION_STATE_FILE:-}" ]]; then
      printf 'PAUSED\n' >"$FAKE_GCLOUD_RETENTION_STATE_FILE"
    fi
    if [[ -n "${FAKE_GCLOUD_EVENT_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_EVENT_LOG"
    fi
    ;;
  "scheduler jobs resume"*)
    job="$4"
    if [[ -n "${FAKE_GCLOUD_SCHEDULER_MUTATION_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_SCHEDULER_MUTATION_LOG"
    fi
    if [[ "$job" == "analysis-v2-recovery" \
      && -n "${FAKE_GCLOUD_SCHEDULER_STATE_FILE:-}" ]]; then
      printf 'ENABLED\n' >"$FAKE_GCLOUD_SCHEDULER_STATE_FILE"
    elif [[ "$job" == "analysis-v2-preflight-retention" \
      && -n "${FAKE_GCLOUD_RETENTION_STATE_FILE:-}" ]]; then
      printf 'ENABLED\n' >"$FAKE_GCLOUD_RETENTION_STATE_FILE"
    fi
    if [[ -n "${FAKE_GCLOUD_EVENT_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_EVENT_LOG"
    fi
    ;;
  "storage cp"*)
    lock_file="${FAKE_GCLOUD_DEPLOY_LOCK_FILE:-${FAKE_GCLOUD_STATE_FILE:-/tmp/analysis-v2-fake}.deploy-lock}"
    [[ "$command_line" == *"--if-generation-match=0"* ]] || exit 98
    [[ "$command_line" == *"gs://analysis-v2-lock-0123456789abcdef0123456789abcdef/asia-northeast3/analysis-worker.lock"* ]] \
      || exit 98
    [[ ! -e "$lock_file" ]] || exit 1
    grep -Eq '^[0-9a-f]{40} [a-z0-9]{5} [a-f0-9]{32}$' "$3" \
      || exit 98
    cp "$3" "$lock_file"
    if [[ -n "${FAKE_GCLOUD_EVENT_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_EVENT_LOG"
    fi
    [[ "${FAKE_GCLOUD_LOCK_CP_AMBIGUOUS_SUCCESS:-false}" != "true" ]] \
      || exit 1
    ;;
  "storage objects describe"*)
    lock_file="${FAKE_GCLOUD_DEPLOY_LOCK_FILE:-${FAKE_GCLOUD_STATE_FILE:-/tmp/analysis-v2-fake}.deploy-lock}"
    [[ -e "$lock_file" ]] || exit 1
    if [[ "${FAKE_GCLOUD_LOCK_REPLACED_BEFORE_DESCRIBE:-false}" == "true" ]]; then
      printf 'foreign deployment\n' >"$lock_file"
      printf '23\n'
    else
      printf '17\n'
    fi
    ;;
  "storage cat"*)
    lock_file="${FAKE_GCLOUD_DEPLOY_LOCK_FILE:-${FAKE_GCLOUD_STATE_FILE:-/tmp/analysis-v2-fake}.deploy-lock}"
    lock_generation='17'
    [[ "${FAKE_GCLOUD_LOCK_REPLACED_BEFORE_DESCRIBE:-false}" != "true" ]] \
      || lock_generation='23'
    [[ "$command_line" == *"#$lock_generation"* && -e "$lock_file" ]] || exit 1
    cat "$lock_file"
    ;;
  "storage rm"*)
    lock_file="${FAKE_GCLOUD_DEPLOY_LOCK_FILE:-${FAKE_GCLOUD_STATE_FILE:-/tmp/analysis-v2-fake}.deploy-lock}"
    lock_generation='17'
    [[ "${FAKE_GCLOUD_LOCK_REPLACED_BEFORE_DESCRIBE:-false}" != "true" ]] \
      || lock_generation='23'
    [[ "$command_line" == *"--if-generation-match=$lock_generation"* ]] || exit 98
    [[ -e "$lock_file" ]] || exit 1
    rm -f "$lock_file"
    if [[ -n "${FAKE_GCLOUD_EVENT_LOG:-}" ]]; then
      printf '%s\n' "$command_line" >>"$FAKE_GCLOUD_EVENT_LOG"
    fi
    ;;
  *)
    printf 'unexpected fake gcloud command: %s\n' "$command_line" >&2
    exit 90
    ;;
esac
EOF
chmod +x "$temp_dir/bin/gcloud"

cat >"$temp_dir/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == "1" && "$1" =~ ^[0-9]+$ ]] || exit 98
if [[ -n "${FAKE_SLEEP_LOG:-}" ]]; then
  printf '%s\n' "$1" >>"$FAKE_SLEEP_LOG"
fi
EOF
chmod +x "$temp_dir/bin/sleep"

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
SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED="true"
SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS="750"
SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS="100"
EOF

cat >"$temp_dir/runtime-provider-secret.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="quinary"
APIFY_QUINARY_API_TOKEN="SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/runtime-quoted-secret.yaml" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: "test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT: "quinary"
"APIFY_QUINARY_API_TOKEN": "QUOTED_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/runtime-quoted-gate.yaml" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: "test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT: "quinary"
"ANALYSIS_V2_TASKS_ENABLED": "true"
EOF

cat >"$temp_dir/runtime-wrong-slot.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="primary"
EOF

cat >"$temp_dir/runtime-secondary-slot.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_APIFY_API_TOKEN_SLOT="secondary"
SELFHOSTED_PROFILE_GLOBAL_GATE_ENABLED="true"
SELFHOSTED_PROFILE_GLOBAL_MIN_INTERVAL_MS="750"
SELFHOSTED_PROFILE_GLOBAL_RESPONSE_GUARD_MS="100"
EOF

cat >"$temp_dir/build.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: "PUBLIC_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
EOF

cat >"$temp_dir/build-secret.yaml" <<'EOF'
SUPABASE_SERVICE_ROLE_KEY: "SECRET_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
EOF
cat >"$temp_dir/build-quoted-secret.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon"
"SOME_API_KEY": "QUOTED_BUILD_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
EOF
cat >"$temp_dir/build-duplicate.yaml" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL: "https://fixture.example.test"
"NEXT_PUBLIC_SUPABASE_URL": "https://duplicate.example.test"
NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon"
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

cat >"$temp_dir/runtime-r2-credential.env" <<'EOF'
ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET="test-project-analysis-v2-media"
ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY="R2_RUNTIME_CREDENTIAL_SENTINEL_MUST_NOT_BE_PRINTED"
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

repo_source_commit="$(git -C "$script_dir/.." rev-parse --verify 'HEAD^{commit}')"
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
  'ANALYSIS_V2_DEPLOY_LOCK_BUCKET=analysis-v2-lock-0123456789abcdef0123456789abcdef'
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=quinary'
  'ANALYSIS_V2_SUPABASE_SERVICE_ROLE_SECRET_VERSION=7'
  'ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=7'
  'ANALYSIS_V2_IMAGE_PROXY_SIGNING_SECRET_VERSION=7'
  'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION=7'
  'ANALYSIS_V2_WORKER_ENABLED=false'
  'ANALYSIS_V2_RECOVERY_ENABLED=false'
  'ANALYSIS_V2_DEPLOY_REVISION_NONCE=abc12'
  "FAKE_GCLOUD_SOURCE_COMMIT=$repo_source_commit"
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml"
)

missing_deploy_lock_env=()
for item in "${common_env[@]}"; do
  [[ "$item" == ANALYSIS_V2_DEPLOY_LOCK_BUCKET=* ]] \
    || missing_deploy_lock_env+=("$item")
done
if env -u ANALYSIS_V2_DEPLOY_LOCK_BUCKET "${missing_deploy_lock_env[@]}" \
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" --check \
  >"$temp_dir/deploy-lock-missing-env.out" 2>&1; then
  fail "deploy-lock configuration accepted a missing persistent bucket name"
fi
assert_contains "$temp_dir/deploy-lock-missing-env.out" \
  "missing required environment variable: ANALYSIS_V2_DEPLOY_LOCK_BUCKET"
if env -u ANALYSIS_V2_DEPLOY_LOCK_BUCKET "${missing_deploy_lock_env[@]}" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-deploy-lock-missing-env.out" 2>&1; then
  fail "worker deployment accepted a missing persistent deploy-lock bucket name"
fi
assert_contains "$temp_dir/worker-deploy-lock-missing-env.out" \
  "ANALYSIS_V2_DEPLOY_LOCK_BUCKET is required"

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

unconfigured_legacy_enqueuer_env=()
for item in "${common_env[@]}"; do
  [[ "$item" == ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=* ]] \
    || unconfigured_legacy_enqueuer_env+=("$item")
done
unconfigured_legacy_enqueuer_env+=(
  'ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true'
)
env -u ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  "${unconfigured_legacy_enqueuer_env[@]}" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-v1-enqueuer-unconfigured.out"
assert_contains "$temp_dir/identity-v1-enqueuer-unconfigured.out" \
  "V1 enqueuer service-account identity is explicitly unconfigured"

if env -u ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  "${unconfigured_legacy_enqueuer_env[@]}" \
  'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL=legacy-task@test-project.iam.gserviceaccount.com' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-v1-task-reuse-with-unconfigured-enqueuer.out" 2>&1; then
  fail "V1 task identity was reused by V2 when the V1 enqueuer is explicitly unconfigured"
fi
assert_contains "$temp_dir/identity-v1-task-reuse-with-unconfigured-enqueuer.out" \
  "V2 identities must not reuse a V1 task or enqueuer identity"

if env "${common_env[@]}" \
  'ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true' \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-v1-enqueuer-mutually-exclusive.out" 2>&1; then
  fail "V1 enqueuer identity and unconfigured declaration must be mutually exclusive"
fi
assert_contains "$temp_dir/identity-v1-enqueuer-mutually-exclusive.out" \
  "ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL and ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED are mutually exclusive"

missing_legacy_enqueuer_env=()
for item in "${unconfigured_legacy_enqueuer_env[@]}"; do
  [[ "$item" == ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=* ]] \
    || missing_legacy_enqueuer_env+=("$item")
done
missing_legacy_enqueuer_env+=(
  'ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=false'
)
if env -u ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  "${missing_legacy_enqueuer_env[@]}" \
  bash "$script_dir/configure-analysis-v2-worker-identity.sh" --dry-run \
  >"$temp_dir/identity-v1-enqueuer-missing.out" 2>&1; then
  fail "V1 enqueuer identity must be present without the explicit unconfigured declaration"
fi
assert_contains "$temp_dir/identity-v1-enqueuer-missing.out" \
  "ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL is required unless ANALYSIS_V1_TASKS_ENQUEUER_UNCONFIGURED=true"

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
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" --check \
  >"$temp_dir/deploy-lock-check.out"
assert_contains "$temp_dir/deploy-lock-check.out" \
  "only the configured deployer can access deploy locks"
assert_contains "$temp_dir/deploy-lock-check.out" \
  "Analysis V2 deploy-lock coordination bucket verified"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=identity_ready' \
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" --dry-run \
  >"$temp_dir/deploy-lock-create-dry-run.out"
assert_contains "$temp_dir/deploy-lock-create-dry-run.out" \
  "gcloud storage buckets create gs://analysis-v2-lock-0123456789abcdef0123456789abcdef"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'FAKE_GCLOUD_LOCK_IAM_RUNTIME=true' \
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" --check \
  >"$temp_dir/deploy-lock-runtime-iam.out" 2>&1; then
  fail "runtime identity access to the deploy-lock bucket was accepted"
fi
assert_contains "$temp_dir/deploy-lock-runtime-iam.out" \
  "deploy-lock bucket IAM is not exact"

: >"$temp_dir/deploy-lock-foreign-project-mutations.out"
if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'FAKE_GCLOUD_LOCK_BUCKET_PROJECT_NUMBER=999999999999' \
  "FAKE_GCLOUD_STORAGE_MUTATION_LOG=$temp_dir/deploy-lock-foreign-project-mutations.out" \
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" \
  >"$temp_dir/deploy-lock-foreign-project.out" 2>&1; then
  fail "foreign-project deploy-lock bucket was accepted"
fi
assert_contains "$temp_dir/deploy-lock-foreign-project.out" \
  "belongs to another project or location; refusing to mutate it"
[[ ! -s "$temp_dir/deploy-lock-foreign-project-mutations.out" ]] \
  || fail "foreign-project deploy-lock bucket was mutated before ownership validation"

: >"$temp_dir/deploy-lock-wrong-location-mutations.out"
if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'FAKE_GCLOUD_LOCK_BUCKET_LOCATION=US-CENTRAL1' \
  "FAKE_GCLOUD_STORAGE_MUTATION_LOG=$temp_dir/deploy-lock-wrong-location-mutations.out" \
  bash "$script_dir/configure-analysis-v2-deploy-lock.sh" \
  >"$temp_dir/deploy-lock-wrong-location.out" 2>&1; then
  fail "wrong-location deploy-lock bucket was accepted"
fi
assert_contains "$temp_dir/deploy-lock-wrong-location.out" \
  "belongs to another project or location; refusing to mutate it"
[[ ! -s "$temp_dir/deploy-lock-wrong-location-mutations.out" ]] \
  || fail "wrong-location deploy-lock bucket was mutated before location validation"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker.out"
assert_contains "$temp_dir/worker.out" "gcloud run deploy analysis-worker"
assert_not_contains "$temp_dir/worker.out" "--ignore-file"
assert_contains "$temp_dir/worker.out" "--concurrency=8"
assert_contains "$temp_dir/worker.out" "--max=1"
assert_contains "$temp_dir/worker.out" "--cpu-throttling"
assert_contains "$temp_dir/worker.out" "--clear-network"
assert_contains "$temp_dir/worker.out" "--deploy-health-check"
assert_not_contains "$temp_dir/worker.out" "--no-traffic"
assert_contains "$temp_dir/worker.out" \
  "--update-labels=analysis-v2-source-commit=$repo_source_commit"
assert_contains "$temp_dir/worker.out" \
  "--build-service-account=projects/test-project/serviceAccounts/analysis-build@test-project.iam.gserviceaccount.com"
assert_contains "$temp_dir/worker.out" \
  "--set-secrets=SUPABASE_SERVICE_ROLE_KEY=ai-baram-v2-supabase-service-role:7\\,APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:7\\,IMAGE_PROXY_SIGNING_SECRET=ai-baram-v2-image-proxy-signing:7\\,ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET=ai-baram-v2-preflight-identity-hmac:7"
assert_contains "$temp_dir/worker.out" "roles/run.invoker will contain only task and maintenance OIDC identities"
assert_not_contains "$temp_dir/worker.out" "SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
assert_not_contains "$temp_dir/worker.out" "PUBLIC_BUILD_SENTINEL_MUST_NOT_BE_PRINTED"
assert_contains "$temp_dir/worker.out" \
  "verifying prerequisite order: worker identity -> secrets -> media bucket -> worker deploy"
assert_contains "$temp_dir/worker.out" \
  "deploy-lock bucket metadata and IAM are audited separately by an admin"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_RESULT_IMAGES_ENABLED=true' \
  'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' \
  'ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET=analysis-v2-result-images' \
  'ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID_SECRET_VERSION=3' \
  'ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY_SECRET_VERSION=4' \
  'ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET_VERSION=5' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-result-images.out"
assert_contains "$temp_dir/worker-result-images.out" \
  "ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID=ai-baram-v2-r2-writer-access-key-id:3"
assert_contains "$temp_dir/worker-result-images.out" \
  "ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY=ai-baram-v2-r2-writer-secret-access-key:4"
assert_contains "$temp_dir/worker-result-images.out" \
  "ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET=ai-baram-v2-result-image-object-hmac:5"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-result-images-partial.out" 2>&1; then
  fail "partial retained result-image configuration was accepted while disabled"
fi
assert_contains "$temp_dir/worker-result-images-partial.out" \
  "require ANALYSIS_V2_RESULT_IMAGES_ENABLED=true"

env -u ANALYSIS_V1_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  "${unconfigured_legacy_enqueuer_env[@]}" \
  'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-v1-enqueuer-unconfigured.out"
assert_contains "$temp_dir/worker-v1-enqueuer-unconfigured.out" \
  "V1 enqueuer service-account identity is explicitly unconfigured"

for lookup_failure_state in \
  service_list_failure \
  service_describe_failure \
  service_describe_invalid_json \
  service_list_invalid_json \
  service_list_duplicate; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$lookup_failure_state" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-$lookup_failure_state.out" 2>&1; then
    fail "Cloud Run lookup failure was treated as a first deployment: $lookup_failure_state"
  fi
  assert_contains "$temp_dir/worker-$lookup_failure_state.out" \
    'Cloud Run worker lookup failed; refusing to infer a first deployment'
  assert_not_contains "$temp_dir/worker-$lookup_failure_state.out" \
    'first deployment has no prior traffic revision'
  assert_not_contains "$temp_dir/worker-$lookup_failure_state.out" \
    'gcloud run deploy analysis-worker'
  assert_not_contains "$temp_dir/worker-$lookup_failure_state.out" '--no-traffic'
done
assert_contains "$temp_dir/worker-service_list_failure.out" \
  'category=permission-denied'
assert_contains "$temp_dir/worker-service_describe_failure.out" \
  'category=transport-unavailable'
assert_not_contains "$temp_dir/worker-service_list_failure.out" \
  'SECRET_SERVICE_LOOKUP_SENTINEL_MUST_NOT_BE_PRINTED'
assert_not_contains "$temp_dir/worker-service_describe_failure.out" \
  'SECRET_SERVICE_DESCRIBE_SENTINEL_MUST_NOT_BE_PRINTED'

deploy_source_repo="$temp_dir/deploy-source-repo"
mkdir -p "$deploy_source_repo/scripts"
git -C "$temp_dir" init -q deploy-source-repo
git -C "$deploy_source_repo" config user.email test@example.test
git -C "$deploy_source_repo" config user.name Test
printf '{"private":true}\n' >"$deploy_source_repo/package.json"
printf 'tracked deploy source\n' >"$deploy_source_repo/deploy-marker.txt"
printf '.env.local\n' >"$deploy_source_repo/.gitignore"
cp "$script_dir/analysis-v2-source.gcloudignore" \
  "$deploy_source_repo/scripts/analysis-v2-source.gcloudignore"
git -C "$deploy_source_repo" add .gitignore deploy-marker.txt package.json scripts
git -C "$deploy_source_repo" commit -qm initial
deploy_source_commit="$(git -C "$deploy_source_repo" rev-parse --verify 'HEAD^{commit}')"
printf 'UNTRACKED_DEPLOY_SECRET_SENTINEL\n' >"$deploy_source_repo/.env.local"
printf 'prerequisites_ready\n' >"$temp_dir/deploy-state"
printf '0\n' >"$temp_dir/transient-revision-observation-count"
: >"$temp_dir/transient-revision-sleep.out"
env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/deploy-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_REVISION_OBSERVATION_MODE=transient' \
  "FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE=$temp_dir/transient-revision-observation-count" \
  "FAKE_SLEEP_LOG=$temp_dir/transient-revision-sleep.out" \
  'FAKE_GCLOUD_LOCK_BUCKET_ADMIN_READ_DENIED=true' \
  'FAKE_GCLOUD_LOCK_CP_AMBIGUOUS_SUCCESS=true' \
  'FAKE_GCLOUD_FIRST_DEPLOY=true' \
  "FAKE_GCLOUD_DEPLOY_LOG=$temp_dir/deploy-command.out" \
  "FAKE_GCLOUD_ENDPOINT_UPDATE_LOG=$temp_dir/deploy-endpoint-update.out" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/deploy-traffic.out" \
  "FAKE_GCLOUD_DEPLOY_SOURCE_MANIFEST=$temp_dir/deploy-source-manifest.out" \
  "FAKE_GCLOUD_DEPLOY_SOURCE_PATH=$temp_dir/deploy-source-path.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/worker-apply.out"
assert_contains "$temp_dir/worker-apply.out" \
  "verified: source deploy uses a clean tracked commit archive"
assert_contains "$temp_dir/worker-apply.out" \
  "adopted this deployment's generation-bound lock after an ambiguous create response"
[[ "$(<"$temp_dir/transient-revision-observation-count")" == "3" ]] \
  || fail "apply did not retry transient source-build revision observations"
[[ "$(wc -l <"$temp_dir/transient-revision-sleep.out" | tr -d ' ')" == "2" ]] \
  || fail "apply did not back off between transient revision observations"
[[ ! -e "$temp_dir/deploy-state.deploy-lock" ]] \
  || fail "an ambiguously successful self-owned deploy lock was not released"
assert_contains "$temp_dir/deploy-command.out" "run deploy analysis-worker"
assert_not_contains "$temp_dir/deploy-command.out" "--ignore-file"
assert_not_contains "$temp_dir/deploy-command.out" "--no-traffic"
assert_contains "$temp_dir/deploy-command.out" \
  "--update-labels=analysis-v2-source-commit=$deploy_source_commit"
assert_contains "$temp_dir/deploy-endpoint-update.out" "--no-traffic"
assert_contains "$temp_dir/deploy-endpoint-update.out" \
  "--image=asia-northeast3-docker.pkg.dev/test-project/cloud-run-source-deploy/analysis-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert_contains "$temp_dir/deploy-endpoint-update.out" \
  "--update-labels=analysis-v2-source-commit=$deploy_source_commit"
assert_contains "$temp_dir/deploy-endpoint-update.out" \
  "--revision-suffix=f${deploy_source_commit:0:6}abc12"
assert_contains "$temp_dir/deploy-traffic.out" \
  "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100"
[[ "$(<"$temp_dir/deploy-state")" == "promoted" ]] \
  || fail "Cloud Run apply did not finish on the verified staged revision"
assert_contains "$temp_dir/deploy-source-manifest.out" "./.gcloudignore"
assert_contains "$temp_dir/deploy-source-manifest.out" "./deploy-marker.txt"
assert_not_contains "$temp_dir/deploy-source-manifest.out" "./.env.local"
assert_not_contains "$temp_dir/worker-apply.out" "UNTRACKED_DEPLOY_SECRET_SENTINEL"
deploy_archive_path="$(<"$temp_dir/deploy-source-path.out")"
[[ ! -e "$deploy_archive_path" ]] \
  || fail "temporary deploy source archive was not removed"
runtime_snapshot_path="$(grep -o -- '--env-vars-file=[^ ]*' \
  "$temp_dir/deploy-command.out" | head -n 1 | cut -d= -f2-)"
build_snapshot_path="$(grep -o -- '--build-env-vars-file=[^ ]*' \
  "$temp_dir/deploy-command.out" | head -n 1 | cut -d= -f2-)"
[[ -n "$runtime_snapshot_path" && -n "$build_snapshot_path" \
  && ! -e "$runtime_snapshot_path" && ! -e "$build_snapshot_path" ]] \
  || fail "validated env manifest snapshots were not removed after deployment"

printf 'ready\n' >"$temp_dir/permanent-revision-mismatch-state"
printf '0\n' >"$temp_dir/permanent-revision-observation-count"
: >"$temp_dir/permanent-revision-sleep.out"
: >"$temp_dir/permanent-revision-traffic.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/permanent-revision-mismatch-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_REVISION_OBSERVATION_MODE=permanent_mismatch' \
  "FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE=$temp_dir/permanent-revision-observation-count" \
  "FAKE_SLEEP_LOG=$temp_dir/permanent-revision-sleep.out" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/permanent-revision-traffic.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/permanent-revision-mismatch.out" 2>&1; then
  fail "apply accepted a permanent source-build revision provenance mismatch"
fi
[[ "$(<"$temp_dir/permanent-revision-observation-count")" == "5" ]] \
  || fail "apply revision observation retries were not bounded to five attempts"
[[ "$(wc -l <"$temp_dir/permanent-revision-sleep.out" | tr -d ' ')" == "4" ]] \
  || fail "apply did not stop retrying after the bounded observation window"
assert_contains "$temp_dir/permanent-revision-mismatch.out" \
  "missing exact commit provenance after 5 attempts"
[[ ! -s "$temp_dir/permanent-revision-traffic.out" ]] \
  || fail "permanently mismatched revision received live traffic"

printf '0\n' >"$temp_dir/check-revision-observation-count"
: >"$temp_dir/check-revision-sleep.out"
if env "${common_env[@]}" \
  'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_REVISION_OBSERVATION_MODE=permanent_mismatch' \
  'FAKE_GCLOUD_REVISION_OBSERVATION_TARGET=all' \
  "FAKE_GCLOUD_REVISION_OBSERVATION_COUNT_FILE=$temp_dir/check-revision-observation-count" \
  "FAKE_SLEEP_LOG=$temp_dir/check-revision-sleep.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/check-revision-mismatch.out" 2>&1; then
  fail "check accepted a revision provenance mismatch"
fi
[[ "$(<"$temp_dir/check-revision-observation-count")" == "2" ]] \
  || fail "check did not use one immediate provenance observation"
[[ ! -s "$temp_dir/check-revision-sleep.out" ]] \
  || fail "check waited for revision provenance instead of failing immediately"
assert_contains "$temp_dir/check-revision-mismatch.out" \
  "missing exact commit provenance after 1 attempt"

printf 'ready\n' >"$temp_dir/slot-staging-state"
: >"$temp_dir/slot-staging-traffic.out"
env -u ANALYSIS_V2_WORKER_ENV_VARS_FILE "${common_env[@]}" \
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=primary' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/slot-staging-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_RUNTIME_SLOT=quaternary' \
  'FAKE_GCLOUD_ACTIVE_RUNTIME_SLOT=quaternary' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=quaternary' \
  'FAKE_GCLOUD_ACTIVE_APIFY_SECRET_SLOTS=quaternary' \
  "FAKE_GCLOUD_DEPLOY_LOG=$temp_dir/slot-staging-deploy.out" \
  "FAKE_GCLOUD_ENDPOINT_UPDATE_LOG=$temp_dir/slot-staging-endpoint.out" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/slot-staging-traffic.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/slot-staging.out"
assert_not_contains "$temp_dir/slot-staging-deploy.out" ' --env-vars-file='
assert_contains "$temp_dir/slot-staging-deploy.out" \
  "--build-env-vars-file="
assert_contains "$temp_dir/slot-staging-deploy.out" \
  "--update-env-vars=ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET=test-project-analysis-v2-media,ANALYSIS_V2_APIFY_API_TOKEN_SLOT=primary"
assert_contains "$temp_dir/slot-staging.out" \
  "verified: source-build revision staged without live traffic"
assert_contains "$temp_dir/slot-staging-endpoint.out" \
  "--image=asia-northeast3-docker.pkg.dev/test-project/cloud-run-source-deploy/analysis-worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert_contains "$temp_dir/slot-staging.out" \
  "verified: final worker revision is staged without receiving live traffic"
assert_contains "$temp_dir/slot-staging-traffic.out" \
  "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100"
assert_not_contains "$temp_dir/slot-staging-traffic.out" \
  "--to-revisions=analysis-worker-b${deploy_source_commit:0:6}abc12=100"
[[ "$(grep -c 'run services update-traffic' "$temp_dir/slot-staging-traffic.out")" == "1" ]] \
  || fail "slot-staging deployment changed known-good traffic before final promotion"
[[ "$(<"$temp_dir/slot-staging-state")" == "promoted" ]] \
  || fail "slot-staging deployment did not finish on the verified final revision"

printf 'ready\n' >"$temp_dir/deploy-lock-state"
printf 'locked\n' >"$temp_dir/deploy-lock-object"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/deploy-lock-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  "FAKE_GCLOUD_DEPLOY_LOCK_FILE=$temp_dir/deploy-lock-object" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/deploy-lock.out" 2>&1; then
  fail "concurrent deployment bypassed the exclusive Cloud Storage lock"
fi
assert_contains "$temp_dir/deploy-lock.out" \
  "another deployment holds the Cloud Storage deploy lock"
[[ -e "$temp_dir/deploy-lock-object" ]] \
  || fail "failed lock acquisition removed another deployment's lock"

printf 'ready\n' >"$temp_dir/replaced-lock-state"
rm -f "$temp_dir/replaced-lock-object"
: >"$temp_dir/replaced-lock-events.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/replaced-lock-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  "FAKE_GCLOUD_DEPLOY_LOCK_FILE=$temp_dir/replaced-lock-object" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/replaced-lock-events.out" \
  'FAKE_GCLOUD_LOCK_CP_AMBIGUOUS_SUCCESS=true' \
  'FAKE_GCLOUD_LOCK_REPLACED_BEFORE_DESCRIBE=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/replaced-lock.out" 2>&1; then
  fail "deployment accepted a lock generation replaced before owner verification"
fi
assert_contains "$temp_dir/replaced-lock.out" \
  "another deployment holds the Cloud Storage deploy lock"
[[ "$(<"$temp_dir/replaced-lock-object")" == "foreign deployment" ]] \
  || fail "owner mismatch cleanup removed or changed another deployment's lock"
assert_not_contains "$temp_dir/replaced-lock-events.out" "storage rm"

printf 'prerequisites_ready\n' >"$temp_dir/bootstrap-rollback-state"
printf 'ENABLED\n' >"$temp_dir/bootstrap-retention-state"
: >"$temp_dir/bootstrap-rollback-traffic.out"
: >"$temp_dir/bootstrap-rollback-events.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/bootstrap-rollback-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_FIRST_DEPLOY=true' \
  "FAKE_GCLOUD_RETENTION_STATE_FILE=$temp_dir/bootstrap-retention-state" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/bootstrap-rollback-traffic.out" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/bootstrap-rollback-events.out" \
  'FAKE_GCLOUD_POST_PROMOTION_QUEUE_FAILURE=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/bootstrap-rollback.out" 2>&1; then
  fail "first-deployment post-promotion failure did not fail closed"
fi
[[ "$(<"$temp_dir/bootstrap-rollback-state")" == "rolled_back_bootstrap" ]] \
  || fail "first-deployment failure did not restore the disabled bootstrap revision"
assert_contains "$temp_dir/bootstrap-rollback-traffic.out" \
  "--to-revisions=analysis-worker-b${deploy_source_commit:0:6}abc12=100"
assert_contains "$temp_dir/bootstrap-rollback.out" \
  "rollback verified: analysis-worker-b${deploy_source_commit:0:6}abc12 serves 100% of traffic"
[[ "$(<"$temp_dir/bootstrap-retention-state")" == "PAUSED" ]] \
  || fail "bootstrap rollback did not pause retention against the disabled revision"
pause_line="$(grep -n 'scheduler jobs pause analysis-v2-preflight-retention' \
  "$temp_dir/bootstrap-rollback-events.out" | tail -n 1 | cut -d: -f1)"
rollback_line="$(grep -n -- "--to-revisions=analysis-worker-b${deploy_source_commit:0:6}abc12=100" \
  "$temp_dir/bootstrap-rollback-events.out" | tail -n 1 | cut -d: -f1)"
[[ -n "$pause_line" && -n "$rollback_line" && "$pause_line" -lt "$rollback_line" ]] \
  || fail "bootstrap rollback did not pause retention before restoring disabled traffic"

printf 'rolled_back_bootstrap\n' >"$temp_dir/bootstrap-retry-state"
printf 'PAUSED\n' >"$temp_dir/bootstrap-retry-scheduler-state"
printf 'PAUSED\n' >"$temp_dir/bootstrap-retry-retention-state"
: >"$temp_dir/bootstrap-retry-events.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/bootstrap-retry-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_ACTIVE_BOOTSTRAP=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/bootstrap-retry-scheduler-state" \
  "FAKE_GCLOUD_RETENTION_STATE_FILE=$temp_dir/bootstrap-retry-retention-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/bootstrap-retry-events.out" \
  'FAKE_GCLOUD_POST_PROMOTION_QUEUE_FAILURE=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/bootstrap-retry.out" 2>&1; then
  fail "bootstrap retry post-promotion failure did not fail closed"
fi
[[ "$(<"$temp_dir/bootstrap-retry-state")" == "rolled_back_bootstrap" ]] \
  || fail "bootstrap retry failure did not restore the disabled bootstrap revision"
assert_contains "$temp_dir/bootstrap-retry.out" \
  "active known-good revision is an execution-disabled bootstrap rollback revision"
assert_contains "$temp_dir/bootstrap-retry.out" \
  "execution-disabled bootstrap traffic defers Scheduler reconciliation until the final gated revision is promoted"
assert_contains "$temp_dir/bootstrap-retry.out" \
  "rollback verified: analysis-worker-b${deploy_source_commit:0:6}abc12 serves 100% of traffic"
[[ "$(<"$temp_dir/bootstrap-retry-scheduler-state")" == "PAUSED" ]] \
  || fail "bootstrap retry rollback did not keep recovery paused"
[[ "$(<"$temp_dir/bootstrap-retry-retention-state")" == "PAUSED" ]] \
  || fail "bootstrap retry rollback did not re-pause retention"
resume_line="$(grep -n 'scheduler jobs resume analysis-v2-preflight-retention' \
  "$temp_dir/bootstrap-retry-events.out" | head -n 1 | cut -d: -f1)"
pause_line="$(grep -n 'scheduler jobs pause analysis-v2-preflight-retention' \
  "$temp_dir/bootstrap-retry-events.out" | tail -n 1 | cut -d: -f1)"
[[ -n "$resume_line" && -n "$pause_line" && "$resume_line" -lt "$pause_line" ]] \
  || fail "bootstrap retry did not re-pause retention after the failed promoted revision"

printf 'ready\n' >"$temp_dir/rollback-state"
printf 'PAUSED\n' >"$temp_dir/rollback-scheduler-state"
: >"$temp_dir/rollback-traffic.out"
: >"$temp_dir/rollback-events.out"
if env "${common_env[@]}" \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/rollback-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/rollback-scheduler-state" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/rollback-traffic.out" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/rollback-events.out" \
  'FAKE_GCLOUD_POST_PROMOTION_QUEUE_FAILURE=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/worker-rollback.out" 2>&1; then
  fail "post-promotion verification failure did not fail the deployment"
fi
[[ "$(<"$temp_dir/rollback-state")" == "rolled_back" ]] \
  || fail "failed deployment did not restore the recorded known-good revision"
assert_contains "$temp_dir/rollback-traffic.out" \
  "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100"
assert_contains "$temp_dir/rollback-traffic.out" \
  "--to-revisions=analysis-worker-00002=100"
assert_contains "$temp_dir/worker-rollback.out" \
  "rollback verified: analysis-worker-00002 serves 100% of traffic"
pause_line="$(grep -n 'scheduler jobs pause analysis-v2-recovery' \
  "$temp_dir/rollback-events.out" | tail -n 1 | cut -d: -f1)"
rollback_line="$(grep -n -- '--to-revisions=analysis-worker-00002=100' \
  "$temp_dir/rollback-events.out" | tail -n 1 | cut -d: -f1)"
[[ -n "$pause_line" && -n "$rollback_line" && "$pause_line" -lt "$rollback_line" ]] \
  || fail "recovery-disabled rollback did not pause Scheduler before restoring traffic"

printf 'ready\n' >"$temp_dir/stale-rollback-state"
printf 'PAUSED\n' >"$temp_dir/stale-rollback-scheduler-state"
: >"$temp_dir/stale-rollback-traffic.out"
if env "${common_env[@]}" \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/stale-rollback-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/stale-rollback-scheduler-state" \
  "FAKE_GCLOUD_TRAFFIC_LOG=$temp_dir/stale-rollback-traffic.out" \
  'FAKE_GCLOUD_CONCURRENT_PROMOTION_ON_FAILURE=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/stale-rollback.out" 2>&1; then
  fail "simulated concurrent promotion did not fail the deployment"
fi
[[ "$(<"$temp_dir/stale-rollback-state")" == "foreign_promoted" ]] \
  || fail "stale rollback overwrote traffic owned by another deployment"
assert_contains "$temp_dir/stale-rollback.out" \
  "refusing stale rollback because live traffic is owned by another deployment"
assert_not_contains "$temp_dir/stale-rollback-traffic.out" \
  "--to-revisions=analysis-worker-00002=100"

printf 'ready\n' >"$temp_dir/paused-recovery-deploy-state"
printf 'PAUSED\n' >"$temp_dir/paused-recovery-deploy-scheduler-state"
: >"$temp_dir/paused-recovery-deploy-events.out"
env "${common_env[@]}" \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/paused-recovery-deploy-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/paused-recovery-deploy-scheduler-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/paused-recovery-deploy-events.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/paused-recovery-deploy.out"
paused_recovery_traffic_line="$(grep -n -- \
  "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100" \
  "$temp_dir/paused-recovery-deploy-events.out" | tail -n 1 | cut -d: -f1)"
paused_recovery_resume_line="$(grep -n \
  'scheduler jobs resume analysis-v2-recovery' \
  "$temp_dir/paused-recovery-deploy-events.out" | tail -n 1 | cut -d: -f1)"
[[ -n "$paused_recovery_traffic_line" && -n "$paused_recovery_resume_line" \
  && "$paused_recovery_traffic_line" -lt "$paused_recovery_resume_line" ]] \
  || fail "manually paused recovery was resumed before verified traffic promotion"
[[ "$(<"$temp_dir/paused-recovery-deploy-scheduler-state")" == "ENABLED" ]] \
  || fail "successful promotion did not apply the requested recovery gate"

printf 'ready\n' >"$temp_dir/prepromotion-failure-state"
printf 'ENABLED\n' >"$temp_dir/prepromotion-failure-scheduler-state"
printf 'ENABLED\n' >"$temp_dir/prepromotion-failure-retention-state"
: >"$temp_dir/prepromotion-failure-events.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/prepromotion-failure-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/prepromotion-failure-scheduler-state" \
  "FAKE_GCLOUD_RETENTION_STATE_FILE=$temp_dir/prepromotion-failure-retention-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/prepromotion-failure-events.out" \
  'FAKE_GCLOUD_RETENTION_DRIFT=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/prepromotion-failure.out" 2>&1; then
  fail "pre-promotion maintenance drift did not fail closed"
fi
[[ "$(<"$temp_dir/prepromotion-failure-state")" == "rolled_back" ]] \
  || fail "pre-promotion maintenance failure did not preserve known-good traffic"
[[ "$(<"$temp_dir/prepromotion-failure-scheduler-state")" == "ENABLED" ]] \
  || fail "pre-promotion maintenance failure did not restore the live recovery gate"
[[ "$(<"$temp_dir/prepromotion-failure-retention-state")" == "PAUSED" ]] \
  || fail "pre-promotion retention drift was not left safely paused"
assert_not_contains "$temp_dir/prepromotion-failure-events.out" \
  "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100"
pause_line="$(grep -n 'scheduler jobs pause analysis-v2-recovery' \
  "$temp_dir/prepromotion-failure-events.out" | head -n 1 | cut -d: -f1)"
rollback_line="$(grep -n -- '--to-revisions=analysis-worker-00002=100' \
  "$temp_dir/prepromotion-failure-events.out" | tail -n 1 | cut -d: -f1)"
resume_line="$(grep -n 'scheduler jobs resume analysis-v2-recovery' \
  "$temp_dir/prepromotion-failure-events.out" | tail -n 1 | cut -d: -f1)"
[[ -n "$pause_line" && -n "$rollback_line" && -n "$resume_line" \
  && "$pause_line" -lt "$rollback_line" && "$rollback_line" -lt "$resume_line" ]] \
  || fail "pre-promotion failure did not restore traffic before re-enabling recovery"

printf 'ready\n' >"$temp_dir/drifted-recovery-rollback-state"
printf 'PAUSED\n' >"$temp_dir/drifted-recovery-scheduler-state"
: >"$temp_dir/drifted-recovery-events.out"
if env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/drifted-recovery-rollback-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED=true' \
  'FAKE_GCLOUD_RECOVERY_DRIFT=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/drifted-recovery-scheduler-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/drifted-recovery-events.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/drifted-recovery-rollback.out" 2>&1; then
  fail "structurally drifted recovery job did not fail closed"
fi
[[ "$(<"$temp_dir/drifted-recovery-scheduler-state")" == "PAUSED" ]] \
  || fail "rollback resumed a structurally drifted recovery Scheduler job"
assert_contains "$temp_dir/drifted-recovery-rollback.out" \
  "scheduler job has drifted; inspect or use --reconcile-jobs: analysis-v2-recovery"
assert_not_contains "$temp_dir/drifted-recovery-events.out" \
  "scheduler jobs resume analysis-v2-recovery"

printf 'ready\n' >"$temp_dir/enabled-drift-rollback-state"
printf 'ENABLED\n' >"$temp_dir/enabled-drift-scheduler-state"
: >"$temp_dir/enabled-drift-events.out"
if env "${common_env[@]}" \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/enabled-drift-rollback-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED=true' \
  'FAKE_GCLOUD_RECOVERY_DRIFT_ON_ROLLBACK=true' \
  'FAKE_GCLOUD_POST_PROMOTION_QUEUE_FAILURE=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/enabled-drift-scheduler-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/enabled-drift-events.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/enabled-drift-rollback.out" 2>&1; then
  fail "enabled recovery drift during rollback did not fail closed"
fi
[[ "$(<"$temp_dir/enabled-drift-scheduler-state")" == "PAUSED" ]] \
  || fail "rollback left a structurally drifted recovery job enabled"
assert_contains "$temp_dir/enabled-drift-rollback.out" \
  "refusing to resume a structurally drifted recovery Scheduler job"
assert_contains "$temp_dir/enabled-drift-events.out" \
  "scheduler jobs pause analysis-v2-recovery"

printf 'ready\n' >"$temp_dir/recovery-disable-deploy-state"
printf 'ENABLED\n' >"$temp_dir/recovery-disable-scheduler-state"
: >"$temp_dir/recovery-disable-events.out"
env "${common_env[@]}" \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/recovery-disable-deploy-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  'FAKE_GCLOUD_KNOWN_GOOD_RECOVERY_ENABLED=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-disable-scheduler-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/recovery-disable-events.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/recovery-disable-deploy.out"
pause_line="$(grep -n 'scheduler jobs pause analysis-v2-recovery' \
  "$temp_dir/recovery-disable-events.out" | head -n 1 | cut -d: -f1)"
promotion_line="$(grep -n -- "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100" \
  "$temp_dir/recovery-disable-events.out" | head -n 1 | cut -d: -f1)"
[[ -n "$pause_line" && -n "$promotion_line" && "$pause_line" -lt "$promotion_line" ]] \
  || fail "recovery true-to-false deployment did not pause Scheduler before promotion"
[[ "$(<"$temp_dir/recovery-disable-scheduler-state")" == "PAUSED" ]] \
  || fail "recovery Scheduler was not paused after disabling recovery"

printf 'ready\n' >"$temp_dir/recovery-enable-deploy-state"
printf 'PAUSED\n' >"$temp_dir/recovery-enable-scheduler-state"
: >"$temp_dir/recovery-enable-events.out"
env "${common_env[@]}" \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "ANALYSIS_V2_WORKER_SOURCE_DIR=$deploy_source_repo" \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build.yaml" \
  "FAKE_GCLOUD_STATE_FILE=$temp_dir/recovery-enable-deploy-state" \
  "FAKE_GCLOUD_SOURCE_COMMIT=$deploy_source_commit" \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-enable-scheduler-state" \
  "FAKE_GCLOUD_EVENT_LOG=$temp_dir/recovery-enable-events.out" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" \
  >"$temp_dir/recovery-enable-deploy.out"
promotion_line="$(grep -n -- "--to-revisions=analysis-worker-f${deploy_source_commit:0:6}abc12=100" \
  "$temp_dir/recovery-enable-events.out" | head -n 1 | cut -d: -f1)"
resume_line="$(grep -n 'scheduler jobs resume analysis-v2-recovery' \
  "$temp_dir/recovery-enable-events.out" | head -n 1 | cut -d: -f1)"
[[ -n "$promotion_line" && -n "$resume_line" && "$promotion_line" -lt "$resume_line" ]] \
  || fail "recovery false-to-true deployment resumed Scheduler before promotion"
[[ "$(<"$temp_dir/recovery-enable-scheduler-state")" == "ENABLED" ]] \
  || fail "recovery Scheduler was not enabled after recovery promotion"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_WORKER_ENABLED=true' \
  'ANALYSIS_V2_RECOVERY_ENABLED=false' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-independent-gates.out"
assert_contains "$temp_dir/worker-independent-gates.out" \
  "ANALYSIS_V2_WORKER_ENABLED=true\\,ANALYSIS_V2_RECOVERY_ENABLED=false"
assert_contains "$temp_dir/worker-independent-gates.out" "--no-traffic"
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

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary' \
  'ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS=tertiary:6,quaternary:6,quinary:6' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-secondary-slot.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-secondary-slot-additional-refs.out"
for additional_assignment in \
  'APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:7' \
  'APIFY_TERTIARY_API_TOKEN=ai-baram-v2-apify-tertiary:6' \
  'APIFY_QUATERNARY_API_TOKEN=ai-baram-v2-apify-quaternary:6' \
  'APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:6'; do
  assert_contains "$temp_dir/worker-secondary-slot-additional-refs.out" \
    "$additional_assignment"
done
assert_not_contains "$temp_dir/worker-secondary-slot-additional-refs.out" \
  'APIFY_PRIMARY_API_TOKEN='

for invalid_additional_refs in \
  'secondary:7' \
  'tertiary:latest' \
  'tertiary:6,tertiary:6' \
  'senary:6'; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
    'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary' \
    "ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS=$invalid_additional_refs" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-secondary-slot.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-invalid-additional-refs.out" 2>&1; then
    fail "invalid additional Apify refs were accepted: $invalid_additional_refs"
  fi
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=tertiary,quinary' \
  'FAKE_GCLOUD_APIFY_SECRET_VERSION=6' \
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary' \
  'ANALYSIS_V2_APIFY_ADDITIONAL_SECRET_VERSIONS=tertiary:5' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-secondary-slot.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-conflicting-additional-ref.out" 2>&1; then
  fail "conflicting retained and additional Apify refs were accepted"
fi
assert_contains "$temp_dir/worker-conflicting-additional-ref.out" \
  'conflicts with an existing retained numeric version'

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,tertiary,quaternary,quinary' \
  'FAKE_GCLOUD_APIFY_SECRET_VERSION=6' \
  'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=secondary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-secondary-slot.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-secondary-slot-recovery.out"
for retained_assignment in \
  'APIFY_PRIMARY_API_TOKEN=ai-baram-v2-apify-primary:6' \
  'APIFY_TERTIARY_API_TOKEN=ai-baram-v2-apify-tertiary:6' \
  'APIFY_QUATERNARY_API_TOKEN=ai-baram-v2-apify-quaternary:6' \
  'APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:6'; do
  assert_contains "$temp_dir/worker-secondary-slot-recovery.out" \
    "$retained_assignment"
done
assert_contains "$temp_dir/worker-secondary-slot-recovery.out" \
  'APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:7'
assert_not_contains "$temp_dir/worker-secondary-slot-recovery.out" \
  'APIFY_SECONDARY_API_TOKEN=ai-baram-v2-apify-secondary:6'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=quinary' \
  'FAKE_GCLOUD_APIFY_SECRET_VERSION=6' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-same-slot-version-overwrite.out" 2>&1; then
  fail "same selected Apify slot v6 to v7 overwrite was accepted"
fi
assert_contains "$temp_dir/worker-same-slot-version-overwrite.out" \
  'same-slot overwrite can strand unresolved runs and account identity'

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=quinary' \
  'FAKE_GCLOUD_APIFY_SECRET_VERSION=7' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-same-slot-same-version.out"
assert_contains "$temp_dir/worker-same-slot-same-version.out" \
  'APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:7'

for requested_apify_version in 7 8; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
    'FAKE_GCLOUD_APIFY_SECRET_VERSION=8' \
    'FAKE_GCLOUD_ACTIVE_APIFY_SECRET_VERSION=7' \
    "ANALYSIS_V2_APIFY_API_TOKEN_SECRET_VERSION=$requested_apify_version" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-apify-active-v7-latest-v8-requested-v$requested_apify_version.out" 2>&1; then
    fail "active Apify v7/latest v8 divergence matched requested v$requested_apify_version"
  fi
  assert_contains \
    "$temp_dir/worker-apify-active-v7-latest-v8-requested-v$requested_apify_version.out" \
    'active and latest identities must agree'
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=quinary' \
  'FAKE_GCLOUD_ACTIVE_APIFY_SECRET_SLOTS=primary,quinary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-apify-dropped-active-recovery-ref.out" 2>&1; then
  fail "latest template dropped an active Apify recovery reference"
fi
assert_contains "$temp_dir/worker-apify-dropped-active-recovery-ref.out" \
  'latest may not drop an active recovery reference'

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,quinary' \
  'FAKE_GCLOUD_ACTIVE_APIFY_SECRET_SLOTS=quinary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-apify-latest-superset.out"
assert_contains "$temp_dir/worker-apify-latest-superset.out" \
  'APIFY_PRIMARY_API_TOKEN=ai-baram-v2-apify-primary:7'
assert_contains "$temp_dir/worker-apify-latest-superset.out" \
  'APIFY_QUINARY_API_TOKEN=ai-baram-v2-apify-quinary:7'

# A deployed identity HMAC reference is immutable. Only the exact canonical
# numeric version may be reused; only a service that does not exist may add it.
env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  'FAKE_GCLOUD_IDENTITY_HMAC_MODE=absent' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-initial.out"
assert_contains "$temp_dir/worker-hmac-initial.out" \
  'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET=ai-baram-v2-preflight-identity-hmac:7'

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_IDENTITY_HMAC_VERSION=7' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-same-version.out"
assert_contains "$temp_dir/worker-hmac-same-version.out" \
  'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET=ai-baram-v2-preflight-identity-hmac:7'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_IDENTITY_HMAC_VERSION=7' \
  'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION=8' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-version-change.out" 2>&1; then
  fail "existing preflight identity HMAC v7 to v8 overwrite was accepted"
fi
assert_contains "$temp_dir/worker-hmac-version-change.out" \
  'production in-place rotation is blocked until a DB-backed drain audit path exists'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_IDENTITY_HMAC_MODE=absent' \
  'FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_MODE=absent' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-existing-absent.out" 2>&1; then
  fail "existing service without a preflight identity HMAC reference was bootstrapped in-place"
fi
assert_contains "$temp_dir/worker-hmac-existing-absent.out" \
  'must be exactly one canonical ref at the requested numeric version'

for requested_hmac_version in 7 8; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
    'FAKE_GCLOUD_IDENTITY_HMAC_VERSION=8' \
    'FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_VERSION=7' \
    "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET_VERSION=$requested_hmac_version" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-hmac-active-v7-latest-v8-requested-v$requested_hmac_version.out" 2>&1; then
    fail "active HMAC v7/latest v8 divergence matched requested v$requested_hmac_version"
  fi
  assert_contains \
    "$temp_dir/worker-hmac-active-v7-latest-v8-requested-v$requested_hmac_version.out" \
    'existing preflight identity HMAC reference is invalid or its numeric version changed'
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_MODE=wrong-secret' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-active-wrong-secret.out" 2>&1; then
  fail "invalid active known-good HMAC reference was accepted"
fi
assert_contains "$temp_dir/worker-hmac-active-wrong-secret.out" \
  'active known-good Cloud Run revision existing preflight identity HMAC reference is invalid'

for active_identity_hmac_mode in plaintext duplicate; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
    "FAKE_GCLOUD_ACTIVE_IDENTITY_HMAC_MODE=$active_identity_hmac_mode" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-hmac-active-$active_identity_hmac_mode.out" 2>&1; then
    fail "invalid active known-good HMAC reference was accepted: $active_identity_hmac_mode"
  fi
done
assert_contains "$temp_dir/worker-hmac-active-plaintext.out" \
  'active known-good Cloud Run revision'
assert_contains "$temp_dir/worker-hmac-active-duplicate.out" \
  'active known-good Cloud Run revision existing preflight identity HMAC reference is invalid'
assert_not_contains "$temp_dir/worker-hmac-active-plaintext.out" \
  'PLAINTEXT_ACTIVE_HMAC_SENTINEL_MUST_NOT_BE_PRINTED'

for identity_hmac_mode in wrong-secret duplicate; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
    "FAKE_GCLOUD_IDENTITY_HMAC_MODE=$identity_hmac_mode" \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/worker-hmac-$identity_hmac_mode.out" 2>&1; then
    fail "invalid existing preflight identity HMAC reference was accepted: $identity_hmac_mode"
  fi
  assert_contains "$temp_dir/worker-hmac-$identity_hmac_mode.out" \
    'existing preflight identity HMAC reference is invalid or its numeric version changed'
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_IDENTITY_HMAC_MODE=plaintext' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-hmac-plaintext.out" 2>&1; then
  fail "plaintext existing preflight identity HMAC reference was accepted"
fi
assert_contains "$temp_dir/worker-hmac-plaintext.out" \
  'deployed worker contains a forbidden plaintext provider or credential value'
assert_not_contains "$temp_dir/worker-hmac-plaintext.out" \
  'PLAINTEXT_HMAC_SENTINEL_MUST_NOT_BE_PRINTED'

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,secondary,tertiary,quaternary,quinary' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-five-slot-recovery-check.out"
assert_contains "$temp_dir/worker-five-slot-recovery-check.out" \
  'verified: private worker runtime, bounded scaling, and default dynamic egress'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,quinary' \
  'FAKE_GCLOUD_APIFY_PLAINTEXT_SLOT=primary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-recovery-plaintext.out" 2>&1; then
  fail "plaintext recovery-only Apify token was accepted"
fi
assert_contains "$temp_dir/worker-recovery-plaintext.out" \
  'deployed worker contains a forbidden plaintext provider or credential value'
assert_not_contains "$temp_dir/worker-recovery-plaintext.out" \
  'APIFY_PLAINTEXT_SENTINEL_MUST_NOT_BE_PRINTED'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,quinary' \
  'FAKE_GCLOUD_APIFY_BAD_REF_SLOT=primary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-recovery-bad-ref.out" 2>&1; then
  fail "non-canonical recovery-only Apify secret reference was accepted"
fi
assert_contains "$temp_dir/worker-recovery-bad-ref.out" \
  'existing worker Apify references are invalid or the selected slot version changed'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=primary,quinary' \
  'FAKE_GCLOUD_APIFY_SECRET_VERSION=latest' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-recovery-latest-ref.out" 2>&1; then
  fail "latest recovery-only Apify secret version was accepted"
fi
assert_contains "$temp_dir/worker-recovery-latest-ref.out" \
  'existing worker Apify references are invalid or the selected slot version changed'

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_APIFY_SECRET_SLOTS=quinary,senary' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-recovery-unallowlisted.out" 2>&1; then
  fail "unallowlisted recovery-only Apify token slot was accepted"
fi
assert_contains "$temp_dir/worker-recovery-unallowlisted.out" \
  'deployed worker contains a forbidden plaintext provider or credential value'

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

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-r2-credential.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/runtime-r2-credential.out" 2>&1; then
  fail "runtime plaintext R2 credential override was accepted"
fi
assert_contains "$temp_dir/runtime-r2-credential.out" \
  "runtime env file must not contain plaintext provider or credential key: ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY"
assert_not_contains "$temp_dir/runtime-r2-credential.out" \
  "R2_RUNTIME_CREDENTIAL_SENTINEL_MUST_NOT_BE_PRINTED"

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

for quoted_runtime_manifest in quoted-secret quoted-gate; do
  if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
    "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime-$quoted_runtime_manifest.yaml" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
    >"$temp_dir/runtime-$quoted_runtime_manifest.out" 2>&1; then
    fail "quoted runtime key bypassed structured manifest validation: $quoted_runtime_manifest"
  fi
done
assert_contains "$temp_dir/runtime-quoted-secret.out" \
  "runtime env file must not contain plaintext provider or credential key: APIFY_QUINARY_API_TOKEN"
assert_not_contains "$temp_dir/runtime-quoted-secret.out" \
  "QUOTED_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"
assert_contains "$temp_dir/runtime-quoted-gate.out" \
  "runtime env file contains a forbidden placement, gate, or WIF bootstrap key: ANALYSIS_V2_TASKS_ENABLED"

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
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build-quoted-secret.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-quoted-secret.out" 2>&1; then
  fail "quoted build secret key bypassed structured YAML validation"
fi
assert_contains "$temp_dir/build-quoted-secret.out" \
  "build env file contains a non-public or unsupported key: SOME_API_KEY"
assert_not_contains "$temp_dir/build-quoted-secret.out" \
  "QUOTED_BUILD_SECRET_SENTINEL_MUST_NOT_BE_PRINTED"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=prerequisites_ready' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  "ANALYSIS_V2_WORKER_BUILD_ENV_VARS_FILE=$temp_dir/build-duplicate.yaml" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/build-duplicate.out" 2>&1; then
  fail "duplicate quoted/unquoted YAML key was accepted"
fi
assert_contains "$temp_dir/build-duplicate.out" \
  "build env file must be a valid, duplicate-free YAML mapping"
assert_not_contains "$temp_dir/build-duplicate.out" \
  "https://duplicate.example.test"

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

printf 'ENABLED\n' >"$temp_dir/recovery-scheduler-state"
: >"$temp_dir/recovery-scheduler-mutations.out"
env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-scheduler-state" \
  "FAKE_GCLOUD_SCHEDULER_MUTATION_LOG=$temp_dir/recovery-scheduler-mutations.out" \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
  >"$temp_dir/recovery-scheduler-pause.out"
[[ "$(<"$temp_dir/recovery-scheduler-state")" == "PAUSED" ]] \
  || fail "disabled recovery gate did not pause the recovery Scheduler job"
assert_contains "$temp_dir/recovery-scheduler-mutations.out" \
  "scheduler jobs pause analysis-v2-recovery"
assert_not_contains "$temp_dir/recovery-scheduler-mutations.out" \
  "analysis-v2-preflight-retention"

printf 'PAUSED\n' >"$temp_dir/recovery-scheduler-state"
: >"$temp_dir/recovery-scheduler-mutations.out"
env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_RECOVERY_ENABLED=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-scheduler-state" \
  "FAKE_GCLOUD_SCHEDULER_MUTATION_LOG=$temp_dir/recovery-scheduler-mutations.out" \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
  >"$temp_dir/recovery-scheduler-resume.out"
[[ "$(<"$temp_dir/recovery-scheduler-state")" == "ENABLED" ]] \
  || fail "enabled recovery gate did not resume the recovery Scheduler job"
assert_contains "$temp_dir/recovery-scheduler-mutations.out" \
  "scheduler jobs resume analysis-v2-recovery"

printf 'ENABLED\n' >"$temp_dir/recovery-scheduler-state"
if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-scheduler-state" \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" --check \
  >"$temp_dir/recovery-scheduler-state-drift.out" 2>&1; then
  fail "enabled recovery Scheduler was accepted while the recovery gate was false"
fi
assert_contains "$temp_dir/recovery-scheduler-state-drift.out" \
  "scheduler job state has drifted: analysis-v2-recovery (PAUSED required)"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_DRIFT=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" --check \
  >"$temp_dir/scheduler-drift-check.out" 2>&1; then
  fail "scheduler audience drift was accepted"
fi
assert_contains "$temp_dir/scheduler-drift-check.out" "scheduler job has drifted"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_DRIFT=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
    --dry-run --reconcile-jobs \
  >"$temp_dir/scheduler-drift-reconcile-dry-run.out"
assert_contains "$temp_dir/scheduler-drift-reconcile-dry-run.out" \
  "gcloud scheduler jobs update http analysis-v2-recovery"
assert_contains "$temp_dir/scheduler-drift-reconcile-dry-run.out" \
  "--update-headers=Content-Type=application/json"
assert_not_contains "$temp_dir/scheduler-drift-reconcile-dry-run.out" \
  "--headers=Content-Type=application/json"

printf 'ENABLED\n' >"$temp_dir/recovery-scheduler-state"
: >"$temp_dir/recovery-scheduler-mutations.out"
if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_DRIFT=true' \
  "FAKE_GCLOUD_SCHEDULER_STATE_FILE=$temp_dir/recovery-scheduler-state" \
  "FAKE_GCLOUD_SCHEDULER_MUTATION_LOG=$temp_dir/recovery-scheduler-mutations.out" \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
  >"$temp_dir/scheduler-drift-apply.out" 2>&1; then
  fail "scheduler drift was replaced without explicit approval"
fi
assert_contains "$temp_dir/scheduler-drift-apply.out" "inspect or use --reconcile-jobs"
assert_contains "$temp_dir/scheduler-drift-apply.out" \
  "safety pause applied before reporting scheduler configuration drift"
[[ "$(<"$temp_dir/recovery-scheduler-state")" == "PAUSED" ]] \
  || fail "recovery Scheduler drift failure did not first stop the disabled job"

printf 'ENABLED\n' >"$temp_dir/retention-scheduler-state"
: >"$temp_dir/retention-scheduler-mutations.out"
if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_RETENTION_DRIFT=true' \
  "FAKE_GCLOUD_RETENTION_STATE_FILE=$temp_dir/retention-scheduler-state" \
  "FAKE_GCLOUD_SCHEDULER_MUTATION_LOG=$temp_dir/retention-scheduler-mutations.out" \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" \
  >"$temp_dir/retention-scheduler-drift-apply.out" 2>&1; then
  fail "retention drift was replaced without explicit approval"
fi
assert_contains "$temp_dir/retention-scheduler-drift-apply.out" \
  "safety pause applied before reporting scheduler configuration drift: analysis-v2-preflight-retention"
assert_contains "$temp_dir/retention-scheduler-mutations.out" \
  "scheduler jobs pause analysis-v2-preflight-retention"
[[ "$(<"$temp_dir/retention-scheduler-state")" == "PAUSED" ]] \
  || fail "retention Scheduler drift failure did not stop the unsafe job"

env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_SCHEDULER_MISSING=true' \
  bash "$script_dir/configure-analysis-v2-maintenance.sh" --dry-run \
  >"$temp_dir/scheduler-create-dry-run.out"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "gcloud scheduler jobs create http analysis-v2-recovery"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "gcloud scheduler jobs create http analysis-v2-preflight-retention"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "--headers=Content-Type=application/json"
assert_not_contains "$temp_dir/scheduler-create-dry-run.out" \
  "--update-headers=Content-Type=application/json"
assert_contains "$temp_dir/scheduler-create-dry-run.out" \
  "gcloud scheduler jobs pause analysis-v2-recovery"

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
  'FAKE_GCLOUD_V2_QUEUE_MISSING=true' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --dry-run \
  >"$temp_dir/v2-queue-default-capacity.out"
assert_contains "$temp_dir/v2-queue-default-capacity.out" \
  "--max-dispatches-per-second=8"
assert_contains "$temp_dir/v2-queue-default-capacity.out" \
  "--max-concurrent-dispatches=8"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND=10' \
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=12' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --dry-run \
  >"$temp_dir/v2-queue-unsafe-capacity.out" 2>&1; then
  fail "legacy V2 queue capacity overrides were accepted"
fi
assert_contains "$temp_dir/v2-queue-unsafe-capacity.out" \
  "ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND must remain 8 during early access"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND=8' \
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=12' \
  bash "$script_dir/configure-analysis-v2-tasks-queue.sh" --dry-run \
  >"$temp_dir/v2-queue-unsafe-concurrency.out" 2>&1; then
  fail "legacy V2 queue concurrency override was accepted"
fi
assert_contains "$temp_dir/v2-queue-unsafe-concurrency.out" \
  "ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES must remain 8 during early access"

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

for drift_state in failed_latest old_traffic unpromoted_latest; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$drift_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$drift_state.out" 2>&1; then
    fail "Cloud Run service drift was accepted: $drift_state"
  fi
  assert_contains "$temp_dir/worker-$drift_state.out" \
    "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
done

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=ready' \
  'FAKE_GCLOUD_TRAFFIC_TAGGED=true' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-traffic-tagged.out" 2>&1; then
  fail "a tagged zero-percent Cloud Run revision was accepted"
fi
assert_contains "$temp_dir/worker-traffic-tagged.out" \
  "Cloud Run traffic tags are forbidden while Gemini concurrency is process-local"

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=runtime_sidecar' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-runtime_sidecar.out" 2>&1; then
  fail "Cloud Run sidecar boundary drift was accepted"
fi
assert_contains "$temp_dir/worker-runtime_sidecar.out" \
  "existing worker Apify references are invalid"

for boundary_state in runtime_placement runtime_duplicate_env; do
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

if env "${common_env[@]}" 'FAKE_GCLOUD_STATE=secret_ref_drift' \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
  >"$temp_dir/worker-secret_ref_drift.out" 2>&1; then
  fail "Cloud Run exact secret mapping drift was accepted: secret_ref_drift"
fi
assert_contains "$temp_dir/worker-secret_ref_drift.out" \
  'same-slot overwrite can strand unresolved runs and account identity'

for secret_drift_state in slot_drift; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$secret_drift_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/worker-$secret_drift_state.out" 2>&1; then
    fail "Cloud Run exact secret mapping drift was accepted: $secret_drift_state"
  fi
  assert_contains "$temp_dir/worker-$secret_drift_state.out" \
    "active and latest identities must agree"
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

for selfhosted_global_drift_state in \
  runtime_selfhosted_global_gate_drift \
  runtime_selfhosted_global_interval_drift \
  runtime_selfhosted_response_guard_drift; do
  if env "${common_env[@]}" "FAKE_GCLOUD_STATE=$selfhosted_global_drift_state" \
    bash "$script_dir/deploy-analysis-v2-worker.sh" --check \
    >"$temp_dir/$selfhosted_global_drift_state.out" 2>&1; then
    fail "Cloud Run self-hosted global profile gate drift was accepted: $selfhosted_global_drift_state"
  fi
  assert_contains "$temp_dir/$selfhosted_global_drift_state.out" \
    "Cloud Run worker runtime, scaling, egress, or artifact config has drifted"
done

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
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=8' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/capacity.out" 2>&1; then
  fail "under-provisioned Cloud Run capacity was accepted"
fi
assert_contains "$temp_dir/capacity.out" \
  "Cloud Run capacity must cover ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES"

if env "${common_env[@]}" \
  'ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND=10' \
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=8' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/worker-unsafe-queue-rate.out" 2>&1; then
  fail "worker deploy accepted a queue rate above the early-access limit"
fi
assert_contains "$temp_dir/worker-unsafe-queue-rate.out" \
  "ANALYSIS_V2_TASKS_MAX_DISPATCHES_PER_SECOND must remain 8 during early access"

if env "${common_env[@]}" \
  'ANALYSIS_V2_WORKER_CONCURRENCY=8' \
  'ANALYSIS_V2_WORKER_MAX_INSTANCES=2' \
  'ANALYSIS_V2_TASKS_MAX_CONCURRENT_DISPATCHES=8' \
  "ANALYSIS_V2_WORKER_ENV_VARS_FILE=$temp_dir/runtime.env" \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --dry-run \
  >"$temp_dir/process-local-gemini-limit.out" 2>&1; then
  fail "multiple Cloud Run instances were accepted with a process-local Gemini limiter"
fi
assert_contains "$temp_dir/process-local-gemini-limit.out" \
  "ANALYSIS_V2_WORKER_MAX_INSTANCES must remain 1 while Gemini concurrency is process-local"

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

printf 'Analysis V2 infrastructure script tests passed\n'
