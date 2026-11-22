import { DevLiveVertexBudgetReservationPendingError } from '@/lib/services/dev-ui/live-budget-signals';
import { describe, expect, it, vi } from 'vitest';
import {
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V211_VERSION,
    AI_STAGE_POLICY_VERSION,
} from '@/lib/services/ai/stage-policy';
import {
    createGenderTriageMicrobatchAccountId,
    createGenderTriageMicrobatchResultIdentity,
    plannedGenderTriageOperationKey,
    prepareGenderTriagePlanAccount,
    type GenderTriageInput,
} from '@/lib/services/ai/v2-staged-analysis';
import {
    pinProfileGenderPlan, planProfileGender, type PinProfileGenderPlan,
} from '@/lib/services/analysis/v2-profile-gender-plan';
import { AnalysisV2JobFenceError } from '@/lib/services/analysis/v2-job-store';

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: vi.fn() },
}));
import {
    createDurableAnalysisV2AiStageRuntime,
    type AnalysisV2AiStageRuntimeDependencies,
} from '../../../lib/services/analysis/v2-ai-stage-runtime';
import {
    AnalysisV2AiResultRecoveredCutoffError,
    AnalysisV2AiResultRecoveryPendingError,
} from '../../../lib/services/analysis/v2-ai-result-store';
import type { AnalysisV2SchedulerRuntimeOptions } from '../../../lib/services/analysis/v2-ai-scheduler-runtime';

