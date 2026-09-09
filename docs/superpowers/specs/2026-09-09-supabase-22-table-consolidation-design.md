# Supabase 22-Table Consolidation Design

**Date:** 2026-09-09 (Asia/Seoul)

**Status:** Owner-approved design

## Objective

Reduce the production `public` schema from 174 base tables to exactly 22 base
tables while preserving required user, payment, result, provider, recovery, and
audit data. The primary outcome is a smaller operational and contract surface:
fewer migrations, RPCs, fixtures, and table-specific state machines to maintain
during ordinary feature work and incident recovery.

The count applies only to `public` base and partitioned tables. Supabase-managed
schemas such as `auth`, views, and external R2/GCS objects are not counted. The
design does not satisfy the goal by moving old tables into another PostgreSQL
schema. Retired data is copied into a canonical table or a verified encrypted
archive and the redundant table is eventually removed.

## Constraints

- Preserve the fixed marketing copy in `app/page.tsx`.
- Preserve user ownership, payment evidence, result history, provider-cost
  lineage, account-deletion semantics, and external-media lifecycle evidence.
- Never mutate an external user's `payment_pending` order without independent
  provider evidence and an auditable disposition.
- Do not infer historical identity links from usernames, timestamps, UTM data,
  referrers, user agents, or IP addresses.
- Keep every public table RLS-enabled. Browser clients never receive a service
  role credential, raw anonymous device identifier, internal HMAC, or claim
  token.
- Apply one reviewed migration allowlist at a time. Never bulk-push unrelated
  pending migrations from a mixed worktree.
- Do not activate analysis admission or run the real `0_min._.00` canary as part
  of this project.

## Simplicity Rules

1. Reuse the existing public table name when it already represents the canonical
   aggregate.
2. Add a new table only when two or more current families share the same
   lifecycle, retention, and access rules.
3. Put high-cardinality query keys and state-machine fences in typed columns.
   Put infrequently queried, versioned stage details in validated JSONB.
4. Do not create one RPC per stage. Prefer a small service boundary with typed
   operation kinds and explicit authorization.
5. Do not add a generic framework for a single caller. Compatibility adapters
   exist only while a real old caller remains.
6. Delete obsolete contract tests with their retired table or RPC. Replace them
   with tests for the canonical invariant, not one-for-one copies.

## Canonical Public Tables

| # | Table | Responsibility |
|---:|---|---|
| 1 | `users` | Canonical application principal and paid/account projection; `auth.users` remains external. |
| 2 | `landing_leads` | Target and excluded account inputs linked to an anonymous journey and, after claim, a user. |
| 3 | `earlybird_waitlist` | Active waitlist membership and immutable signup snapshot. |
| 4 | `earlybird_orders` | Commercial order aggregate, pricing snapshot, payment state, and result linkage. |
| 5 | `result_feedback` | Owner-submitted result feedback. |
| 6 | `analysis_requests` | Analysis aggregate root, ownership, admission snapshot, and current progress projection. |
| 7 | `analysis_preflights` | Preflight aggregate, anonymous claim, exclusion decision, policy snapshot, and bounded scrub state. |
| 8 | `analysis_jobs` | Request DAG work, dependencies, attempts, dispatch generation, lease, and completion fences. |
| 9 | `analysis_events` | Append-only progress, lifecycle, and sanitized operational events. |
| 10 | `analysis_artifacts` | Typed staged evidence, manifests, media references, replay material, and retention metadata. |
| 11 | `analysis_results` | Versioned summaries, candidates, scores, narrative, publication, ranking, and sharing state. |
| 12 | `analysis_provider_runs` | Provider execution state, operation identity, reservation, ambiguity, usage, and reconciliation. |
| 13 | `analysis_costs` | Append-only provider/AI cost facts, attribution, conservative bounds, and late reconciliation. |
| 14 | `analysis_cache` | AI, profile, anonymous, and B-lite cache entries with typed scope, TTL, and single-flight state. |
| 15 | `analysis_audit_bundles` | Permanent versioned audit evidence, completeness, parity attestation, and purge fence. |
| 16 | `payment_events` | Immutable webhook, reconciliation, refund/failure, and paid-evidence events. |
| 17 | `fulfillment_jobs` | Earlybird delivery/admission queue with bounded retry and operator-review state. |
| 18 | `notification_outbox` | Discord, Kakao, Sentry, and future notification delivery with deduplication and retry. |
| 19 | `account_lifecycle` | Classification, paid evidence, deletion, withdrawal, E2E, and retirement transitions. |
| 20 | `system_configuration` | Versioned plans, gates, provider policies, budgets, and effective configuration snapshots. |
| 21 | `system_leases` | Typed concurrency reservations, leases, heartbeats, generations, and fencing tokens. |
| 22 | `maintenance_jobs` | Recovery, replay, rearm, cleanup, terminalization, purge, and audit-assembly work. |

