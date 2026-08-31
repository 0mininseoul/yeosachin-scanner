import { randomUUID } from 'node:crypto';
import {
    analysisProviderAdmissionStore,
    type AnalysisProviderAdmissionRecoveryCursor,
    type AnalysisProviderAdmissionRecoveryCandidate,
    type AnalysisProviderAdmissionStore,
} from './provider-admission-store';

export const ANALYSIS_PROVIDER_ADMISSION_RECOVERY_MAX = 64;
/**
 * Keep each keyset page small enough that unresolved provider runs do not
 * monopolize a maintenance transaction. The bounded pass below walks every
 * available page up to the hard work limit.
 */
export const ANALYSIS_PROVIDER_ADMISSION_RECOVERY_PAGE_SIZE = 16;
export const ANALYSIS_PROVIDER_ADMISSION_RECOVERY_CONCURRENCY = 8;

export interface AnalysisProviderAdmissionRecoverySummary {
    scanned: number;
    recovered: number;
    resolved: number;
    skipped: number;
    failed: number;
    hasMore: boolean;
}

type RecoveryCandidateHandler = (
    candidate: AnalysisProviderAdmissionRecoveryCandidate,
) => Promise<{ recovered: boolean; resolved: boolean }>;

function assertBatchOptions(limit: number, concurrency: number): void {
    if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > ANALYSIS_PROVIDER_ADMISSION_RECOVERY_MAX
    ) {
        throw new Error('ANALYSIS_PROVIDER_ADMISSION_RECOVERY_ERROR: invalid limit.');
    }
    if (
        !Number.isSafeInteger(concurrency)
        || concurrency < 1
        || concurrency > ANALYSIS_PROVIDER_ADMISSION_RECOVERY_CONCURRENCY
    ) {
        throw new Error('ANALYSIS_PROVIDER_ADMISSION_RECOVERY_ERROR: invalid concurrency.');
    }
}

async function recoverCandidate(
    candidate: AnalysisProviderAdmissionRecoveryCandidate,
    handler: RecoveryCandidateHandler,
): Promise<{
    outcome: 'resolved' | 'skipped' | 'failed';
    recovered: boolean;
}> {
    try {
        const result = await handler(candidate);
        return {
            outcome: result.resolved ? 'resolved' : 'skipped',
            recovered: result.recovered,
        };
    } catch {
        // Recovery is retried by the next bounded maintenance pass.  Do not
        // loop here: concurrent lease renewal or another worker may own it.
        return { outcome: 'failed', recovered: false };
    }
}

export async function recoverExpiredAnalysisProviderAdmissions(
    dependencies: {
        store?: AnalysisProviderAdmissionStore;
        limit?: number;
        concurrency?: number;
        randomUuid?: () => string;
    } = {},
): Promise<AnalysisProviderAdmissionRecoverySummary> {
    const store = dependencies.store ?? analysisProviderAdmissionStore;
    const limit = dependencies.limit ?? ANALYSIS_PROVIDER_ADMISSION_RECOVERY_PAGE_SIZE;
    const concurrency = dependencies.concurrency
        ?? ANALYSIS_PROVIDER_ADMISSION_RECOVERY_CONCURRENCY;
    const nextRecoveryToken = dependencies.randomUuid ?? randomUUID;
    assertBatchOptions(limit, concurrency);

    if (!store.listExpired) {
        throw new Error('ANALYSIS_PROVIDER_ADMISSION_RECOVERY_ERROR: expiry listing unavailable.');
    }
    const summary: AnalysisProviderAdmissionRecoverySummary = {
        scanned: 0,
        recovered: 0,
        resolved: 0,
        skipped: 0,
        failed: 0,
        hasMore: false,
    };
    let cursor: AnalysisProviderAdmissionRecoveryCursor | undefined;
    let pageHasMore = false;
    do {
        const remaining = ANALYSIS_PROVIDER_ADMISSION_RECOVERY_MAX - summary.scanned;
        if (remaining <= 0) break;
        const page = await store.listExpired({
            limit: Math.min(limit, remaining),
            ...(cursor ? { cursor } : {}),
        });
        // Keep the page size and continuation bit authoritative at the store
        // boundary. In particular, do not infer "has more" from a default
        // that may differ from the SQL function's limit.
        const candidates = page.candidates.slice(0, remaining);
        if (page.hasMore && !page.nextCursor) {
            // Custom stores used by tests and future adapters must obey the
            // same fail-closed invariant as the Zod-validated Supabase store.
            // Never turn an un-followable continuation into a false drain.
            throw new Error(
                'ANALYSIS_PROVIDER_ADMISSION_RECOVERY_ERROR: missing continuation cursor.',
            );
        }
        summary.scanned += candidates.length;
        pageHasMore = page.hasMore;
        let candidateCursor = 0;
        const worker = async () => {
            while (candidateCursor < candidates.length) {
                const candidate = candidates[candidateCursor++];
                const outcome = await recoverCandidate(candidate, async current => {
                    const recovered = await store.recoverExpired({
                        admissionId: current.admissionId,
                        recoveryToken: nextRecoveryToken(),
                    });
                    if (!recovered) return { recovered: false, resolved: false };
                    const resolved = await store.resolve({
                        admissionId: current.admissionId,
                        resolutionToken: nextRecoveryToken(),
                    });
                    return { recovered: true, resolved };
                });
                summary[outcome.outcome] += 1;
                if (outcome.recovered) summary.recovered += 1;
            }
        };
        await Promise.all(
            Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
        );
        if (!pageHasMore || candidates.length === 0) break;
        cursor = page.nextCursor;
    } while (summary.scanned < ANALYSIS_PROVIDER_ADMISSION_RECOVERY_MAX);
    // If the bounded work budget stopped before the keyset was exhausted, the
    // next maintenance pass must continue rather than reporting a false drain.
    summary.hasMore = pageHasMore && summary.scanned >= ANALYSIS_PROVIDER_ADMISSION_RECOVERY_MAX;
    return Object.freeze(summary);
}
