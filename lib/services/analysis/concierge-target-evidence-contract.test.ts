import { describe, expect, it } from 'vitest';
import { targetEvidenceFromStepData } from '../../../scripts/correct-concierge-basic-result';

function retainedEvidence() {
    return Array.from({ length: 95 }, (_, index) => ({
        actorUsername: `candidate.${index + 1}`,
        postId: `post-${index + 1}`,
        signal: 'target_post_like' as const,
        sourceInteractionId: `interaction-${index + 1}`,
        occurredAt: null,
        content: null,
    }));
}

describe('concierge target evidence persistence contract', () => {
    it('fails closed when terminal V2 evidence manifests have been deleted', () => {
        expect(() => targetEvidenceFromStepData({
            targetPosts: [{ id: 'post-1' }],
        })).toThrow('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    });

    it('accepts only the retained, complete source evidence snapshot', () => {
        const rows = retainedEvidence();
        expect(targetEvidenceFromStepData({ targetEvidence: rows })).toEqual(rows);
        expect(() => targetEvidenceFromStepData({ targetEvidence: rows.slice(0, 94) }))
            .toThrow('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    });
});
