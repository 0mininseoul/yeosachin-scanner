# Supabase 22 Wave 1 production read-only evidence

## Status and boundary

Production read-only collection is **VERIFIED**. Wave 1 parity and cutover are
**BLOCKED**: no family reached complete canonical parity, and no family is
eligible for flag activation or destructive retirement.

- Source revision: fresh `origin/main` at `ac3ad2ed8361621ab2c0cbf2b380ce20a6ffbcc8`.
- Supabase CLI check: `npx --yes supabase@2.102.0 --version` returned exactly
  `2.102.0`.
- The checked-in `scripts/backfill-analysis-canonical.ts` report-only function
  ran against production with `LIMIT=100`. The canonical main worktree
  `.env.local` was supplied only through Node's `--env-file` mechanism; it was
  not sourced, copied, printed, or persisted.
- Cursors, selected request scope, and rows stayed in process memory. The
  wrapper enforced a strict 32-page maximum and emitted only page/family
  aggregates, counts, SHA-256 checksums, mismatch paths, and completion totals.

No migration, flag change, delete/truncate, analysis activation, provider call,
real canary, or payment-state mutation was performed. No tests, typecheck,
lint, build, CI, or deploy command was run.

## Sanitized traversal totals

| Aggregate | Result |
|---|---:|
| pages traversed | 15 |
| page cap reached | no (`32` maximum) |
| terminal cursor | yes |
| page status | `blocked` on all 15 pages |
| page-scanned total | 1,318 |
| page-complete total | 1,318 |
| page-blocked total | 360 |

The scanned/complete totals are page aggregates: family-continuation pages
reuse the same bounded request batch, so they must not be interpreted as a
distinct-row total. Three source-page checksums were non-null during
traversal: `84e69185f7384f7f2e676e58d66721e24691f8ec7fe61aed006e91e2f637e0c7`,
`b56d5473bb6a6123a5a7e3269117c36765f461be81835aa4636426a5715e06e4`, and
`06d7eef1f45ccd3fd22fedc110351bd5eb6931525301fb52f22a78f04b9fdeea`.

## Family result

| Family | Status | Sanitized counts/checksums | Mismatch paths |
|---|---|---|---|
| jobs | blocked | source page-sum `1,294`; canonical page-sum `0`, canonical complete pages `0`; canonical checksum `null` | `source.missing` |
| events | blocked | source page-sum `90`; source checksum `fc812ef7a0930bb00d12fe5f31a52465c7120c7d8c7defc481586d64641483ac`; canonical page-sum `0`, complete pages `0`, checksum `null` | `source.missing` |
| artifacts | blocked | source page-sum `0`, checksum `null`; canonical page-sum `0`, complete pages `0`, checksum `null` | `source.missing` |
| costs | blocked | source page-sum `24`; source checksum `5ea14f9dad2be25844f764a676a112f6b2f29b3cab4322e4a8bffc21fabdb16d`; canonical page-sum `0`, complete pages `0`, checksum `null` | `source.missing` |
| cache | blocked/deferred | no executable request-safe source was read; counts/checksums `0`/`null` | `source.missing` |
| audit | blocked/deferred | held for the independent audit-evidence wave; counts/checksums `0`/`null` | `source.missing` |

`canonical_count=0` with `canonical_complete=false` is an incomplete-read
signal, not proof that a canonical table is empty. The runner observed no
`mismatch` path and no `match` status: **verified parity families: none**;
**mismatch families: none observed**; **blocked/deferred families: jobs,
events, artifacts, costs, cache, audit**.

The production table count remains recorded as **177** from the prior baseline;
it was not separately re-queried in this run.

## Cutover boundary

Legacy sources remain authoritative. Canonical read/write flags remain
unchanged and disabled, and this evidence does not authorize migration apply,
backfill mutation, source archive/drop, activation, a real canary, or any
payment operation.
