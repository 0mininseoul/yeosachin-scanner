# Instagram authenticated worker operations

`services/instagram-auth-worker` is a private Cloud Run service used only when the application enables `selfhosted_auth`. It is an additive path: the existing Apify relationship route remains the rollback target.

## Baseline

The application kill switch is closed by default:

```dotenv
SELFHOSTED_AUTH_ENABLED=false
```

Leaving it false prevents application requests to the worker even if a worker service exists. The normal relationship providers remain:

```dotenv
SCRAPER_FOLLOWERS=apify
SCRAPER_FOLLOWING=apify
SCRAPER_LIKERS=apify
SCRAPER_COMMENTS=apify
```

## Deploy preflight

Create the session-settings secret through the approved Secret Manager workflow before deploying. The deployment script needs only its secret ID and an immutable positive numeric version; it never reads a secret payload. Do not use `latest`, pass session settings on a command line, or add them to an environment file.

Set these deployment-time values in the operator shell or its approved secret-free deployment configuration:

```dotenv
INSTAGRAM_AUTH_WORKER_PROJECT=your-project-id
INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@your-project-id.iam.gserviceaccount.com
INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@your-project-id.iam.gserviceaccount.com
INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress
INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul
INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID=instagram-auth-session-settings
INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7
```

`INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL` must be the runtime identity that obtains the Google ID token in the application process. It receives service-level `roles/run.invoker`; no public principal is granted access.

The named network and Seoul-region subnet must already use Cloud NAT manual allocation with one reserved static outbound IPv4 address. The deploy script routes all worker egress through that Direct VPC path. Do not canary an authenticated session from Cloud Run's default dynamic outbound IP pool.

Review the planned mutation first:

```bash
bash scripts/deploy-instagram-auth-worker.sh --dry-run
```

The fixed service settings are Seoul (`asia-northeast3`), `min-instances=1`, `max-instances=1`, request `concurrency=5`, and `timeout=300s`. Keeping one warm instance preserves the in-memory cooldown/quarantine across idle periods; infrastructure restarts can still reset it, so an Instagram challenge or authentication failure also requires the application kill switch to remain off until operator review. The script source-deploys the worker, injects `IG_SESSION_SETTINGS_BASE64` only with `--set-secrets=<secret-id>:<numeric-version>`, disables unauthenticated access, routes all egress through the required VPC/subnet, and grants the caller runtime account `roles/run.invoker`. It does not retrieve, echo, or write secret payloads.

After review, run the same script without `--dry-run`. This repository's automation does not deploy external resources on its own. For later worker revisions, close `SELFHOSTED_AUTH_ENABLED`, drain in-flight requests, deploy and verify the single revision, and only then reopen the kill switch; revision overlap must never be used as account-operation concurrency.

## Application enablement

After the Cloud Run service URL and OIDC caller have been verified, configure the application environment with the HTTPS origin and its matching audience, then make the provider selection that uses `selfhosted_auth`:

```dotenv
SELFHOSTED_AUTH_ENABLED=true
SELFHOSTED_AUTH_WORKER_URL=https://instagram-auth-worker-<hash>-an.a.run.app
SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE=https://instagram-auth-worker-<hash>-an.a.run.app
SELFHOSTED_AUTH_WORKER_AUTH_MODE=oidc
SELFHOSTED_AUTH_WORKER_TIMEOUT_MS=240000
SCRAPER_FOLLOWERS=selfhosted_auth
SCRAPER_FOLLOWING=selfhosted_auth
SCRAPER_LIKERS=selfhosted_auth
SCRAPER_COMMENTS=selfhosted_auth
SCRAPER_FALLBACK=true
```

Do not use bearer mode in production. It is a local-development compatibility path, not the Cloud Run authorization mechanism.

Apply `20260803140000_add_authenticated_selfhosted_scraper_receipts.sql` through the repository's reviewed migration workflow before enabling the selectors. Start with a low-volume canary. Suspension risk cannot be eliminated; rate-limit responses trigger a cooldown, while challenges and authentication failures quarantine the account process and should trigger rollback.

## Roll back to Apify

To stop new authenticated-worker requests, first update and deploy the application environment:

```dotenv
SELFHOSTED_AUTH_ENABLED=false
SCRAPER_FOLLOWERS=apify
SCRAPER_FOLLOWING=apify
SCRAPER_LIKERS=apify
SCRAPER_COMMENTS=apify
```

This takes effect without reading or rotating the worker session secret. Leave the Cloud Run service private; do not make it public during rollback. Investigate the failure before re-enabling the kill switch.
