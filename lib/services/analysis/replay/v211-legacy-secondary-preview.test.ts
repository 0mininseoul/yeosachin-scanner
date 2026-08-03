import { describe, expect, it, vi } from 'vitest';
import { applyV211LegacySecondaryPreview, createV211LegacySecondaryPreview, verifyV211LegacySecondaryPreview } from './v211-legacy-secondary-preview';
import type { AnalysisV2ReplayBundle } from './replay-bundle';

const requestId = '10000000-0000-4000-8000-000000000001';
const bundle = {
    schemaVersion: 1,
    createdAt: '2026-08-03T00:00:00.000Z', expiresAt: '2026-08-04T00:00:00.000Z',
    capture: {
        requestFingerprint: 'a'.repeat(64),
        sourceLineage: { selectedPlanId: 'standard', policyVersions: { pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.10', scheduler: 'ai-scheduler-v1' } },
        evaluationPolicy: { capability: 'test-entitlement-standard-v210-risk-v25-scheduler-v1-to-ai-v211-legacy-secondary', aiStage: 'ai-stage-policy-v2.11' },
        legacySecondary: { requestId, sourceFingerprint: 'b'.repeat(64), currentRevision: 0, originalFemaleRows: [{
            candidateId: 'candidate:one', sortOrdinal: 1, instagramId: 'female_one', fullName: null,
            profileImageUrl: null, bio: null, displayScore: 7.5, riskBand: 'high_risk', featuredRank: 1,
            recentMutualRank: null, analysisDepth: 'narrative', oneLineOverview: '기존 요약', highRiskNarrative: ['첫 문장', '둘째 문장'],
        }] },
    },
    profiles: [{ ordinal: 1, isPrivate: false, username: 'female_one', fullName: null, hasProfileImage: true, bio: null, media: [{ selectionId: 'm1', kind: 'profile', caption: null, jpegBase64: '/9j/2Q==' }], triageSelectionIds: ['m1'], featureSelectionIds: ['m1'], resolverSelectionIds: ['m1'], captions: [], coverage: { selectedCount: 1, normalizedCount: 1, failures: [] } }],
    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
} satisfies AnalysisV2ReplayBundle;

describe('v2.11 legacy-secondary preview', () => {
    it('merges only retained result metadata and seals the apply payload', () => {
        const preview = createV211LegacySecondaryPreview({ requestId, bundle, semanticInputFingerprint: 'c'.repeat(64), accountOutputs: [{ ordinal: 1, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'v2.11 요약' }] });
        expect(preview.counts).toEqual({ male: 0, female: 1, unknown: 0 });
        expect(preview.femaleRows[0]).toMatchObject({ candidateId: 'candidate:one', oneLineOverview: 'v2.11 요약', highRiskNarrative: ['첫 문장', '둘째 문장'] });
        expect(verifyV211LegacySecondaryPreview(preview)).toEqual(preview);
    });

    it('rejects a newly classified female without immutable score metadata', () => {
        const invalid = { ...bundle, profiles: [{ ...bundle.profiles[0], username: 'new_female' }] } as AnalysisV2ReplayBundle;
        expect(() => createV211LegacySecondaryPreview({ requestId, bundle: invalid, semanticInputFingerprint: 'c'.repeat(64), accountOutputs: [{ ordinal: 1, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'new' }] })).toThrow('ANALYSIS_V2_V211_PREVIEW_NEW_FEMALE_METADATA_UNAVAILABLE');
    });

    it('binds the explicit request to the sealed capture metadata and rejects malformed previews', () => {
        expect(() => createV211LegacySecondaryPreview({ requestId: '20000000-0000-4000-8000-000000000001', bundle, semanticInputFingerprint: 'c'.repeat(64), accountOutputs: [{ ordinal: 1, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'v2.11 요약' }] })).toThrow('ANALYSIS_V2_V211_PREVIEW_SCOPE_INVALID');
        const preview = createV211LegacySecondaryPreview({ requestId, bundle, semanticInputFingerprint: 'c'.repeat(64), accountOutputs: [{ ordinal: 1, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'v2.11 요약' }] });
        expect(() => verifyV211LegacySecondaryPreview({ ...preview, counts: { ...preview.counts, female: 2 } })).toThrow('ANALYSIS_V2_V211_PREVIEW_INVALID');
    });

    it('passes only the sealed preview fields to the atomic revision RPC', async () => {
        const preview = createV211LegacySecondaryPreview({ requestId, bundle, semanticInputFingerprint: 'c'.repeat(64), accountOutputs: [{ ordinal: 1, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: 'v2.11 요약' }] });
        const rpc = async (_name: string, params: Record<string, unknown>) => ({ data: params, error: null });
        await expect(applyV211LegacySecondaryPreview({ rpc } as never, preview)).resolves.toMatchObject({
            p_expected_current_revision: 0, p_female_count: 1, p_source_fingerprint: 'b'.repeat(64),
        });
    });

    it('text-only preview preserves canonical counts and every original row while merging only matching feature overviews', async () => {
        const textOnly = {
            ...bundle,
            capture: {
                ...bundle.capture,
                evaluationPolicy: {
                    capability: 'test-entitlement-standard-v210-risk-v25-scheduler-v1-to-ai-v211-legacy-secondary-account-text-only',
                    aiStage: 'ai-stage-policy-v2.11',
                },
                legacySecondary: {
                    ...bundle.capture.legacySecondary,
                    textOnly: { canonicalCounts: { male: 9, female: 1, unknown: 4 } },
                },
            },
            profiles: [
                { ...bundle.profiles[0], ordinal: 1, username: 'no_media', media: [], triageSelectionIds: [], featureSelectionIds: [], resolverSelectionIds: [], captions: [], coverage: { selectedCount: 0, normalizedCount: 0, failures: [] } },
                { ...bundle.profiles[0], ordinal: 2 },
            ],
        } satisfies AnalysisV2ReplayBundle;
        const preview = createV211LegacySecondaryPreview({
            requestId, bundle: textOnly, semanticInputFingerprint: 'c'.repeat(64),
            accountOutputs: [{ ordinal: 2, finalClassification: 'verified_female', classificationSource: 'feature', featureOverview: '새 v2.11 요약' }],
        });
        expect(preview.textOnly).toBe(true);
        expect(preview.counts).toEqual({ male: 9, female: 1, unknown: 4 });
        expect(preview.femaleRows).toEqual([expect.objectContaining({
            candidateId: 'candidate:one', sortOrdinal: 1, displayScore: 7.5,
            highRiskNarrative: ['첫 문장', '둘째 문장'], oneLineOverview: '새 v2.11 요약',
        })]);
        const rpc = vi.fn(async (_name: string, params: Record<string, unknown>) => ({ data: params, error: null }));
        await applyV211LegacySecondaryPreview({ rpc } as never, preview);
        expect(rpc).toHaveBeenCalledWith(
            'apply_analysis_v2_v211_legacy_secondary_text_only_revision',
            expect.objectContaining({ p_male_count: 9, p_female_count: 1, p_unknown_count: 4 }),
        );
    });
});
