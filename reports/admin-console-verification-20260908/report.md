# Admin operations console verification

- Date: 2026-09-08 (Asia/Seoul)
- Branch: `admin-console-verification-20260908`
- Original verification base: `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`
- Refreshed PR base: `ca28b43f7894080b19336efd8b927115b0162415`
- Implementation reviewed: existing PR #546 console, not a replacement dashboard

## Outcome

The existing operations console was exercised with local synthetic responses across overview, detail, loading, empty, partial, stale, failure, and recovery states. Eight scoped QA defects were reproduced, fixed with red-to-green regression tests, and verified in the rendered UI. A final independent specification review then found two additional frontend gaps; both were reproduced, fixed with red-to-green tests, and reverified. No API, RPC, schema, identity-epoch, or marketing-copy change was needed.

Scoped disposition: **pass**. All console/API audit tests, lint/type checks, the synthetic production build, authorization denial, cache controls, responsive checks, interaction checks, and rendered axe scans pass. The previously time-sensitive PGlite fixture failure was fixed on main and now passes after the normal main merge; details are recorded below.

## Baseline and scope proof

- Startup `npm install` had removed only `devOptional` from the Rollup 4.62.2 lockfile entry. That exact incidental diff was inspected and restored with `apply_patch` before baseline. `package-lock.json` has no branch diff.
- A fresh fetch established `HEAD == origin/main == merge-base` at `02e89f496c2dabaf4ef6a9c2251928006a5b17bc`; initial ahead/behind was `0 / 0`.
- After PR #554 merged, this branch normally merged `origin/main` at `ca28b43f7894080b19336efd8b927115b0162415`. The merge had no conflicts and changed only the clock-relative terminalizer fixture inherited from main; the PR diff against refreshed main remains confined to the admin console and this report.
- PR #546 checks inspected at baseline were green: Vercel, production-payment-recovery-postgres, quality, revenue-settlement-postgres, and score-audit-postgres.
- Baseline targeted suite: 9 files, 93 tests passed.
- Baseline console lint and `tsc --noEmit` passed. A first production build failed only because the isolated worktree intentionally had no Supabase environment; the build passed with synthetic public Supabase values.
- The branch diff is confined to `app/admin/analysis-audit/**` plus this report. There is no diff in `package-lock.json`, `app/page.tsx`, migrations, admin APIs, audit/shared contracts, or identity files.
- No `.env` file was sourced or printed. No live/protected records, provider calls, production writes, deployments, activations, destructive cleanup, or real canary were used.

## Synthetic test surface

A temporary Vite harness outside the repository imported the real `AnalysisAuditWorkbench` and `console.css` and supplied strict, schema-shaped synthetic API responses. Synthetic identifiers, balances, hashes, and timestamps were visibly artificial. The harness supported loading, empty, partial/stale, error-then-recover, overview, and direct-detail scenarios. Browser measurements, focus observations, console inspection, and axe results below are fresh manual synthetic observations; the transient harness itself is intentionally not committed. Committed component regressions and screenshots retain the reproducible source and visual evidence.

Rendered checks used 1440x1000, 1024x900, 768x900, and 375x812 viewports. Representative final renders:

- [Desktop overview](screenshots/final-overview-1440x1000.png)
- [Tablet overview](screenshots/final-overview-768x900.png)
- [Mobile overview](screenshots/final-overview-375x812.png)
- [Mobile detail](screenshots/final-detail-375x812.png)
- [Expanded desktop risk ledger](screenshots/final-detail-risk-ledger-1024x900.png)
- [Expanded mobile risk ledger](screenshots/final-risk-ledger-375x812.png)

## Fixed defects

### ISSUE-001: wide tables escaped the document on tablet/mobile

Severity: high responsive/interaction defect.

Before, the 840px overview tables propagated their overflow to the page. At 768px the document was 829px wide; at 375px it was 823px wide and could be scrolled 448px into blank space. The table wrappers already scrolled, but did not contain painting.

Fix: add paint containment to `.oc-table-scroll`, preserving horizontal table scrolling while preventing page-level overflow. Regression: `operator-console-responsive.regression-1.test.ts`.

