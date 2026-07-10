import { isAnalysisRequestStale } from './failure';
import type { AnalysisRequestLease } from './request-lease';

interface StaleAnalysisCandidate {
    id: string;
    status: 'pending' | 'processing';
    currentStep: string;
    createdAt: string;
    idempotencyKey: string | null;
}

interface StaleAnalysisCleanupDependencies {
    loadActiveRequest(): Promise<unknown>;
    acquireCleanupLease(candidate: StaleAnalysisCandidate): Promise<AnalysisRequestLease | null>;
    releaseCleanupLease(lease: AnalysisRequestLease): Promise<void>;
    abortProviderRuns(candidate: StaleAnalysisCandidate): Promise<void>;
    failRequest(candidate: StaleAnalysisCandidate): Promise<boolean>;
    nowMs?: number;
}

function parseCandidate(value: unknown): StaleAnalysisCandidate | null {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: active analysis cleanup row is invalid.');
    }
    const row = value as Record<string, unknown>;
    const currentStep = row.current_step ?? 'pending';
    if (
        typeof row.id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
        || (row.status !== 'pending' && row.status !== 'processing')
        || typeof currentStep !== 'string'
        || currentStep.length === 0
        || currentStep.length > 50
        || typeof row.created_at !== 'string'
        || (row.idempotency_key !== null && typeof row.idempotency_key !== 'string')
    ) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: active analysis cleanup row is invalid.');
    }
    return {
        id: row.id,
        status: row.status,
        currentStep,
        createdAt: row.created_at,
        idempotencyKey: row.idempotency_key as string | null,
    };
}

/**
 * Reclaims a stale request only after every known paid Actor is terminal and
 * reconciled. A same-key retry must remain an idempotent replay.
 */
export async function expireStaleAnalysisBeforeStart(
    incomingIdempotencyKey: string | undefined,
    dependencies: StaleAnalysisCleanupDependencies
): Promise<boolean> {
    const candidate = parseCandidate(await dependencies.loadActiveRequest());
    if (
        !candidate
        || (
            incomingIdempotencyKey !== undefined
            && candidate.idempotencyKey === incomingIdempotencyKey
        )
        || !isAnalysisRequestStale(candidate.createdAt, dependencies.nowMs)
    ) {
        return false;
    }

    const lease = await dependencies.acquireCleanupLease(candidate);
    if (!lease) return false;

    let terminalized = false;
    try {
        await dependencies.abortProviderRuns(candidate);
        terminalized = await dependencies.failRequest(candidate);
        return terminalized;
    } finally {
        // The failure RPC clears its own lease atomically. On any aborted cleanup,
        // release this token so a healthy worker can continue immediately.
        if (!terminalized) {
            await dependencies.releaseCleanupLease(lease);
        }
    }
}
