# Amplitude UX Funnel Chart Alignment Design

## Goal

Align the production `얼리버드 전환 대시보드` with the current anonymous preflight, exclusion, preview, plan, login, and payment-confirmation journey. Remove charts that do not support the current operating decisions and make landing acquisition sources extensible without a code change for every new campaign source.

## Current-state findings

- The saved core funnel starts at `auth_completed`, even though authentication now occurs after anonymous preflight, exclusion, preview, and plan selection.
- `preflight_succeeded` records backend readiness and can occur before `exclusion_decided`; it is not a reliable proxy for the moment a user sees a preflight result.
- The acquisition chart adds `landing_viewed` twice, once grouped by `source` and once by `medium`, so direct traffic appears twice as `source=direct` and `medium=direct`.
- The plan-demand chart filters to Basic and Standard but does not break the series down by `plan_id`.
- The preflight-quality chart combines success with two failure measurements, while the requested operating view is daily technical failures only.
- The payment-confirmation chart repeats the same event across unique users, event totals, and amount sums. `amount_krw` is not a stable segmentation key and `payment_confirmed_viewed` is a confirmation-screen observation, not the revenue ledger.
- The result-usage chart measures post-purchase result viewing and sharing. It does not belong in the current acquisition-to-payment dashboard.

## Source attribution design

`utm_source` becomes a bounded dynamic event property instead of a closed enum.

- Normalize the value by URL decoding through `URLSearchParams`, trimming surrounding whitespace, and lowercasing.
- Limit the accepted value to 64 characters so a campaign URL cannot create an unbounded analytics payload.
- Preserve any other non-empty normalized value. A previously unseen value therefore appears automatically as a new Amplitude `source` series.
- Canonicalize common aliases:
  - `thread`, `threads.net` → `threads`
  - `twitter`, `twitter.com`, `x.com` → `x`
  - `everytime.kr` → `everytime`
  - `chatgpt.com` → `chatgpt`
- Keep `direct` when no UTM attribution is present and keep the existing `shared` session attribution override.
- Continue collecting `medium` for event-schema compatibility, but do not use it in the acquisition chart.

The dynamic source value may contain campaign-supplied personal or unexpected text. This is an explicit owner-approved exception to the previous closed source allowlist. Existing restrictions on Instagram identifiers and other event properties remain unchanged.

This change is prospective. Historical source values that the closed parser removed cannot be reconstructed inside Amplitude. The landing-lead writer used the same parser, so its `utm_source` column also omitted those unknown values. A stored referrer may support partial offline domain analysis for some submitted leads, but it cannot be used to backfill the original `landing_viewed` events accurately.

## Dashboard design

### 유입 추이 및 채널

Use one `landing_viewed` series measured as daily unique users and grouped only by `source`. Remove the duplicate `medium` series. Update the description to state that new normalized UTM sources appear automatically.

### 핵심 UX 퍼널

Use the current visible journey in this order, completed within seven days and measured by unique users:

1. `landing_viewed`
2. `preflight_started`
3. `exclusion_decided`
4. `precheckout_demo_completed`
5. `precheckout_plan_gate_reached`
6. `plan_selected`
7. `auth_completed`
8. `checkout_redirected`
9. `payment_confirmed_viewed`

`precheckout_demo_completed` represents completion of either the result or fallback preview. `precheckout_plan_gate_reached` represents the explicit transition from the preview into the plan surface. The funnel does not use `preflight_succeeded` as a visible result step because its emission order is backend-driven.

### 전환 시간 분포

Use the same nine ordered events as the core UX funnel. Configure unique users completed within seven days, use the conversion-time distribution visualization, and show the median time from the first event to the final event. Total conversion remains in the core UX funnel so the two charts have distinct purposes without disagreeing about the product journey.

### 사전 조회 실패

Rename `사전 조회 품질` to `사전 조회 실패`. Use a single daily `preflight_failed` event-total series grouped by `error_code`. Do not add `preflight_succeeded` or `preflight_blocked`; business blocks are not technical failures.

### 결제 확인

Use one daily `payment_confirmed_viewed` event-total series, filter `plan_id` to Basic and Standard, and group by `plan_id`. This produces the two requested plan series. Remove unique-user and `amount_krw` measurements. The description must explicitly say this is a confirmation-screen observation and that Supabase remains the payment ledger.

### Deleted charts

Permanently delete the saved `플랜 수요` and `결과 이용` charts as explicitly requested. Their dashboard cards should disappear with the saved content. Do not recreate replacements in another dashboard.

## Code and documentation scope

- Modify `lib/services/analytics-funnel.ts` for dynamic source normalization and aliases.
- Modify `lib/services/analytics.ts` so the `source` property validator accepts bounded normalized source strings.
- Update the focused analytics tests covering attribution normalization, property filtering, and arbitrary sources.
- Update `docs/amplitude-analytics-operations.md` to match the new source contract and five-chart dashboard.
- Do not modify `app/page.tsx` marketing copy.
- Do not modify payment or Supabase state.

## Verification

- Run the focused analytics and Amplitude caller contract tests.
- Run lint or the smallest repository-wide static check needed for changed TypeScript files.
- Verify in the production Amplitude UI that the dashboard contains the five retained charts, the two requested charts are deleted, and each retained chart has the specified event order, metric, filter, grouping, and description.
- Verify the acquisition chart uses `source` only.
- Verify no secret, authorization header, raw event export, user/device identifier, or real user UUID is printed or persisted.
