export const EARLYBIRD_CHECKOUT_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const EARLYBIRD_CHECKOUT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

/**
 * Recovery timestamps are written by PostgreSQL and read by the application.
 * A small clock difference must not strand a freshly-issued checkout, while a
 * materially future timestamp remains invalid and fails closed.
 */
export function isEarlybirdCheckoutRecoverableAt(
    createdAt: string,
    nowMs: number = Date.now(),
): boolean {
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;

    const ageMs = nowMs - createdAtMs;
    return ageMs < EARLYBIRD_CHECKOUT_RECOVERY_WINDOW_MS
        && ageMs >= -EARLYBIRD_CHECKOUT_MAX_FUTURE_SKEW_MS;
}
