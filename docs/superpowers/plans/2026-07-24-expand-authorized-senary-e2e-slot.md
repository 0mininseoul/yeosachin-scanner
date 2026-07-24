# Authorized Senary E2E Slot Implementation Plan

> **For Codex:** Execute this plan with the `subagent-driven-development` workflow. Keep production calls, migrations, secret creation, deployment, and the paid E2E outside the implementation commit until review and CI are green.

**Goal:** Add a true, same-named `senary` Apify credential slot for the single authorized Standard E2E while keeping `septenary` rejected and leaving the separate profile-repair microcanary at its existing five-slot boundary. Plus remains out of scope because it is not launch-ready.

**Architecture:** Extend the shared V2 credential-slot vocabulary, exact environment-to-secret identity maps, and helper-backed database policy with one append-only migration. Recreate the cleanup settlement RPC so a failed senary-backed run can be settled safely. Use a durable singleton database guard to serialize destructive ref pruning with both manual canary reservation paths, and clear it only through an explicit post-reattachment deployment path. Do not alias a token, edit an applied migration, or widen the profile-repair microcanary.

**Stack:** TypeScript, Next.js, Vitest, PGlite, Bash, Supabase Postgres, Cloud Run, Secret Manager, Vercel.

---

## Task 1: Add failing runtime and parser tests

**Files:**

- Modify: `lib/services/instagram/providers/apify.test.ts`
- Modify: `lib/services/analysis/authorized-test-provider-policy.test.ts`
- Modify: `lib/services/analysis/preflight-provider-run.test.ts`
- Modify: `scripts/preflight-ambiguous-start-resolution-options.test.ts`
- Review and extend only where needed:
  - `lib/services/analysis/test-entitlement-route.test.ts`
  - `lib/services/analysis/test-entitlement-consumption.test.ts`
  - `lib/services/analysis/v2-collection-executors.test.ts`

**Required assertions:**

- `senary` is accepted as an authorized V2 slot.
- `APIFY_SENARY_API_TOKEN` is selected only for `senary`.
- Stored preflight runs and manual ambiguous-start resolution accept `senary`.
- `septenary` remains rejected everywhere.
- Existing legacy `APIFY_API_TOKEN_SLOT` behavior remains primary/secondary only.

Run the focused tests and confirm they fail for the intended missing support before changing implementation.

## Task 2: Implement the runtime slot

**Files:**

- Modify: `lib/services/instagram/providers/types.ts`
- Modify: `lib/services/instagram/providers/apify-relationship.ts`
- Modify: `lib/services/analysis/preflight-provider-run.ts`
- Modify: `scripts/preflight-ambiguous-start-resolution-options.ts`
- Modify: `.env.example`

**Implementation:**

- Append `senary` to the shared slot tuple; do not add `septenary`.
- Map `senary` exactly to `APIFY_SENARY_API_TOKEN`.
- Reuse the shared slot guard in the preflight parser where practical.
- Keep all missing-token behavior fail-closed.

Run the focused tests until green.

## Task 3: Add the append-only database migration

**Files:**

- Create: a migration later than `20260724203500_set_dashboard_postgres_timezone_kst.sql`
- Create: a new migration contract test
- Modify only as needed:
  - `lib/services/analysis/preflight-provider-run-pglite.test.ts`
  - `lib/services/analysis/v2-authorized-test-provider-policy-pglite.test.ts`

**Migration requirements:**

- Replace `public.analysis_v2_valid_apify_credential_slot(TEXT)` with exactly:
  `primary`, `secondary`, `tertiary`, `quaternary`, `quinary`, `senary`.
- Preserve `IMMUTABLE`, empty `search_path`, null rejection, and revoked execution.
- Recreate `public.settle_analysis_v2_provider_run_for_cleanup(...)` using the shared validator instead of its historical five-value literal.
- Do not edit any applied migration or widen profile-repair microcanary constraints/RPCs.

**Contract requirements:**

- Prove `senary` passes helper-backed policy/constraint paths needed by the authorized V2 E2E.
- Prove `septenary` fails.
- Prove cleanup settlement can handle a senary-backed failed run.
- Preserve the historical five-slot migration contract test unchanged.

## Task 4: Extend exact infrastructure identity maps

**Files:**

- Modify: `scripts/configure-analysis-v2-secrets.sh`
- Modify: `scripts/generate-analysis-v2-env-files.sh`
- Modify: `scripts/deploy-analysis-v2-worker.sh`
- Modify: `scripts/test-analysis-v2-secret-scripts.sh`
- Modify: `scripts/test-analysis-v2-infra-scripts.sh`

**Requirements:**

- Accept `senary` in the general V2 worker path.
- Derive and validate only the exact identity:
  `senary` → `APIFY_SENARY_API_TOKEN` → `ai-baram-v2-apify-senary:<numeric-version>`.
- Extend every worker deployment inventory and plaintext-secret allowlist consistently.
- Raise exact maximum reference counts from five to six where the inventory now contains six identities.
- Convert previous `senary` negative fixtures to positive same-name coverage.
- Use `septenary` as the unsupported negative fixture.
- Preserve exact numeric secret versions and recovery references.
- Keep the separate profile-repair microcanary five-slot-only and document this boundary.

Run the Bash contract suites and focused TypeScript tests.

## Task 5: Update the authorized E2E runbook

**Files:**

- Modify: `docs/authorized-apify-sharded-e2e-runbook.md`
- Modify: `lib/observability/operations-docs-contract.test.ts`

**Required policy:**