- [Before: page-level horizontal scroll](screenshots/mobile-page-horizontal-scroll.png)
- [After: 768px](screenshots/issue-001-after-768x900.png)
- [After: 375px](screenshots/issue-001-after-375x812.png)

Final measurements are `document.scrollWidth == viewport width` at 1440, 1024, 768, and 375. At 375 the inner table remains intentionally scrollable (`840px / 311px`) while `scrollX` remains zero.

### ISSUE-002: order drilldown lost keyboard and scroll context

Severity: high interaction/accessibility defect.

Before, pressing Enter on an order at overview `scrollY ~= 974` opened detail at the same deep scroll offset and moved focus to `BODY`; the Back control and page heading were outside the viewport. Returning also lost the originating control.

Fix: record the originating order focus key and scroll position, move detail to the top, focus Back after both loading and loaded detail render, then restore the exact overview scroll position and originating order button on return. Loading/error detail states now also have a page-level heading. Regression: `operator-console-navigation.regression-2.test.ts(x)`.

- [Before: detail opened out of context](screenshots/issue-focus-detail-entry-before.png)
- [After: detail top and Back focus](screenshots/issue-002-detail-after.png)

Rendered result: enter detail at `scrollY = 0` with focus on `← 주문 목록`; return to `scrollY ~= 974` with focus on the original order trigger.

### ISSUE-003: supporting text, focus rings, landmarks, and detail headings failed accessibility checks

Severity: high accessibility defect.

Before, axe reported a serious color-contrast violation across 32 overview nodes plus a duplicate named landmark. Supporting text ratios included approximately 3.16–4.49:1, and the translucent focus ring composited far below 3:1. Detail also skipped directly from `h1` to `h3`.

Fix: use a consistent opaque supporting-text color meeting 4.5:1 on the console backgrounds, an opaque blue focus ring above 3:1, one named attention landmark, and a sequential `h1`/`h2` detail hierarchy. Regression: `operator-console-accessibility.regression-3.test.ts`.

- [Before: faint focus indicator](screenshots/issue-focus-visibility-before.png)
- [After: accessible detail](screenshots/issue-003-accessibility-after.png)

Final axe results: zero violations on overview and loaded detail.

### ISSUE-004: pending/failed sources appeared as verified zero states and offered no recovery

Severity: high operational-trust and interaction defect.

Before, the attention area displayed `0건` and “확인이 필요한 항목이 없습니다” while data was still loading and after both sources failed. The order heading similarly showed `0건 표시`; neither failed source had an explicit retry action.

Fix: model pending, unavailable, and verified-empty states separately; suppress zero/empty claims until both sources succeed; add separate account and order retry actions; and suppress the empty order row on failure. Regression: `operator-console-recovery.regression-4.test.ts(x)`.

- [Before: loading shown as clear](screenshots/state-loading-before.png)
- [Before: failure shown as clear](screenshots/state-error-before.png)
- [After: honest loading](screenshots/issue-004-loading-after.png)
- [After: unavailable plus retry controls](screenshots/issue-004-error-recovery-after.png)
- [After: recovered data](screenshots/issue-004-recovered-after.png)

Both retry requests were exercised in the browser. Alerts and retry controls cleared after success, real attention items returned, and axe remained clean.

### ISSUE-005: expanded risk ledger skipped a heading level

Severity: medium accessibility defect.

The collapsed detail passed axe, but expanding a risk formula exposed two `h4` ledger headings directly below the `h2` evidence section. Axe reported `heading-order` with moderate impact.

Fix: render and style the two ledger subheadings as `h3`. Regression: `operator-console-expanded-accessibility.regression-5.test.ts`.

Final expanded hierarchy is `h1` page, `h2` evidence, then the two `h3` ledger headings; expanded-state axe reports zero violations.

### ISSUE-006: unavailable inventory fabricated blocked account states

Severity: high operational-trust defect.

After an inventory fetch failure, absent rows were passed into normal account rendering. The paid card and free table therefore synthesized red “차단” chips, unknown meters, and “스냅샷이 없습니다” reasons despite having no account response.

Fix: when inventory is unavailable, render a bounded unavailable-state instruction in both account sections and do not render account status rows/cards until a valid all-ten inventory arrives. Regression: `operator-console-inventory-failure.regression-6.test.ts(x)`.

