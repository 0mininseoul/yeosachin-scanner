#!/usr/bin/env bash
# Deploys the private Cherry worker from one committed revision.
#
# Runtime settings and secret references are copied from the paid analyzer worker, so both products
# share one Apify account, one Vertex project, and one image bucket. Secret values are never read.
# Access grants are not made here; --print-grants shows the commands an administrator runs once.
set -euo pipefail

PROJECT="${CHERRY_PROJECT:-gen-lang-client-0311522474}"
REGION="${CHERRY_REGION:-asia-northeast3}"
SERVICE="cherry-worker"
SOURCE_SERVICE="analysis-paid-worker"
QUEUE="cherry-worker"
JOB="cherry-worker-tick"
REVISION="HEAD"
MODE="dry-run"

usage() {
  cat <<'EOF'
Usage: scripts/deploy-cherry-worker.sh [--apply | --dry-run | --print-grants] [--revision <git-ref>]

  --dry-run       Show what would be deployed (default). Names only, no values.
  --apply         Deploy the service, create the queue, and create the scheduler job paused.
  --print-grants  Print the access grants the worker needs.

Optional environment:
  CHERRY_EMAIL_FROM              Sender for e-mail notices, for example "체리 <notice@example.com>".
  CHERRY_KAKAO_CHANNEL_ID        Alimtalk channel ID.
  CHERRY_ALIMTALK_TEMPLATES      JSON object of notice kind to template ID.
  CHERRY_SECRETS                 Extra comma-separated NAME=secret:version references
                                 (CHERRY_SOLAPI_API_KEY, CHERRY_SOLAPI_API_SECRET, CHERRY_SOLAPI_SENDER,
                                 CHERRY_TOSS_SECRET_KEY, CHERRY_TOSS_CLIENT_KEY, CHERRY_BILLING_KEY_SECRET, RESEND_API_KEY).
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    --print-grants) MODE="print-grants" ;;
    --revision) REVISION="${2:?}"; shift ;;
    *) usage; exit 2 ;;
  esac
  shift
done

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
command -v gcloud >/dev/null || die "gcloud is required"
command -v jq >/dev/null || die "jq is required"

NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="https://${SERVICE}-${NUMBER}.${REGION}.run.app"
SCHEDULER_SA="analysis-v2-maintenance@${PROJECT}.iam.gserviceaccount.com"
TASK_SA="analysis-v2-task@${PROJECT}.iam.gserviceaccount.com"
ENQUEUER_SA="analysis-v2-enqueuer@${PROJECT}.iam.gserviceaccount.com"

if [[ "$MODE" == "print-grants" ]]; then
  printf '%s\n' \
    "gcloud run services add-iam-policy-binding $SERVICE --project=$PROJECT --region=$REGION --member=serviceAccount:$SCHEDULER_SA --role=roles/run.invoker" \
    "gcloud run services add-iam-policy-binding $SERVICE --project=$PROJECT --region=$REGION --member=serviceAccount:$TASK_SA --role=roles/run.invoker" \
    "gcloud tasks queues add-iam-policy-binding $QUEUE --project=$PROJECT --location=$REGION --member=serviceAccount:$ENQUEUER_SA --role=roles/cloudtasks.enqueuer" \
    "gcloud scheduler jobs resume $JOB --project=$PROJECT --location=$REGION"
  exit 0
fi

COMMIT="$(git rev-parse --verify "${REVISION}^{commit}")"
git merge-base --is-ancestor "$COMMIT" origin/main || die "only commits on origin/main are deployed"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"
gcloud run services describe "$SOURCE_SERVICE" --project="$PROJECT" --region="$REGION" --format=json > "$WORK/source.json"

# Plain settings both workers share. Admission, queue, and rollout switches of the analyzer stay behind.
jq -c '
  [.spec.template.spec.containers[0].env[] | select(has("value"))
    | select(.name | test("^(NEXT_PUBLIC_SUPABASE_URL|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT|ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET|VERTEX_AI_BUDGET_GUARD_ENABLED|VERTEX_AI_BUDGET_STORE|VERTEX_AI_DAILY_BUDGET_USD)$"))
    | {key: .name, value: .value}] | from_entries' "$WORK/source.json" > "$WORK/shared.json"
jq -e 'has("NEXT_PUBLIC_SUPABASE_URL") and has("ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET")' "$WORK/shared.json" >/dev/null \
  || die "the source worker no longer exposes the shared settings"
jq -c --arg audience "$URL" --arg callers "$SCHEDULER_SA,$TASK_SA" --arg from "${CHERRY_EMAIL_FROM:-}" \
  --arg channel "${CHERRY_KAKAO_CHANNEL_ID:-}" --arg templates "${CHERRY_ALIMTALK_TEMPLATES:-}" '
  . + {
    CHERRY_WORKER_ENABLED: "true", CHERRY_WORKER_AUDIENCE: $audience, CHERRY_WORKER_CALLERS: $callers,
    PREFLIGHT_APIFY_API_TOKEN_SLOTS: "primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth",
    VERTEX_AI_PER_RUN_BUDGET_USD: "0.10", VERTEX_AI_PER_ORDER_BUDGET_USD: "3.00"
  }
  + (if $from == "" then {} else {CHERRY_EMAIL_FROM: $from} end)
  + (if $channel == "" then {} else {CHERRY_KAKAO_CHANNEL_ID: $channel} end)
  + (if $templates == "" then {} else {CHERRY_ALIMTALK_TEMPLATES: $templates} end)' "$WORK/shared.json" > "$WORK/env.json"
