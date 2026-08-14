/**
 * Submission-anchored B-lite timing shared by server, database contract, and browser flow.
 * Provider and checkpoint budgets remain unchanged; the reserved fallback demo remains 12s.
 */
export const BLITE_PROVIDER_DEADLINE_MS = 40_000;
export const BLITE_CHECKPOINT_DEADLINE_MS = 43_000;
export const BLITE_UX_DEADLINE_MS = 90_000;
export const BLITE_FALLBACK_DEMO_DURATION_MS = 12_000;
export const BLITE_FALLBACK_LATCH_MS = BLITE_UX_DEADLINE_MS - BLITE_FALLBACK_DEMO_DURATION_MS;
export const BLITE_INFERENCE_DEADLINE_MS = BLITE_UX_DEADLINE_MS - 4_000;
