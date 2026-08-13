import 'server-only';
import { createHash } from 'node:crypto';

export const BLITE_PROVIDER_DEADLINE_MS = 40_000;
export const BLITE_CHECKPOINT_DEADLINE_MS = 43_000;
export const BLITE_FALLBACK_LATCH_MS = 48_000;
export const BLITE_INFERENCE_DEADLINE_MS = 56_000;
export const BLITE_UX_DEADLINE_MS = 60_000;

const PREFLIGHT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface BliteCohortSelectionOptions {
    /** Set only after the server has verified an internal signed test entitlement. */
    readonly signedTestEntitlement?: boolean;
}

export interface BliteDeadlines {
    readonly provider: number;
    readonly checkpoint: number;
    readonly fallback: number;
    readonly inference: number;
    readonly ux: number;
}

function rolloutPercent(env: Record<string, string | undefined>): number {
    const value = env.PRECHECKOUT_BLITE_ROLLOUT_PERCENT;
    if (value === undefined || value === '') return 0;
    if (!/^(?:0|[1-9][0-9]?|100)$/u.test(value)) {
        return 0;
    }
    return Number(value);
}

function preflightBucket(preflightId: string): number {
    if (!PREFLIGHT_ID_PATTERN.test(preflightId)) {
        throw new Error('PRECHECKOUT_BLITE_COHORT_ERROR: preflightId must be a UUID.');
    }
    return createHash('sha256')
        .update(preflightId.toLowerCase(), 'utf8')
        .digest()
        .readUInt32BE(0) % 100;
}

export function bliteDeadlines(submittedAtMs: number): BliteDeadlines {
    if (!Number.isFinite(submittedAtMs)) {
        throw new Error('PRECHECKOUT_BLITE_DEADLINE_ERROR: submittedAtMs must be finite.');
    }
    return Object.freeze({
        provider: submittedAtMs + BLITE_PROVIDER_DEADLINE_MS,
        checkpoint: submittedAtMs + BLITE_CHECKPOINT_DEADLINE_MS,
        fallback: submittedAtMs + BLITE_FALLBACK_LATCH_MS,
        inference: submittedAtMs + BLITE_INFERENCE_DEADLINE_MS,
        ux: submittedAtMs + BLITE_UX_DEADLINE_MS,
    });
}

/**
 * Chooses the cohort before provider work. Callers persist this result with the preflight;
 * subsequent work must use the stored bit rather than re-reading the environment.
 */
export function selectBliteCohort(
    preflightId: string,
    env: Record<string, string | undefined> = process.env,
    options: BliteCohortSelectionOptions = {},
): boolean {
    if (env.PRECHECKOUT_BLITE_ENABLED !== 'true') return false;
    if (options.signedTestEntitlement === true) return true;

    const percent = rolloutPercent(env);
    return percent > 0 && preflightBucket(preflightId) < percent;
}
