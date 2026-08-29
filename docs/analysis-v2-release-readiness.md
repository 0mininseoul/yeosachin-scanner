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
IMAGE_PROXY_SIGNING_SECRET=<pinned-cloud-run-secret-injected-into-process> \
ANALYSIS_V2_IMAGE_PROXY_PROBE_BASE_URL=https://yeosachin.com \
ANALYSIS_V2_RELEASE_SUPABASE_WORKDIR=<linked-read-only-workdir> \
bash scripts/check-analysis-v2-release-readiness.sh
```

The gate performs only Cloud Run `describe`, Vercel deployment `GET`,
`supabase migration list --linked`, and one read-only production image-proxy
compatibility request. `VERCEL_PROJECT_ID` must identify the existing
production project; the gate never creates, links, deploys, or promotes a
Vercel project, and it never applies, repairs, or pushes a Supabase migration.
The image-proxy compatibility probe signs a fixed non-user fixture URL with the
caller-provided `IMAGE_PROXY_SIGNING_SECRET` using the application token helper,
then calls the production Vercel `/api/image-proxy` route. A 200 image response
or the documented retryable 503 `IMAGE_UNAVAILABLE` response proves the token
was accepted; 403 and every other response category fail the gate. The probe
prints only its pass/fail category and never prints the secret, token, signed
path, fixture URL, response body, or any derived hash. Inject the pinned Cloud
Run Secret Manager version into the process without putting it in command
arguments or logs.

Use `bash scripts/test-analysis-v2-release-readiness.sh` for the local contract
test. Its fake providers verify matching provenance, stale Cloud Run/Vercel/DB
failures, token-free diagnostics, compatibility-probe rejection handling, and
the absence of mutating commands.
