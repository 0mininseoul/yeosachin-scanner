# Five-Hour Production Stabilization and Cleanup Design

**Date:** 2026-08-30  
**Decision owner:** coordinator, delegated by the user  
**Deadline:** five-hour working window  
**Release base:** `origin/main` at `2a28326462bf636f92368dc894b5ea76911d79bb`

## Objective

Restore a green, trustworthy release line for the paid checkout → automatic analysis → result flow, then use the remaining parallel capacity to turn the deferred Supabase and legacy-analysis cleanup into an evidence-backed removal sequence. The production database must not be mutated during the cleanup audit.

## Chosen Approach

Use a stabilization-first parallel plan:

1. Repair the six failing GitHub Actions contracts, including the real bounded-Amplitude-flush regression.
2. Add a fail-closed production rollout check for the exact commit's GitHub Actions CI conclusion.
3. Audit live Supabase objects and repository dependencies read-only, and classify cleanup candidates without applying DDL or DML.
4. Integrate only release-safe code changes, run the complete quality suite, wait for exact-SHA CI success, and then align Vercel and Cloud Run to that same SHA.

This is preferred over either a CI-only response, which wastes the available window, or concurrent production table deletion, which would mix a release repair with an irreversible data migration.

## Workstreams

### A. CI Contract Repair

Scope ownership:

- `app/earlybird/earlybird-status.tsx`
- the four currently failing contract-test files

Required behavior:

- Restore `flushAnalytics()` before automatic status navigation, retaining its existing 500 ms upper bound.
- Keep the immediate automatic-analysis bridge visible while the durable request URL materializes.
- Update stale assertions from immutable prop reads to the owner-refreshed `currentOrder` snapshot.
- Validate both visible and invisible probe image paths as unoptimized signed proxy images.
- Do not weaken Amplitude privacy, checkout recovery, or real-image-only contracts.

### B. Exact-SHA CI Deployment Gate

Scope ownership:

- analysis-worker rollout/readiness scripts and their focused tests
- release-readiness operations documentation

Required behavior:

- A production rollout must fail before mutation unless the GitHub Actions `CI` workflow for the exact expected commit is completed successfully.
- Authentication and API failures fail closed without printing credentials.
- An explicit local dry-run/test seam may use deterministic fixture data; production bypasses are forbidden.
- Existing Cloud Run/Vercel/DB/image-signing exact-SHA checks remain intact.

### C. Supabase and Legacy Analysis Cleanup Audit

Scope ownership:

- read-only live catalog inspection
- repository reference and migration-history inspection
- audit documentation only

Required outputs:

- Inventory public/private application tables, views, materialized views, functions, triggers, policies, foreign keys, and storage dependencies.
- Map every live object to runtime code, current migrations, operations scripts, or an explicit retention obligation.
- Classify objects as `keep`, `consolidate`, `archive-then-drop`, `drop-candidate`, or `unknown`.
- Preserve all user data from 2026-07-24 onward, the administrator identity, and payment/provider evidence unless an independently approved migration says otherwise.
- Record the requested target/excluded lead split, separate plan waitlist, withdrawn-user archive semantics, anonymous-to-authenticated identity mapping, payment-pending retention, and paid-only `first_paid_at` contract.
- Produce proposed SQL only inside a documentation code block or non-executable report. Do not create a file under `supabase/migrations` and do not execute DDL/DML.
- Identify high-confidence legacy API/module removal candidates, but do not remove them in this workstream.

## Integration and Release Order

1. Run A, B, and C in isolated top-level Orca worktrees based on `origin/main`.
2. Review A and B independently, then integrate them onto one clean release branch.
3. Run the six reproducing tests, complete `npm test`, lint, TypeScript, production build, and release-readiness script tests.
4. Push the integrated SHA and wait for the exact GitHub Actions workflow to turn green.
5. Only after CI success, deploy Vercel and Cloud Run at the same SHA and run no-spend public/readiness canaries.
6. Keep C as an audit artifact for the next explicitly approved schema-reduction migration.

## Safety Boundaries

- No Apify, Gemini, payment, replay, or failed-order invocation.
- No production Supabase DDL/DML or data deletion.
- No destructive worktree cleanup.
- Do not touch user-owned dirty files or the protected migration `20260719190000_reconcile_stuck_groble_earlybird_order.sql`.
- Do not implement the B-lite redesign before visual approval.
- Do not use or create the obsolete Vercel project `ai-baram-detector`.

## Acceptance Criteria

- GitHub Actions `CI` succeeds for the final exact commit.
- The complete local test suite, lint, TypeScript, and production build pass.
- Vercel production and the sole 100% Cloud Run revision report the final exact commit.
- Release readiness, image signing, and public no-spend canaries pass.
- The cleanup audit names object-level evidence and a safe execution order without mutating production.

## Self-Review

- No placeholders or undecided production mutations remain.
- Workstream ownership is disjoint.
- The release path is serialized only at integration and deployment.
- Cleanup findings cannot be applied accidentally by `supabase db push`.
