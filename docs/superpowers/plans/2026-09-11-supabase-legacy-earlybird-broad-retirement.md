# Supabase Legacy Earlybird Broad Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve 11 completed historical recovery records in canonical `maintenance_jobs`, then retire exactly eight unused legacy earlybird tables and their orphaned service-only routines so production `public` base/partitioned tables contract from 185 to 177.

**Architecture:** A single guarded, transactional migration copies each source row into `maintenance_jobs` with deterministic source-qualified keys, complete `to_jsonb` payloads, and content hashes, verifies per-source count and checksum parity, drops the exact orphaned routine/table allowlists without `CASCADE`, and verifies the terminal catalog. A checked-in restore operation reconstructs the eight source schemas and records from canonical payloads in an isolated database. Coordinator-owned production rollout uses a fetched-remote isolated Supabase workdir, pinned CLI 2.102.0, dry-run, one apply, and post-apply read-only verification.

**Tech Stack:** PostgreSQL/Supabase migrations, Supabase CLI 2.102.0, TypeScript, Vitest, PGlite, Next.js repository contracts.

**Spec:** `docs/superpowers/specs/2026-09-09-supabase-22-table-consolidation-design.md`

## Global Constraints

- Exact table allowlist: `earlybird_concierge_batch_target_lineage_repairs`, `earlybird_partial_adoption_second_rearms`, `earlybird_profile_evidence_failure_recoveries`, `earlybird_v211_apify_transient_admission_resumes`, `earlybird_v211_concierge_copy_corrections`, `earlybird_v212_concierge_copy_corrections`, `earlybird_v213_concierge_copy_corrections`, `earlybird_v214_concierge_gemini_copy_corrections`.
- Production preflight exact source counts are respectively `3,1,2,1,1,1,1,1` for a total of 11; any mismatch blocks the migration.
- No source has an incoming foreign key, view dependency, publication membership, application/runtime caller, repository script caller, DB cron caller, or caller from another retained database routine in the collected 2026-09-11 evidence. PostgreSQL `track_functions` is `none`, so `pg_stat_user_functions` is explicitly not used as traffic proof.
- Drop only routines whose exact identity signature is derived from and asserted against the production catalog; do not use `CASCADE`.
- Preserve every source column value in canonical JSONB and prove deterministic per-source count and checksum parity before any drop.
- Never mutate `payment_pending`, payment evidence, users, Auth identities, admission flags, or external services.
- Do not activate analysis admission and do not run the real `0_min._.00` canary.
- Do not modify `app/page.tsx`, `.playwright-mcp/`, or `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`.
- Never run `supabase db push --include-all`; production application is coordinator-only after merge and CI.
- Use no new framework or table. Reuse `maintenance_jobs` and existing retirement verification patterns.

---

## File Map

- `supabase/migrations/20260911001903_retire_legacy_earlybird_recovery_tables.sql`: guarded canonical copy, parity assertions, exact routine drops, exact table drops, and terminal assertions.
- `supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql`: sanitized pre/post catalog, count, dependency, canonical parity, and migration-history verification query; read-only except session-local temporary state rolled back.
- `supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql`: isolated-database-only recreation and canonical-payload restore for all eight tables.
- `scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`: fail-closed static, dynamic allowlist, migration, dependency, and PGlite restore tests.
- `scripts/generate-supabase-22-retirement-inventory.ts`: map the exact eight sources to `maintenance_jobs` so future inventory reports describe the approved canonical destination.
- `scripts/generate-supabase-22-retirement-inventory.test.ts`: assert those exact mappings and no broader prefix-based mapping.
- `docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json`: machine-readable allowlist, expected counts, hashes, evidence, and rollout state.
- `docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-evidence.md`: human-readable evidence and explicit activation boundary.

### Task 1: Freeze the exact retirement contract

**Files:**
- Modify: `scripts/generate-supabase-22-retirement-inventory.ts`
- Modify: `scripts/generate-supabase-22-retirement-inventory.test.ts`
- Create: `docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json`

**Interfaces:**
- Consumes: the eight-table allowlist and production aggregate evidence in Global Constraints.
- Produces: explicit `destinationFor(tableName) === 'maintenance_jobs'` mappings and a versioned manifest consumed by migration tests and rollout verification.

- [x] **Step 1: Add failing exact-mapping tests**

  Extend the existing destination test with all eight literal names and add negative assertions for `earlybird_webhook_events`, `earlybird_fulfillments`, `earlybird_payment_discord_outbox`, `earlybird_first15_canary_provider_rearms`, and `earlybird_v211_concierge_publications`.

