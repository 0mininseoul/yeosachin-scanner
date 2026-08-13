# Precheckout B-lite single-collection rollout

This path remains off by default: `PRECHECKOUT_BLITE_ENABLED=false` and
`PRECHECKOUT_BLITE_ROLLOUT_PERCENT=0`. It is migration-first and additive; the legacy
ready-preflight card and plans remain the rollback surface until a reviewed cohort wins.

## Release order

1. Land the reviewed application and migration together through the normal GitHub pull-request
   flow. Do not use a direct Vercel deploy: only a merge to `main` may trigger the Vercel
   production integration.
2. In an isolated Supabase worktree, confirm the exact allowlist contains only
   `20260813041712_precheckout_blite_single_collection.sql`. Run the approved dry-run there;
   never use `supabase db push --include-all` from a mixed or dirty worktree.
3. Apply that approved migration before enabling any application cohort. If an apply command
   appears to hang, inspect remote migration history before stopping it and never retry blindly.
4. Keep both B-lite environment values at their default off/zero while the backward-compatible
   `main` revision reaches production. The trusted preflight worker is capped at 75 seconds and
   the browser status route at 15 seconds; neither limit authorizes an additional collection.

## Post-migration smoke

Run the migration contract and PGlite schema smoke before a rollout change:

```bash
npm test -- lib/services/precheckout/blite-single-collection-migration-contract.test.ts \
  lib/services/precheckout/blite-single-collection-pglite.test.ts
```

Then, using an approved isolated operator session and no browser credentials, verify migration
history and the service-only RPC/schema contract: the new source table has RLS forced, browser
roles have no table/RPC grants, and these RPCs resolve with their expected signatures:
`activate_precheckout_blite_cohort_v1`, `finalize_preflight_blite_source_v1`,
`claim_precheckout_blite_v2`, `complete_precheckout_blite_v2`,
`fail_precheckout_blite_v2`, and `read_precheckout_blite_status_v1`. Exercise the approved
schema fixture only in the isolated smoke environment; it must prove one source projection,
terminal source deletion, and no second Instagram collection.

## Canary and rollback

Enable signed internal test-entitlement traffic first, then change the server-only rollout through
reviewed GitHub `main` changes at 1%, 5%, 25%, and 100%. At each step confirm the original
submission clock, one provider lineage, B-lite terminal state, T+48/T+60 demo behavior, and that
late cached results do not replace a fallback page.

To stop rollout, return the GitHub `main` configuration to `PRECHECKOUT_BLITE_ENABLED=false` and
`PRECHECKOUT_BLITE_ROLLOUT_PERCENT=0`; do not alter payments, provider ledgers, retention, or
use a direct Vercel deployment. The additive schema and retention cleanup stay in place.