SECRETS="$(jq -r '
  [.spec.template.spec.containers[0].env[] | select(has("valueFrom"))
    | select(.name | test("^(SUPABASE_SERVICE_ROLE_KEY|APIFY_[A-Z]+_API_TOKEN|IMAGE_PROXY_SIGNING_SECRET|ANALYSIS_V2_RESULT_IMAGE_(R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|OBJECT_HMAC_SECRET))$"))
    | "\(.name)=\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)"] | join(",")' "$WORK/source.json")"
[[ "$SECRETS" == *SUPABASE_SERVICE_ROLE_KEY=* && "$SECRETS" == *APIFY_SECONDARY_API_TOKEN=* ]] || die "shared secret references are missing"
[[ -z "${CHERRY_SECRETS:-}" ]] || SECRETS="$SECRETS,$CHERRY_SECRETS"
RUNTIME_SA="$(jq -r '.spec.template.spec.serviceAccountName' "$WORK/source.json")"
BUILD_SA="$(jq -er '.metadata.annotations["run.googleapis.com/build-service-account"]' "$WORK/source.json")" \
  || die "the source worker has no dedicated build account"
# The two public Supabase values are compiled into the shared Next.js build.
jq -er '.metadata.annotations["run.googleapis.com/build-environment-variables"] | fromjson
  | with_entries(select(.key | test("^NEXT_PUBLIC_SUPABASE_(URL|ANON_KEY)$")))' "$WORK/source.json" > "$WORK/build.json" \
  || die "the source worker has no reusable build settings"

# A redeploy keeps the Cherry settings and secret references the running worker already has.
EXISTING="$(gcloud run services list --project="$PROJECT" --region="$REGION" --format='value(metadata.name)')" \
  || die "could not list the existing services"
if grep -qx "$SERVICE" <<<"$EXISTING"; then
  gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format=json > "$WORK/current.json" \
    || die "could not read the running worker; its settings would be lost"
  jq -c --slurpfile next "$WORK/env.json" '
    ([.spec.template.spec.containers[0].env[]? | select(has("value")) | select(.name | test("^CHERRY_"))
      | {key: .name, value: .value}] | from_entries) + $next[0]' "$WORK/current.json" > "$WORK/merged.json"
  mv "$WORK/merged.json" "$WORK/env.json"
  KEPT="$(jq -r '[.spec.template.spec.containers[0].env[]? | select(has("valueFrom"))
    | select(.name | test("^(CHERRY_|RESEND_API_KEY$)")) | "\(.name)=\(.valueFrom.secretKeyRef.name):\(.valueFrom.secretKeyRef.key)"] | .[]' "$WORK/current.json")"
  while IFS= read -r reference; do
    [[ -z "$reference" || ",$SECRETS" == *",${reference%%=*}="* ]] || SECRETS="$SECRETS,$reference"
  done <<<"$KEPT"
fi

printf 'commit %s\nservice %s (%s)\n' "$COMMIT" "$SERVICE" "$URL"
printf 'settings: %s\n' "$(jq -r 'keys | join(", ")' "$WORK/env.json")"
printf 'secrets: %s\n' "$(tr ',' '\n' <<<"$SECRETS" | cut -d= -f1 | paste -sd, -)"
if [[ "$MODE" == "dry-run" ]]; then
  printf 'dry run: nothing was changed\n'
  exit 0
fi

mkdir "$WORK/src"
git archive "$COMMIT" | tar -x -C "$WORK/src"
cp "$WORK/src/scripts/analysis-v2-source.gcloudignore" "$WORK/src/.gcloudignore"
gcloud run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" --source="$WORK/src" \
  --service-account="$RUNTIME_SA" --execution-environment=gen2 --cpu=1 --memory=1Gi --concurrency=4 \
  --min-instances=0 --max-instances=3 --timeout=600s --port=8080 --cpu-throttling --cpu-boost \
  --ingress=all --invoker-iam-check --no-allow-unauthenticated --labels="cherry-source-commit=$COMMIT" \
  --description='Private Cherry worker' --env-vars-file="$WORK/env.json" --set-secrets="$SECRETS" \
  --build-env-vars-file="$WORK/build.json" --build-service-account="$BUILD_SA" --quiet

gcloud tasks queues describe "$QUEUE" --project="$PROJECT" --location="$REGION" >/dev/null 2>&1 \
  || gcloud tasks queues create "$QUEUE" --project="$PROJECT" --location="$REGION" \
    --max-concurrent-dispatches=5 --max-dispatches-per-second=5 --max-attempts=3 --min-backoff=10s --max-backoff=60s --quiet
if ! gcloud scheduler jobs describe "$JOB" --project="$PROJECT" --location="$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs create http "$JOB" --project="$PROJECT" --location="$REGION" --schedule='* * * * *' --time-zone=Etc/UTC \
    --uri="$URL/api/cherry/worker" --http-method=POST --headers=Content-Type=application/json --message-body='{"kind":"tick"}' \
    --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$URL" --attempt-deadline=540s \
    --max-retry-attempts=0 --quiet
  gcloud scheduler jobs pause "$JOB" --project="$PROJECT" --location="$REGION" --quiet
fi
printf 'deployed. The scheduler job is created paused; run with --print-grants for the remaining steps.\n'
