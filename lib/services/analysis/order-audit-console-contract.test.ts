import { describe, expect, it } from 'vitest';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const hash = 'a'.repeat(64);
const timestamp = '2026-09-05T00:00:00.000Z';

const summary = {
    requestId,
    version: 1,
    bundleHash: hash,
    previousVersionHash: null,
    sourceSetHash: hash,
    status: 'complete',
    completeness: 'complete',
    gapCodes: [],
    pipelineVersion: 'v2',
    pipelinePolicy: {},
    riskPolicyVersion: 'risk-v1',
    aiPolicyVersion: 'ai-v1',
    schedulerPolicyVersion: 'scheduler-v1',
    planId: 'basic',
    accessMode: 'production',
    orderId: null,
    targetInstagramId: 'target.account',
    targetProfileAvailable: true,
    targetPostsAvailable: true,
    targetPostCount: 12,
    followers: { declared: 100, collected: 100 },
    following: { declared: 80, collected: 80 },
    mutuals: {
        total: 10,
        public: 8,
        private: 2,
        screened: 8,
        declared: 10,
        collected: 10,
        listHash: hash,
        keyCoverage: { expected: [], observed: [], complete: true, missing: [], extra: [] },
    },
    gender: { initialResolved: 8, finalResolved: 7 },
    risk: { declared: 7, collected: 7 },
    interactions: {
        declared: 5,
        collected: 5,
        targetLikes: { declared: 3, collected: 3 },
        targetComments: { declared: 2, collected: 2 },
        candidateLikes: { declared: null, collected: null, evidenceCollected: null },
        tags: { declared: null, collected: null },
        mentions: { declared: null, collected: null },
    },
    providerRuns: [],
    stageStatus: {
        relationships: true,
        targetEvidence: true,
        candidateFeatures: true,
        riskScores: true,
        finalized: true,
        cost: 'complete',
        costSourceHash: hash,
        candidateKeyCoverage: { expected: [], observed: [], missing: [], extra: [], complete: true },
        targetLikes: true,
        targetComments: true,
        candidateLikes: false,
        tags: false,
        mentions: false,
        retainedEvidenceSourceSetHash: hash,
    },
    retention: {
        state: 'retained',
        queueStatus: 'completed',
        version: 1,
        assembledAt: timestamp,
        purgeFencedAt: null,
        purgeFenceReason: null,
        purgedAt: timestamp,
        queueUpdatedAt: timestamp,
    },
    assembledAt: timestamp,
    cost: {
        currency: 'USD',
        status: 'complete',
        knownUsd: 0.12,
        conservativeUsd: 0.14,
        totalKnownCostUsd: 0.12,
        totalConservativeCostUsd: 0.14,
        usageUnknown: false,
        missingSourceCodes: [],
        provenance: {},
    },
    usageUnknown: false,
};

describe('operator console audit payload contracts', () => {
    it('exports strict summary and section row schemas for real RPC payloads', async () => {
        const contractModule = await import('./order-audit-bundle');
        const summarySchema = contractModule.orderAuditSummarySchema;
        const rowSchemas = [
            contractModule.mutualAuditRowSchema,
            contractModule.genderAuditRowSchema,
            contractModule.interactionAuditRowSchema,
            contractModule.riskAuditRowSchema,
        ];

        expect(summarySchema).toBeDefined();
        expect(rowSchemas.every(Boolean)).toBe(true);
        expect(summarySchema.safeParse(summary).success).toBe(true);
        expect(summarySchema.safeParse({ ...summary, unexpected: true }).success).toBe(false);
    });

    it('keeps independently paginated section payloads typed and rejects row shape drift', async () => {
        const contractModule = await import('./order-audit-bundle');
        const payloadSchema = contractModule.orderAuditLoadPayloadSchema;
        const mutual = {
            candidateId: 'candidate:1',
            username: 'candidate.one',
            mutualOrdinal: 1,
            followingOrdinal: 2,
            isPrivate: false,
            isVerified: false,
            profileAvailable: true,
            profileImageAvailable: true,
            profileFailureCode: null,
            finalInclusionState: 'included',
            completeness: 'complete',
        };

        expect(payloadSchema.safeParse({
            summary,
            section: 'mutuals',
            rows: [mutual],
            total: 1,
            nextCursor: null,
        }).success).toBe(true);
        expect(payloadSchema.safeParse({
            summary,
            section: 'mutuals',
            rows: [{ ...mutual, leakedToken: 'no' }],
            total: 1,
            nextCursor: null,
        }).success).toBe(false);
    });
});
