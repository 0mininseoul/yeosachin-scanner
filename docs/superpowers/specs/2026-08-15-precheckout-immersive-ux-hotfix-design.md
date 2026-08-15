# Precheckout immersive UX hotfix

## Decision

Apply a localized presentation fix to `components/precheckout-immersive.tsx` and
`app/analyze/page.tsx`. Do not change the B-lite API/DTO, provider work, durable
deadline policy, page-flow reducer, checkout admission flow, or any landing-page
marketing copy.

PR #412 deliberately started the immersive surface before preflight readiness, but
it also passed the accepted-preflight timestamp into the demo. A later mount therefore
calculates elapsed time from before the surface was visible and can begin at a later
stage or directly in the slow loop. The same PR moved the post-CTA viewport to the
plan section. The selected fix separates the presentation clock from the persisted
preflight clock and restores the narrow conditional gender confirmation that the PR
removed.

Considered alternatives:

1. Keep the accepted timestamp and compensate inside the stage graph. This still
   resumes an in-progress animation on reload and leaves two clocks implicit.
2. Persist a browser-level animation session. This adds storage/recovery states for
   a display-only flow and still cannot guarantee a fresh visible entry after reload.
3. Use one mount-local visible-entry timestamp for the demo, while retaining the
   accepted timestamp only for the existing B-lite deadline. This is the smallest
   change and is the chosen approach.

## Components and state

### `PrecheckoutImmersive`

Keep `submittedAtMs` as the accepted-preflight timestamp for `BLITE_UX_DEADLINE_MS`.
Add a mount-local `visibleEntryAtMs`, initialized once with `Date.now()` when the
immersive component becomes visible. Pass only `visibleEntryAtMs` to
`PrecheckoutDemo`, `nextGraphTransitionAt`, and demo-duration analytics.

Every mount, remount, and full reload must therefore render S1 first, then S2, S3,
and S4 in order over the existing 12-second initial pass. A completed B-lite DTO may
be fetched immediately, but it cannot reveal a result before that visible pass ends.
The slow waiting loop begins only after the same S1-to-S4 pass has completed.

The accepted-preflight deadline still decides whether B-lite polling is allowed and
whether the terminal screen is a result or neutral fallback. If it expires during a
newly visible initial pass, latch the fallback and stop polling as today, but settle
the presentation through the next transition calculated from `visibleEntryAtMs`;
do not force an immediate mid-sequence exit. This is the necessary bounded display
grace to preserve the guaranteed 1 -> 2 -> 3 -> 4 visible order after a reload. It
does not restart server work, extend the durable B-lite deadline, or issue another
provider/Gemini request.

Extend the local view state with a conditional gender-confirmation view. Restore the
existing `GenderConfirmScreen` only when
`dto.genderRead.likelyFemale === true` **and**
`dto.genderRead.confidence >= PRECHECKOUT_BLITE_LIKELY_FEMALE_CONFIDENCE_THRESHOLD`
(including exactly `0.70`). Its current reasons, yes/no controls, and
`BLITE_GENDER_CONFIRMATION_COMPLETED` outcomes remain unchanged:

- `예` emits `confirmed` and opens the normal B-lite result.
- `아니오` emits `rejected`, suppresses the B-lite result, and leads to the existing
  neutral completion CTA; it never releases plans automatically.

The rejected path is not a B-lite timeout: do not emit
`BLITE_FALLBACK_SELECTED`. Its final explicit CTA records the already-available
`result` demo mode, so timeout/failure reporting and a user rejection remain distinct.

For every other DTO, go directly to the B-lite result. Remove the ordinary `성별 판독
요약` result card entirely: neither its verdict, confidence, nor reasons are rendered
outside the high-confidence confirmation gate. Do not alter the schema, inference,
or API response merely because `genderRead` and `postCount` cease to be normal-result
display fields.

In `BliteResultScreen`, change the two copy-only renderings to these exact forms:

