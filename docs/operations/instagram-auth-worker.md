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

## Create or resume the local session

Create the session settings on one trusted Mac/network before putting them in
Secret Manager. The repository helper keeps the full `instagrapi` device state
in a local mode-0600 file, so an Instagram approval challenge can be completed
in the official app or web flow and retried with the same state:

```sh
cd <repository-root>
<path-to-instagrapi-venv>/bin/python \
  scripts/bootstrap-instagram-session.py
```

The helper prompts for the username, password, and optional 2FA code without
echoing them. If Instagram asks for approval, complete that approval on the
trusted device and rerun the exact command. Do not delete or recreate
`/tmp/instagram-session-bootstrap-settings.json` between attempts; it contains
the device identifiers needed for a resumable login. A successful run writes
the complete password-free persisted client state as base64 to
`/tmp/instagram-session-settings.b64` and prints no credential or session
value. Keeping the complete state is required by authenticated relationship
endpoints that depend on the restored cookie and header state in addition to
the session ID and device identifiers.

Treat both local files as secrets. Do not copy them into chat, shell history,
logs, an env file, or Git. Use the approved Secret Manager workflow to create a
version from the local output without echoing its contents, then configure the
immutable numeric version in the deployment variables below. Keep the state
file until the secret version has been verified; remove local copies only by an
explicit operator cleanup procedure.

This is an official approval/resume flow, not a challenge bypass. A repeated
challenge, rate limit, or authentication failure must follow the durable
quarantine and cooldown procedures below; changing device identifiers, app
state, proxy/IP, or app-version overrides to evade a checkpoint is not a
supported recovery step.

## Deploy preflight

Create the session-settings secret through the approved Secret Manager workflow and a dedicated, private GCS bucket for the worker's durable operation ledger and account-safety state before deploying. The deployment script needs only the secret ID and immutable positive numeric version; it never reads a secret payload. Do not use `latest`, pass session settings on a command line, or add them to an environment file. Bucket identifiers and object paths are operational metadata, but session settings, account cookies, request bodies, and stored state must never be included in shell commands or logs.

Set these deployment-time values in the operator shell or its approved secret-free deployment configuration:

```dotenv
INSTAGRAM_AUTH_WORKER_PROJECT=your-project-id
INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL=instagram-auth-worker@your-project-id.iam.gserviceaccount.com
INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL=analysis-worker@your-project-id.iam.gserviceaccount.com
INSTAGRAM_AUTH_WORKER_NETWORK=instagram-egress
INSTAGRAM_AUTH_WORKER_SUBNET=instagram-egress-seoul
INSTAGRAM_AUTH_WORKER_NAT_ROUTER=instagram-egress-router
INSTAGRAM_AUTH_WORKER_NAT_CONFIG=instagram-egress-nat
INSTAGRAM_AUTH_WORKER_NAT_STATIC_IP=instagram-egress-ip
INSTAGRAM_AUTH_WORKER_SESSION_SECRET_ID=instagram-auth-session-settings
INSTAGRAM_AUTH_WORKER_SESSION_SECRET_VERSION=7
INSTAGRAM_AUTH_WORKER_DURABLE_STORE_BUCKET=instagram-auth-worker-state-your-unique-suffix
# Optional; defaults to instagram-auth-worker.
INSTAGRAM_AUTH_WORKER_DURABLE_STORE_PREFIX=instagram-auth-worker
```

`INSTAGRAM_AUTH_WORKER_CALLER_SERVICE_ACCOUNT_EMAIL` must be the runtime identity that obtains the Google ID token in the application process. It receives service-level `roles/run.invoker`; no public principal is granted access.

The durable-store bucket must be dedicated to this worker and use uniform bucket-level access and public-access prevention. The deployment script grants only `roles/storage.objectUser` at that bucket scope to `INSTAGRAM_AUTH_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL`, which is the minimum predefined object role required to read, create, replace, and remove the worker's ledger and account-safety objects. Do not grant it Storage project roles, bucket-admin roles, or access to any other bucket. The operator/deployer may retain separate administrative access for audited recovery, but must not use the worker runtime identity for that access.

The named network and Seoul-region subnet must already use the named Cloud NAT router and NAT configuration. They must use `MANUAL_ONLY` allocation with exactly one configured NAT IP: the named, regional `EXTERNAL` reserved static address. The NAT configuration must explicitly use `LIST_OF_SUBNETWORKS` and include `INSTAGRAM_AUTH_WORKER_SUBNET`. The deploy script routes all worker egress through that Direct VPC path. Do not canary an authenticated session from Cloud Run's default dynamic outbound IP pool.

Review the planned mutation first:

```bash
bash scripts/deploy-instagram-auth-worker.sh --dry-run
```

`--dry-run` still executes read-only Compute Engine `describe` calls before it prints any mutations. It fails closed unless the router and subnet both resolve to the configured project/network/region, the NAT has `MANUAL_ONLY` allocation and exactly one IP, that IP is the named regional reserved address, and the NAT explicitly includes the configured subnet. It does not deploy or change resources in dry-run mode.

