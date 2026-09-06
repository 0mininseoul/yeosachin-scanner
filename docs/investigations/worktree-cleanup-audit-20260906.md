# Git worktree cleanup audit — 2026-09-06

## Result

- Audit target: all 20 Git worktree registrations for `yeosachin_scanner`.
- `origin/main` was fetched before the audit and resolved to `694109753880a86dbb50878277ceb5912b451160`.
- This worker worktree is based exactly on `origin/main` at that SHA.
- Removed registrations: **none**. No registered worktree satisfied all three removal predicates (clean, inactive, and `HEAD` fully merged into `origin/main`), so no `git worktree remove` command was run.
- Local branches were not deleted. No reset, checkout, clean, prune, source edit, or production mutation was performed.

The preservation categories below overlap intentionally. A path remains preserved if any one of its safety predicates applies.

## Audit method and safety scope

For each registered path, the audit captured:

1. `git status --porcelain=v1 --untracked-files=all` counts (names and file contents were not copied into this report).
2. `git merge-base --is-ancestor HEAD origin/main`.
3. The presence of `.playwright-mcp` without opening it.
4. Working-tree, index, and committed-tree differences for the protected migration `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` without reading its contents.
5. A live-process snapshot using processes whose current working directory is the worktree (`lsof -d cwd`), plus live Orca terminal counts.
6. Orca worker/resource records across registered-repository runs, using only sanitized worktree/resource state (active, retained, reclaimable, or released).

No secret values, environment-file contents, cookies, credentials, authorization headers, raw process arguments, user/device IDs, or production data were read or recorded.

## Registered-worktree audit

`dirty entries` includes tracked changes and untracked entries; `untracked` is the subset beginning with `??`. `merged` means `HEAD` is an ancestor of the fetched `origin/main`. `live CWD` is a point-in-time process indicator and `Orca` reports live terminal count plus any non-released resource evidence found for that registered path.

| Worktree | HEAD | Merged | Dirty entries | Untracked | `.playwright-mcp` | Protected migration diff | Live CWD | Orca/resource evidence | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner` | `c07e3c0a19034d0674ad7307d0b056478c9ec7d3` | yes | 23 | 21 | yes | no | no | 0 terminals; Desktop main anchor | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-opus5-20260903` | `f62146df20caee60baf0bb4493e66dfc932a8155` | no | 3 | 0 | no | no | yes | 2 terminals; retained user-owned resource | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-visibility-opus5-20260905` | `a3ce5d9023893d1bb9b571f6813c771e40409666` | no | 13 | 12 | yes | no | yes | 1 terminal; no worker resource record | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/bounded-preflight-fallback-ux-20260906` | `69c25c1411ed102ca9d7c41727710eeb6c99df43` | no | 2 | 1 | no | no | yes | 2 terminals; retained external resource | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/external-runtime-trace-20260905` | `694109753880a86dbb50878277ceb5912b451160` | yes | 5 | 4 | no | no | yes | 2 terminals; retained external resource | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/external-state-funnel-trace-20260905` | `694109753880a86dbb50878277ceb5912b451160` | yes | 3 | 2 | no | no | yes | 2 terminals; retained external resource | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-contract-guard-20260906` | `94fe6a257400156b65ddc0a54c39a4bbbf2e38ce` | no | 7 | 0 | no | no | yes | 2 terminals; retained external resource | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-production-recovery-20260906` | `13f966f778fe4af5889e5d90537ebc38355498a1` | no | 0 | 0 | no | no | yes | 2 terminals; retained external resource; report source | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-producer-config-reconcile-20260906` | `694109753880a86dbb50878277ceb5912b451160` | yes | 0 | 0 | no | no | yes | 1 terminal; reclaimable owned resource in current run; explicitly retained | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-stale-iam-cleanup-20260906` | `4e052caf862e9c1ff40fee0b916d867bf1cf2a06` | no | 0 | 0 | no | no | no | 0 terminals; report source retained until integration | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/safe-worktree-cleanup-20260906` | `694109753880a86dbb50878277ceb5912b451160` | yes | 0 | 0 | no | no | yes | 1 terminal; active owned resource; this worker | preserve |
| `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/vertex-production-rollout-20260904` | `8595fe34089ef22c68e99a91aa17d903ef955417` | no | 1 | 1 | no | no | yes | 1 terminal; no worker resource record | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/automatic-analysis-initial-activation-20260902` | `8841c75101224b2f8b956061a4c8b7372c36fe3e` | no | 3 | 2 | no | no | no | 0 terminals; no worker resource record | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-redesign-opus` | `22ee5bc23c56e40eca39afd1e4414a422bf80197` | yes | 1 | 1 | no | no | no | 0 terminals; retained user-owned resource | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-result-a-hybrid` | `919256fd34f4c923c4b42cf29eff78532a5ce375` | no | 19 | 18 | yes | no | no | 0 terminals; retained user-owned/owned resources | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/coelacanth` | `a87eaf20b2e804a5367b225f500b6bfb702736a6` | yes | 2 | 1 | no | no | no | 0 terminals; no worker resource record | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/cormorant` | `03bf505fbb9356c6a33fefbc820b1106ef902c1a` | no | 10 | 5 | no | no | yes | 3 terminals; coordinator/root anchor | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/sanddab` | `c07e3c0a19034d0674ad7307d0b056478c9ec7d3` | yes | 9 | 8 | no | no | no | 0 terminals; no worker resource record | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/tellin` | `0c52c1003ffba2750c213688a23f06a0f5551185` | no | 11 | 10 | no | no | no | 0 terminals; no worker resource record | preserve |
| `/Users/youngminpark/orca/workspaces/yeosachin_scanner/trevally` | `a87eaf20b2e804a5367b225f500b6bfb702736a6` | yes | 5 | 4 | no | no | no | 0 terminals; no worker resource record | preserve |