- [ ] **Step 2: Verify the mapping tests fail**

  Run: `npx vitest run scripts/generate-supabase-22-retirement-inventory.test.ts`

  Expected: failure because the eight destinations are not yet explicit.

- [x] **Step 3: Add only the eight explicit mappings**

  Add eight literal entries to the existing destination map. Do not add prefix matching or infer any additional destination.

- [x] **Step 4: Create the manifest**

  Record schema version `supabase-22-legacy-earlybird-retirement-v1`, baseline commit `e2edd2d18a8425721ce8e52f671230e9a1ff3231`, public counts `185 -> 177`, the ordered table allowlist, counts `3,1,2,1,1,1,1,1`, expected total `11`, canonical destination `maintenance_jobs`, exact routine signatures, no-`CASCADE`, rollback source, and rollout status `not_applied`. Store no UUID, row payload, credential, project ref, or secret.

- [x] **Step 5: Verify mapping tests pass**

  Run: `npx vitest run scripts/generate-supabase-22-retirement-inventory.test.ts`

  Expected: all tests pass.

- [x] **Step 6: Commit the contract**

  Run: `git add scripts/generate-supabase-22-retirement-inventory.ts scripts/generate-supabase-22-retirement-inventory.test.ts docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json docs/superpowers/plans/2026-09-11-supabase-legacy-earlybird-broad-retirement.md && git commit -m "docs: freeze broad earlybird retirement contract"`

### Task 2: Implement guarded canonical preservation and retirement

**Files:**
- Modify: `supabase/migrations/20260911001903_retire_legacy_earlybird_recovery_tables.sql`
- Create: `scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

**Interfaces:**
- Consumes: manifest exact allowlists/counts and existing `maintenance_jobs(kind, target_key_hash, state, payload, content_hash, created_at, updated_at)`.
- Produces: 11 deterministic `maintenance_jobs` rows and absence of exactly eight source tables and their orphaned routines.

- [x] **Step 1: Write failing static contract tests**

  Assert a transaction-scoped advisory lock, `5s` lock timeout, bounded statement timeout, exact public baseline count 185, exact ordered allowlist hash, exact counts, source catalog/dependency assertions, explicit routine signatures, `DROP ...` without `CASCADE`, post-copy parity assertions, and final public count 177. Add tests that reject a ninth table, dynamic identifier input, truncated SQL, missing EOF commit, or a broadened destructive statement.

- [ ] **Step 2: Run the focused test and observe failure**

  Run: `npx vitest run scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

  Expected: failure because the migration is empty.

- [x] **Step 3: Implement deterministic canonical copy**

  In one explicit transaction, lock the wave, assert every source table and canonical table shape, then insert one canonical row per source row. Derive `kind` as `rearm`, `replay`, or `recovery`; derive `target_key_hash` from a versioned domain string, source table, and the complete primary-key JSON; set `state='succeeded'`; store `legacy_source_table`, `legacy_primary_key`, `legacy_row`, and `schema_version=1` in payload; compute `content_hash` from canonicalized payload text. Use `ON CONFLICT (kind, target_key_hash) DO UPDATE` only when the existing `content_hash` is identical; raise on conflicting content.

- [x] **Step 4: Assert parity before destructive DDL**

  For each source, compare exact source count with canonical rows filtered by `payload->>'legacy_source_table'`. Compare deterministic aggregates of source `to_jsonb(row)` and canonical `payload->'legacy_row'`. Require exactly 11 total canonical rows.

- [x] **Step 5: Drop the exact orphaned routine signatures and tables**

  Revoke execution where applicable, drop only the manifest routine identities, then issue eight literal `DROP TABLE public.<name>` statements without `CASCADE`. Assert all targets/routines are absent, the canonical parity rows remain 11, and the public base/partitioned count is 177 before commit.

