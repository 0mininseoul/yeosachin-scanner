# Authenticated Instagram worker

Single-account FastAPI worker for the authenticated self-hosted scraper. It exposes only the relationship and interaction endpoints consumed by `selfhosted-auth/client.ts`; interactive API documentation is deliberately disabled.

## Required configuration

- `IG_SESSION_SETTINGS_BASE64`: base64-encoded persisted `instagrapi` settings containing `authorization_data.sessionid` and `device_settings`. Supply this through a secret manager; never commit or log it.
- `IG_MAX_IN_FLIGHT`: optional, 1–5 (default `5`). Account operations are still serialized to one at a time.
- `IG_QUEUE_TIMEOUT_SECONDS`: optional, 1–300 (default `240`).
- `IG_RATE_LIMIT_COOLDOWN_SECONDS`: optional, 60–86400 (default `900`).
- `IG_DURABLE_STORE_BUCKET`: required in production. Dedicated GCS bucket for the durable operation ledger, account-safety state, and global account-operation lock. If this configuration or its object access is unavailable, production must fail closed; there is no in-memory fallback.
- `IG_DURABLE_STORE_PREFIX`: optional durable-store object prefix (default `instagram-auth-worker`).
- `WORKER_LOCAL_BEARER_TOKEN`: optional local-only bearer protection, 32–512 characters. Production Cloud Run deployments should require authenticated invocation instead of making the service public.

## Local run and test

Install the pinned requirements, configure the required session setting using your local secret workflow, then run:

```sh
uvicorn app.main:app --host 127.0.0.1 --port 8080
```

Run the test suite from this directory:

```sh
/tmp/ai-baram-instagram-worker-venv/bin/python -m unittest discover -s tests -v
```

## Container

```sh
docker build -t instagram-auth-worker .
docker run --rm -p 8080:8080 --env-file /secure/path/worker.env instagram-auth-worker
```

The image runs as a non-root user and honors Cloud Run's `PORT` environment variable. Keep Cloud Run ingress and IAM restricted to the application service account; do not expose this worker publicly.

Production must also route all egress through a Direct VPC subnet backed by Cloud NAT with one reserved static outbound IP. The client restores the same persisted device/session settings and applies a randomized 1-3 second private-request delay; changing outbound IPs or removing that delay increases challenge risk. Keep `max-instances=1` and request `concurrency=5`; before a revision change, close the application kill switch and drain active calls.

The durable store treats an unresolved `pending` operation as potentially executed: an operator must inspect the account-visible result and explicitly record recovery before retrying. It also holds a single, GCS-generation-fenced global account-operation lock across Cloud Run processes and revisions. The lock has no lease: if an operation process dies or release is uncertain, it remains held and an authorized operator must recover it deliberately before any new account operation can run. Completed idempotency-cache reads do not require this lock. Challenges and authentication failures are durable quarantines; never clear them automatically. An authorized operator must first repair and verify the account/session, then deliberately clear the matching quarantine as part of a recorded recovery procedure.