## Preserved paths by category

### Required anchors

- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/cormorant` — coordinator/root worktree.
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner` — Desktop main worktree; also contains `.playwright-mcp`.
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/safe-worktree-cleanup-20260906` — this worker worktree.

### Explicitly active, retained, or report-source worktrees

- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/bounded-preflight-fallback-ux-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-contract-guard-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-producer-config-reconcile-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-production-recovery-20260906` — report source; preserve until integrated.
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-stale-iam-cleanup-20260906` — report source; preserve until integrated.

### Dirty or untracked worktrees

- `/Users/youngminpark/Desktop/개발/yeosachin_scanner`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-opus5-20260903`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-visibility-opus5-20260905`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/bounded-preflight-fallback-ux-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/external-runtime-trace-20260905`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/external-state-funnel-trace-20260905`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-contract-guard-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/vertex-production-rollout-20260904`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/automatic-analysis-initial-activation-20260902`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-redesign-opus`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-result-a-hybrid`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/coelacanth`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/cormorant`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/sanddab`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/tellin`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/trevally`

### Non-ancestor / unmerged worktrees

- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-opus5-20260903`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-visibility-opus5-20260905`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/bounded-preflight-fallback-ux-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-contract-guard-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-oidc-production-recovery-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/preflight-stale-iam-cleanup-20260906`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/vertex-production-rollout-20260904`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/automatic-analysis-initial-activation-20260902`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-result-a-hybrid`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/cormorant`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/tellin`

### `.playwright-mcp` protection

- `/Users/youngminpark/Desktop/개발/yeosachin_scanner`
- `/Users/youngminpark/Desktop/개발/yeosachin_scanner/.orca/worktrees/yeosachin_scanner/admin-operations-dashboard-visibility-opus5-20260905`
- `/Users/youngminpark/orca/workspaces/yeosachin_scanner/blite-result-a-hybrid`

### Protected migration

No registered worktree showed a working-tree, index, or committed-tree difference for `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql`; this rule did not add any additional path beyond the categories above.

## Follow-up

After the named active/report-source worktrees are integrated and the coordinator confirms a fresh audit, rerun the same three-predicate check. Only then should a later cleanup worker consider any newly eligible clean, inactive, fully merged registration, using `git worktree remove` without `--force` and retaining its local branch.
