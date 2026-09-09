# Landing identity and operator Leads evidence

Date: 2026-09-09 (Asia/Seoul)

Status: READY_FOR_OPERATOR_DRY_RUN

## Change set

- Implementation commit: `a58fe72dc47d820a2989930dea0fc389fd449e96`
  (`fix: close landing identity compliance gaps`).
- Landing journey migration: `supabase/migrations/20260909095950_add_landing_lead_journey_contract.sql`.
- Wave B post-deploy ACL migration (generated):
  `supabase/migrations/20260909183850_revoke_legacy_landing_lead_insert_after_rpc_ready.sql`.
- Atomic OAuth claim migration: `supabase/migrations/20260909110000_atomic_anonymous_preflight_landing_claim.sql`.
- Atomic exclusion migration: `supabase/migrations/20260909150000_atomic_preflight_exclusion_landing.sql`.
- Predecessors inspected: `20260719160000_add_landing_leads.sql`,
  `20260725021500_add_landing_lead_input_context.sql`, and the production
  preflight claim recovery migration that owns the private claim helper.

The landing page, its fixed marketing copy, `.playwright-mcp/`, and the
protected reconciliation migration were not modified.

## Database boundary

`public.landing_leads` enables and forces RLS. Wave A revokes table privileges
from `PUBLIC`, `anon`, `authenticated`, and `service_role`, then grants only
`INSERT` to `service_role` so the old direct `/api/leads` writer remains
available during the mixed-version window. The generated Wave B post-deploy
migration revokes exactly that `INSERT` after the RPC-backed code is ready;
the final table ACL is RPC-only, with mutations exposed through the existing
service-mediated `SECURITY DEFINER` functions using `SET search_path = ''`.
Target capture is now target-only; the capture RPC normalizes the account and
rejects replay when the journey, normalized account, input context, or
anonymous principal differs from the stored token row. The dedicated
exclusion RPC requires a target row bound to the supplied `source_preflight_id`,
so a false/no-target result is a persistence failure, not a successful
exclusion.

The new atomic claim RPC invokes the private anonymous preflight owner claim
and the landing journey claim in one transaction. A landing claim failure
raises and rolls back the preflight owner transition, leaving the signed claim
retryable; owner claims remain monotonic and the account-retirement trigger
keeps deleted journeys permanently fenced.

The exclusion boundary now validates either the authenticated owner or a live
anonymous claim hash while holding the preflight row lock, then records the
write-once decision and excluded landing row through one RPC/transaction. It
rejects foreign or stale anonymous claims, invalid lifecycle/expiry states,
conflicting decisions, and target-equals-excluded inputs. A missing target
journey or failed excluded-row insert raises and rolls back the decision;
identical retries replay the existing excluded row idempotently. The atomic
function is `SECURITY DEFINER` with an empty search path, five-second lock and
two-minute statement timeouts, and is executable only by `anon`/`authenticated`;
the historical browser wrappers delegate to it with their narrow grants.

The local PGlite contracts apply the predecessor migrations plus the landing
journey, Wave B ACL, and atomic exclusion migrations. They verify the old
direct `INSERT` succeeds in Wave A, is denied in Wave B, and the capture RPC
remains executable after contraction, alongside target/excluded rows sharing
one journey, idempotent capture replay, account/principal/context mismatches,
excluded capture context rejection, monotonic claims, conflicting owners,
deletion fencing, and permanent claim exclusion. The disposable native
PostgreSQL contract exercises the same Wave A/B ACL transition when its
explicit loopback marker is supplied.
The atomic exclusion cases cover authenticated ownership, foreign/stale
anonymous claims, lifecycle and expiry fences, immutable decisions, target
equality, idempotent retries, excluded-row insertion, and rollback when the
target landing row is absent.

Production migration dry-run/apply and production row-count/checksum parity
were not run. No remote migration was applied, and no production database
credentials or raw identity values were read or recorded.

## API and client boundary