- [x] **Step 6: Run focused tests**

  Run: `npx vitest run scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

  Expected: all tests pass, including disposable PGlite apply and parity assertions.

- [x] **Step 7: Commit the migration**

  Run: `git add supabase/migrations/20260911001903_retire_legacy_earlybird_recovery_tables.sql scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts && git commit -m "feat: retire legacy earlybird recovery tables"`

### Task 3: Prove isolated restoration and rollout verification

**Files:**
- Create: `supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql`
- Create: `supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql`
- Modify: `scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`
- Create: `docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-evidence.md`
- Modify: `docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json`

**Interfaces:**
- Consumes: canonical payload contract from Task 2.
- Produces: isolated restore proof and sanitized coordinator pre/post verification output.

- [x] **Step 1: Write failing restore and verifier tests**

  Require the restore operation to reject non-isolated databases through an explicit caller-set guard, recreate all eight exact schemas/constraints, restore typed values from `legacy_row`, and prove source/canonical count and checksum parity. Require the verifier to emit only table/routine names, counts, hashes, boolean dependency facts, and migration occurrence counts.

- [x] **Step 2: Implement isolated restore SQL**

  Recreate the exact eight table definitions using committed historical migrations as the schema source, populate them from the canonical JSON payload with explicit casts for every column, and compare deterministic checksums. Do not delete canonical rows.

- [x] **Step 3: Implement sanitized verification SQL**

  Provide `preflight` and `postapply` modes controlled by a session-local setting. Preflight must prove baseline 185, counts, dependencies, routine identities, canonical table shape, and no publications. Postapply must prove final 177, target/routine absence, exact 11 canonical records, checksum parity metadata, migration-history occurrence one, and no unexpected public-table delta.

- [x] **Step 4: Run the PGlite restore drill**

  Run: `npx vitest run scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

  Expected: apply, restore, type-level field parity, and destructive-scope tests all pass.

- [x] **Step 5: Write pre-apply evidence**

  Record the exact evidence, exclusions, risks, rollback procedure, and status `READY_FOR_REVIEW_NOT_APPLIED`. State explicitly that payment tables, active functions, activation flags, and the real canary are out of scope.

- [x] **Step 6: Commit verification artifacts**

  Run: `git add supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-evidence.md docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json && git commit -m "test: prove earlybird retirement recovery"`

### Task 4: Verify branch and prepare reviewed delivery

**Files:**
- Review all files listed above.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a clean reviewed branch ready for PR; no production mutation.

- [ ] **Step 1: Run focused suites**

  Run: `npx vitest run scripts/generate-supabase-22-retirement-inventory.test.ts scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

  Expected: all tests pass.

- [ ] **Step 2: Run lint and type/build gates**

  Run: `npx eslint scripts/generate-supabase-22-retirement-inventory.ts scripts/generate-supabase-22-retirement-inventory.test.ts scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts && npm run build`

  Expected: exit 0 for both commands.

- [ ] **Step 3: Validate repository safety**

  Run: `git diff --check && git status --short && rg -n "service_role|SUPABASE_ACCESS_TOKEN|postgres(ql)?://|0_min\._\.00" docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-* supabase/operations/20260911_* scripts/verify-supabase-22-legacy-earlybird-retirement.test.ts`

  Expected: no whitespace errors, only intended files, no secret material, and only a negative canary boundary reference if present.

- [ ] **Step 4: Request independent review**

  Provide the reviewer the exact base/head commits, manifest, migration, restore operation, tests, and production evidence constraints. Resolve all high/medium findings through the implementation owner and rerun Step 1-3.

- [ ] **Step 5: Prepare PR**

  Push the branch and create a PR that names the exact eight-table allowlist, `185 -> 177`, canonical row count 11, rollback proof, and explicit no-activation/no-canary boundary.

## Coordinator-only rollout gate

After PR review, merge, final-main CI, and Vercel success, the coordinator may create a short-lived unregistered isolated Supabase workdir from fetched `origin/main`, copy only `20260911001903_retire_legacy_earlybird_recovery_tables.sql` plus matching linked-project config, verify the dry-run prints exactly that one migration, apply once, and run the checked-in postapply verifier. If apply appears to hang, inspect remote migration history and catalog before terminating or retrying. A separate evidence PR must record sanitized postapply facts. Stop at `VERIFIED_PRODUCTION_EVIDENCE`; do not activate flags or run the real canary.

## Self-review

- Spec coverage: canonical preservation, exact allowlist, archive/restore, dependency proof, rollback, production evidence, and activation boundary each map to Tasks 1-4 or the coordinator gate.
- Placeholder scan: no TBD/TODO/fill-later language or inferred wildcard scope remains.
- Interface consistency: the manifest, migration, restore operation, verifier, and tests all use the same eight-table list, 11-row total, `maintenance_jobs` destination, and `185 -> 177` catalog transition.
- Scope correction: the initial 29-table investigation was deliberately narrowed because 20 tables participate in current runtime-called DB functions or sensitive payment paths. The publication table is additionally excluded because its helper is referenced by retained result-summary triggers. The eight retained targets still form a meaningful historical recovery family and require no active runtime cutover.
