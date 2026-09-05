# Supabase table-consolidation readiness

**Status:** blocked. This worktree has no genuine completed permanent audit bundles and no trustworthy parity evidence. The tooling below is read-only and does not authorize or execute a table drop, rename, truncate, archive deletion, migration push, or production data mutation.

## What was added

- `20260905110000_add_order_audit_consolidation_readiness.sql` adds a bounded `parity_attestation` JSONB column and completion trigger to the existing assembly queue plus the service-role-only, `STABLE` RPC `read_analysis_order_audit_parity_snapshot(uuid)`. The trigger captures only the aggregate snapshot after permanent bundle children exist and before the existing purge call; the RPC prefers captured source sections when live rows are gone and always reads the latest immutable bundle/cost evidence. It depends directly on the existing permanent order-audit bundle migration (`20260904130000`) because it reads those bundle tables and shared redaction/digest functions, and it returns only aggregate row counts, null/completeness markers, deterministic SHA-256 checksums, and no raw identifiers or payloads.
- `lib/services/analysis/order-audit-consolidation.ts` validates the bounded snapshot, computes stable checksums, emits deterministic mismatch paths, evaluates the contraction gates, and refuses every mutation mode.
- `scripts/verify-analysis-order-audit-parity.ts` is the operator-only report command. It accepts at most 20 explicitly selected request IDs, never prints those IDs, and has an opt-in `--shadow-read` marker. `--archive-manifest` emits reversible dry-run archive scaffolding; it writes no file and runs no archive or restore operation.
- `2026-09-05-supabase-consolidation-manifest.json` records candidate classifications, code references, FK/view/function/policy/trigger dependency evidence, and an empty contraction allowlist. Its denylist keeps permanent audit, payment, pending, and cost-ledger surfaces out of any future contraction.

## Operator command

After a genuine completed production order exists and the service-role RPC migration has been reviewed and applied through the normal migration process, run a bounded report with an explicit selection:

```bash
npm run verify:order-audit-parity -- --request-id=<uuid> --archive-manifest
```

For an explicit shadow-read comparison, add `--shadow-read`. The command returns non-zero whenever a request is not a real completed production order, a source or bundle is absent, a section is incomplete, a count/checksum differs, or any readiness gate remains open. It performs no provider/paid call and has no `--execute`, `--apply`, `--drop`, `--truncate`, `--rename`, `--delete`, or `--mutate` mode.

The existing terminal assembler may purge its working source rows after a successful permanent copy. A later report therefore must be run while the selected source rows are still available, or against a separately approved retained source snapshot; an absent source is an explicit blocked result, never an empty parity match.

Archive parity is intentionally independent from contraction readiness: the archive manifest reports `parityStatus: ready` only when at least one genuine completed production order has a permanent bundle and completed recovery row, every selected report is ready, and blocked/mismatch counts are both zero. An empty selection can never produce archive parity, and the overall readiness remains blocked until the separate archive-manifest, restore, rollback, dependency, owner-approval, and observation gates are independently recorded.

## Exact gates for later contraction

All of these must be independently recorded before a separately approved, exact allowlist can be considered:

1. A genuine completed production order has a complete permanent audit bundle and an associated recovery/assembly outcome.
2. Every selected completed order passes 100% parity for relationships, target evidence/interactions, candidate keys/features, risk rows, and the cost ledger. Missing source data is blocked, not treated as an empty match.
3. Per-order and aggregate SHA-256 checksums match. Retain the checksum manifest as audit evidence; a count match alone is insufficient.
4. A bounded, encrypted, access-controlled archive manifest exists, with permanent audit, payment, recovery, identity, and required user-linked retention explicitly represented.
5. A restore drill reproduces all required aggregate counts and checksums and records zero mismatch paths. Restore verification is not complete merely because an archive object exists.
6. Rollback evidence proves the old read path remains available and equivalent for the full rollback window; the old path stays read-only during that window.
7. An owner-authorized catalog snapshot proves no unresolved foreign-key, view, function, policy, trigger, RLS, grant, publication, sequence, partition, or `pg_depend` dependency remains for each proposed object.
8. A complete traffic observation window proves the legacy write path is quiet across routes, workers, jobs, scripts, dashboards, RPCs, and external operators. Historical reads must still resolve through a compatibility adapter.
9. The owner separately approves a small exact contraction allowlist. No denylisted object, `payment_pending` row, credential, cookie, user UUID, provider evidence, or protected migration enters that scope.
10. Post-operation aggregate catalog, route, owner-history, payment/recovery, media, and secret-scan verification is recorded, and rollback evidence remains retained for the agreed window.

The current result remains blocked at the first two gates because there are zero genuine completed permanent bundles and zero parity reports. No production state was changed to manufacture evidence.
