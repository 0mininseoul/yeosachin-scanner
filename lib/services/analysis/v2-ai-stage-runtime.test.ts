import { describe, expect, it, vi } from 'vitest';
import {
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_VERSION,
} from '@/lib/services/ai/stage-policy';

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: vi.fn() },
}));
import {
    createDurableAnalysisV2AiStageRuntime,
    type AnalysisV2AiStageRuntimeDependencies,
} from './v2-ai-stage-runtime';
import {
    AnalysisV2AiResultRecoveredCutoffError,
    AnalysisV2AiResultRecoveryPendingError,
} from './v2-ai-result-store';

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
            runGenderResolution: vi.fn(),
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
        expect(() => runtime.startGenderResolution({ media: [] }, staleFence))
            .toThrow('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');

        for (const dependency of Object.values(dependencies)) {
            expect(dependency).not.toHaveBeenCalled();
        }
    });

    it('starts a v2.7 resolver and exposes only an audited ready result', async () => {
        const onCutoff = vi.fn().mockResolvedValue(undefined);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: onCutoff,
        }));
        const runGenderResolution = vi.fn().mockResolvedValue({
            assessment: {
                inferredGender: 'female',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
            },
            analyzedSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({
            media: [{
                selectionId: 'profile:owner',
                kind: 'profile',
                normalizedJpegBase64: '/9j/2Q==',
            }, {
                selectionId: 'post:owner:thumbnail',
                kind: 'feed',
                normalizedJpegBase64: '/9j/2g==',
                postId: 'owner-post',
            }],
        }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        expect(handle.peek()).toEqual({ status: 'pending' });
        await handle.completion;
        expect(handle.peek()).toMatchObject({
            status: 'ready',
            value: {
                result: {
                    assessment: { inferredGender: 'female' },
                },
                operationKey: expect.stringMatching(/^gender-resolution:[a-f0-9]{64}$/),
                resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                source: 'checkpoint',
            },
        });
        expect(runGenderResolution).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(onCutoff).not.toHaveBeenCalled();
    });

    it('keeps the resolver available for v2.8 instead of coupling it to the old latest label', async () => {
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn(),
        }));
        const runGenderResolution = vi.fn().mockResolvedValue({
            assessment: {
                inferredGender: 'unknown',
                confidence: 'low',
                ownerConsistency: 'not_visible',
                evidenceSelectionIds: [],
            },
            analyzedSelectionIds: [],
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
        });
        await handle.completion;
        expect(handle.peek()).toMatchObject({ status: 'ready' });
        expect(runGenderResolution).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION }),
        );
    });

    it('cuts off a pending resolver without waiting for the provider promise', async () => {
        const onCutoff = vi.fn().mockResolvedValue(undefined);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: onCutoff,
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await handle.cutoff();

        expect(handle.peek()).toEqual({ status: 'cutoff' });
        expect(onCutoff).toHaveBeenCalledOnce();
        await handle.completion;
    });

    it.each([
        {
            label: 'never settles',
            cutoff: () => new Promise<void>(() => undefined),
            expectedError: 'ANALYSIS_V2_GENDER_RESOLUTION_CUTOFF_PERSISTENCE_ERROR',
        },
        {
            label: 'rejects',
            cutoff: () => Promise.reject(new Error('temporary cutoff bookkeeping failure')),
            expectedError: 'temporary cutoff bookkeeping failure',
        },
    ])('bounds resolver cutoff bookkeeping when it $label', async scenario => {
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn(scenario.cutoff),
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        const outcome = await Promise.race([
            handle.cutoff().then(
                () => ({ status: 'resolved' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            ),
            new Promise<{ status: 'timed_out' }>(resolve => {
                setTimeout(() => resolve({ status: 'timed_out' }), 100);
            }),
        ]);

        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
            expect(outcome.error).toEqual(expect.objectContaining({
                message: scenario.expectedError,
            }));
        }
        expect(handle.peek()).toEqual({ status: 'cutoff' });
        await handle.completion;
    });

    it('preserves an immediate resolver cutoff bookkeeping rejection', async () => {
        const persistenceFailure = new Error('DATABASE_FENCE_REJECTED');
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn().mockRejectedValue(persistenceFailure),
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await expect(handle.cutoff()).rejects.toBe(persistenceFailure);
        expect(handle.peek()).toEqual({ status: 'cutoff' });
        await handle.completion;
    });

    it.each([
        {
            label: 'reserved attempt awaiting exact recovery',
            error: new AnalysisV2AiResultRecoveryPendingError(),
            status: 'recovery_pending' as const,
            cutoffRejects: true,
        },
        {
            label: 'durably recovered cutoff',
            error: new AnalysisV2AiResultRecoveredCutoffError(),
            status: 'cutoff' as const,
            cutoffRejects: false,
        },
    ])('reconstructs a $label without exposing terminal_unavailable', async scenario => {
        const cutoff = vi.fn().mockRejectedValue(scenario.error);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn().mockRejectedValue(scenario.error),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({ createAudit });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await handle.completion;
        expect(handle.peek()).toEqual({ status: scenario.status });
        await expect(handle.cutoff()).resolves.toBeUndefined();
        expect(handle.peek()).not.toEqual({ status: 'terminal_unavailable' });
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
