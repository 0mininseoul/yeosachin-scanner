import { createHash } from 'node:crypto';

export const ANALYSIS_V2_BOOTSTRAP_JOB_KEY = 'coordinator:bootstrap' as const;
export const ANALYSIS_V2_RELATIONSHIPS_JOB_KEY = 'track:relationships:collect' as const;
export const ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY = 'track:target-evidence:collect' as const;
export const ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY = 'coordinator:join:primary-evidence' as const;

const JOB_INPUT_HASH_DOMAIN = 'analysis-v2-job-input-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AnalysisV2FoundationJobKey =
    | typeof ANALYSIS_V2_BOOTSTRAP_JOB_KEY
    | typeof ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
    | typeof ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
    | typeof ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY;

export interface AnalysisV2SuccessorJob {
    jobKey: AnalysisV2FoundationJobKey;
    track: 'coordinator' | 'relationships' | 'target_evidence';
    kind: 'coordinator' | 'collection';
    batch: number | null;
    inputHash: string;
    requiredJobKeys: readonly AnalysisV2FoundationJobKey[];
}

function assertRequestId(requestId: string): void {
    if (!UUID_PATTERN.test(requestId)) {
        throw new Error('ANALYSIS_V2_COORDINATOR_ERROR: invalid request id.');
    }
}

export function analysisV2JobInputHash(
    requestId: string,
    jobKey: AnalysisV2FoundationJobKey
): string {
    assertRequestId(requestId);
    return createHash('sha256')
        .update(`${JOB_INPUT_HASH_DOMAIN}\n${requestId.toLowerCase()}\n${jobKey}`, 'utf8')
        .digest('hex');
}

function successor(
    requestId: string,
    jobKey: AnalysisV2FoundationJobKey,
    track: AnalysisV2SuccessorJob['track'],
    kind: AnalysisV2SuccessorJob['kind'],
    requiredJobKeys: readonly AnalysisV2FoundationJobKey[] = []
): AnalysisV2SuccessorJob {
    return Object.freeze({
        jobKey,
        track,
        kind,
        batch: null,
        inputHash: analysisV2JobInputHash(requestId, jobKey),
        requiredJobKeys: Object.freeze([...requiredJobKeys]),
    });
}

/**
 * Returns only the durable edges owned by the Phase C foundation. Later phases extend the
 * primary join instead of changing these two parallel entry tracks.
 */
export function planAnalysisV2Successors(
    requestId: string,
    completedJobKey: AnalysisV2FoundationJobKey
): readonly AnalysisV2SuccessorJob[] {
    assertRequestId(requestId);
    if (completedJobKey === ANALYSIS_V2_BOOTSTRAP_JOB_KEY) {
        return Object.freeze([
            successor(
                requestId,
                ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
                'relationships',
                'collection'
            ),
            successor(
                requestId,
                ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
                'target_evidence',
                'collection'
            ),
        ]);
    }
    if (
        completedJobKey === ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
        || completedJobKey === ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
    ) {
        return Object.freeze([
            successor(
                requestId,
                ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
                'coordinator',
                'coordinator',
                [
                    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
                    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
                ]
            ),
        ]);
    }
    if (completedJobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY) {
        return Object.freeze([]);
    }
    const exhaustive: never = completedJobKey;
    throw new Error(`ANALYSIS_V2_COORDINATOR_ERROR: unsupported job ${exhaustive}.`);
}

export function isAnalysisV2CoordinatorJob(
    jobKey: string
): jobKey is typeof ANALYSIS_V2_BOOTSTRAP_JOB_KEY | typeof ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY {
    return jobKey === ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        || jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY;
}
