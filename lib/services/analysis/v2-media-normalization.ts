import type { SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import {
    classifyAnalysisImagePreparationError,
    type AnalysisImagePreparationFailureDisposition,
    type AnalysisImagePreparationFailureReason,
} from '@/lib/services/ai/image-preprocessing';
import {
    aiStagePolicySupports,
    assertSupportedAiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import type { NormalizedAiMediaSelection } from '@/lib/services/ai/v2-staged-analysis';

export const ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS = 2;

export interface AnalysisV2ProfileMediaCoverage {
    selectedCount: number;
    normalizedCount: number;
    failures: readonly Readonly<{
        selectionId: string;
        reason: AnalysisImagePreparationFailureReason;
        disposition: AnalysisImagePreparationFailureDisposition;
    }>[];
}

export function isAnalysisV2PartialMediaCoverageAllowed(
    coverage: AnalysisV2ProfileMediaCoverage,
): boolean {
    return coverage.normalizedCount >= 1
        && coverage.failures.length * 5 <= coverage.selectedCount;
}

export class AnalysisV2TransientMediaPreparationError extends Error {
    constructor() {
        super('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');
        this.name = 'AnalysisV2TransientMediaPreparationError';
    }
}

function supportsPartialMediaCoverage(version: string): boolean {
    try {
        return aiStagePolicySupports(
            assertSupportedAiStagePolicyVersion(version),
            'partialMediaCoverage',
        );
    } catch {
        return false;
    }
}

export async function normalizeAnalysisV2MediaSelections(
    selected: readonly SelectedAnalysisMedia[],
    normalizeMedia: (media: SelectedAnalysisMedia) => Promise<Buffer>,
    aiStagePolicyVersion: string = 'ai-stage-policy-v2.6',
): Promise<Readonly<{
    media: NormalizedAiMediaSelection[];
    bytes: Map<string, Buffer>;
    coverage: AnalysisV2ProfileMediaCoverage;
}>> {
    const prepared = await Promise.all(selected.map(async item => {
        for (
            let attempt = 1;
            attempt <= ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS;
            attempt++
        ) {
            try {
                return {
                    status: 'success' as const,
                    item,
                    bytes: await normalizeMedia(item),
                };
            } catch (error) {
                const failure = classifyAnalysisImagePreparationError(error, 'download');
                if (
                    failure.disposition === 'transient'
                    && attempt < ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS
                ) continue;
                return {
                    status: 'failure' as const,
                    item,
                    failure: {
                        selectionId: item.selectionId,
                        reason: failure.reason,
                        disposition: failure.disposition,
                    },
                };
            }
        }
        throw new Error('ANALYSIS_V2_MEDIA_PREPARATION_ATTEMPT_DRIFT');
    }));
    const successful = prepared.filter(item => item.status === 'success');
    const failures = prepared.flatMap(item => (
        item.status === 'failure' ? [item.failure] : []
    ));
    if (
        !supportsPartialMediaCoverage(aiStagePolicyVersion)
        && failures.some(failure => failure.disposition === 'transient')
    ) {
        const failureReasons = failures.reduce<Record<string, number>>((counts, failure) => {
            counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
            return counts;
        }, {});
        console.warn('Analysis V2 media preparation has transient failures', {
            selectedCount: selected.length,
            failureReasons,
        });
        throw new AnalysisV2TransientMediaPreparationError();
    }
    const media: NormalizedAiMediaSelection[] = successful.map(({ item, bytes }) => ({
        selectionId: item.selectionId,
        kind: item.role === 'profile' ? 'profile' : 'feed',
        normalizedJpegBase64: bytes.toString('base64'),
        ...(item.postId ? { postId: item.postId } : {}),
    }));
    return {
        media,
        bytes: new Map(successful.map(item => [item.item.selectionId, item.bytes])),
        coverage: Object.freeze({
            selectedCount: selected.length,
            normalizedCount: successful.length,
            failures: Object.freeze(failures),
        }),
    };
}
