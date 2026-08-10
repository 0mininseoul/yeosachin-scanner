# Revenue E2E frontend observation notes

Observed 2026-08-10 with Orca browse at `https://vir-tually.love`, entering the approved
`0_min._.00` target. No credentials, cookies, or session values were captured.

## Reusable interaction patterns

- A narrow, mobile-first viewport keeps one primary question or status state in focus.
- The flow uses short staged states: target confirmation, progress/scanning, one question at a
  time, then a result teaser and an explicit authentication handoff.
- Question progress is communicated with a compact dot indicator and the active state is
  preserved while the next question swaps in.
- Loading states use bounded, human-readable phases instead of an indeterminate spinner alone.
- The pre-login handoff is a dedicated screen with one provider action, separate from the result
  teaser.

## Product-specific translation

- Reuse this app's existing result card, spacing, colors, and typography tokens for the demo
  preview; keep the demo between ready preflight and plan cards.
- Use a compact `예시 결과` marker and three synthetic candidates, with no target-derived names,
  photos, counts, or copy.
- Keep preview expansion state local and preserve scroll position when it opens or closes.
- Emit `demo_result_viewed`, `demo_result_expanded`, and `plan_selected` against the same
  anonymous preflight lineage; login remains at the existing purchase boundary.
- Preserve back/refresh behavior by storing only the anonymous preflight lineage and preview UI
  state, never credentials or provider payloads.

## Explicit non-copy decisions

- Do not copy the reference brand, headlines, Korean copy, colors, illustrations, assets, or
  countdown framing.
- Do not change fixed marketing copy in `app/page.tsx`.
- Do not capture or document Kakao credentials. Observation stopped at the Kakao login screen.

## Acceptance checks for a future frontend pass

- Mobile and desktop layouts keep the existing app's result hierarchy intact.
- Reduced motion disables teaser transitions without hiding status or CTA content.
- Keyboard focus reaches the preview toggle and plan CTA in order.
- Back and refresh restore the ready preflight and preview expansion state safely.
- Fixture failure hides only the preview and leaves plan selection usable.
