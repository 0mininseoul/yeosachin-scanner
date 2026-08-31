# Automatic-analysis capacity stabilization implementation plan

## Scope

Implement the approved capacity extension on the exact stabilization base. Keep
the existing V2 DAG/provider-run/cost ledgers and Gemini lease protocol. Do not
change `app/page.tsx` marketing copy or touch protected files. Do not apply
remote migrations, deploy infrastructure, call paid providers, or mutate
production data from this worktree.

## Bounded work packages

### Launch-critical

1. Add red tests for role-aware task contracts, fail-closed preflight/paid
   worker gates, deterministic task identities, provider admission RPC
   contract/ACL/indexes, fenced expiry recovery, and duplicate terminalization.
2. Add `analysis_provider_admission_leases` migration with immutable role and
   budget seed rows, acquire/renew/release/recover RPCs, fixed `search_path`,
   service-only ACLs, and hot claim/expiry indexes. Allowlist only this
   migration for rollout; preserve unrelated pending migrations.
3. Add a typed runtime admission store and integrate acquisition before every
   actual paid Apify start while retaining existing provider-run reserve,
   checkpoint, cost settlement, and Gemini lease boundaries. Ensure retries
   resume confirmed runs and never double-start ambiguous runs.
4. Extend task payloads and worker routes with `workloadRole`; reject missing
   or mismatched role before durable claim/provider work. Add separate config
   parsers for preflight and paid queues/services with staged bounds (32/64 and
   8/16+), exact target URL/OIDC audience, and fail-closed apply/check parity.
5. Add deployment/configuration scripts and shell contract tests for both
   role-specific queues/services, exact IAM, attached runtime identities,
   autoscaling/concurrency limits, and rollback declarations.
6. Add explicit test-only fake Apify/Gemini injection and a no-network load
   harness that submits 400 preflight and 200 paid admissions, duplicates
   deliveries, expires/recoveries, and reports JSON aggregates.
7. Add PGlite concurrency/ACL tests plus EXPLAIN assertions for claim and
   expiry indexes where feasible. Run targeted tests, infrastructure scripts,
   migration contracts, load harness, scheduler benchmark, full test/lint/type
   check/build/diff check.
8. Update English/Korean operations docs with migration allowlist, rollout
   thresholds, staged promotions, observability, and rollback commands.

### Later, explicitly deferred

- Supabase table reduction or legacy RPC/table deletion.
- B-lite redesign or contract changes.
- Provider credential rotation, Cloud Tasks/Cloud Run mutation, remote
  migration application, or production data repair.

## Verification and release gates

- Fake mode must fail closed unless the explicit load/test capability is set;
  production envs cannot select fake providers.
- `capacity_extension_load_harness.ts` must emit accepted=600,
  terminalized=600, lost=0, duplicateTerminalEffects=0, and eventualDrain=true.
  Initial and expanded runs must each measure exact provider maxima of
  preflight=32, paid=8, and Gemini=8; worker-stage observations are separate
  (32/8 initially and 64/16 when expanded). Capacity-pending, recovery, and
  fence-rotation counters must each be positive, and database contention must
  come from the durable fake transaction path rather than a tautological local
  permit bound.
- Shell contract tests must prove dry-run emits only mutations, check emits no
  mutations, and apply path has exact queue/service/role/IAM contracts without
  requiring gcloud in local test mode.
- SQL/PGlite tests must prove same-operation replay, stale fence rejection,
  one-winner expiry recovery, budget isolation, restrictive ACLs, and index
  usage or a bounded fallback explanation.
- No completion claim until `npm test`, `npm run lint`, `npx tsc --noEmit`,
  `npm run build`, and `git diff --check` have fresh output. If Docker or
  disposable PostgreSQL is unavailable, report the exact bounded exception and
  use PGlite substitutes.
