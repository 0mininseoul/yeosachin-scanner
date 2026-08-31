#!/usr/bin/env bash
set -euo pipefail

for name in \
  PREFLIGHT_TASKS_PROJECT \
  PREFLIGHT_TASKS_LOCATION \
  PREFLIGHT_TASKS_QUEUE \
  PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL \
  PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL \
  PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL \
  PREFLIGHT_TASKS_CLOUD_RUN_SERVICE \
  PREFLIGHT_TASKS_CLOUD_RUN_REGION; do
  [[ -n "${!name:-}" ]] || {
    printf 'error: %s is required\n' "$name" >&2
    exit 1
  }
done

# Legacy V2 deployments reuse the historical preflight queue during mixed-version
# drain.  Keep that contract task+maintenance, while split-capacity deployments
# provide the role-scoped preflight maintenance identity explicitly.
preflight_maintenance_service_account="${PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:-${ANALYSIS_V2_MAINTENANCE_SERVICE_ACCOUNT_EMAIL:-}}"
[[ -n "$preflight_maintenance_service_account" ]] || {
  printf 'error: PREFLIGHT_TASKS_MAINTENANCE_SERVICE_ACCOUNT_EMAIL is required\n' >&2
  exit 1
}

export ANALYSIS_TASKS_PROJECT="$PREFLIGHT_TASKS_PROJECT"
export ANALYSIS_TASKS_LOCATION="$PREFLIGHT_TASKS_LOCATION"
export ANALYSIS_TASKS_QUEUE="$PREFLIGHT_TASKS_QUEUE"
export ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL="$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL="$PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL"
export ANALYSIS_TASKS_CLOUD_RUN_SERVICE="$PREFLIGHT_TASKS_CLOUD_RUN_SERVICE"
export ANALYSIS_TASKS_CLOUD_RUN_REGION="$PREFLIGHT_TASKS_CLOUD_RUN_REGION"
# Transport/authentication failures happen before the database claim counter. Keep retrying for
# the full preflight TTL; successful crawler claims have their own independent database ceiling.
export ANALYSIS_TASKS_MAX_RETRY_DURATION="1800s"
export ANALYSIS_TASKS_MAX_DISPATCHES_PER_SECOND="${PREFLIGHT_TASKS_MAX_DISPATCHES_PER_SECOND:-2}"
export ANALYSIS_TASKS_MAX_CONCURRENT_DISPATCHES="${PREFLIGHT_TASKS_MAX_CONCURRENT_DISPATCHES:-2}"
export ANALYSIS_TASKS_IAM_SCOPE="queue"
export ANALYSIS_TASKS_EXACT_IAM="true"
export ANALYSIS_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL="$PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL"
# The worker runtime enqueues onto this queue itself: a paid order's fresh-admission
# dispatch is created from inside the worker, not by the Vercel enqueuer. Declaring
# "none" here contradicted that, and --reconcile-iam faithfully applied the wrong
# declaration -- stripping the runtime's enqueuer binding and stranding every paid
# order at admission until the binding was restored by hand.
export ANALYSIS_TASKS_RUNTIME_QUEUE_ACCESS="enqueue-view"
export ANALYSIS_TASKS_CLOUD_RUN_ALLOWED_INVOKER_MEMBERS="serviceAccount:$PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL,serviceAccount:$preflight_maintenance_service_account"

exec bash "$(dirname "$0")/configure-analysis-tasks-queue.sh" "$@"