- Runtime supports primary through senary; septenary remains inventory-only and unsupported.
- The one paid run selects exactly Standard. Its relationship caps are 800/800
  and its detailed-mutual cap is 600; do not substitute the unready Plus plan.
- Require the same-named numeric Secret Manager reference for senary.
- State that the final map is permitted only after an immediate live credit and Actor allowance check.
- Use the planned map, subject to that live gate:
  - normal selected slot, target profile and profile fallback/repair: senary
  - relationship followers: senary
  - relationship following: quinary
  - target likers: senary
  - target comments: tertiary
  - candidate likers: quinary
- Fix the Standard worst-case exposure from the catalog and current Actor
  rates: senary `$4.7952` (including initial + fresh target profiles
  `2 × $0.0026 = $0.0052`) with 110% balance `$5.27472`; quinary `$2.23`
  with 110% balance `$2.453`; tertiary `$0.234` with 110% balance
  `$0.2574`.
- Preserve the deployment sequence: verify the initial `primary:3` baseline, stage the exact
  same-named senary selected secret plus quinary/tertiary additional secrets with sharding disabled,
  activate only the sharding flag, then disable sharding and restore `primary:3` during teardown.
- Retain the one-owner, one-target, signed `test_entitlement` boundary.
- Retain fail-closed teardown: sharding off, ordinary-deploy exact primary:3
  while retaining temporary refs, then use only
  `--prune-apify-secret-refs=tertiary,quinary,senary` with exact selected
  `primary:3`. The prune command must hold the deploy lock across its own
  300-second drain and require unchanged, exactly observed service generation,
  active revision, 100% traffic, refs, sharding, and destination afterward.
  The canonical build Supabase origin must equal the single latest
  and active Cloud Run runtime origin. The service-role readiness RPC must prove
  global zero pending/processing requests and preflights, zero active drop-slot
  policies, zero active or unreconciled request/preflight runs, zero active,
  ambiguous, or unreconciled 5-slot profile-repair canary runs, and zero
  incomplete official profile-provider source cleanup that depends on those
  exact stored source-run slots before staging and again immediately before
  promotion. Ordinary deploy/check keeps
  preserving valid recovery refs; prune `--check` requires a primary-only
  inventory.
- Explicitly say profile-repair microcanary does not support senary.

## Task 6: Add a durable database fence around secret-ref pruning

**Files:**

- Modify: `supabase/migrations/20260724220000_expand_analysis_v2_apify_senary_slot.sql`
- Modify: `lib/services/analysis/v2-senary-apify-credential-migration-contract.test.ts`
- Modify: `lib/services/analysis/profile-provider-canary-run-pglite.test.ts`
- Modify: `lib/services/analysis/profile-repair-canary-run-pglite.test.ts`
- Modify: `scripts/deploy-analysis-v2-worker.sh`
- Modify: `scripts/test-analysis-v2-infra-scripts.sh`
- Modify: `docs/authorized-apify-sharded-e2e-runbook.md`

**Required lifecycle:**

- Add one always-present singleton guard row whose constraint permits exactly
  inactive (all fence columns null) or active (normalized non-empty drop slots,
  40-hex source commit owner, and timestamps) state. Force RLS and revoke all
  direct access.
- Add service-role-only acquire, load, readiness, and compare-and-clear RPCs.
  Acquire and both canary reserve RPCs must lock the same singleton row
  `FOR UPDATE`. Identical owner and slots are idempotent; every other active
  acquire conflicts.
- Acquire the fence after the 300-second unchanged-service drain and before the
  first ledger audit. Re-run readiness with the exact same owner immediately
  before traffic promotion. Never clear the fence automatically after prune
  success, rollback, or process failure.
- Rewrite the latest profile-repair canary reserve function to reject an
  overlapping requested credential slot. Rewrite the latest official
  profile-provider reserve function to reject when any of the eight validated
  source-run credential slots overlaps. Existing reservation retries are also
  blocked while overlapping; non-overlapping calls retain their prior behavior.
- Add explicit `--clear-apify-secret-ref-prune-fence=SLOTS`, mutually exclusive
  with pruning. It may mutate only in apply mode, after ordinary no-traffic
  staging and promotion, and only when latest and active Cloud Run inventories
  both contain every fenced same-named numeric secret reference. Use the
  previously loaded owner and exact slots for compare-and-clear. An already
  inactive retry succeeds; owner or slot drift fails.
- Dry-run and check must never acquire or clear the database fence. Never log
  the service-role credential or fence owner.

**Test sequence:**

1. Add failing PGlite tests for inactive/active row constraints, exact acquire
   identity, idempotent retry, conflicting acquire, exact readiness identity,
   compare-and-clear, and both overlapping/non-overlapping canary reserves.
2. Add failing Bash tests for apply acquire order and two readiness calls,
   dry-run/check non-mutation, persistent fence on failed promotion, idempotent
   apply retry, explicit reattach clear, and owner/inventory drift rejection.
3. Implement the SQL and Bash paths minimally until those focused tests pass.

## Task 7: Verification and commit

Run:

1. All changed/focused Vitest and Bash contract tests.
2. Migration/PGlite tests.
3. `npm run lint`
4. `npx tsc --noEmit`
5. Full `npm test -- --run`
6. `git diff --check`

Remove the incidental `package-lock.json` metadata-only drift produced by dependency installation; the feature has no dependency change.

Commit only reviewed implementation, tests, migration, example environment key, runbook, and this plan. Do not apply the migration, create secrets, deploy, or make any paid call from the implementation task.
