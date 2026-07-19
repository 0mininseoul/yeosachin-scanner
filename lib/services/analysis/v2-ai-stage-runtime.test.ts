import { describe, expect, it, vi } from 'vitest';
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: vi.fn() },
}));
import {
    createDurableAnalysisV2AiStageRuntime,
    type AnalysisV2AiStageRuntimeDependencies,
} from './v2-ai-stage-runtime';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow
const fence = {
    requestId,
    claimToken,
    jobKey: 'track:profile-ai:batch:0',
    aiStagePolicyVersion: AI_STAGE_POLICY_VERSION,
};

function cachedAuditFactory(input: {
    gender?: unknown;
    privateNames?: unknown;
}) {
    const beforeAttempt = vi.fn();
    const attemptTelemetry = vi.fn();
    const createAudit: NonNullable<AnalysisV2AiStageRuntimeDependencies['createAudit']> =
        options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            async prepare() {
                const raw = options.resultIdentity.stage === 'genderTriage'
                    ? input.gender
                    : input.privateNames;
                return {
                    result: options.resultSchema.parse(raw),
                    source: 'request',
                    startingAttempt: 1,
                };
            },
            onBeforeAttempt: beforeAttempt,
            onAttemptTelemetry: attemptTelemetry,
        });
    return { createAudit, beforeAttempt, attemptTelemetry };
}

describe('durable V2 AI stage runtime', () => {
    it('rejects every cross-version job before creating an audit or calling Gemini', async () => {
        const dependencies = {
            createAudit: vi.fn(),
            runGender: vi.fn(),
            runFeatures: vi.fn(),
            runPrivateNames: vi.fn(),
            runPartnerSafety: vi.fn(),
            runNarrative: vi.fn(),
        } satisfies AnalysisV2AiStageRuntimeDependencies;
        const runtime = createDurableAnalysisV2AiStageRuntime(dependencies);
        const staleFence = { ...fence, aiStagePolicyVersion: 'ai-stage-policy-v2.3' };
        const invocations = [
            () => runtime.gender({ media: [] }, staleFence),
            () => runtime.features({} as never, staleFence),
            () => runtime.privateNames([], staleFence),
            () => runtime.partnerSafety({} as never, staleFence),
            () => runtime.narrative({} as never, staleFence),
        ];

        for (const invoke of invocations) {
            await expect(invoke()).rejects.toThrow('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
        }

        for (const dependency of Object.values(dependencies)) {
            expect(dependency).not.toHaveBeenCalled();
        }
    });

    it('replays the same cached gender operation without opening another provider attempt', async () => {
        const cached = cachedAuditFactory({
            gender: {
                inferredGender: 'male',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
            },
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: cached.createAudit,
        });
        const input = {
            media: [{
                selectionId: 'profile:owner',
                kind: 'profile' as const,
                normalizedJpegBase64: '/9j/2Q==',
            }, {
                selectionId: 'post:owner:thumbnail',
                kind: 'feed' as const,
                normalizedJpegBase64: '/9j/2g==',
                postId: 'owner-post',
            }],
        };

        const first = await runtime.gender(input, fence);
        const replay = await runtime.gender(input, fence);

        expect(first.result.routingDecision).toBe('exclude_high_confidence_male');
        expect(replay.operationKey).toBe(first.operationKey);
        expect(replay.resultHash).toBe(first.resultHash);
        expect(cached.beforeAttempt).not.toHaveBeenCalled();
        expect(cached.attemptTelemetry).not.toHaveBeenCalled();
    });

    it('wraps private-name arrays in a durable object envelope without losing rows', async () => {
        const results = [
            { id: 'candidate:one', femaleScore: 0.9, isName: true, confidence: 0.8 },
            { id: 'candidate:two', femaleScore: 0.5, isName: false, confidence: 0 },
        ];
        const cached = cachedAuditFactory({ privateNames: { results } });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: cached.createAudit,
        });

        const analyzed = await runtime.privateNames([
            { id: 'candidate:one', username: 'woman.one', fullName: '하나' },
            { id: 'candidate:two', username: 'brand.two', fullName: '브랜드' },
        ], { ...fence, jobKey: 'track:private-names:batch:0' });

        expect(analyzed.results).toEqual(results);
        expect(analyzed.source).toBe('checkpoint');
        expect(analyzed.operationKey).toMatch(/^private-account-name:[a-f0-9]{64}$/);
        expect(analyzed.resultHash).toMatch(/^[a-f0-9]{64}$/);
        expect(cached.beforeAttempt).not.toHaveBeenCalled();
    });
});
