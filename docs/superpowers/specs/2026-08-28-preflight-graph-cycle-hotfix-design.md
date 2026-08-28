# Preflight graph-cycle hotfix design

## Goal

Keep the four-stage preflight demonstration visually correct during long-running
production preflights and give each graph enough time to be readable.

## Confirmed root cause

The waiting-loop boundary first clears all four progress rails, then calls the
normal stage transition helper while stage 4 is still recorded as active. That
helper completes the previous stage before activating stage 1, immediately
refilling the fourth rail to 100%. The renderer therefore starts every waiting
cycle after the first with stage 1 running while the fourth rail is red.

## Chosen behavior

- Make the guaranteed initial S1-S4 pass exactly 20,000 ms: four 4,500 ms graph
  stages followed by the existing completed-frame reveal, extended to 2,000 ms.
- Keep subsequent waiting cycles at the existing 24,000 ms total, or 6,000 ms
  per stage. They are already slower than the requested initial pass.
- At every transition into a new waiting cycle, explicitly clear the active
  stage, hide its graph, and reset all four rails before activating stage 1.
  Normal transitions inside a cycle still complete the preceding rail.
- Preserve the current result and fallback handoff rule: the UI exits only on a
  graph-stage boundary. Extending the initial pass changes that first boundary
  from 12 seconds to 20 seconds but does not change the 90-second preflight
  deadline, polling, provider work, or fallback authority.

## Scope

The implementation is limited to the precheckout graph player and its focused
component/immersive tests. It does not change preflight collection, Apify token
selection, checkout/payment logic, Supabase data, analytics schemas, landing
copy, or the graph artwork itself.

## Verification

- Assert the exported initial duration is 20,000 ms and the four stage
  durations remain ordered and deterministic.
- Regress the reported failure by crossing the first and a later waiting-cycle
  boundary, proving stage 1 is active and stage 4 remains empty at each reset.
- Update only existing timing assertions that encode the old 12-second
  contract, then run the focused precheckout component and immersive suites,
  TypeScript, lint, build, and `git diff --check`.
- After deployment, visually observe at least two cycles in production and
  confirm no fourth-rail carryover.

## Rollback

Revert the single application commit. No database or external-service rollback
is required.
