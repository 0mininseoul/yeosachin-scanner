import { VertexDispatchAuthorizationError } from '@/lib/services/ai/vertex-dispatch-window';
import { AnalysisV2AiCapacityPendingError } from './v2-gemini-lease-store';
import { withStandardResolverAdmission } from '@/lib/services/ai/standard-resolver-admission';
import { LocalResolverPermitTimeoutError } from '@/lib/services/ai/gemini-generation-limiter';
import { AI_GEMINI_MIN_REMAINING_MS } from '@/lib/services/ai/stage-policy';
import { DevLiveVertexBudgetReservationPendingError } from '@/lib/services/dev-ui/live-budget-signals';
import { z } from 'zod';
import {
    aiStagePolicySupports,
    assertSupportedAiStagePolicyVersion,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import { VertexAiBudgetCapacityPendingError, VertexAiBudgetExceededError, type VertexAiBudgetGuard } from '@/lib/services/ai/vertex-ai-cost-policy';
import {
    analyzePrivateAccountNames,
    createPrivateNameBatchIdentity,
    createPrivateNameBatchResponseSchema,
    type PrivateNameAccountInput,
    type PrivateNameAnalysisAudit,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import {
    createFeatureAnalysisResultIdentity,
    createGenderTriageMicrobatchAccountId,
    createGenderTriageMicrobatchResponseSchema,
    createGenderTriageMicrobatchResultIdentity,
    createGenderResolutionResultIdentity,
    createGenderTriageResultIdentity,
    createHighRiskNarrativeResultIdentity,
    createPartnerSafetyResultIdentity,
    featureAnalysisResultSchema,
    featureAnalysis,
    featureAnalysisModelResponseSchema,
    genderResolution,
    genderResolutionCheckpointAssessment,
    genderResolutionModelResponseSchema,
    genderTriage,
    genderTriageMicrobatch,
    genderTriageResultSchema,
    genderTriageModelResponseSchema,
    highRiskNarrative,
    highRiskNarrativeModelResponseSchema,
    partnerSafetyAnalysis,
    partnerSafetyModelResponseSchema,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
    type GenderResolutionInput,
    type GenderResolutionResult,
    type GenderTriageInput,
    type GenderTriageMicrobatchAccountInput,
    type GenderTriageResult,
    type HighRiskNarrativeInput,
    type HighRiskNarrativeResult,
    type PartnerSafetyInput,
    type PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import type { DevStandardProfileDelivery } from '@/lib/services/dev-ui/standard-profile-delivery';
import type { ProfileReadySnapshot } from './v2-profile-media-inputs';
import { planProfileGender, type PinProfileGenderPlan, type ProfileGenderGroup } from './v2-profile-gender-plan';
import { AnalysisV2AiTerminalUnavailableError } from './v2-ai-fallback-policy';
import {
    AnalysisV2AiResultRecoveredCutoffError,
    AnalysisV2AiResultRecoveryPendingError,
    createAnalysisV2AiAuditAdapter,
    createAnalysisV2AiResultContentHash,
    type AnalysisV2AiAuditAdapter,
    type AnalysisV2AiResultIdentity,
} from './v2-ai-result-store';
import type { AiSchedulerCapability } from '@/lib/services/ai/scheduler-policy';
import {
    ANALYSIS_V2_SCHEDULER_COMMIT_MARGIN_MS,
    AnalysisV2SchedulerAdmissionDeferredError,
    runAnalysisV2FairAiScheduler,
    type AnalysisV2SchedulerStage,
    type AnalysisV2SchedulerTask,
} from './v2-ai-scheduler-runtime';
import {
    createAnalysisV2SchedulerOperationStore,
} from './v2-ai-scheduler-operation-store';
import {
    AnalysisV2SchedulerContinuationError,
    AnalysisV2ConfirmedCapacityContinuation,
    schedulerContinuationReason,
} from './v2-ai-scheduler-continuation';

export interface AnalysisV2AiJobFence {
    jobInputHash?: string;
    /** Immutable ready envelopes from this delivery's fenced Dev profile input read. */
    profileReadySnapshot?: ProfileReadySnapshot;
    profileDelivery?: DevStandardProfileDelivery;
    requestId: string;
    jobKey: string;
    claimToken: string;
    aiStagePolicyVersion: string;
    /** Optional shared monetary guard; v2.12 uses a fail-closed default when omitted. */
    budgetGuard?: VertexAiBudgetGuard;
    budgetOrderId?: string | null;
    schedulerCapability?: AiSchedulerCapability;
    handlerDeadlineAtMs?: number;
    /** Internal checkpoint-only replay fence; production callers must not set it. */
    schedulerRecoveryOnly?: boolean;
    /** Internal terminal safe-fallback fence; production callers must not set it. */
    schedulerTerminalUnavailable?: boolean;
    admittedStandardResolver?: true;
    /**
     * Strict revenue cohorts reserve a request-scoped resolver slot before
     * constructing the external Gemini call. The callback is intentionally
     * identity-only: no candidate fields or model inputs cross this boundary.
     */
    reserveGenderResolutionCapacity?: (
        operationKey: string,
    ) => Promise<'accepted' | 'capacity_skipped'>;
}

export interface AnalysisV2AuditedResult<T> {
    result: T;
    operationKey: string;
    resultHash: string | null;
    source: 'checkpoint' | 'safe_fallback' | 'feature_only';
}

export interface AnalysisV2PrivateNameAuditedResult {
    results: readonly PrivateNameAnalysisResult[];
    operationKey: string;
    resultHash: string | null;
    source: 'checkpoint' | 'safe_fallback';
}

export interface AnalysisV2AiStageRuntime {
    profileGender?: {
        plan: typeof planProfileGender;
        run(inputs: readonly GenderTriageInput[], group: ProfileGenderGroup, fence: AnalysisV2AiJobFence):
            Promise<readonly AnalysisV2AuditedResult<GenderTriageResult>[]>;
    };
    gender(
        input: GenderTriageInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<GenderTriageResult>>;
    startGenderResolution(
        input: GenderResolutionInput,
        fence: AnalysisV2AiJobFence
    ): AnalysisV2GenderResolutionHandle;
    features(
        input: FeatureAnalysisInput,
        fence: AnalysisV2AiJobFence,
        onAttemptReserved?: () => void,
    ): Promise<AnalysisV2AuditedResult<FeatureAnalysisResult>>;
    privateNames(
        input: readonly PrivateNameAccountInput[],
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2PrivateNameAuditedResult>;
    partnerSafety(
        input: PartnerSafetyInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<PartnerSafetyResult>>;
    narrative(
        input: HighRiskNarrativeInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<HighRiskNarrativeResult>>;
}

export type AnalysisV2GenderResolutionState =
    | { status: 'pending' }
    | {
        status: 'ready';
        value: AnalysisV2AuditedResult<GenderResolutionResult>;
    }
    | { status: 'cutoff' }
    | { status: 'recovery_pending' }
    | { status: 'blocking_error'; error: Error }
    | { status: 'budget_reservation_pending'; error: DevLiveVertexBudgetReservationPendingError | VertexAiBudgetCapacityPendingError }
    | { status: 'capacity_skipped'; localFirstAttemptTimedOut?: true }
    | { status: 'deadline_pending' }
    | { status: 'unsent_capacity_pending' }
    | {
        status: 'terminal_unavailable';
        budgetError?: 'DEV_LIVE_BUDGET_EXCEEDED' | 'DEV_LIVE_BUDGET_UNAVAILABLE';
    };

export type ResolverCutoffReason = 'resolver_handler_deadline' | 'resolver_capacity_continuation'
    | 'resolver_deadline_continuation' | 'resolver_required_error' | 'resolver_batch_barrier';

export interface AnalysisV2GenderResolutionHandle {
    operationKey: string;
    completion: Promise<void>;
    /** The single cutoff write for this delivery can still be running after peek() becomes cutoff. */
    readonly cutoffCompletion?: Promise<void> | null;
    holdActiveAttempt?(includeStartedSetup?: boolean): boolean;
    finishCurrentOrFirstAttempt?(): void;
    readonly recoveredCutoffFromAudit?: boolean;
    peek(): AnalysisV2GenderResolutionState;
    cutoff(reason?: ResolverCutoffReason): Promise<void>;
}

type AuditFactory = <T>(options: Parameters<typeof createAnalysisV2AiAuditAdapter<T>>[0]) =>
AnalysisV2AiAuditAdapter<T>;

export interface AnalysisV2AiStageRuntimeDependencies {
    pinProfileGenderPlan?: PinProfileGenderPlan;
    createAudit?: AuditFactory;
    runGender?: typeof genderTriage;
    runGenderMicrobatch?: typeof genderTriageMicrobatch;
    runGenderResolution?: typeof genderResolution;
    runFeatures?: typeof featureAnalysis;
    runPrivateNames?: typeof analyzePrivateAccountNames;
    runPartnerSafety?: typeof partnerSafetyAnalysis;
    runNarrative?: typeof highRiskNarrative;
    runScheduler?: typeof runAnalysisV2FairAiScheduler;
    createSchedulerOperationStore?: typeof createAnalysisV2SchedulerOperationStore;
}

const GENDER_RESOLUTION_CUTOFF_BOOKKEEPING_WAIT_MS = 25;

export class AnalysisV2GenderResolutionCutoffPersistenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_GENDER_RESOLUTION_CUTOFF_PERSISTENCE_ERROR');
        this.name = 'AnalysisV2GenderResolutionCutoffPersistenceError';
    }
}

async function waitForCutoffBookkeeping(
    operation: () => Promise<void> | undefined,
    maxWaitMs: number,
): Promise<void> {
    const handled = Promise.resolve()
        .then(operation)
        .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
        );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        handled,
        new Promise<{ status: 'timed_out' }>(resolve => {
            timer = setTimeout(
                () => resolve({ status: 'timed_out' }),
                maxWaitMs
            );
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.status === 'rejected') {
        throw outcome.error;
    }
    if (outcome.status === 'timed_out') {
        throw new AnalysisV2GenderResolutionCutoffPersistenceError();
    }
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('ANALYSIS_V2_AI_RUNTIME_INVALID_JSON');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )).join(',')}}`;
    }
    throw new Error('ANALYSIS_V2_AI_RUNTIME_INVALID_JSON');
}

export function analysisV2CanonicalAiResultHash(value: unknown): string {
    return createAnalysisV2AiResultContentHash(canonicalJson(value));
}

function adapter<T>(
    createAudit: AuditFactory,
    fence: AnalysisV2AiJobFence,
    resultIdentity: AnalysisV2AiResultIdentity,
    resultSchema: z.ZodType<T>
): AnalysisV2AiAuditAdapter<T> {
    const { requestId, jobKey, claimToken } = fence;
    return createAudit({
        requestId,
        jobKey,
        claimToken,
        aiStagePolicyVersion: assertAiStagePolicyVersion(fence),
        resultIdentity,
        resultSchema,
        handlerDeadlineAtMs: fence.handlerDeadlineAtMs,
        schedulerRecoveryOnly: fence.schedulerRecoveryOnly,
        schedulerTerminalUnavailable: fence.schedulerTerminalUnavailable,
        budgetGuard: fence.budgetGuard,
        budgetOrderId: fence.budgetOrderId,
    });
}

function assertAiStagePolicyVersion(fence: AnalysisV2AiJobFence): AiStagePolicyVersion {
    try {
        return assertSupportedAiStagePolicyVersion(fence.aiStagePolicyVersion);
    } catch {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
}

function assertGenderResolutionPolicyVersion(fence: AnalysisV2AiJobFence): void {
    assertAiStagePolicyVersion(fence);
    if (!aiStagePolicySupports(
        assertAiStagePolicyVersion(fence),
        'genderResolution',
    )) {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
}

const AI_RESULT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function exactSchedulerEnabled(fence: AnalysisV2AiJobFence): boolean {
    return (
        fence.aiStagePolicyVersion === 'ai-stage-policy-v2.8'
        || aiStagePolicySupports(
            assertAiStagePolicyVersion(fence),
            'genderTriageMicrobatchV29',
        )
    )
        && fence.schedulerCapability === 'scheduler-v1';
}

interface PendingSchedulerPlan<T> {
    key: string;
    stage: AnalysisV2SchedulerStage;
    schema: z.ZodType<T>;
    run(): Promise<T>;
    recover(): Promise<T>;
    terminalFallback(): Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

function schedulerBatchKey(fence: AnalysisV2AiJobFence): string {
    return [
        fence.requestId,
        fence.jobKey,
        fence.claimToken,
        String(fence.handlerDeadlineAtMs ?? ''),
    ].join(':');
}

function createSchedulerMicrobatch(
    dependencies: Pick<
        AnalysisV2AiStageRuntimeDependencies,
        'runScheduler' | 'createSchedulerOperationStore'
    >,
) {
    const runScheduler = dependencies.runScheduler ?? runAnalysisV2FairAiScheduler;
    const createStore = dependencies.createSchedulerOperationStore
        ?? createAnalysisV2SchedulerOperationStore;
    const groups = new Map<string, {
        fence: AnalysisV2AiJobFence;
        plans: PendingSchedulerPlan<unknown>[];
        scheduled: boolean;
    }>();

    const flush = async (groupKey: string): Promise<void> => {
        const group = groups.get(groupKey);
        if (!group) return;
        groups.delete(groupKey);
        const plans = [...group.plans].sort((left, right) => (
            left.key.localeCompare(right.key)
        ));
        try {
            if (
                group.fence.handlerDeadlineAtMs === undefined
                || !Number.isFinite(group.fence.handlerDeadlineAtMs)
            ) {
                throw new AnalysisV2SchedulerContinuationError(
                    'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT'
                );
            }
            const schemas = new Map<string, z.ZodType<unknown>>();
            const uniquePlans: PendingSchedulerPlan<unknown>[] = [];
            const seen = new Map<string, AnalysisV2SchedulerStage>();
            for (const plan of plans) {
                const existingStage = seen.get(plan.key);
                if (existingStage && existingStage !== plan.stage) {
                    throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_STAGE_DRIFT');
                }
                if (existingStage) {
                    continue;
                }
                seen.set(plan.key, plan.stage);
                uniquePlans.push(plan);
                schemas.set(plan.key, plan.schema);
            }
            const operationStore = createStore<unknown>({
                requestId: group.fence.requestId,
                jobKey: group.fence.jobKey,
                jobClaimToken: group.fence.claimToken,
                onClaimRpc: group.fence.profileDelivery?.claimRpc,
                schemas,
            });
            const tasks: AnalysisV2SchedulerTask<unknown>[] = uniquePlans.map((
                plan,
                ordinal,
            ) => ({
                key: plan.key,
                stage: plan.stage,
                ordinal,
                run: plan.run,
                recover: plan.recover,
                terminalFallback: plan.terminalFallback,
            }));
            const result = await runScheduler<unknown>({
                capability: 'scheduler-v1',
                tasks,
                operationStore,
                handlerDeadlineAtMs: group.fence.handlerDeadlineAtMs,
            });
            const completed = new Map(result.completed.map(item => [item.key, item.value]));
            const recoveryPending = new Set(result.recoveryPendingKeys);
            const terminalUnavailable = new Set(result.terminalUnavailableKeys);
            for (const plan of plans) {
                if (completed.has(plan.key)) {
                    plan.resolve(plan.schema.parse(completed.get(plan.key)));
                } else if (terminalUnavailable.has(plan.key)) {
                    plan.reject(new AnalysisV2AiTerminalUnavailableError());
                } else {
                    plan.reject(new AnalysisV2SchedulerContinuationError(
                        recoveryPending.has(plan.key)
                            ? 'ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING'
                            : 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
                        Math.min(300, Math.max(
                            1,
                            Math.ceil(result.continuationDelayMs / 1_000),
                        )),
                    ));
                }
            }
        } catch (error) {
            if (error instanceof AnalysisV2SchedulerAdmissionDeferredError) {
                const delaySeconds = Math.min(300, Math.max(
                    1,
                    Math.ceil((error.notBeforeAtMs - performance.now()) / 1_000),
                ));
                plans.forEach(plan => plan.reject(
                    error.confirmedCapacityOnly && error.reason === 'ANALYSIS_V2_AI_CAPACITY_PENDING'
                        ? new AnalysisV2ConfirmedCapacityContinuation(delaySeconds)
                        : new AnalysisV2SchedulerContinuationError(error.reason, delaySeconds),
                ));
                return;
            }
            const continuation = schedulerContinuationReason(error);
            const rejected = continuation && !(error instanceof AnalysisV2SchedulerContinuationError)
                ? new AnalysisV2SchedulerContinuationError(continuation)
                : error;
            plans.forEach(plan => plan.reject(rejected));
        }
    };

    return function schedule<T>(
        fence: AnalysisV2AiJobFence,
        plan: Omit<PendingSchedulerPlan<T>, 'resolve' | 'reject'>,
    ): Promise<T> {
        const snapshot = fence.profileReadySnapshot;
        if (snapshot && snapshot.fence.requestId === fence.requestId && snapshot.fence.jobKey === fence.jobKey
            && snapshot.fence.claimToken === fence.claimToken && snapshot.fence.inputHash === fence.jobInputHash
            && !fence.schedulerRecoveryOnly && !fence.schedulerTerminalUnavailable
            && Number.isFinite(fence.handlerDeadlineAtMs) && performance.now() < (fence.handlerDeadlineAtMs ?? 0)) {
            const ready = snapshot.byKey.get(plan.key);
            if (ready?.stage === plan.stage) {
                const parsed = plan.schema.safeParse(ready.result);
                if (!parsed.success) throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: invalid ready result.');
                if (fence.profileDelivery) fence.profileDelivery.readyHits++;
                return Promise.resolve(parsed.data);
            }
        }
        const groupKey = schedulerBatchKey(fence);
        let group = groups.get(groupKey);
        if (!group) {
            group = { fence, plans: [], scheduled: false };
            groups.set(groupKey, group);
        }
        return new Promise<T>((resolve, reject) => {
            group!.plans.push({
                ...plan,
                resolve: value => resolve(value as T),
                reject,
            } as PendingSchedulerPlan<unknown>);
            if (!group!.scheduled) {
                group!.scheduled = true;
                setTimeout(() => void flush(groupKey), 0);
            }
        });
    };
}

/**
 * Production runtime for the already-defined staged AI functions. Provider calls stay behind this
 * interface, so executor tests never need Vertex credentials and retry replay remains auditable.
 */
export function createDurableAnalysisV2AiStageRuntime(
    dependencies: AnalysisV2AiStageRuntimeDependencies = {}
): AnalysisV2AiStageRuntime {
    const createAudit = dependencies.createAudit ?? createAnalysisV2AiAuditAdapter;
    const runGender = dependencies.runGender ?? genderTriage;
    const runGenderMicrobatch = dependencies.runGenderMicrobatch ?? genderTriageMicrobatch;
    const runGenderResolution = dependencies.runGenderResolution ?? genderResolution;
    const runFeatures = dependencies.runFeatures ?? featureAnalysis;
    const runPrivateNames = dependencies.runPrivateNames ?? analyzePrivateAccountNames;
    const runPartnerSafety = dependencies.runPartnerSafety ?? partnerSafetyAnalysis;
    const runNarrative = dependencies.runNarrative ?? highRiskNarrative;
    const schedule = createSchedulerMicrobatch(dependencies);

    type PendingGenderMicrobatchPlan = {
        accountId: string;
        input: GenderTriageInput;
        fence: AnalysisV2AiJobFence;
        waiters: Array<{
            resolve(value: AnalysisV2AuditedResult<GenderTriageResult>): void;
            reject(error: unknown): void;
        }>;
    };
    const pendingGenderMicrobatches = new Map<string, {
        fence: AnalysisV2AiJobFence;
        plans: PendingGenderMicrobatchPlan[];
        scheduled: boolean;
        pinnedKey?: string;
    }>();

    const flushGenderMicrobatch = async (groupKey: string): Promise<void> => {
        const group = pendingGenderMicrobatches.get(groupKey);
        if (!group) return;
        pendingGenderMicrobatches.delete(groupKey);
        const chunks = planGenderTriageMicrobatches(group.plans.map(plan => ({
            accountId: plan.accountId,
            value: plan,
        }))).map(batch => batch.map(member => member.value));
        await Promise.all(chunks.map(async chunk => {
            const accounts: GenderTriageMicrobatchAccountInput[] = chunk.map(plan => ({
                accountId: plan.accountId,
                input: plan.input,
            }));
            try {
                const identity = createGenderTriageMicrobatchResultIdentity(
                    accounts,
                    assertAiStagePolicyVersion(group.fence),
                );
                if (group.pinnedKey && group.pinnedKey !== identity.operationKey) {
                    throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
                }
                const responseSchema = createGenderTriageMicrobatchResponseSchema(accounts);
                const envelopeSchema = z.object({
                    results: z.array(z.object({
                        accountId: z.string().regex(/^account:[0-9a-f]{64}$/),
                        result: genderTriageResultSchema,
                        source: z.enum(['checkpoint', 'safe_fallback']),
                    }).strict()).length(chunk.length),
                    operationKey: z.literal(identity.operationKey),
                }).strict();
                const execute = async (
                    activeFence: AnalysisV2AiJobFence,
                ) => {
                    const audit = adapter(
                        createAudit,
                        activeFence,
                        identity,
                        responseSchema,
                    );
                    const results = await runGenderMicrobatch(accounts, audit, {
                        aiStagePolicyVersion: assertAiStagePolicyVersion(activeFence),
                    });
                    return {
                        results,
                        operationKey: identity.operationKey,
                    };
                };
                const completed = await schedule(group.fence, {
                    key: identity.operationKey,
                    stage: 'genderTriage',
                    schema: envelopeSchema,
                    run: () => execute(group.fence),
                    recover: () => execute({ ...group.fence, schedulerRecoveryOnly: true }),
                    terminalFallback: () => execute({
                        ...group.fence,
                        schedulerTerminalUnavailable: true,
                    }),
                });
                const byAccount = new Map(completed.results.map(result => [
                    result.accountId,
                    result,
                ]));
                for (const plan of chunk) {
                    const result = byAccount.get(plan.accountId);
                    if (!result) {
                        throw new Error('ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_RESULT_MISSING');
                    }
                    const completedResult = {
                        result: result.result,
                        operationKey: completed.operationKey,
                        // Safe fallback is deterministic and scheduler-checkpointed even when the
                        // provider response itself was rejected, so the profile-stage hash remains
                        // replayable without pretending the Gemini result was accepted.
                        resultHash: analysisV2CanonicalAiResultHash(result.result.assessment),
                        source: result.source,
                    } as const;
                    plan.waiters.forEach(waiter => waiter.resolve(completedResult));
                }
            } catch (error) {
                chunk.forEach(plan => plan.waiters.forEach(waiter => waiter.reject(error)));
            }
        }));
    };

    const queueGenderMicrobatch = (
        input: GenderTriageInput,
        fence: AnalysisV2AiJobFence,
        pinnedKey?: string,
        verifiedAccountId?: string,
    ): Promise<AnalysisV2AuditedResult<GenderTriageResult>> => {
        if (!exactSchedulerEnabled(fence)) {
            return Promise.reject(new Error('ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_SCHEDULER_REQUIRED'));
        }
        const accountId = verifiedAccountId ?? createGenderTriageMicrobatchAccountId(
            input,
            assertAiStagePolicyVersion(fence),
        );
        const groupKey = pinnedKey ? `${schedulerBatchKey(fence)}:${pinnedKey}` : schedulerBatchKey(fence);
        let group = pendingGenderMicrobatches.get(groupKey);
        if (!group) {
            group = { fence, plans: [], scheduled: false, pinnedKey };
            pendingGenderMicrobatches.set(groupKey, group);
        }
        return new Promise((resolve, reject) => {
            // The profile-stage operation may be observed more than once while a job is being
            // recovered. It must remain one logical member of the exact batch, never two copies
            // that could make an otherwise valid response ambiguous.
            const existing = group!.plans.find(plan => plan.accountId === accountId);
            if (existing) {
                existing.waiters.push({ resolve, reject });
                return;
            }
            group!.plans.push({
                accountId,
                input,
                fence,
                waiters: [{ resolve, reject }],
            });
            if (!pinnedKey && !group!.scheduled) {
                group!.scheduled = true;
                setTimeout(() => void flushGenderMicrobatch(groupKey), 0);
            }
        });
    };

    return {
        profileGender: {
            plan: (accounts, fence) => planProfileGender(accounts, fence, dependencies.pinProfileGenderPlan),
            async run(inputs, group, fence) {
                const ids = inputs.map(input => createGenderTriageMicrobatchAccountId(input, assertAiStagePolicyVersion(fence)));
                if (ids.length !== group.accountIds.length || ids.some((id, index) => id !== group.accountIds[index])) {
                    throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
                }
                const results = inputs.map((input, index) => (
                    queueGenderMicrobatch(input, fence, group.operationKey, ids[index])
                ));
                void flushGenderMicrobatch(`${schedulerBatchKey(fence)}:${group.operationKey}`);
                return Promise.all(results);
            },
        },
        async gender(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            if (aiStagePolicySupports(policyVersion, 'genderTriageMicrobatchV29')) {
                return queueGenderMicrobatch(input, fence);
            }
            const identity = createGenderTriageResultIdentity(input, policyVersion);
            const execute = async (
                activeFence: AnalysisV2AiJobFence,
            ): Promise<AnalysisV2AuditedResult<GenderTriageResult>> => {
                const audit = adapter(
                    createAudit,
                    activeFence,
                    identity,
                    genderTriageModelResponseSchema
                );
                const result = await runGender(input, audit, {
                    aiStagePolicyVersion: policyVersion,
                });
                return {
                    result,
                    operationKey: identity.operationKey,
                    resultHash: analysisV2CanonicalAiResultHash(result.assessment),
                    source: 'checkpoint',
                };
            };
            if (!exactSchedulerEnabled(fence)) return execute(fence);
            const envelopeSchema = z.object({
                result: genderTriageResultSchema,
                operationKey: z.literal(identity.operationKey),
                resultHash: z.string().regex(AI_RESULT_HASH_PATTERN),
                source: z.literal('checkpoint'),
            }).strict();
            return schedule(fence, {
                key: identity.operationKey,
                stage: 'genderTriage',
                schema: envelopeSchema,
                run: () => execute(fence),
                recover: () => execute({ ...fence, schedulerRecoveryOnly: true }),
                terminalFallback: () => execute({
                    ...fence,
                    schedulerTerminalUnavailable: true,
                }),
            });
        },

        startGenderResolution(input, fence) {
            assertGenderResolutionPolicyVersion(fence);
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createGenderResolutionResultIdentity(input, policyVersion);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                genderResolutionModelResponseSchema,
            );
            const controller = new AbortController();
            let state: AnalysisV2GenderResolutionState = { status: 'pending' };
            let recoveredCutoffFromAudit = false;
            let cutoffStarted: Promise<void> | null = null;
            const completion = (async () => {
                let auditStarted = false;
                try {
                    if (fence.reserveGenderResolutionCapacity) {
                        const admission = await fence.reserveGenderResolutionCapacity(
                            identity.operationKey,
                        );
                        if (state.status !== 'pending') return;
                        if (admission !== 'accepted') {
                            state = { status: 'capacity_skipped' };
                            return;
                        }
                    }
                    auditStarted = true;
                    const run = () => runGenderResolution(input, audit, {
                        abortSignal: controller.signal,
                        aiStagePolicyVersion: policyVersion,
                    });
                    if (fence.admittedStandardResolver && fence.handlerDeadlineAtMs !== undefined
                        && fence.handlerDeadlineAtMs - performance.now() < AI_GEMINI_MIN_REMAINING_MS) {
                        // Reuse a finished decision even near the deadline. A fresh delivery can
                        // perform the first paid attempt if this one cannot safely admit it.
                        const saved = await audit.prepare();
                        if (state.status !== 'pending') return;
                        if (!saved.result) {
                            state = { status: 'deadline_pending' };
                            return;
                        }
                    }
                    const result = fence.admittedStandardResolver
                        ? await withStandardResolverAdmission(controller.signal, run) : await run();
                    if (state.status !== 'pending') return;
                    state = {
                        status: 'ready',
                        value: {
                            result,
                            operationKey: identity.operationKey,
                            resultHash: analysisV2CanonicalAiResultHash(
                                genderResolutionCheckpointAssessment(
                                    input,
                                    result.assessment
                                )
                            ),
                            source: 'checkpoint',
                        },
                    };
                } catch (error) {
                    if (state.status !== 'pending') return;
                    if (fence.admittedStandardResolver && (
                        error instanceof AnalysisV2AiCapacityPendingError
                        || (error instanceof VertexDispatchAuthorizationError && error.reason === 'db_contention')
                    )) {
                        // The gate rolled back before reserving the attempt or sending a request.
                        state = { status: 'unsent_capacity_pending' };
                        return;
                    }
                    if (fence.admittedStandardResolver && error instanceof Error
                        && error.message === 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT') {
                        state = { status: 'deadline_pending' };
                        return;
                    }
                    if (error instanceof DevLiveVertexBudgetReservationPendingError || error instanceof VertexAiBudgetCapacityPendingError) {
                        state = { status: 'budget_reservation_pending', error };
                        return;
                    }
                    // Only the admitted Standard path drains paid siblings across a continuation.
                    if (fence.admittedStandardResolver && error instanceof Error && (
                        error instanceof VertexAiBudgetExceededError
                        || error.message.endsWith('_FENCE_MISMATCH')
                        || error.message === 'ANALYSIS_V2_JOB_LEASE_LOST'
                        || error.message === 'DEV_LIVE_BUDGET_EXCEEDED'
                        || error.message === 'DEV_LIVE_BUDGET_UNAVAILABLE'
                        || error.message.startsWith('VERTEX_AI_BUDGET_RPC_')
                    )) {
                        state = { status: 'blocking_error', error };
                        return;
                    }
                    if (error instanceof Error && (
                        error.message === 'DEV_LIVE_BUDGET_EXCEEDED'
                        || error.message === 'DEV_LIVE_BUDGET_UNAVAILABLE'
                    )) {
                        state = { status: 'terminal_unavailable', budgetError: error.message };
                        return;
                    }
                    if (error instanceof AnalysisV2AiResultRecoveredCutoffError) {
                        // Only the audited resolver can report an exact terminal attempt from prepare().
                        recoveredCutoffFromAudit = auditStarted;
                        state = { status: 'cutoff' };
                        return;
                    }
                    if (fence.admittedStandardResolver && error instanceof LocalResolverPermitTimeoutError && error.attempt === 1) {
                        state = { status: 'capacity_skipped', localFirstAttemptTimedOut: true };
                        return;
                    }
                    state = {
                        status: error instanceof AnalysisV2AiResultRecoveryPendingError
                            ? 'recovery_pending'
                            : error instanceof Error
                                && error.message === 'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'
                                ? 'capacity_skipped'
                                : 'terminal_unavailable',
                    };
                }
            })();
            return {
                operationKey: identity.operationKey,
                completion,
                holdActiveAttempt: audit.holdActiveResolverAttempt,
                finishCurrentOrFirstAttempt: audit.finishCurrentOrFirstResolverAttempt,
                get recoveredCutoffFromAudit() { return recoveredCutoffFromAudit; },
                get cutoffCompletion() { return cutoffStarted; },
                peek: () => state,
                cutoff(reason) {
                    if (cutoffStarted) return cutoffStarted;
                    cutoffStarted = (async () => {
                        if (state.status !== 'pending') return;
                        state = { status: 'cutoff' };
                        controller.abort(reason);
                        try {
                            const maxWaitMs = fence.admittedStandardResolver
                                ? Math.min(ANALYSIS_V2_SCHEDULER_COMMIT_MARGIN_MS, Math.max(0,
                                    (fence.handlerDeadlineAtMs ?? Infinity) - performance.now()))
                                : GENDER_RESOLUTION_CUTOFF_BOOKKEEPING_WAIT_MS;
                            await waitForCutoffBookkeeping(() => audit.cutoff?.(), maxWaitMs);
                        } catch (error) {
                            if (fence.admittedStandardResolver && error instanceof AnalysisV2GenderResolutionCutoffPersistenceError) {
                                // The write may still commit. Only a fenced recovery can decide the outcome.
                                state = { status: 'recovery_pending' };
                                return;
                            }
                            if (error instanceof AnalysisV2AiResultRecoveryPendingError) {
                                state = { status: 'recovery_pending' };
                            }
                            if (error instanceof AnalysisV2AiResultRecoveredCutoffError) {
                                state = { status: 'cutoff' };
                                return;
                            }
                            throw error;
                        }
                    })();
                    return cutoffStarted;
                },
            };
        },

        async features(input, fence, onAttemptReserved) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createFeatureAnalysisResultIdentity(input, policyVersion);
            const execute = async (
                activeFence: AnalysisV2AiJobFence,
            ): Promise<AnalysisV2AuditedResult<FeatureAnalysisResult>> => {
                const audit = adapter(
                    createAudit,
                    activeFence,
                    identity,
                    featureAnalysisModelResponseSchema
                );
                const featureAudit = onAttemptReserved ? {
                    ...audit,
                    async onBeforeAttempt(telemetry: Parameters<typeof audit.onBeforeAttempt>[0]) {
                        await audit.onBeforeAttempt(telemetry);
                        onAttemptReserved();
                    },
                } : audit;
                const result = await runFeatures(input, featureAudit, {
                    aiStagePolicyVersion: policyVersion,
                });
                return {
                    result,
                    operationKey: identity.operationKey,
                    resultHash: analysisV2CanonicalAiResultHash(result.features),
                    source: 'checkpoint',
                };
            };
            if (!exactSchedulerEnabled(fence)) return execute(fence);
            const envelopeSchema = z.object({
                result: featureAnalysisResultSchema,
                operationKey: z.literal(identity.operationKey),
                resultHash: z.string().regex(AI_RESULT_HASH_PATTERN),
                source: z.literal('checkpoint'),
            }).strict();
            return schedule(fence, {
                key: identity.operationKey,
                stage: 'featureAnalysis',
                schema: envelopeSchema,
                run: () => execute(fence),
                recover: () => execute({ ...fence, schedulerRecoveryOnly: true }),
                terminalFallback: () => execute({
                    ...fence,
                    schedulerTerminalUnavailable: true,
                }),
            });
        },

        async privateNames(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const responseSchema = createPrivateNameBatchResponseSchema(
                input.map(account => account.id)
            );
            const identity = createPrivateNameBatchIdentity(input, policyVersion);
            const execute = async (
                activeFence: AnalysisV2AiJobFence,
            ): Promise<AnalysisV2PrivateNameAuditedResult> => {
                let operationKey: string | null = null;
                let envelopeHash: string | null = null;
                let checkpointed = false;
                const checkpointSchema = z.object({ results: responseSchema }).strict();
                const audit: PrivateNameAnalysisAudit = {
                    forChunk(chunkIdentity) {
                        if (
                            chunkIdentity.chunkIndex !== 0
                            || operationKey !== null
                            || chunkIdentity.operationKey !== identity.operationKey
                        ) {
                            throw new Error('ANALYSIS_V2_PRIVATE_NAME_BATCH_IDENTITY_DRIFT');
                        }
                        operationKey = chunkIdentity.operationKey;
                        const durable = adapter(
                            createAudit,
                            activeFence,
                            chunkIdentity.resultIdentity,
                            checkpointSchema
                        );
                        return {
                            requestId: durable.requestId,
                            operationKey: durable.operationKey,
                            resultIdentity: durable.resultIdentity,
                            async prepare() {
                                const prepared = await durable.prepare();
                                if (prepared.result) {
                                    checkpointed = true;
                                    envelopeHash = analysisV2CanonicalAiResultHash(
                                        prepared.result
                                    );
                                }
                                return {
                                    ...prepared,
                                    result: prepared.result?.results ?? null,
                                };
                            },
                            onBeforeAttempt: telemetry => durable.onBeforeAttempt(telemetry),
                            async onAttemptTelemetry(telemetry, parsedResult) {
                                const envelope = parsedResult === undefined
                                    ? undefined
                                    : { results: responseSchema.parse(parsedResult) };
                                await durable.onAttemptTelemetry(telemetry, envelope);
                                if (telemetry.disposition === 'success' && envelope) {
                                    checkpointed = true;
                                    envelopeHash = analysisV2CanonicalAiResultHash(envelope);
                                }
                            },
                            ...(durable.budgetGuard
                                ? { budgetGuard: durable.budgetGuard }
                                : {}),
                            ...(durable.budgetOrderId !== undefined
                                ? { budgetOrderId: durable.budgetOrderId }
                                : {}),
                        };
                    },
                };
                const results = await runPrivateNames(
                    [...input],
                    activeFence.requestId,
                    audit,
                    { aiStagePolicyVersion: policyVersion },
                );
                if (operationKey === null) {
                    throw new Error('ANALYSIS_V2_PRIVATE_NAME_OPERATION_MISSING');
                }
                return {
                    results,
                    operationKey,
                    resultHash: checkpointed ? envelopeHash : null,
                    source: checkpointed ? 'checkpoint' : 'safe_fallback',
                };
            };
            if (!exactSchedulerEnabled(fence)) return execute(fence);
            const resultSchema = z.object({
                results: responseSchema,
                operationKey: z.literal(identity.operationKey),
                resultHash: z.string().regex(AI_RESULT_HASH_PATTERN).nullable(),
                source: z.enum(['checkpoint', 'safe_fallback']),
            }).strict();
            return schedule(fence, {
                key: identity.operationKey,
                stage: 'privateAccountName',
                schema: resultSchema,
                run: () => execute(fence),
                recover: () => execute({ ...fence, schedulerRecoveryOnly: true }),
                terminalFallback: () => execute({
                    ...fence,
                    schedulerTerminalUnavailable: true,
                }),
            });
        },

        async partnerSafety(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createPartnerSafetyResultIdentity(input, policyVersion);
            if (!identity) {
                const result = await runPartnerSafety(
                    input,
                    undefined,
                    { aiStagePolicyVersion: policyVersion },
                );
                return {
                    result,
                    operationKey: '',
                    resultHash: null,
                    source: 'feature_only',
                };
            }
            const audit = adapter(
                createAudit,
                fence,
                identity,
                partnerSafetyModelResponseSchema
            );
            const result = await runPartnerSafety(
                input,
                audit,
                { aiStagePolicyVersion: policyVersion },
            );
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: result.source === 'gemini' && result.assessment
                    ? analysisV2CanonicalAiResultHash(result.assessment)
                    : null,
                source: result.source === 'safe_fallback' ? 'safe_fallback' : 'checkpoint',
            };
        },

        async narrative(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createHighRiskNarrativeResultIdentity(
                input,
                policyVersion,
                aiStagePolicySupports(policyVersion, 'vertexAiCostGuardV1')
                    ? { escalationReason: 'high_value' }
                    : {},
            );
            const audit = adapter(
                createAudit,
                fence,
                identity,
                highRiskNarrativeModelResponseSchema
            );
            const result = await runNarrative(
                input,
                audit,
                {
                    aiStagePolicyVersion: policyVersion,
                    ...(aiStagePolicySupports(policyVersion, 'vertexAiCostGuardV1')
                        ? { escalationReason: 'high_value' as const }
                        : {}),
                },
            );
            const modelEnvelope = {
                lines: [
                    { text: result.lines[0], evidenceRefs: result.evidenceRefs[0] },
                    { text: result.lines[1], evidenceRefs: result.evidenceRefs[1] },
                ],
            };
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: result.source === 'gemini'
                    ? analysisV2CanonicalAiResultHash(modelEnvelope)
                    : null,
                source: result.source === 'safe_fallback' ? 'safe_fallback' : 'checkpoint',
            };
        },
    };
}
