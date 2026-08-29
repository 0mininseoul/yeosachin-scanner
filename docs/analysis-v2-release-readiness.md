# Analysis V2 release readiness

Run the gate from the exact release commit. It compares one lowercase 40-character
`ANALYSIS_V2_EXPECTED_GIT_SHA` against the active Cloud Run revision label,
the latest ready Vercel production deployment, and the applied Supabase progress
migration `20260829120000` plus its local contract markers.

```bash
ANALYSIS_V2_EXPECTED_GIT_SHA=<release-sha> \
ANALYSIS_V2_TASKS_PROJECT=<gcp-project> \
ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE=<worker-service> \
ANALYSIS_V2_TASKS_CLOUD_RUN_REGION=<cloud-run-region> \
VERCEL_PROJECT_ID=<existing-project-id> \
VERCEL_TOKEN=<read-token> \
ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR=<linked-read-only-workdir> \
bash scripts/check-analysis-v2-release-readiness.sh
```

The gate performs only Cloud Run `describe`, Vercel deployment `GET`, and
`supabase migration list --linked` reads. `VERCEL_PROJECT_ID` must identify the
existing production project; the gate never creates, links, deploys, or promotes
a Vercel project, and it never applies, repairs, or pushes a Supabase migration.

Use `bash scripts/test-analysis-v2-release-readiness.sh` for the local contract
test. Its fake providers verify matching provenance, stale Cloud Run/Vercel/DB
failures, token-free diagnostics, and the absence of mutating commands.