const supabase = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: supabase }));

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

    it('uses the durable resolver admission before its external model boundary', async () => {
        const reserveResolverCapacity = vi.fn(async () => 'capacity_skipped' as const);
        const runGenderResolution = vi.fn();
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
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
            reserveGenderResolutionCapacity: reserveResolverCapacity,
        });

        await handle.completion;
        expect(handle.peek()).toEqual({ status: 'capacity_skipped' });
        expect(reserveResolverCapacity).toHaveBeenCalledWith(
            expect.stringMatching(/^gender-resolution:[a-f0-9]{64}$/),
        );
        expect(runGenderResolution).not.toHaveBeenCalled();
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

    it('retains the typed budget rollback when a resolver has yet to dispatch', async () => {
        const error = new DevLiveVertexBudgetReservationPendingError();
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: cachedAuditFactory({}).createAudit,
            runGenderResolution: vi.fn().mockRejectedValue(error),
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence, aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });
        await handle.completion;
        await handle.cutoff();
        expect(handle.peek()).toEqual({ status: 'budget_reservation_pending', error });
    });

    it.each(['DEV_LIVE_BUDGET_EXCEEDED', 'DEV_LIVE_BUDGET_UNAVAILABLE'])(
        'preserves %s when the resolver cannot start', async budgetError => {
            const runGenderResolution = vi.fn();
            const runtime = createDurableAnalysisV2AiStageRuntime({
                createAudit: cachedAuditFactory({}).createAudit,
                runGenderResolution,
            });
            const handle = runtime.startGenderResolution({ media: [] }, {
                ...fence,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                reserveGenderResolutionCapacity: vi.fn().mockRejectedValue(new Error(budgetError)),
            });
            await handle.completion;
            expect(handle.peek()).toEqual({ status: 'terminal_unavailable', budgetError });
            expect(runGenderResolution).not.toHaveBeenCalled();
        },
    );

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

    it('microbatches concurrent v2.8 gender operations behind one durable scheduler', async () => {
        const runGender = vi.fn(async (input: GenderTriageInput) => ({
            assessment: {
                inferredGender: 'unknown' as const,
                confidence: 'low' as const,
                ownerConsistency: 'not_visible' as const,
                evidenceSelectionIds: [],
            },
            routingDecision: 'route_to_feature_analysis' as const,
            routingReason: 'conserve_female_recall' as const,
            analyzedSelectionIds: input.media.map(item => item.selectionId),
        }));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runScheduler = vi.fn(async (
            options: AnalysisV2SchedulerRuntimeOptions<unknown>,
        ) => {
            schedulerCalls.push(options);
            const completed = await Promise.all(options.tasks.map(async item => ({
                key: item.key,
                stage: item.stage,
                value: await item.run(),
            })));
            return {
                status: 'completed' as const,
                completed,
                remainingKeys: [],
                recoveryPendingKeys: [],
                terminalUnavailableKeys: [],
                continuationDelayMs: 1_000,
            };
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGender,
            runScheduler: runScheduler as typeof import(
                '../../../lib/services/analysis/v2-ai-scheduler-runtime'
            ).runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(),
                commitReady: vi.fn(),
            })) as typeof import(
                '../../../lib/services/analysis/v2-ai-scheduler-operation-store'
            ).createAnalysisV2SchedulerOperationStore,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const media = (suffix: string) => ({
            media: [{
                selectionId: `profile:${suffix}`,
                kind: 'profile' as const,
                normalizedJpegBase64: '/9j/2Q==',
            }],
        });

        const [first, second] = await Promise.all([
            runtime.gender(media('first'), scheduledFence),
            runtime.gender(media('second'), scheduledFence),
        ]);

        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(2);
        expect(schedulerCalls[0]!.tasks.every(item => (
            typeof item.recover === 'function'
            && typeof item.terminalFallback === 'function'
        ))).toBe(true);
        expect(runGender).toHaveBeenCalledTimes(2);
        expect(first.operationKey).not.toBe(second.operationKey);
    });

    it('rejects only the scheduler plan reported as terminal unavailable', async () => {
        const runScheduler = vi.fn(async (
            options: AnalysisV2SchedulerRuntimeOptions<unknown>,
        ) => ({
            status: 'completed' as const,
            completed: [],
            remainingKeys: [],
            recoveryPendingKeys: [],
            terminalUnavailableKeys: options.tasks.map(task => task.key),
            continuationDelayMs: 1_000,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runScheduler: runScheduler as typeof import('../../../lib/services/analysis/v2-ai-scheduler-runtime')
                .runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(),
                commitReady: vi.fn(),
            })) as typeof import('../../../lib/services/analysis/v2-ai-scheduler-operation-store')
                .createAnalysisV2SchedulerOperationStore,
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };

        await expect(runtime.gender({
            media: [{
                selectionId: 'profile:terminal',
                kind: 'profile',
                normalizedJpegBase64: '/9j/2Q==',
            }],
        }, scheduledFence)).rejects.toThrow('ANALYSIS_V2_AI_TERMINAL_UNAVAILABLE');
    });

    it.each([
        ['v2.10', AI_STAGE_POLICY_V210_VERSION],
        ['v2.11', AI_STAGE_POLICY_V211_VERSION],
    ] as const)(
        'keeps %s on the v2.9 microbatch scheduler path while binding its own immutable policy',
        async (_label, policyVersion) => {
        const runGenderMicrobatch = vi.fn(async (
            accounts: readonly { accountId: string; input: GenderTriageInput }[],
        ) => accounts.map(account => ({
            accountId: account.accountId,
            result: {
                assessment: {
                    inferredGender: 'unknown' as const,
                    confidence: 'low' as const,
                    ownerConsistency: 'not_visible' as const,
                    evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'uncertain' as const,
            },
            source: 'checkpoint' as const,
        })));
        const runScheduler = vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => ({
            status: 'completed' as const,
            completed: await Promise.all(options.tasks.map(async task => ({
                key: task.key,
                stage: task.stage,
                value: await task.run(),
            }))),
            remainingKeys: [],
            recoveryPendingKeys: [],
            terminalUnavailableKeys: [],
            continuationDelayMs: 1_000,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGenderMicrobatch,
            runScheduler: runScheduler as typeof import('../../../lib/services/analysis/v2-ai-scheduler-runtime')
                .runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as typeof import('../../../lib/services/analysis/v2-ai-scheduler-operation-store')
                .createAnalysisV2SchedulerOperationStore,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(), onBeforeAttempt: vi.fn(), onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: policyVersion,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const input = (suffix: string) => ({ media: [{
            selectionId: `profile:${suffix}`,
            kind: 'profile' as const,
            normalizedJpegBase64: '/9j/2Q==',
        }] });

        await Promise.all([
            runtime.gender(input('first'), scheduledFence),
            runtime.gender(input('second'), scheduledFence),
        ]);

        expect(runScheduler).toHaveBeenCalledOnce();
        expect(runGenderMicrobatch).toHaveBeenCalledOnce();
        const call = runGenderMicrobatch.mock.calls[0] as unknown as [
            Parameters<typeof createGenderTriageMicrobatchResultIdentity>[0],
            { operationKey: string },
            { aiStagePolicyVersion?: string },
        ];
        expect(call[1].operationKey).toBe(
            createGenderTriageMicrobatchResultIdentity(
                call[0],
                policyVersion,
            ).operationKey,
        );
        expect(call[2]).toEqual({
            aiStagePolicyVersion: policyVersion,
        });
    });

    it('uses one audited v2.9 Gemini batch for two concurrent accounts and no individual calls', async () => {
        const runGender = vi.fn();
        const runGenderMicrobatch = vi.fn(async accounts => accounts.map((account: {
            accountId: string;
            input: GenderTriageInput;
        }) => ({
            accountId: account.accountId,
            source: 'checkpoint' as const,
            result: {
                assessment: {
                    inferredGender: 'female' as const,
                    confidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    evidenceSelectionIds: account.input.media.map(item => item.selectionId),
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'personal' as const,
            },
        })));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGender,
            runGenderMicrobatch: runGenderMicrobatch as never,
            runScheduler: vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => {
                schedulerCalls.push(options);
                const completed = await Promise.all(options.tasks.map(async item => ({
                    key: item.key,
                    stage: item.stage,
                    value: await item.run(),
                })));
                return {
                    status: 'completed' as const,
                    completed,
                    remainingKeys: [],
                    recoveryPendingKeys: [],
                    terminalUnavailableKeys: [],
                    continuationDelayMs: 1_000,
                };
            }) as never,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as never,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V29_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const media = (suffix: string) => ({ media: [{
            selectionId: `profile:${suffix}`,
            kind: 'profile' as const,
            normalizedJpegBase64: '/9j/2Q==',
        }, {
            selectionId: `post:${suffix}`,
            kind: 'feed' as const,
            normalizedJpegBase64: '/9j/2g==',
            postId: `post:${suffix}`,
        }] });

        const [first, second] = await Promise.all([
            runtime.gender(media('first'), scheduledFence),
            runtime.gender(media('second'), scheduledFence),
        ]);

        expect(runGender).not.toHaveBeenCalled();
        expect(runGenderMicrobatch).toHaveBeenCalledTimes(1);
        expect(runGenderMicrobatch.mock.calls[0]![0]).toHaveLength(2);
        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(1);
        expect(first.operationKey).toBe(second.operationKey);
        expect(first.resultHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('coalesces duplicate v2.9 gender members before the one durable batch operation', async () => {
        const runGenderMicrobatch = vi.fn(async accounts => accounts.map((account: {
            accountId: string;
            input: GenderTriageInput;
        }) => ({
            accountId: account.accountId,
            source: 'checkpoint' as const,
            result: {
                assessment: {
                    inferredGender: 'female' as const,
                    confidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    evidenceSelectionIds: account.input.media.map(item => item.selectionId),
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'personal' as const,
            },
        })));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGenderMicrobatch: runGenderMicrobatch as never,
            runScheduler: vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => {
                schedulerCalls.push(options);
                const completed = await Promise.all(options.tasks.map(async item => ({
                    key: item.key,
                    stage: item.stage,
                    value: await item.run(),
                })));
                return {
                    status: 'completed' as const,
                    completed,
                    remainingKeys: [],
                    recoveryPendingKeys: [],
                    terminalUnavailableKeys: [],
                    continuationDelayMs: 1_000,
                };
            }) as never,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as never,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V29_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const duplicateInput: GenderTriageInput = { media: [{
            selectionId: 'profile:duplicate',
            kind: 'profile',
            normalizedJpegBase64: '/9j/2Q==',
        }] };

        const [first, second] = await Promise.all([
            runtime.gender(duplicateInput, scheduledFence),
            runtime.gender(duplicateInput, scheduledFence),
        ]);

        expect(runGenderMicrobatch).toHaveBeenCalledTimes(1);
        expect(runGenderMicrobatch.mock.calls[0]![0]).toHaveLength(1);
        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(1);
        expect(first.operationKey).toBe(second.operationKey);
        expect(first.resultHash).toBe(second.resultHash);
    });
});

describe('persisted v2.11 profile gender membership', () => {
    const policy = AI_STAGE_POLICY_V211_VERSION;
    const planFence = { ...fence, inputHash: '4'.repeat(64) };
    const input = (suffix: string, hasProfileImage = true): GenderTriageInput => ({
        media: [
            { selectionId: `profile:${suffix}`, kind: 'profile', normalizedJpegBase64: '/9j/2Q==' },
            { selectionId: `feed:${suffix}`, kind: 'feed', postId: `post:${suffix}`, normalizedJpegBase64: '/9j/2g==' },
        ],
        accountProfile: { fullName: suffix, bio: 'fixture', hasProfileImage },
    });
    const rawKey = (inputs: readonly GenderTriageInput[]) => createGenderTriageMicrobatchResultIdentity(
        inputs.map(input => ({ input, accountId: createGenderTriageMicrobatchAccountId(input, policy) })), policy,
    ).operationKey;

    it('returns stale claims to the existing worker fence handling', async () => {
        supabase.rpc.mockResolvedValueOnce({
            data: null, error: { message: 'ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH' },
        });
        await expect(pinProfileGenderPlan(planFence, [])).rejects.toBeInstanceOf(AnalysisV2JobFenceError);
    });

    it('pins empty and singleton input and refuses a new candidate after a singleton is sealed', async () => {
        const a = prepareGenderTriagePlanAccount(input('a'), policy);
        const b = prepareGenderTriagePlanAccount(input('b'), policy);
        const fresh: PinProfileGenderPlan = async (_fence, groups) => ({ kind: 'pinned', groups: [...groups] });
        expect(await planProfileGender([], planFence, fresh)).toEqual([]);
        const singleton = await planProfileGender([a,a], planFence, fresh);
        expect(singleton).toEqual([{ accountIds: [a.accountId], operationKey: rawKey([input('a')]) }]);
        await expect(planProfileGender([a,b], planFence, async () => ({ kind: 'pinned', groups: [...singleton] })))
            .rejects.toThrow('PLAN_DRIFT');
    });

    it('reproduces the pre-change singleton and pair operation keys from compact evidence', () => {
        vi.stubEnv('CONCIERGE_BATCH_NAME_GENDER_ASSERTIVE', 'false');
        try {
            const inputs = [input('first'), input('second', false)];
            const members = inputs.map(value => prepareGenderTriagePlanAccount(value, policy));
            // Captured from the pre-change prompt + media identity, including projected attachment ordinals.
            expect(rawKey(inputs)).toBe('gender-triage:5df887986a185e919e325fe8b0a979bcb15ff6a309d15589f94f253855bd9e7b');
            expect(rawKey(inputs.slice(1))).toBe('gender-triage:ea11f3a567337d2c528082dfb9a1f0f2fecad8a98c806b05380ac3b2223828d1');
            expect(plannedGenderTriageOperationKey(members.toReversed(), policy)).toBe(rawKey(inputs));
            expect(plannedGenderTriageOperationKey(members.slice(1), policy)).toBe(rawKey(inputs.slice(1)));
            expect(JSON.stringify(members)).not.toContain('/9j/');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('adopts exact legacy ready members and opaque cross-pair claims before assigning untouched candidates', async () => {
        const accounts = Array.from({length: 6}, (_, i) => prepareGenderTriagePlanAccount(input(String(i)), policy))
            .sort((a,b) => a.accountId.localeCompare(b.accountId));
        const historical = [[accounts[0]!], [accounts[1]!,accounts[4]!]].map(rows => ({
            accountIds: rows.map(row => row.accountId), operationKey: plannedGenderTriageOperationKey(rows, policy),
        }));
        const pin = vi.fn<PinProfileGenderPlan>()
            .mockResolvedValueOnce({kind:'history',groups:[historical[0]!,{...historical[1]!, accountIds:null}]})
            .mockImplementation(async (_fence, groups) => ({kind:'pinned', groups:[...groups]}));
        const plan = await planProfileGender(accounts, planFence, pin);
        expect(plan).toEqual(expect.arrayContaining(historical));
        expect(plan.flatMap(row => row.accountIds).sort()).toEqual(accounts.map(row => row.accountId).sort());
        expect(pin).toHaveBeenCalledTimes(2);
    });

    it('blocks missing input and historical overlaps without pinning another operation', async () => {
        const a = prepareGenderTriagePlanAccount(input('a'), policy);
        const b = prepareGenderTriagePlanAccount(input('b'), policy);
        const old = (rows: typeof a[]) => ({ operationKey: plannedGenderTriageOperationKey(rows, policy), accountIds: null });
        for (const history of [[old([a,b])], [old([a]),old([a,b])]]) {
            const pin = vi.fn<PinProfileGenderPlan>().mockResolvedValue({kind:'history',groups:history});
            await expect(planProfileGender(history.length === 1 ? [a] : [a,b], planFence, pin)).rejects.toThrow('PLAN_DRIFT');
            expect(pin).toHaveBeenCalledOnce();
        }
    });
});
