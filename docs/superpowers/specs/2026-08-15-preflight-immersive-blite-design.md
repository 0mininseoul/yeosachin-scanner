# Preflight immersive B-lite flow

## Decision

Use the accepted-preflight clock to mount the four-stage mobile demo as soon as the
existing exclusion decision permits source work. Keep the existing single full-profile
collection and durable B-lite inference unchanged; decouple only the browser display
gate from `preflight.status === 'ready'`.

## Sanitized production evidence and root cause

The reported production session spent more than 90 seconds on generic lookup, then
showed the target card and one B-lite card; its CTA opened the plan surface without the
approved sequence. The code reproduced that path: `app/analyze/page.tsx` mounts the
immersive component only inside the ready-preflight branch, `PrecheckoutImmersive`
returns `null` while B-lite is pending, and the B-lite-card CTA emits `SUCCESS_CTA`,
which starts the demo only after the card has been viewed. The B-lite source is already
projected from the same full profile collected by preflight and persisted/finalized with
the ready snapshot, so moving that collection earlier would add a migration and risk a
second provider/Gemini path without improving the visual wait.

## Considered approaches

1. Keep the ready-only mount and shorten provider work. This cannot guarantee an
   immediate experience and leaves the visible state coupled to provider latency.
2. Split B-lite source collection into an independent worker before preflight readiness.
   It risks duplicate provider work and a larger durable-schema/dispatch change.
3. Mount the approved demo from the accepted preflight clock and poll the existing
   durable B-lite status in the background. This preserves the one-collection contract,
   has no new provider or Gemini invocation, and fixes the observed gate; this is the
   selected approach.

## UX state sequence

After an accepted preflight with the exclusion decision made, mobile renders the
fullscreen demo instead of the pending lookup, target card, B-lite card, or plans.
The first 12 seconds play S1–S4 once at the approved timing. If no durable B-lite DTO is
available at that point, the same graph engines continue on a six-second-per-stage loop
with rotating progress copy; this is slower and distinct from mechanically replaying the
initial twelve-second animation.

A valid B-lite result waits for the active graph transition (and never interrupts the
initial pass), then reveals a full result screen containing target, persona, feed-signal,
gender, and relationship-range cards. Its `상세 분석 보기` CTA is the only successful
path to plans. If B-lite remains pending, is unavailable, or is terminal at T+90, the
current graph ends at that deadline and a neutral fallback CTA opens plans; no B-lite
failure message is exposed.

## State, refresh, and cost guarantees

The flow is derived from the persisted accepted-preflight timestamp plus the durable
status response. A remount therefore resumes the same first-pass/slow-loop/deadline
position and polls only the status endpoint; existing durable source, dispatch, provider
run, and Gemini idempotency remain authoritative. Status `204` is treated as an
unresolved preview while the demo is running so it cannot create an early plan bypass;
it is retried only through the existing T+90 client deadline.

## Test plan

Component tests cover immediate demo mount without any legacy card/plan gate, the
twelve-second first pass, slow pending continuation with changing copy, next-transition
B-lite result reveal, T+90 neutral fallback, CTA gating, and refresh/resume without a
second provider request. Page tests verify that the target/plans surface remains hidden
until the immersive CTA. Existing preflight and B-lite single-collection tests remain the
proof that source collection is not duplicated.
