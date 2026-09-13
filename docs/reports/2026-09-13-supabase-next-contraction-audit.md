# Supabase next contraction audit (post-W1A)

Status: `BLOCKED_NO_CHANGE`

Observation time: `2026-09-13T03:45:40Z` (UTC)

Source revision: `cccf369013263abfd91538e6451be3dd6b9dcd9c` (`origin/main`)

Supabase read path: pinned CLI `2.102.0`, `npx --yes supabase@2.102.0 db query --linked`, using the coordinator-provided isolated linked workdir. All SQL was aggregate-only or catalog-only; no production migration, write, flag change, payment-state mutation, or canary ran.

## Baseline

The live catalog reports **152** base/partitioned tables, matching the expected post-W1A count. All 152 have RLS enabled; 117 force RLS. The database-wide aggregate reports 200 foreign-key constraints and 89 non-internal triggers (excluding system triggers); the public-schema-only slice reports 177 foreign-key constraints and 83 non-internal triggers. The catalog also reports three explicit public publication memberships.

The W1A policy and contraction migration versions are present in the remote migration history. The 12 retained tables are all present, and the four out-of-scope payment relation names are absent. No payment state was read or changed.

Remote migration history contains 391 rows and 391 distinct versions. Local migration filenames also contain 391 distinct versions, but the sets diverge: six local-only versions (`20260805001619`, `20260805014000`, `20260805023000`, `20260805025000`, `20260805050000`, `20260813233000`) and six remote-only versions (`20260814110000`, `20260814111000`, `20260823165841`, `20260824151600`, `20260824152500`, `20260824160500`). This is a fail-closed provenance blocker for any new migration authoring or application.

## Bounded candidate wave

The useful bounded next wave is the three-table `analysis_v2_replay_capture` cluster:

| Table | Exact rows | Non-internal dependency edges | FK out/in | Routine body refs | Static runtime table refs | Disposition |
|---|---:|---:|---:|---:|---:|---|
| `analysis_v2_replay_capture_audit_events` | 0 | 9 | 1/0 | 3 | 0 | blocked |
| `analysis_v2_replay_capture_authorizations` | 0 | 125 | 2/2 | 4 | 0 | blocked |
| `analysis_v2_replay_capture_fragments` | 0 | 58 | 1/0 | 1 | 0 | blocked |

All three tables have RLS and FORCE RLS enabled, no user triggers, no publication membership, and no privileges for `PUBLIC`, `anon`, `authenticated`, or `service_role`. Empty data is therefore proven, but emptiness does not establish a safe drop closure.

The deployed database still contains the following contract edges:

- `purge_expired_analysis_v2_preflights` references `analysis_v2_replay_capture_authorizations`.
- `arm_analysis_v2_replay_capture` and `bind_analysis_v2_replay_capture` write the authorization and audit-event contracts.
- `register_analysis_v2_replay_capture_fragment` writes the authorization, fragment, and audit-event contracts.
- `analysis_v2_replay_capture_authorizations` has two incoming and two outgoing foreign-key edges.
- The five inspected routines are `SECURITY DEFINER`; their deployed `search_path` configuration is not empty and each is executable only by `service_role`.

The repository has no non-test runtime references to the three table names or the three writer routine names. However, `read_analysis_v2_replay_capture_source` is called by `lib/services/analysis/replay/replay-supabase-repository.ts`, and the deployed database dependency closure still includes the cleanup and writer contracts above. A point-in-time `pg_stat_activity` check found zero other client queries containing the candidate keyword, but this is not queue-drain or runtime-inactivity proof.

## Operational dashboard dependencies

The seven admin route files were checked for candidate table/routine names; candidate hits were zero. Existing dashboard contracts remain in scope and must be preserved: order-audit routes use `list_analysis_order_audit_bundles` and `load_analysis_order_audit_bundle`; analysis observability reads `analysis_operational_cost_summary` and `analysis_step_events`; landing-lead and token-usage routes retain their existing sources. The wave cannot be approved merely because it is not directly displayed by the dashboard.

## Decision and handoff

No candidate passed the combined gates of exact-zero data, deployed dependency closure, runtime-reference absence, and clean migration provenance. Consequently the destructive allowlist is explicitly empty, no migration or restore artifact was prepared, and rollback is not applicable because production was not mutated.

Reopen this wave only after reconciling the six-version history divergence, retiring or redirecting every deployed routine/FK dependency, and collecting a fresh exact object/ACL/dependency/dashboard observation. At that point, author a fixed no-CASCADE migration and typed restore artifact from the reviewed allowlist; do not infer targets from a broad catalog scan.

The machine-readable evidence is in [`2026-09-13-supabase-next-contraction-audit-manifest.json`](./2026-09-13-supabase-next-contraction-audit-manifest.json).