The fixed service settings are Seoul (`asia-northeast3`), `min-instances=1`, `max-instances=1`, request `concurrency=5`, and `timeout=300s`. Keeping one warm instance preserves the in-memory cooldown/quarantine across idle periods. The script source-deploys the worker, injects `IG_SESSION_SETTINGS_BASE64` only with `--set-secrets=<secret-id>:<numeric-version>`, injects the non-secret `IG_DURABLE_STORE_BUCKET` and prefix, disables unauthenticated access, routes all egress through the required VPC/subnet, grants the worker runtime account the bucket-scoped durable-store object role and `roles/secretmanager.secretAccessor` only on the configured session secret, and grants the caller runtime account `roles/run.invoker`. It does not retrieve, echo, or write secret payloads.

After review, run the same script without `--dry-run`. This repository's automation does not deploy external resources on its own. For later worker revisions, close `SELFHOSTED_AUTH_ENABLED`, wait for all active calls to finish or reach their caller timeout, confirm no durable ledger entry remains `pending`, deploy and verify the single revision, and only then reopen the kill switch; revision overlap must never be used as account-operation concurrency.

## Durable-state incidents and recovery

The GCS store is authoritative across Cloud Run restarts. In production, a missing, malformed, unreadable, or unwritable durable-store configuration is fail-closed: do not enable the application kill switch and do not bypass it with an in-memory fallback.

An operation left `pending`, or whose result is ambiguous after a timeout, process interruption, or GCS error, must be treated as potentially executed. Do not automatically replay it, delete its ledger object, or infer success from a missing response. Keep `SELFHOSTED_AUTH_ENABLED=false`, inspect the durable ledger and the relevant Instagram-visible outcome using an approved operator workflow, then explicitly record the recovered terminal result before allowing a retry. If the operation cannot be resolved, leave it blocked and escalate; a new operation ID must not be used to evade that decision.

`account_operation_locked` means the durable global account-operation mutex is held, including when another revision owns it or a previous release failed. It is fail-closed: do not retry around it, deploy another revision to bypass it, or delete its object merely to restore traffic. Keep `SELFHOSTED_AUTH_ENABLED=false`, drain and verify that no invocation can still be running on any revision, then resolve the owner operation as above. Only after recording that result and verifying the mutex is stale may an authorized operator clear the durable mutex through the approved audited recovery procedure. If ownership or outcome cannot be proven, leave the mutex in place and escalate.

An `instagram_challenge` or `authentication_failed` state is a permanent account quarantine. Never auto-clear, auto-retry, or delete that quarantine object. Close the kill switch, drain requests, investigate and repair the account/session outside the worker, then have an authorized operator explicitly perform the documented recovery that replaces the session settings and clears the matching durable quarantine only after verification. Redeploy and validate the single worker revision while the switch remains off; reopen it only after the operator records the recovery decision.

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
SCRAPER_FALLBACK=false
```

Do not use bearer mode in production. It is a local-development compatibility path, not the Cloud Run authorization mechanism.

Analysis V2 treats the four paid collection selectors as one route: `followers`, `following`, `likers`, and `comments` must all be `selfhosted_auth` or all be `apify`. Mixed values are rejected before collection. With `selfhosted_auth`, `SCRAPER_FALLBACK=false` is required and an authenticated-worker error fails the paid request without creating an Apify run. That route requires the worker URL, matching OIDC audience, 1,000–300,000 ms timeout, and enabled `SELFHOSTED_AUTH_ENABLED` kill switch in the generated non-secret runtime manifest. An all-Apify rollback instead requires `SELFHOSTED_AUTH_ENABLED=false` and does not require worker URL, audience, or timeout configuration.

Beta requests carrying `providerExecutionPolicy.mode=betatest_free_pool` are separate: relationship and interaction calls always use their request-frozen free Apify slots and budgets regardless of these global paid selectors. Their existing selfhosted profile primary may still use the frozen free Apify profile fallback.

Apply `20260803140000_add_authenticated_selfhosted_scraper_receipts.sql` through the repository's reviewed migration workflow before enabling the selectors. Start with a low-volume canary. Suspension risk cannot be eliminated; rate-limit responses trigger a durable cooldown, while challenges and authentication failures create a durable account quarantine and require the explicit recovery procedure above.

## Roll back to Apify

To stop new authenticated-worker requests, first update and deploy the application environment:

```dotenv
SELFHOSTED_AUTH_ENABLED=false
SCRAPER_FOLLOWERS=apify
SCRAPER_FOLLOWING=apify
SCRAPER_LIKERS=apify
SCRAPER_COMMENTS=apify
SCRAPER_FALLBACK=true
```

This takes effect without reading or rotating the worker session secret. Leave the Cloud Run service private; do not make it public during rollback. Wait for in-flight calls to settle, inspect unresolved durable ledger entries and any account quarantine, and investigate the failure before an explicit operator decision to re-enable the kill switch.