- [After: inventory unavailable without fabricated status](screenshots/issue-006-inventory-unavailable-after.png)

Rendered failure state contains zero account `blocked` chips and zero free-account tables, remains recoverable from the top retry, and passes axe.

### ISSUE-007: repeated order reload failures retained a stale next-page cursor

Severity: high interaction/data-integrity defect, found by independent review.

After a successful first page, an append failure exposed “주문 다시 시도”. If that first-page retry also failed, the table correctly cleared but retained the old page-2 cursor, leaving “다음 25건” enabled and allowing page 2 to be appended without page 1.

Fix: clear the cursor whenever a non-append load begins and again if it fails. Regression: `operator-console-review-regressions-7.test.ts(x)`.

- [After: failed retry has no rows and disabled pagination](screenshots/issue-007-stale-cursor-after.png)

The two-failure sequence was reproduced in the component test and synthetic browser. Final state is `확인 불가`, zero order rows, and disabled Next.

### ISSUE-008: direct detail return had no focus destination

Severity: high accessibility/navigation defect, found by independent review.

A detail entered through `initialRequestId` has no originating overview trigger. Back therefore returned to the overview with focus on `BODY`, unlike a drilldown initiated inside the list.

Fix: make the overview `h1` programmatically focusable and use it only as the fallback destination when Back has no recorded list origin. List-origin restoration remains unchanged. Regression: `operator-console-review-regressions-7.test.ts(x)`.

- [After: direct detail Back focuses the overview heading](screenshots/issue-008-direct-return-focus-after.png)

Rendered result: Back returns to `판독 운영 콘솔`, whose `tabindex=-1` heading owns focus; axe reports zero violations.

## Final independent-review hardening

The fresh specification review found two Important frontend gaps after ISSUE-001 through ISSUE-008. Both were reproduced before the fix and then added to `operator-console-review-regressions-7.test.ts(x)`:

- If one overview source failed, the attention panel replaced actionable items already known from the successful source with a blanket unavailable message. Account mutation errors also reused the source-load error state and incorrectly invalidated already loaded attention data. The final implementation preserves known attention items with a partial-coverage warning and separates inventory load failures from action failures.
- Returning from a detail opened by the `requestId` query focused the overview correctly but left the query in the address bar, so refresh reopened detail. Direct-entry Back now removes only `requestId`, preserves other query/hash state, and returns focus to the overview heading. List-origin detail return continues to restore its exact trigger and scroll position.

## Authorization and caching

No frontend-owned authorization or caching defect was found.

