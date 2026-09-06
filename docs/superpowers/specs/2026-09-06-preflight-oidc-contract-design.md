# Preflight OIDC contract guard design

Status: approved implementation baseline (revised for independently
verifiable producer evidence)

Date: 2026-09-06

Base: `origin/main` at `694109753880a86dbb50878277ceb5912b451160`

## Objective

Prevent an active preflight capacity deployment from succeeding when the
currently serving production producer, Cloud Tasks delivery, Cloud Run
receiver, and service IAM describe different authentication contracts. The
guard is read-only and fail-closed. It must catch identity drift and
target/audience version-skew that can send a validly signed task to an older
receiver.

The change is limited to deployment-contract guards, their existing test
harnesses, and the public readiness DTO that exposes deployment-safe evidence.
It does not change task creation, queue contents, production resources, user
experience, or payment state.

## Contract

For an active (`initial` or `expanded`) preflight check or apply, all of the
following observations must agree:

1. The guard first selects the READY Vercel Production deployment returned by
   the existing API lookup, and binds the public readiness origin to that
   deployment's immutable ID, exact source SHA, and observed alias. The
   selected deployment is the currently serving producer plane. Vercel project
   Production environment records are next-deploy configuration, not evidence
   of values loaded by that deployment.
2. The currently serving public
   `GET /api/analysis/capacity/readiness` process computes a non-secret,
   versioned SHA-256 fingerprint from its own canonical preflight tuple:
   `PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL`, normalized
   `PREFLIGHT_TASKS_TARGET_URL`, and normalized
   `PREFLIGHT_TASKS_OIDC_AUDIENCE`.
   The DTO exposes only:
   `preflightProducerConfigFingerprintVersion`,
   `preflightProducerConfigFingerprint`, and
   `preflightProducerConfigReady`. It never exposes the tuple values. Missing
   or invalid runtime configuration returns a null fingerprint, false
   readiness, and an overall `ready: false` response. The fingerprint input is
   the version string followed by the lower-case service-account identity,
   normalized HTTPS target, and normalized HTTPS audience, separated by
   newlines; the SHA-256 output is lower-case hexadecimal.
3. The deployment wrapper computes the same fingerprint from the reviewed
   preflight manifest values and requires an exact version, readiness, and
   digest match from the currently serving public DTO. The manifest is the
   expected-contract input for this comparison, never proof that the producer
   loaded those values. The wrapper makes exactly one read-only Vercel v10
   project environment request without pagination parameters. It requires the
   exact top-level keys `envs` and `hiddenProductionEnvCount`, a valid metadata
   array, an integer hidden count of zero, and exactly one Production entry for
   each required key. It must not decrypt or treat environment records as
   active-producer evidence. Any hidden production values, pagination fields,
   direct-single-env variant, legacy endpoint, duplicate, or malformed shape
   fails closed. Only non-secret `key` and `target` fields are retained for the
   required-key check.
4. The selected preflight Cloud Tasks queue is observed read-only with the
   provider's complete list. If tasks exist, every returned task must carry
   the exact target URL, normalized origin audience, and OIDC
   `serviceAccountEmail` that match the reviewed manifest, active-runtime
   fingerprint contract, receiver, and service IAM. If the queue is empty, the
   active-runtime fingerprint observation is the independently verifiable,
   deployment-bound producer evidence; no caller-provided probe identity is
   accepted.
5. The dedicated receiver value
   `PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL` in the Cloud Run runtime manifest
   and observed service environment is the same task identity. The exact
   service-level `roles/run.invoker` policy must contain only that task member
   and the dedicated maintenance member, with no public principal or
   conditional binding.
6. Cloud Run's attached runtime identity and maintenance OIDC identity remain
   distinct from the task identity and from each other. Existing role-scoped
   checks continue to enforce this separation; this guard does not collapse
   runtime, maintenance, producer, or task identities.

The queue observation and readiness fetches never create, retry, acknowledge,
delete, or mutate a task. Credentials, tuple values, task bodies, and project
environment values are never printed, persisted, or included in release
evidence. Tests use only fake identities and domains.

## Stage and mode behavior

Bootstrap remains gate-off. It verifies the private Cloud Run service contract
and exact service IAM already required for a new service, but does not require
live producer/task evidence while no active intake is allowed. Initial and
expanded preflight `--check` and `--apply` bind the current Vercel deployment,
verify its runtime fingerprint, and then verify queue evidence before deploy
and again before promotion. `--dry-run` remains non-observing and prints no
identity values.

The guard runs in the same verification path as apply, so a successful
preflight deployment cannot bypass it by staging a revision, promoting a
captured revision, or running a post-promotion check. A mismatch stops before
`gcloud run deploy` or traffic mutation. No reconcile flag can authorize an
identity-chain mismatch; IAM reconciliation may repair only the existing
reviewed service binding after the chain itself agrees.

## Test contract

The public readiness unit tests and DTO exact-key assertions cover:

- a valid active runtime emits only the version, digest, and readiness fields
  for the preflight producer contract;
- missing or malformed tuple configuration returns null/false and overall
  `ready: false`; and
- bootstrap and conflicting source provenance remain fail-closed.

The capacity infrastructure harness covers:

- active-runtime fingerprint mismatch and missing evidence fail before deploy,
  even when the manifest and queue fixture are otherwise matching;
- the active-runtime fingerprint permits an empty preflight queue without a
  caller-provided identity string;
- any returned queue task identity, URL, or audience drift fails closed;
- missing next-deploy Vercel required keys fails closed while a project-env
  listing alone cannot pass the active-runtime check; and
- check/apply parity preserves exact service-level IAM and distinct
  runtime/maintenance identities.

The release-readiness shell checker and its fake response accept the expanded
DTO exact-key contract and validate the fingerprint field structurally without
printing it.

## Non-goals

- Do not use a Vercel project environment value, role manifest, or caller
  string as independently observed active-producer evidence.
- Do not add any caller-provided probe identity assertion.
- Do not create a Cloud Task or send a probe from the deployment script.
- Do not mutate Vercel, Cloud Tasks, Cloud Run, IAM, Supabase, or production
  data.
- Do not print or store credentials, decrypted environment values, task bodies,
  or service-account addresses in reports. Fake-only identities may appear in
  isolated test fixtures where needed to exercise equality checks.