- Feed caption: `최근 게시물들에서 확인한 패턴` (no numeric `postCount` interpolation).
- Candidate range: `분석 후보 예상 범위 ${min}~${max}명` (ASCII Korean tilde, no spaces
  or en dash; for example `34~80명`).

All remaining target, persona, signal, range, CTA, status polling, fallback, and
event de-duplication behavior remains as shipped.

### `AnalyzePage` CTA handoff

`handleGoToPlans` remains the sole callback that changes the matching preflight
surface from `awaiting` to `legacy`; it must still not choose a plan, start checkout,
or invoke login. Remove the `planSectionRef`/`planHeadingRef` effect that waits for a
ready preflight and calls `scrollIntoView` on `#plan-selection`.

Instead, on this explicit immersive CTA transition, reset the document viewport to
`(0, 0)` with non-smooth scrolling after the legacy surface is committed. If focus is
managed, focus the top next-screen heading with `preventScroll`, never the plan
heading. Apply the top reset whether the legacy page initially renders the pending
status or the ready target/plans, and do not perform a second scroll when readiness
later changes. The next screen consequently begins at its top rather than pre-scrolled
to its plans.

## Data flow and failures

```
accepted preflight timestamp ──> existing B-lite deadline/poll cutoff
immersive component mount ────> visibleEntryAtMs ──> S1 -> S2 -> S3 -> S4
B-lite complete DTO ──────────> threshold gate? ──yes──> male confirmation
                                      │ no / confirmed
                                      └───────────────> B-lite result -> explicit CTA
deadline, failed, invalid, error ───> neutral fallback -> explicit CTA
```

`fetchPrecheckoutBlite`, its request cache, DTO validation, retry cadence, and the
90-second server-side B-lite lifecycle remain authoritative. A malformed response,
transient status, failed status, or demo error continues to choose the existing
neutral fallback without exposing an error-specific checkout bypass. A valid result
received during the initial animation continues to wait for its visible boundary.
No migration, new endpoint, provider call, storage record, or analytics event is
introduced. Existing result/fallback event properties remain truthful; a gender
rejection retains its confirmation outcome and still requires the neutral CTA before
the page gate is released.

## Regression coverage

Update the focused Vitest coverage rather than adding a new flow framework.

- `components/precheckout-immersive.test.tsx`: mount with a deliberately stale
  `submittedAtMs`, then remount/reload (including `StrictMode`) and assert each fresh
  visible surface announces 1/4 before 2/4, 3/4, and 4/4. Assert a cached/fast DTO
  still waits the fresh 12 seconds, and a deadline latched during that pass does not
  cut it short before the neutral fallback.
- The same component tests must cover the threshold boundary (`likelyFemale: true`,
  confidence `0.70`), confirmed and rejected paths, no confirmation below threshold,
  no ordinary gender-summary card in any normal result, and no plan callback until
  the applicable explicit CTA. Keep the existing timeout, terminal-status, malformed
  DTO, and demo-error gate tests.
- Add copy assertions using a DTO range of `34`/`80` and a nonzero post count:
  render `34~80명`, render `최근 게시물들`, and do not render the exact recent-post
  count or the prior spaced dash range.
- `components/precheckout-demo.test.tsx`: retain the stage-duration assertions and
  its existing direct S1-to-S4 ordering coverage; the stale accepted-timestamp
  regression belongs at the `PrecheckoutImmersive` boundary where the local entry
  clock is created.
- `app/analyze/page.test.ts`: exercise the explicit plan-gate transition at a
  nonzero scroll position and assert a non-smooth top reset, no
  `#plan-selection.scrollIntoView`, and no delayed readiness scroll to plans. Verify
  the existing pending and ready legacy branches still remain closed before that CTA.

Run the focused component/page test files, followed by the repository lint command.
This hotfix changes no landing marketing copy, checkout/business rules, or backend
contracts.
