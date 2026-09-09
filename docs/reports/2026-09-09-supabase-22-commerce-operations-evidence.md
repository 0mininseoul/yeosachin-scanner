# Supabase commerce and operations canonicalization evidence

Date: 2026-09-09 (Asia/Seoul)

## Decision

**BLOCKED / report-only.** The additive schema and bounded adapters are ready for review, but production parity, provider evidence, archive/restore evidence, ownership/traffic approval, and a disposable native PostgreSQL concurrency run are not available in this worktree. No remote migration, analysis admission activation, provider call, or real canary was performed.

## Implemented commits

- `98efa726` — generated `20260909095932_add_commerce_operation_canonical_tables.sql` and schema/RLS/ACL contract tests.
- `be4115a8` — typed payment, fulfillment, notification, account lifecycle, lease, maintenance adapters and notification shadow-read hook.
- `3d6d0e64` — report-only bounded backfill, aggregate parity checksums, and fail-closed read-flag rollback.
- `13148d21` — typed immutable system-configuration adapter and service-only configuration RPC.
- `6cbf0657` — review fixes for payment evidence, fenced operation claims, notification producers, lifecycle gates, and bounded parity.

## Schema and security evidence

- Seven additive tables are present: `payment_events`, `fulfillment_jobs`, `notification_outbox`, `account_lifecycle`, `system_configuration`, `system_leases`, and `maintenance_jobs`.
- Each table has RLS enabled and forced; direct `PUBLIC`, `anon`, `authenticated`, and `service_role` table access is revoked. Write/read entry points are service-role-only RPCs with `SECURITY DEFINER SET search_path = ''` and explicit `REVOKE EXECUTE`/`GRANT EXECUTE` ACLs.
- Payment events, account lifecycle entries, and configuration versions have immutable update/delete triggers. Idempotency, dedupe content, lease generation, fence token, attempt, hash, and JSON-object checks are bounded in SQL; zero-valued payment amounts are allowed while negative amounts are rejected.
- Payment evidence retains nullable order linkage, provider, disposition, redacted JSON payload, payload fingerprint, and provider `occurred_at`; event-id and idempotency-key content conflicts have distinct SQL error markers.
- Fulfillment upserts are generation-fenced and monotonic, preserving existing request and lease fields when a legacy snapshot omits them. Notification and maintenance families expose bounded `SKIP LOCKED` claim, lease, finish, stale-reconciliation, retry, and terminal contracts without replacing legacy delivery authority.
- A disposable PGlite replay with only `users`, `earlybird_orders`, and `analysis_requests` stubs executed the migration SQL after removing role ACL statements and verified all seven relations have `relforcerowsecurity = true`; a second PGlite case exercised payment dedupe, zero amount, fulfillment monotonic rejection, and notification/maintenance claim-finish paths.
- All canonical tables remain inaccessible to browser roles through explicit table revocation, forced RLS, and service-role-only `SECURITY DEFINER SET search_path = ''` RPC ACLs.

## Backfill, parity, and rollback evidence

The guarded command:

```text
npx tsx --conditions=react-server scripts/backfill-commerce-operations-canonical.ts --limit=100 --report-only
```

returned `status: blocked`, `mode: report_only`, `processed: 0`, `batchSize: 100`, `unknownEvidenceCount: 0`, and `blockedReasons: ["SOURCE_NOT_CONFIGURED"]`. The report emitted only family-level checksums; it emitted no user, contact, provider, order, or raw payload values.

The report-only implementation caps every source batch and field comparison at 100 and rejects `--apply`, `--delete`, `--cutover`, and `--activate`. `payment_pending` without independent no-sale evidence returns `PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED`; malformed no-sale evidence returns `PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID`; independently witnessed no-sale evidence is only `eligible_for_separate_reconciliation` and never mutates an order. Parity reports expose counts, checksums, compared counts, truncation, and mismatch field names only; no source/canonical record values are returned.

All seven read flags are false by default:

```text
COMMERCE_CANONICAL_PAYMENT_READ=false
COMMERCE_CANONICAL_FULFILLMENT_READ=false
COMMERCE_CANONICAL_NOTIFICATION_READ=false
COMMERCE_CANONICAL_ACCOUNT_READ=false
COMMERCE_CANONICAL_CONFIG_READ=false
COMMERCE_CANONICAL_LEASE_READ=false
COMMERCE_CANONICAL_MAINTENANCE_READ=false
```

The corresponding independent writer flags are `COMMERCE_CANONICAL_{PAYMENT,FULFILLMENT,NOTIFICATION,ACCOUNT,CONFIG,LEASE,MAINTENANCE}_WRITE`, all defaulting closed. `rollbackCanonicalFlags()` forces all read and writer flags to `false`; the legacy global dual-write flag is no longer used by producers. Existing payment finalization, fulfillment, account classification/deletion, and notification delivery remain authoritative until each family is separately enabled.

## Aggregate checksum baseline

These are the deterministic empty-source baseline checksums emitted by the guarded report-only run. They are not a claim that production parity has been established.