`users` is the canonical application principal rather than only a profile row.
`analysis_requests` holds the current progress projection so clients do not have
to replay `analysis_events`. `analysis_results` retains indexed candidate and
revision keys; it is not one unindexed JSON document. `analysis_provider_runs`,
`analysis_costs`, and `payment_events` remain separate because execution state,
cost accounting, and commercial payment evidence have different mutation and
retention rules.

## Typed JSONB Contract

The consolidated tables use a small common envelope only where it removes a real
family of redundant tables:

```text
kind              text, constrained to a reviewed enum
schema_version    integer
request_id        uuid, nullable where the record is not request-scoped
job_id            uuid, nullable
state             text, typed per kind
payload           jsonb, validated by a database check and application parser
content_hash      text, immutable where the record is evidence
retention_class   text
created_at        timestamptz
updated_at        timestamptz
```

Frequently filtered fields such as owner, status, stage, rank, provider,
operation key, next attempt, expiry, and publication state remain ordinary
columns with partial or composite indexes. JSONB is reserved for cold details
that previously required a dedicated manifest/checkpoint/recovery table.

## Landing Lead Identity and Journey Model

`landing_leads` remains one table with one row per submitted Instagram account.
Rows are grouped by a single analysis journey.

Required columns include:

```text
journey_id                 uuid
input_context              target | excluded
instagram_id               normalized text
anonymous_principal_hash   nullable dedicated HMAC
auth_user_id               nullable FK to public.users
source_preflight_id        nullable opaque UUID, deliberately not an FK
capture_token_hash         nullable one-time token hash
mapping_status             legacy_unlinked | anonymous_device |
                           authenticated_user | unlinked_after_deletion
mapping_source             nullable constrained text
linked_at                  nullable timestamptz
```

The existing attribution fields remain. They are not identity keys.

### New journey flow

1. The browser keeps the existing anonymous device identifier locally. The
   server derives a dedicated domain-separated HMAC and never stores the raw
   value.
2. `POST /api/leads` records the target and returns an opaque capture token. Only
   the token hash is stored.
3. Preflight creation consumes the token idempotently, binds the target row to
   the new `journey_id` and `source_preflight_id`, and creates the target row if
   fire-and-forget landing capture was missed.
4. Exclusion persistence creates an `excluded` row with the same journey and
   preflight. Analysis correctness does not depend on lead analytics being
   available; a durable retry records a failed analytics write.
5. Direct `/analyze` and authenticated landing flows use the same preflight
   boundary, so they cannot bypass target capture.
6. A successful OAuth preflight claim monotonically assigns `auth_user_id` to
   every row in that journey. A non-null user is never replaced by another user.
7. Account deletion explicitly nulls `auth_user_id` and marks the rows
   `unlinked_after_deletion`. A later account on the same browser cannot reclaim
   them.

Anonymous identity means the same browser/device. Cross-device anonymous
identity is intentionally unsupported until login. After login, journeys from
that verified account are grouped by `auth_user_id`.

### Historical rows

Existing target rows and any rows whose source preflight was scrubbed or removed
remain `legacy_unlinked`. Existing excluded rows may receive a user only when the
surviving preflight supplies an exact non-null owner. No historical target and
excluded pair is fabricated.

## Operator Dashboard

Add a Leads section to the existing operator console through a server-only
`/api/admin/landing-leads` endpoint. Reuse the existing operator allowlist,
typed response parsing, keyset pagination, and `Cache-Control: private,
no-store` conventions.

The UI provides:

- Target and Excluded tabs;
- authenticated, anonymous-device, and legacy-unlinked filters;
- user/journey grouping;
- normalized Instagram ID and date filtering;
- bounded summary and detail responses.