- Anonymous page request: `307` to `/login` with `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
- Anonymous `/api/admin/order-audit`, `/api/admin/apify-accounts`, and synthetic detail request: `401` with `Cache-Control: private, no-store`.
- Existing route tests cover authenticated non-operator `403` denial and operator-only success paths without weakening the allowlist.
- Client requests use `cache: 'no-store'`, same-origin credentials, and an explicit private/no-store request header.
- The UI does not retain or display provider/source raw payloads.

## State, interaction, responsive, and visual matrix

Verified with synthetic data:

- Loading: explicit live status; no zero or clear claim.
- Empty: verified empty only after both sources return successfully.
- Partial/stale: unknown amounts remain “미상”; stale balances are not promoted to current values; attention items from a successful source remain visible when the other source is unavailable.
- Error/recovery: source-specific alerts and retries; unavailable inventory is fenced; successful retries rehydrate the UI.
- Account control: octonary exclusion/re-entry updated the row and attention list.
- Order pagination: next-page cursor appended `@synthetic.complete` without replacing the first page.
- Drilldown: six evidence stages, correct first divergence (`target-likes`), Back focus, and scroll restoration.
- Evidence filter/pagination: mutual filter switched from all to private, the displayed contract updated to `filter=private`, and the next cursor moved to the second page.
- Risk detail: public-female filter, score transition fields, contribution ledger, retention state, and formula expansion rendered without raw provider data.
- Keyboard: order open and return were exercised with Enter; visible focus uses the corrected opaque indicator.
- Motion: the console defines no animation or transition, so reduced-motion preference does not leave an unbounded motion path.
- Korean copy: no clipping or mojibake observed at any target width.
- Console: no browser console errors throughout the final matrix.

The final rendering remains faithful to the latest light operations-console design: cool gray shell, coral attention surface, paid-account emphasis, dense horizontally scrollable audit tables, compact status tokens, and inline evidence expansion. Proposed surfaces unsupported by current contracts were not invented.

## Verification results

Passing gates:

- Final scoped suite: **16 files / 113 tests passed**.
- Console-only suite: **11 files / 32 tests passed**.
- `npm run lint`: **0 errors**; 17 pre-existing warnings outside the console-owned files.
- `npx tsc --noEmit`: passed.
- Synthetic production build: passed; only the existing multiple-lockfile workspace-root warning was emitted.
- `git diff --check origin/main...HEAD`: passed.
- Rendered axe: zero violations on overview, loaded detail, expanded risk ledger, error, recovered, and unavailable-inventory states.
- Refreshed-main terminalizer fixture: **1 file / 30 tests passed**.

Repository-wide baseline anomaly and resolution:

- On the original `02e89f49` base, `lib/services/analysis/v2-historical-legacy-dispatch-terminalizer-pglite.test.ts` reproduced 2 failures / 28 passes because a fixed `2026-09-01T00:00:00.000Z` “young” fixture crossed the unchanged seven-day cutoff on 2026-09-08.
- A second fresh repository-wide run was started with an emitted command timestamp of `2026-09-08T18:06:25+09:00`. It continued producing test progress but never emitted a completion summary. The supervisor TUI reported approximately 56 minutes elapsed, beyond the agreed 25-minute bound, so only that test process was interrupted. A separate control timestamp immediately after interruption was `2026-09-08T18:16:27+09:00`; because the shell and supervisor elapsed indicators disagreed, no synthetic duration is inferred from them. The preserved outcome is **bounded timeout / non-conclusive**, not a product regression, and the run was not repeated.
- PR #554 changed that test fixture to derive old/young timestamps from the database clock. After merging `ca28b43f`, the formerly failing file passes all **30 / 30** cases without any console-lane modification to the test or migration.
- The historical bounded full-suite result remains non-conclusive evidence for that earlier base; it is not carried forward as a merged-state failure.

## Interface requests and residuals

- API/RPC/schema/shared-contract interface requests: **none**.
- Frontend-owned known defects after this pass: **none reproduced**.
- The prior out-of-scope request for a clock-relative historical-terminalizer fixture was resolved upstream by PR #554 and inherited unchanged through the normal main merge.

## Commit trail

- `d4edbbca` `fix(qa): ISSUE-001 contain mobile table overflow`
- `41c45db5` `fix(qa): ISSUE-002 restore detail navigation context`
- `aaba12cf` `fix(qa): ISSUE-003 meet console accessibility contracts`
- `c8f217f8` `fix(qa): ISSUE-004 distinguish unavailable console data`
- `9925fb13` `fix(qa): ISSUE-005 repair expanded ledger headings`
- `678c050a` `fix(qa): ISSUE-006 fence unavailable inventory state`
- `f71e888c` `fix(qa): close independent review edge cases`
- `c9298e26` `docs(qa): add admin console verification evidence`
- `dbd61949` `fix(qa): close final admin console review gaps`
- `4139cf84` normal merge of refreshed `origin/main` fixture fix.

Independent review: the first code-quality pass found ISSUE-007 and ISSUE-008 as Important. Both were reproduced and fixed with new tests and rendered evidence. A later fresh specification review found the two hardening gaps above; both were also reproduced and fixed. Its one non-blocking Minor note was that the transient browser harness is not part of HEAD, so this report now distinguishes fresh manual browser observations from committed evidence. The final independent code-quality review of the complete frontend diff and both hardening fixes returned **Critical 0 / Important 0 / Minor 0** and **Ready for commit/PR: Yes**.

Post-merge independent review: the complete PR diff against refreshed `origin/main` at `ca28b43f` returned **Critical 0 / Important 0 / Minor 0** and **Ready to push/PR-update: Yes**. It independently re-ran the console suite (**11 files / 32 tests**), final-review regressions (**4 / 4**), and refreshed terminalizer fixture (**30 / 30**), and confirmed the protected-scope diff remains clean.
