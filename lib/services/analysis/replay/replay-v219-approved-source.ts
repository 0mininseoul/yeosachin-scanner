import { createHash, timingSafeEqual } from 'node:crypto';
import type { AnalysisV2ReplayBundle } from './replay-bundle';

const APPROVED_SOURCE_SCHEMA =
    'analysis-v2-replay-v219-approved-source-v1';

/**
 * Immutable, reviewed identities of the retained source pair. The hashes bind
 * every source identity, media byte, resolver selection, coverage record, and
 * evidence row while deliberately excluding only artifact TTL and evaluation
 * policy so the approved V2.17 source can be resealed for V2.19.
 */
export const V219_APPROVED_REPLAY_SOURCE_MANIFEST = Object.freeze({
    schema: APPROVED_SOURCE_SCHEMA,
    manifestId: 'retained-v217-v212-source-20260729-v1',
    parentSourceContentSha256:
        'df0ef11261da53401a856d392676757d7d853bc559214a630e7d13899caf934a',
    witnessSourceContentSha256:
        'b9b949ef575baf6f7a692a2562b1e46876cba3c39ee8056ea3f8edaf018845da',
});

export function v219ReplaySourceContentSha256(
    bundle: AnalysisV2ReplayBundle,
): string {
    const capture = bundle.capture;
    const canonical = {
        schema: APPROVED_SOURCE_SCHEMA,
        schemaVersion: bundle.schemaVersion,
        capture: {
            ...('scope' in capture ? {
                scope: capture.scope,
                notExact: capture.notExact,
                fullE2eEvidence: capture.fullE2eEvidence,
                noMediaSubstitution: capture.noMediaSubstitution,
            } : {}),
            requestFingerprint: capture.requestFingerprint,
            sourceLineage: capture.sourceLineage,
            ...('partial' in capture
                ? { partial: capture.partial }
                : {}),
        },
        profiles: bundle.profiles,
        evidence: bundle.evidence,
    };
    return createHash('sha256')
        .update(JSON.stringify(canonical))
        .digest('hex');
}

export function v219ReplaySourceContentMatches(
    bundle: AnalysisV2ReplayBundle,
    expectedSha256: string,
): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) return false;
    const observed = Buffer.from(
        v219ReplaySourceContentSha256(bundle),
        'hex',
    );
    const expected = Buffer.from(expectedSha256, 'hex');
    return timingSafeEqual(observed, expected);
}
