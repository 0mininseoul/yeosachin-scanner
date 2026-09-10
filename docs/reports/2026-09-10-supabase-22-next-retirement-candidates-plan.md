# Supabase 22 next-retirement-candidates analysis plan

## Objective

Identify the smallest defensible evidence batch after `account_deletion_jobs`
using only committed sanitized inventory, approved Supabase 22 documents,
committed migration history, repository runtime/static references, and git
history. This is an evidence report, not a readiness or destructive-action
approval.

## Method

1. Classify legacy tables from the 2026-09-10 inventory into definitely active,
   sensitive/denylisted, possible dead/empty, or unknown. Never treat a name,
   estimated row count, or zero runtime caller count as proof of retirement.
2. Trace the smallest post-`account_deletion_jobs` batch through migrations,
   runtime/static references, and git history. Name a canonical destination only
   when the approved contract and repository evidence prove it.
3. For each candidate, record the evidence boundary and exact missing production
   queries/gates required before any archive, contract, or DROP decision.
4. Emit a sanitized machine-readable report with both allowlists empty and
   `destructiveOperations: "refused"`, plus a concise human-readable plan.

## Safety and validation

- Do not call production or remote APIs; do not change runtime code or
  migrations; do not mutate flags, payments, data, or protected files.
- Validate JSON schema/content, report tests or a report-only verifier, diff
  whitespace, and secret scans. Recheck that contraction and destructive
  allowlists are empty before commit.

## Resulting next batch

The smallest defensible batch is exactly one evidence candidate:

- `earlybird_webhook_events` → existing canonical `payment_events`.

The destination is proven by the explicit inventory mapping, its test assertion,
the commerce backfill source list, and the canonical `payment_events` migration.
The source is definitely active and payment-sensitive: the webhook route still
calls legacy finalization RPCs, 31 committed migration/operation files reference
it, and canonical payment read/write flags remain closed. This is therefore an
evidence-only, blocked candidate; both allowlists remain empty.

Required production gates are exact source/canonical counts, transformed per-row
parity and deterministic checksums, catalog dependency/RLS/ACL/routine proof,
migration-history alignment, a closed zero-legacy-write observation window,
independent `payment_pending` provider disposition, encrypted archive/isolated
restore, rollback shadow-read parity, and separate owner approval.