List responses omit raw input, referrer, user agent, device/capture hashes, IP,
claim material, and internal identifiers. Supabase client roles retain no direct
access to `landing_leads`.

## Migration Strategy

The project uses expand, verify, cut over, and contract. An arbitrary table count
never overrides a failed evidence gate.

### Wave 0: freeze and inventory

Capture the exact live catalog, routines, triggers, policies, grants,
publications, dependency edges, migration history, application callers, jobs,
scripts, and dashboard readers. Produce an exact survivor map and a contraction
allowlist. Resolve `payments`, `payment_orders`, and `pending_analysis` before
they enter any destructive scope.

### Wave 1: identity and operator surfaces

Extend `landing_leads` with the journey model, add the durable claim operation,
and add the read-only dashboard section. Backfill only exact historical links.
This wave changes no analysis execution table.

### Wave 2: canonical operational tables

Add only canonical tables that do not already exist. Reuse existing aggregate
names. Introduce validated kinds, indexes, RLS, and service-only write paths.
Existing tables remain authoritative.

### Wave 3: dual-write and backfill

Move one lifecycle family at a time. The same transaction writes both stores
where possible; otherwise a durable outbox completes the second write. Backfill
in dependency order and compare counts, ownership, status transitions, ordering,
hashes, costs, and retention markers.

### Wave 4: shadow-read and cutover

Use server-only family flags, not one global switch. Compare legacy and canonical
reads for result, progress, sharing, payment, fulfillment, retry, recovery, and
operator workflows. Switch writes, then reads, one family at a time. Old tables
become read-only during the rollback window.

### Wave 5: archive and contract

Create an encrypted archive manifest with row counts and deterministic
checksums, restore it into an isolated database, and verify required reads. Drop
only the exact reviewed allowlist for that wave after all code, RPC, trigger,
cron, and external traffic dependencies are zero. Verify the live count after
each wave; the terminal count must be exactly 22.

## Failure Handling

- A one-sided dual-write records a bounded retry and blocks that family's
  cutover.
- Missing source data, a partial audit bundle, or a count-only match is not
  parity.
- Any ownership, status, rank, checksum, cost, or retention mismatch blocks the
  wave.
- Conflicting lead ownership remains unlinked and emits a sanitized audit event.
- Payment, provider, media, or deletion evidence without a terminal disposition
  remains retained.
- Migration apply ambiguity is resolved by reading remote history before any
  retry.
- No table is dropped in the same deployment that first moves its readers.

## Rollback

Each family has independent server-only read and write flags. Rollback disables
the canonical reader/writer, drains its retry queue, and returns to the retained
legacy read path. The old tables remain immutable and queryable for the complete
rollback window. A destructive wave requires both a tested compatibility path
and a verified archive restore; PITR or the existence of an archive object alone
is insufficient.

## Verification

Every wave must pass:

1. type, unit, and migration-contract tests;
2. PGlite behavior tests and native PostgreSQL state-machine tests;
3. RLS, ACL, grant, and privileged-function review;
4. deterministic dual-write and backfill parity;
5. owner result, progress, share, payment, fulfillment, retry, recovery, account
   deletion, and operator-dashboard shadow reads;
6. archive and restore checksum verification;
7. catalog proof that the exact contraction allowlist has no remaining FK, view,
   function, trigger, policy, publication, sequence, partition, cron, script, or
   external caller;
8. post-wave route smoke tests and public base-table count.

The existing two production audit bundles are valid partial gap evidence, not
contraction evidence. They caused no source purge. Synthetic and non-canary
fixtures may prove code behavior, but a production destructive wave remains
blocked until its own real parity, traffic, archive, and restore gates pass.

## Completion Criteria

- The live `public` schema contains exactly the 22 named base tables.
- All retained data is represented in a canonical table or verified encrypted
  archive according to its retention class.
- Current application, operator, recovery, payment, and account-deletion flows
  use the canonical contracts.
- Obsolete table-specific RPCs, migrations-as-runtime-contract assumptions, and
  redundant tests are removed.
- `landing_leads` maps all new target/excluded inputs by same-device anonymous
  journey and verified user claim; historical uncertainty remains explicit.
- No admission activation or real `0_min._.00` canary occurred.