Authenticated and anonymous standard preflight creation now requires the stable
browser UUID header. The server awaits exact target capture, binds it to the
returned preflight, and for authenticated direct/already-authenticated flows
claims the journey before acknowledging the request. A missed or stale capture
is repaired with a fresh deterministic opaque capture scoped to the preflight
and derived anonymous principal; the browser's handoff token is consumed by the
existing hook only after the server's accepted response, which now occurs after
positive binding.

OAuth restoration selects the atomic preflight-plus-landing claim RPC. Landing
capture and exclusion failures are no longer fire-and-forget: they return a
failure response, record a bounded PII-free preflight failure event, and keep
the request retryable. Exclusion persistence failures are classified as
retryable persistence errors; stale/foreign claims map to 401, lifecycle or
immutable decisions map to 409, and invalid exclusion payloads map to 400. An
exclusion cannot return success when its target row is missing.

`POST /api/leads` no longer derives identity from User-Agent or a
`missing-device` constant. It rejects a missing/invalid stable device ID and
passes only the server-derived anonymous principal HMAC and capture-token hash
to the journey persistence adapter; legacy unlinked writes remain available
only to existing internal legacy callers. The operator endpoint maps malformed
or tampered signed cursors to HTTP 400, uses the strict bounded projection, and
continues to omit raw input, referrer, User-Agent, hashes, UUIDs, IPs, and claim
fields from JSON.

## Verification evidence

All commands below were run in this worktree:

- Focused landing/preflight/admin suite (prior landing identity implementation): `npx vitest run lib/services/landing/landing-lead-journey.test.ts lib/services/landing/landing-lead-journey-pglite.test.ts lib/services/leads/landing-leads-migration-contract.test.ts lib/services/leads/leads-route.test.ts lib/services/leads/store.test.ts lib/services/analysis/anonymous-preflight.test.ts lib/services/analysis/anonymous-preflight-claim.test.ts app/api/admin/landing-leads/route.test.ts app/admin/analysis-audit/operator-console-leads.test.tsx app/admin/analysis-audit/operator-console-interaction.test.tsx lib/services/analysis/preflight-route.test.ts lib/services/analysis/anonymous-preflight-landing-claim-migration-contract.test.ts lib/services/landing-lead.test.ts` — **PASS, 11 files / 109 tests**.
- Atomic exclusion/preflight contract suite: `npx vitest run lib/services/analysis/preflight-exclusion-landing-atomic-pglite.test.ts lib/services/analysis/preflight-route.test.ts lib/services/analysis/preflight.test.ts lib/services/analysis/anonymous-preflight.test.ts lib/services/analysis/anonymous-preflight-landing-claim-migration-contract.test.ts lib/services/analysis/authenticated-preflight-exclusion-security-definer-migration-contract.test.ts lib/services/analysis/v2-preflight-exclusion-write-once-migration-contract.test.ts lib/services/analysis/analytics-and-anonymous-migration-contract.test.ts lib/services/landing/landing-lead-journey-pglite.test.ts lib/services/leads/landing-leads-migration-contract.test.ts` — **PASS, 10 files / 210 tests**.
- Landing Wave A/B ACL contract and disposable native guard: `npx vitest run lib/services/leads/landing-leads-migration-contract.test.ts lib/services/landing/landing-lead-journey-pglite.test.ts lib/services/analysis/preflight-exclusion-landing-atomic-postgres-concurrency.integration.test.ts` — **PASS, 13 tests / 2 native tests skipped without the explicit loopback marker**.
- OAuth callback regressions: `npx vitest run lib/services/auth/callback-route.test.ts lib/services/auth/oauth-redirect-intent.test.ts` — **PASS, 2 files / 28 tests**.
- Typecheck: `npx tsc --noEmit --pretty false` — **PASS**.
- Lint: `npm run lint` — **PASS, 0 errors, 27 warnings** (existing warning set; no warning in the changed production files).
- Build with process-local non-production placeholder Supabase/signing environment — **PASS** (`BUILD_EXIT:0`).
- `git diff --check` — **PASS**.

No admission activation, payment mutation, provider call, migration apply,
remote write, or canary was run. Remaining rollout blocker: an operator must
perform the approved production migration dry-run and separately verify remote
history/parity before applying anything.
