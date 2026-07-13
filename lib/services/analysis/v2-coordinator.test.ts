import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
    isAnalysisV2CoordinatorJob,
    planAnalysisV2Successors,
} from './v2-coordinator';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

describe('analysis V2 coordinator foundation', () => {
    it('fans bootstrap into the two independent evidence tracks', () => {
        const jobs = planAnalysisV2Successors(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY);
        expect(jobs.map(job => job.jobKey)).toEqual([
            ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
        ]);
        expect(jobs.every(job => job.requiredJobKeys.length === 0)).toBe(true);
        expect(jobs.every(job => /^[a-f0-9]{64}$/.test(job.inputHash))).toBe(true);
    });

    it('gives both predecessors the same dependency-gated join candidate', () => {
        const fromRelationships = planAnalysisV2Successors(
            requestId,
            ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
        );
        const fromTargetEvidence = planAnalysisV2Successors(
            requestId,
            ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
        );
        expect(fromRelationships).toEqual(fromTargetEvidence);
        expect(fromRelationships[0]).toMatchObject({
            jobKey: ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
            requiredJobKeys: [
                ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
                ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
            ],
        });
    });

    it('does not invent later-phase work after the foundation join', () => {
        expect(planAnalysisV2Successors(requestId, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY))
            .toEqual([]);
    });

    it('derives stable PII-free hashes and validates coordinator keys', () => {
        expect(analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY))
            .toBe(analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY));
        expect(() => analysisV2JobInputHash('not-a-uuid', ANALYSIS_V2_BOOTSTRAP_JOB_KEY))
            .toThrow('invalid request id');
        expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_BOOTSTRAP_JOB_KEY)).toBe(true);
        expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY)).toBe(true);
        expect(isAnalysisV2CoordinatorJob(ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)).toBe(false);
    });
});