| Family | Checksum |
| --- | --- |
| payment | `040ffd5925d40e11c67b7238a7fc9957850b8b9a46e9729fab88c24d6a98aff2` |
| fulfillment | `a3f2c4b78aac99eef91bfb4cebff4b303fc07172af2562500fc8aba74ee088c8` |
| notification | `1242ab99f6773a843ffe3860c98564b38ca0ef5ad3e36df681c3fb60ca243aa4` |
| account | `9af211329b2fc82e5efe906062c730082819b23fe8394bc435e0b1bf0458eb54` |
| config | `b79606fb3afea5bd1609ed40b622142f1c98125abcfe89a76a661b0e8e343910` |
| lease | `b544a7686d1186680a9d8f24ff542b00d8ae60da4dd2613a38f6292a8337cc37` |
| maintenance | `8589c63b0943a62bfda9b35dccc71a30f5677386f6f7c644c3307465ce2cfa55` |

## Payment and lease safety proof

- The new migration contains no order-status update and does not add a payment state transition. The only `payment_pending -> payment_failed` path remains the existing evidence-gated no-sale reconciliation RPC.
- Canonical payment recording is append-only and happens after legacy signed finalization. It carries the finalized order/disposition and provider event time, stores only bounded redacted payload fields plus a raw-body fingerprint, and maps idempotency conflicts to an explicit application error; a mirror failure cannot fabricate paid evidence or alter the legacy order. If both canonical and maintenance writes fail, the adapter returns `CANONICAL_MAINTENANCE_UNAVAILABLE` rather than claiming a queued marker.
- Kakao signup, Sentry alert, and payment Discord producers have notification-family dual-writes with bounded sanitized payloads, content hashes, dedupe keys, and legacy-first fail-open behavior. A notification mirror remains non-cutover; its failure is observable and cannot block the legacy producer.
- Account deletion records durable `started`, `prepared`, and completion lifecycle evidence around the begin, each object deletion, database purge, Auth deletion, and completion RPC. When the account canonical writer is enabled, missing lifecycle evidence stops before the next irreversible step.
- The native disposable PostgreSQL concurrency harness was not run; no native target or independent production-parity evidence was supplied. Native PostgreSQL, production source/archive/restore/owner/traffic/provider gates therefore remain explicitly blocked.

## Verification

- Focused Vitest suite: **PASS**, 187 tests across canonical commerce/operations, disposable PGlite migration and claim-contract checks, Groble payment, fulfillment, payment Discord, Kakao signup, Sentry, account lifecycle, account principal, and report-only backfill tests.
- Full `npm test` was started for finishing verification; the suite remained in a long-running capacity identity epoch fixture launcher after more than 11 minutes, so it was interrupted without a test failure. The focused suite is the completion gate for this isolated lane.
- `npx tsc --noEmit --pretty false`: **PASS**.
- `npm run lint`: **PASS**, 0 errors and 27 existing warnings outside this change.
- `npm run build`: webpack and TypeScript compilation **PASS**; page-data/static generation is blocked because this environment has no configured Supabase URL/API key while prerendering `/betatest` and `/_not-found`.
- `git diff --check`: **PASS**.

## Independent re-review closure evidence

- Canonical parity now probes one sentinel row past each bounded source/canonical batch, compares both key directions and actual field content, and blocks on divergent or truncated tails. The internal notification shadow reader derives bounded content-shaped rows from the payment, Kakao, and Sentry legacy outboxes, then compares payload and content hashes against the canonical family rather than reporting a canonical row count alone.
- System configuration rejects `{}` and verifies the SHA-256 content hash over the canonicalized JSON representation in both the TypeScript adapter and SQL RPC. Fulfillment upserts preserve request, lease, attempt, timing, error, completion, and manual-review fields while rejecting lower-rank states even at higher generations and rejecting equal-rank terminal-state changes; notification/maintenance duplicate enqueue returns the actual terminal state, with explicit dead/blocked-only requeue, and stale reconciliation takes a validated limit.
- Already-completed account deletion begin results append `retired:completed:completion` lifecycle evidence before returning. Payment Discord, Kakao signup Discord, Sentry Discord, and Groble webhook canonical mirror/fallback awaits use a one-second bounded timeout while preserving legacy-first/fail-open behavior.
- Latest focused verification: **PASS**, 183 tests across commerce/operations adapters, the PGlite migration/content/concurrency/state-machine checks, backfill parity, Groble webhook, fulfillment, payment Discord, Kakao signup Discord, Sentry, and account deletion. `npx tsc --noEmit --pretty false`: **PASS**; `npm run lint`: **PASS** with 0 errors and 27 pre-existing warnings; `git diff --check`: **PASS**.
- A fresh `npm run build` compiled webpack and TypeScript successfully but failed during static page generation because this environment lacks Supabase URL/API-key configuration while prerendering `/analyze` and `/betatest`; no production or remote Supabase action was attempted.

Production evidence remains blocked until the owning operator supplies source/archive/restore/ownership/traffic/provider gates and a disposable native PostgreSQL target. No remote apply, destructive operation, provider call, activation, `payment_pending` mutation, notification cutover, or canary operation was performed; those operations must remain disabled.
