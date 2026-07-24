import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import {
    ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY,
    ANALYSIS_V2_FINALIZE_JOB_KEY,
    ANALYSIS_V2_FINAL_SCORE_JOB_KEY,
    ANALYSIS_V2_NARRATIVE_JOB_KEY,
    ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
    ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
    assertAnalysisV2DagJob,
    buildAnalysisV2DagPlan,
    successorsForAnalysisV2Job,
    type AnalysisV2DagJob,
    type AnalysisV2DagPlan,
    type AnalysisV2DagState,
} from './v2-dag-planner';
import {
    AnalysisV2DagScopeMissingError,
    AnalysisV2DagStateConflictError,
    AnalysisV2DagStateFenceError,
    createSupabaseAnalysisV2DagStateStore,
    type AnalysisV2DagManifestCheckpoint,
    type AnalysisV2DagStateStore,
} from './v2-dag-state-store';
import {
    AnalysisV2JobFenceError,
    analysisV2JobStore,
    type AnalysisV2JobStore,
    type AnalysisV2JobSuccessor,
    type AnalysisV2TaskDelivery,
    type ClaimedAnalysisV2Job,
} from './v2-job-store';
import {
    AnalysisV2ProgressConflictError,
    AnalysisV2ProgressFenceError,
} from './v2-progress-store';
import {
    createAnalysisV2ProgressReporter,
    type AnalysisV2ProgressReporter,
} from './v2-progress-reporter';
import {
    cleanupConfiguredAnalysisV2TerminalMedia,
} from './v2-media-artifact-store';
import { analysisV2ResultStore } from './v2-result-store';
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';
import {
    analysisV2AiPolicyStore,
    type AnalysisV2AiPolicyStore,
} from './v2-ai-policy-store';
import { prepareAnalysisV2ProviderRunsForTerminalFailure } from './v2-provider-lifecycle';
import { analysisV2ProviderRunStore } from './v2-provider-run-store';
import { getAnalysisV2ProductionExecutorRegistry } from './v2-production-executors';
import { dispatchAnalysisV2Job } from './v2-tasks';
import {
    ANALYSIS_V2_GENERIC_JOB_FAILURE_CODE,
    isAnalysisV2WorkerErrorCode,
} from './v2-worker-error-codes';

const PROFILE_FETCH_JOB_PATTERN = /^track:profiles:batch:\d+$/;
const PROFILE_AI_JOB_PATTERN = /^track:profile-ai:batch:\d+$/;
const PRIVATE_NAME_JOB_PATTERN = /^track:private-names:batch:\d+$/;
export const ANALYSIS_V2_JOB_MAX_ATTEMPTS = 7;
export const ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS = 20;

export type AnalysisV2StageId =
    | 'relationships'
    | 'target_evidence'
    | 'profile_fetch'
    | 'profile_ai'
    | 'private_names'
    | 'primary_join'
    | 'screening'
    | 'reverse_likes'
    | 'partner_safety'
    | 'final_score'
    | 'narrative'
    | 'finalize';

const AI_PROVIDER_STAGES: ReadonlySet<AnalysisV2StageId> = new Set([
    'profile_ai',
    'private_names',
    'partner_safety',
    'narrative',
]);

type CheckpointWithKind<K extends AnalysisV2DagManifestCheckpoint['kind']> = Extract<
    AnalysisV2DagManifestCheckpoint extends infer Checkpoint
        ? Checkpoint extends { kind: infer Kind }
            ? K extends Kind
                ? Omit<Checkpoint, 'kind'> & { kind: K }
                : never
            : never
        : never,
    { kind: K }
>;

export interface AnalysisV2StageCheckpointMap {
    relationships: CheckpointWithKind<'relationships'>;
    target_evidence: CheckpointWithKind<'target_evidence'>;
    profile_fetch: CheckpointWithKind<'profile_fetch_batch'>;
    profile_ai: CheckpointWithKind<'profile_ai_batch'>;
    private_names: CheckpointWithKind<'private_name_batch'>;
    primary_join: CheckpointWithKind<'primary_join'>;
    screening: CheckpointWithKind<'screening'>;
    reverse_likes: CheckpointWithKind<'reverse_likes'>;
    partner_safety: CheckpointWithKind<'partner_safety'>;
    final_score: CheckpointWithKind<'final_score'>;
    narrative: CheckpointWithKind<'narrative'>;
    finalize: null;
}

export interface AnalysisV2StageExecutorContext<S extends AnalysisV2StageId> {
    stage: S;
    claim: ClaimedAnalysisV2Job;
    job: AnalysisV2DagJob;
    state: AnalysisV2DagState;
    aiStagePolicyVersion: string | null;
    /** Reports the exact profile whose work is starting; persistence masks the handle. */
    reportActiveProfile?: (username: string) => Promise<void>;
}

export type AnalysisV2StageExecutor<S extends AnalysisV2StageId> = (
    context: AnalysisV2StageExecutorContext<S>
) => Promise<Readonly<{ checkpoint: AnalysisV2StageCheckpointMap[S] }>>;

/** Missing keys intentionally fail closed; production opens only explicitly registered stages. */
export type AnalysisV2StageExecutorRegistry = Readonly<{
    [S in AnalysisV2StageId]?: AnalysisV2StageExecutor<S>;
}>;

export type AnalysisV2JobHandler = (
    job: ClaimedAnalysisV2Job
) => Promise<readonly AnalysisV2JobSuccessor[]>;

export type AnalysisV2JobDispatcher = (
    requestId: string,
    jobKey: string
) => Promise<unknown>;

export type AnalysisV2TerminalFailureFinalizer = (
    claim: ClaimedAnalysisV2Job,
    errorCode: string
) => Promise<unknown>;

export type AnalysisV2TerminalMediaCleanup = () => Promise<unknown>;
export type AnalysisV2TerminalFailureIntentLoader = (
    claim: ClaimedAnalysisV2Job
) => Promise<string | null>;

export type AnalysisV2WorkerOutcome =
    | Readonly<{ status: 'already_terminal' }>
    | Readonly<{ status: 'retry'; errorCode: string }>
    | Readonly<{ status: 'failed'; errorCode: string }>
    | Readonly<{
        status: 'completed';
        successorCount: number;
        pendingRecoveryCount: number;
    }>;

const PROVIDER_RUN_CLEANUP_REQUIRED_CODE =
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED';
const PROVIDER_RUN_CLEANUP_DEFER_CODES = new Set([
    PROVIDER_RUN_CLEANUP_REQUIRED_CODE,
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT',
]);

export type AnalysisV2JobFailureDisposition = 'permanent' | 'transient' | 'fence';

export class AnalysisV2JobExecutionError extends Error {
    readonly code: string;
    readonly disposition: AnalysisV2JobFailureDisposition;
    readonly retryable: boolean;

    constructor(
        code: string,
        disposition: AnalysisV2JobFailureDisposition | boolean
    ) {
        const safeCode = isAnalysisV2WorkerErrorCode(code)
            ? code
            : ANALYSIS_V2_GENERIC_JOB_FAILURE_CODE;
        super(safeCode);
        this.name = 'AnalysisV2JobExecutionError';
        this.code = safeCode;
        this.disposition = !isAnalysisV2WorkerErrorCode(code)
            ? 'permanent'
            : typeof disposition === 'boolean'
                ? disposition ? 'transient' : 'permanent'
                : disposition;
        this.retryable = this.disposition === 'transient';
    }
}

const defaultDagStateStore = createSupabaseAnalysisV2DagStateStore();
const defaultProgressReporter = createAnalysisV2ProgressReporter({
    reloadState: requestId => defaultDagStateStore.load(requestId),
});
const EMPTY_EXECUTOR_REGISTRY: AnalysisV2StageExecutorRegistry = Object.freeze({});

export async function finalizeAnalysisV2TerminalFailure(
    claim: ClaimedAnalysisV2Job,
    errorCode: string,
    dependencies: {
        prepareProviderRuns?: typeof prepareAnalysisV2ProviderRunsForTerminalFailure;
        failRequest?: AnalysisV2TerminalFailureFinalizer;
    } = {}
): Promise<unknown> {
    const failure = {
        requestId: claim.requestId,
        jobKey: claim.jobKey,
        claimToken: claim.claimToken,
        jobInputHash: claim.inputHash,
        errorCode,
    };
    await (dependencies.prepareProviderRuns
        ?? prepareAnalysisV2ProviderRunsForTerminalFailure)(failure);
    return (dependencies.failRequest
        ?? (input => analysisV2ResultStore.fail({
            requestId: input.requestId,
            jobKey: input.jobKey,
            claimToken: input.claimToken,
            jobInputHash: input.inputHash,
            errorCode,
        })))(claim, errorCode);
}

const finalizeTerminalFailure: AnalysisV2TerminalFailureFinalizer =
    finalizeAnalysisV2TerminalFailure;

const cleanupTerminalMedia: AnalysisV2TerminalMediaCleanup = async () => {
    await cleanupConfiguredAnalysisV2TerminalMedia();
};

const loadTerminalFailureIntent: AnalysisV2TerminalFailureIntentLoader = async claim => {
    const intent = await analysisV2ProviderRunStore.loadCleanupIntent(claim.requestId);
    if (!intent) return null;
    if (
        intent.jobKey !== claim.jobKey
        || intent.jobInputHash !== claim.inputHash
    ) {
        throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
    }
    return intent.errorCode;
};

function executionError(code: string, disposition: AnalysisV2JobFailureDisposition): never {
    throw new AnalysisV2JobExecutionError(code, disposition);
}

function assertBootstrapClaim(job: ClaimedAnalysisV2Job): void {
    if (
        job.jobKey !== ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        || job.track !== 'coordinator'
        || job.kind !== 'bootstrap'
        || job.batch !== null
    ) {
        executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', 'permanent');
    }
    if (
        job.inputHash
        !== analysisV2JobInputHash(job.requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY)
    ) {
        executionError('ANALYSIS_V2_JOB_INPUT_MISMATCH', 'permanent');
    }
}

function isKnownAnalysisV2JobKey(jobKey: string): boolean {
    return jobKey === ANALYSIS_V2_RELATIONSHIPS_JOB_KEY
        || jobKey === ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY
        || jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY
        || jobKey === ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY
        || jobKey === ANALYSIS_V2_REVERSE_LIKES_JOB_KEY
        || jobKey === ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY
        || jobKey === ANALYSIS_V2_FINAL_SCORE_JOB_KEY
        || jobKey === ANALYSIS_V2_NARRATIVE_JOB_KEY
        || jobKey === ANALYSIS_V2_FINALIZE_JOB_KEY
        || PROFILE_FETCH_JOB_PATTERN.test(jobKey)
        || PROFILE_AI_JOB_PATTERN.test(jobKey)
        || PRIVATE_NAME_JOB_PATTERN.test(jobKey);
}

function stageForJob(job: AnalysisV2DagJob): AnalysisV2StageId {
    if (job.jobKey === ANALYSIS_V2_RELATIONSHIPS_JOB_KEY) return 'relationships';
    if (job.jobKey === ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY) return 'target_evidence';
    if (job.jobKey === ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY) return 'primary_join';
    if (job.jobKey === ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY) return 'screening';
    if (job.jobKey === ANALYSIS_V2_REVERSE_LIKES_JOB_KEY) return 'reverse_likes';
    if (job.jobKey === ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY) return 'partner_safety';
    if (job.jobKey === ANALYSIS_V2_FINAL_SCORE_JOB_KEY) return 'final_score';
    if (job.jobKey === ANALYSIS_V2_NARRATIVE_JOB_KEY) return 'narrative';
    if (job.jobKey === ANALYSIS_V2_FINALIZE_JOB_KEY) return 'finalize';
    if (PROFILE_FETCH_JOB_PATTERN.test(job.jobKey)) return 'profile_fetch';
    if (PROFILE_AI_JOB_PATTERN.test(job.jobKey)) return 'profile_ai';
    if (PRIVATE_NAME_JOB_PATTERN.test(job.jobKey)) return 'private_names';
    return executionError('ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE', 'permanent');
}

function persistedBatch(
    batches: AnalysisV2DagState['profileFetchBatches'],
    job: AnalysisV2DagJob
): boolean {
    return job.batch !== null && Boolean(batches?.some(batch => (
        batch.batch === job.batch && batch.producerInputHash === job.inputHash
    )));
}

function hasPersistedCheckpoint(
    stage: AnalysisV2StageId,
    job: AnalysisV2DagJob,
    state: AnalysisV2DagState
): boolean {
    switch (stage) {
        case 'relationships': return state.relationships !== undefined;
        case 'target_evidence': return state.targetEvidence !== undefined;
        case 'profile_fetch': return persistedBatch(state.profileFetchBatches, job);
        case 'profile_ai': return persistedBatch(state.profileAiBatches, job);
        case 'private_names': return persistedBatch(state.privateNameBatches, job);
        case 'primary_join': return state.primaryJoin !== undefined;
        case 'screening': return state.screening !== undefined;
        case 'reverse_likes': return state.reverseLikes !== undefined;
        case 'partner_safety': return state.partnerSafety !== undefined;
        case 'final_score': return state.finalScore !== undefined;
        case 'narrative': return state.narrative !== undefined;
        case 'finalize': return false;
    }
}

function plannedJobForClaim(
    claim: ClaimedAnalysisV2Job,
    plan: AnalysisV2DagPlan,
    state: AnalysisV2DagState
): Readonly<{ job: AnalysisV2DagJob; stage: AnalysisV2StageId }> {
    const candidate = plan.jobs.find(job => job.jobKey === claim.jobKey);
    if (!candidate) {
        if (isKnownAnalysisV2JobKey(claim.jobKey)) {
            executionError('ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY', 'transient');
        }
        executionError('ANALYSIS_V2_JOB_UNKNOWN', 'permanent');
    }
    if (candidate.inputHash !== claim.inputHash) {
        executionError('ANALYSIS_V2_JOB_INPUT_MISMATCH', 'permanent');
    }

    let planned: AnalysisV2DagJob;
    try {
        planned = assertAnalysisV2DagJob(plan, claim);
    } catch {
        return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', 'permanent');
    }
    if (
        planned.track !== claim.track
        || planned.kind !== claim.kind
        || planned.batch !== claim.batch
    ) {
        executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', 'permanent');
    }

    for (const dependencyKey of planned.requiredJobKeys) {
        const dependency = plan.jobs.find(job => job.jobKey === dependencyKey);
        if (!dependency) executionError('ANALYSIS_V2_DAG_PLAN_INVALID', 'permanent');
        const dependencyStage = stageForJob(dependency);
        if (!hasPersistedCheckpoint(dependencyStage, dependency, state)) {
            executionError('ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY', 'transient');
        }
    }

    return Object.freeze({ job: planned, stage: stageForJob(planned) });
}

function canonicalPlan(
    claim: ClaimedAnalysisV2Job,
    state: AnalysisV2DagState
): Readonly<{ plan: AnalysisV2DagPlan; job: AnalysisV2DagJob; stage: AnalysisV2StageId }> {
    let plan: AnalysisV2DagPlan;
    try {
        plan = buildAnalysisV2DagPlan(claim.requestId, state);
    } catch {
        return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', 'permanent');
    }
    const planned = plannedJobForClaim(claim, plan, state);
    return Object.freeze({ plan, ...planned });
}

async function loadDagState(
    claim: ClaimedAnalysisV2Job,
    store: AnalysisV2DagStateStore
): Promise<AnalysisV2DagState> {
    const state = await store.load(claim.requestId);
    if (!state) executionError('ANALYSIS_V2_DAG_SCOPE_MISSING', 'permanent');
    return state;
}

const CHECKPOINT_KIND_BY_STAGE: Readonly<
    Partial<Record<AnalysisV2StageId, AnalysisV2DagManifestCheckpoint['kind']>>
> = Object.freeze({
    relationships: 'relationships',
    target_evidence: 'target_evidence',
    profile_fetch: 'profile_fetch_batch',
    profile_ai: 'profile_ai_batch',
    private_names: 'private_name_batch',
    primary_join: 'primary_join',
    screening: 'screening',
    reverse_likes: 'reverse_likes',
    partner_safety: 'partner_safety',
    final_score: 'final_score',
    narrative: 'narrative',
});

function assertCheckpointMatchesJob(
    stage: AnalysisV2StageId,
    job: AnalysisV2DagJob,
    checkpoint: AnalysisV2DagManifestCheckpoint | null
): asserts checkpoint is AnalysisV2DagManifestCheckpoint {
    if (stage === 'finalize') {
        if (checkpoint !== null) {
            executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', 'permanent');
        }
        return;
    }
    if (!checkpoint || checkpoint.kind !== CHECKPOINT_KIND_BY_STAGE[stage]) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', 'permanent');
    }
    if (
        checkpoint.kind === 'profile_fetch_batch'
        || checkpoint.kind === 'profile_ai_batch'
        || checkpoint.kind === 'private_name_batch'
    ) {
        if (
            job.batch === null
            || checkpoint.manifest.batch !== job.batch
            || checkpoint.manifest.producerInputHash !== job.inputHash
        ) {
            executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', 'permanent');
        }
    }
}

async function executeRegisteredStage<S extends AnalysisV2StageId>(
    stage: S,
    registry: AnalysisV2StageExecutorRegistry,
    context: Omit<AnalysisV2StageExecutorContext<S>, 'stage'>
): Promise<AnalysisV2StageCheckpointMap[S]> {
    const executor = registry[stage] as AnalysisV2StageExecutor<S> | undefined;
    if (!executor) executionError('ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE', 'permanent');
    const result = await executor({ stage, ...context });
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'checkpoint')) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', 'permanent');
    }
    return result.checkpoint;
}

/**
 * Executes one durable DAG stage. The worker owns the manifest fence and derives fanout only
 * from a fresh canonical state, so provider retries cannot invent topology.
 */
export async function executeAnalysisV2DagJob(
    claim: ClaimedAnalysisV2Job,
    dependencies: {
        stateStore?: AnalysisV2DagStateStore;
        executors?: AnalysisV2StageExecutorRegistry;
        progressReporter?: AnalysisV2ProgressReporter | null;
        aiPolicyStore?: AnalysisV2AiPolicyStore;
    } = {}
): Promise<readonly AnalysisV2JobSuccessor[]> {
    const stateStore = dependencies.stateStore ?? defaultDagStateStore;
    const executors = dependencies.executors ?? (
        dependencies.stateStore !== undefined
            ? EMPTY_EXECUTOR_REGISTRY
            : getAnalysisV2ProductionExecutorRegistry()
    );
    const progressReporter = dependencies.progressReporter !== undefined
        ? dependencies.progressReporter
        : dependencies.stateStore || dependencies.executors
            ? null
            : defaultProgressReporter;
    const aiPolicyStore = dependencies.aiPolicyStore ?? analysisV2AiPolicyStore;

    if (claim.jobKey === ANALYSIS_V2_BOOTSTRAP_JOB_KEY) {
        assertBootstrapClaim(claim);
        const state = await stateStore.initializeScope({
            requestId: claim.requestId,
            jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            inputHash: claim.inputHash,
            claimToken: claim.claimToken,
        });
        let plan: AnalysisV2DagPlan;
        try {
            plan = buildAnalysisV2DagPlan(claim.requestId, state);
            const bootstrap = assertAnalysisV2DagJob(plan, claim);
            if (
                bootstrap.track !== claim.track
                || bootstrap.kind !== claim.kind
                || bootstrap.batch !== claim.batch
            ) {
                executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', 'permanent');
            }
        } catch (error) {
            if (error instanceof AnalysisV2JobExecutionError) throw error;
            return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', 'permanent');
        }
        await progressReporter?.initialize({ claim, state });
        return successorsForAnalysisV2Job(plan, claim);
    }

    const state = await loadDagState(claim, stateStore);
    const current = canonicalPlan(claim, state);
    if (hasPersistedCheckpoint(current.stage, current.job, state)) {
        await progressReporter?.report({
            claim,
            state,
            stage: current.stage,
            includeStageEvent: false,
        });
        return successorsForAnalysisV2Job(current.plan, claim);
    }

    let aiStagePolicyVersion: string | null = null;
    if (AI_PROVIDER_STAGES.has(current.stage)) {
        aiStagePolicyVersion = await aiPolicyStore.loadAiStagePolicyVersion(claim.requestId);
        if (aiStagePolicyVersion !== AI_STAGE_POLICY_VERSION) {
            executionError('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH', 'permanent');
        }
    }

    const activeProfileStage = current.stage === 'profile_fetch'
        || current.stage === 'profile_ai'
        ? current.stage
        : null;
    const activeProfileBatchTotal = activeProfileStage
        ? state.relationships?.profileBatches.find(batch => batch.batch === current.job.batch)
            ?.itemCount ?? null
        : null;
    if (activeProfileStage && activeProfileBatchTotal === null) {
        executionError('ANALYSIS_V2_PROFILE_PROGRESS_TOPOLOGY_MISSING', 'permanent');
    }
    let lastActiveProfileStartedAtMs = 0;
    const checkpoint = await executeRegisteredStage(current.stage, executors, {
        claim,
        job: current.job,
        state,
        aiStagePolicyVersion,
        ...(progressReporter?.heartbeat && activeProfileStage ? {
            reportActiveProfile: async (username: string) => {
                const startedAtMs = Math.max(
                    Date.now(),
                    lastActiveProfileStartedAtMs + 1
                );
                lastActiveProfileStartedAtMs = startedAtMs;
                await progressReporter.heartbeat!({
                    claim,
                    stage: activeProfileStage,
                    username,
                    startedAt: new Date(startedAtMs).toISOString(),
                    totalCount: activeProfileBatchTotal!,
                });
            },
        } : {}),
    });
    assertCheckpointMatchesJob(current.stage, current.job, checkpoint);
    if (checkpoint) await stateStore.checkpointManifest(claim, checkpoint);

    const persistedState = await loadDagState(claim, stateStore);
    const persisted = canonicalPlan(claim, persistedState);
    if (
        current.stage !== 'finalize'
        && !hasPersistedCheckpoint(persisted.stage, persisted.job, persistedState)
    ) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_NOT_VISIBLE', 'transient');
    }
    if (current.stage !== 'finalize') {
        await progressReporter?.report({
            claim,
            state: persistedState,
            stage: current.stage,
        });
    }
    return successorsForAnalysisV2Job(persisted.plan, claim);
}

/** Compatibility alias retained for callers created with the Phase C foundation. */
export async function executeAnalysisV2FoundationJob(
    job: ClaimedAnalysisV2Job,
    dependencies: {
        stateStore?: AnalysisV2DagStateStore;
        executors?: AnalysisV2StageExecutorRegistry;
        progressReporter?: AnalysisV2ProgressReporter | null;
        aiPolicyStore?: AnalysisV2AiPolicyStore;
    } = {}
): Promise<readonly AnalysisV2JobSuccessor[]> {
    return executeAnalysisV2DagJob(job, dependencies);
}

const TRANSIENT_FAILURE_CODES = new Set([
    'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR',
    'AI_RATE_LIMIT_ERROR',
    'ANALYSIS_V2_AI_ATTEMPT_NOT_READY',
    'ANALYSIS_V2_AI_RESULT_NOT_READY',
    'ANALYSIS_V2_AI_STAGE_POLICY_PERSISTENCE_ERROR',
    'ANALYSIS_V2_FINALIZE_NOT_READY',
    'ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY',
    'ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT',
    'ANALYSIS_V2_PROFILE_AI_BATCH_NOT_READY',
    'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY',
    'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY',
    'ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME',
    'ANALYSIS_V2_PROGRESS_CONFLICT',
    'ANALYSIS_V2_PROVIDER_RUN_ALREADY_RESERVED',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY',
    'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
    'ANALYSIS_V2_PROVIDER_RUN_RECONCILIATION_NOT_READY',
    'ANALYSIS_V2_RELATIONSHIP_EVIDENCE_NOT_READY',
    'ANALYSIS_V2_RELATIONSHIP_NOT_READY',
    'ANALYSIS_V2_RESULT_NOT_READY',
    'ANALYSIS_V2_SCREENING_NOT_READY',
    'ANALYSIS_V2_STAGE_CHECKPOINT_NOT_VISIBLE',
    'ANALYSIS_V2_TARGET_EVIDENCE_NOT_READY',
    'ANALYSIS_V2_TARGET_PROFILE_NOT_READY',
    'SCRAPING_DATASET_TRANSIENT_ERROR',
    'SCRAPING_RUN_PENDING_ERROR',
]);

const PERMANENT_FAILURE_CODES = new Set([
    'AI_AMBIGUOUS_GENERATION_ERROR',
    'AI_GENERATION_REQUEST_ERROR',
    'AI_GENERATION_RESPONSE_REJECTED_ERROR',
    'ANALYSIS_V2_AI_ATTEMPT_NOT_RETRYABLE',
    'ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE',
    'ANALYSIS_V2_TARGET_PROFILE_UNAVAILABLE',
    'SCRAPING_PROVIDER_QUOTA_ERROR',
]);

const TRANSIENT_TRANSPORT_PATTERNS = [
    /\b(?:econnreset|etimedout|eai_again|enotfound)\b/i,
    /\b(?:network|socket|fetch failed|timed?\s*out|timeout|deadline exceeded)\b/i,
    /\babort(?:ed|error)?\b/i,
];

function stableFailureCode(error: Error): string | null {
    const match = error.message.match(/^([A-Z][A-Z0-9_]{2,63})(?::|\s|\(|$)/);
    const code = match?.[1];
    return isAnalysisV2WorkerErrorCode(code) ? code : null;
}

function hasTransientTransportSignal(error: unknown, depth = 0): boolean {
    if (!error || typeof error !== 'object' || depth > 2) return false;
    const candidate = error as { name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') return true;
    const message = candidate.message;
    return (
        typeof message === 'string'
        && TRANSIENT_TRANSPORT_PATTERNS.some(pattern => pattern.test(message))
    ) || hasTransientTransportSignal(candidate.cause, depth + 1);
}

function isFenceFailureCode(code: string): boolean {
    return code.endsWith('_FENCE_MISMATCH')
        || code === 'ANALYSIS_V2_JOB_LEASE_LOST';
}

function isDeterministicPersistenceFailure(error: Error): boolean {
    return /^[A-Z][A-Z0-9_]*_PERSISTENCE_ERROR:\s*(?:invalid\b|.*\b(?:drift|mismatch)\b)/i
        .test(error.message);
}

function isTransientProfileCheckpointFailure(error: Error): boolean {
    const match = error.message.match(
        /^ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: [a-z ]+ failed \(([A-Za-z0-9_]{1,32})\)\.$/
    );
    if (!match) return false;
    const rpcCode = match[1].toUpperCase();
    return rpcCode === 'UNKNOWN'
        || rpcCode === 'PGRST000'
        || /^(?:08|40|53)[A-Z0-9]{3}$/.test(rpcCode)
        || /^(?:57P0[123]|58030)$/.test(rpcCode);
}

function isTransientMediaObjectFailure(error: Error): boolean {
    const match = error.message.match(
        /^ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: [a-z ]+ failed \((unknown|[1-5][0-9]{2})\)\.$/
    );
    if (!match) return false;
    if (match[1] === 'unknown') return true;
    const status = Number(match[1]);
    return status === 408 || status === 429 || status >= 500;
}

function failureDispositionForCode(
    code: string,
    error: Error
): AnalysisV2JobFailureDisposition {
    if (isFenceFailureCode(code)) return 'fence';
    if (
        code === 'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR'
        && isTransientProfileCheckpointFailure(error)
    ) {
        return 'transient';
    }
    if (
        code === 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
        && isTransientMediaObjectFailure(error)
    ) {
        return 'transient';
    }
    if (TRANSIENT_FAILURE_CODES.has(code)) return 'transient';
    if (PERMANENT_FAILURE_CODES.has(code)) return 'permanent';
    if (isDeterministicPersistenceFailure(error)) return 'permanent';
    if (code.endsWith('_PERSISTENCE_ERROR')) return 'transient';
    if (code.endsWith('_RATE_LIMITED') || code.endsWith('_RATE_LIMIT_ERROR')) {
        return 'transient';
    }
    if (
        code.endsWith('_NOT_READY')
        || code.endsWith('_RETRYABLE_OUTCOME')
    ) {
        return 'transient';
    }
    if (
        code.includes('_VALIDATION_ERROR')
        || code.includes('_CONFIG_ERROR')
        || code.includes('_INVALID_')
        || code.endsWith('_INVALID')
        || code.includes('_SCOPE_')
        || code.includes('_BUDGET_')
        || code.includes('_LIMIT_')
        || code.endsWith('_DRIFT')
        || code.endsWith('_CONFLICT')
        || code.endsWith('_MISMATCH')
        || code.endsWith('_INCOMPLETE')
        || code.endsWith('_MISSING')
    ) {
        return 'permanent';
    }
    return 'permanent';
}

async function finalizeTerminalFailureOrDeferProviderCleanup(
    claim: ClaimedAnalysisV2Job,
    errorCode: string,
    store: AnalysisV2JobStore,
    finalizer: AnalysisV2TerminalFailureFinalizer
): Promise<Extract<AnalysisV2WorkerOutcome, { status: 'retry' }> | null> {
    try {
        await finalizer(claim, errorCode);
        return null;
    } catch (error) {
        return deferClaimForProviderCleanupRetry(claim, store, error);
    }
}

async function deferClaimForProviderCleanupRetry(
    claim: ClaimedAnalysisV2Job,
    store: AnalysisV2JobStore,
    error: unknown
): Promise<Extract<AnalysisV2WorkerOutcome, { status: 'retry' }>> {
    if (
        !(error instanceof Error)
        || !PROVIDER_RUN_CLEANUP_DEFER_CODES.has(error.message)
    ) {
        throw error;
    }
    const deferred = await store.deferTerminalCleanup(claim);
    if (!deferred.released || deferred.status !== 'pending') {
        throw new Error('ANALYSIS_V2_TERMINAL_FAILURE_CLEANUP_REQUIRED');
    }
    return Object.freeze({
        status: 'retry',
        errorCode: PROVIDER_RUN_CLEANUP_REQUIRED_CODE,
    });
}

/** Maps executor failures to one sanitized code and an explicit retry/fence disposition. */
export function classifyAnalysisV2JobFailure(error: unknown): AnalysisV2JobExecutionError {
    if (error instanceof AnalysisV2JobExecutionError) return error;
    if (error instanceof AnalysisV2DagStateConflictError) {
        return new AnalysisV2JobExecutionError('ANALYSIS_V2_DAG_STATE_CONFLICT', 'permanent');
    }
    if (error instanceof AnalysisV2DagScopeMissingError) {
        return new AnalysisV2JobExecutionError('ANALYSIS_V2_DAG_SCOPE_MISSING', 'permanent');
    }
    if (error instanceof AnalysisV2DagStateFenceError) {
        return new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH',
            'fence'
        );
    }
    if (error instanceof AnalysisV2ProgressFenceError) {
        return new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH',
            'fence'
        );
    }
    if (error instanceof AnalysisV2ProgressConflictError) {
        return new AnalysisV2JobExecutionError('ANALYSIS_V2_PROGRESS_CONFLICT', 'transient');
    }
    if (error instanceof Error) {
        if (error.name === 'ZodError') {
            return new AnalysisV2JobExecutionError(
                'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
                'permanent'
            );
        }
        const code = stableFailureCode(error);
        if (code) {
            return new AnalysisV2JobExecutionError(
                code,
                failureDispositionForCode(code, error)
            );
        }
        if (hasTransientTransportSignal(error)) {
            return new AnalysisV2JobExecutionError(
                'ANALYSIS_V2_TRANSIENT_TRANSPORT_ERROR',
                'transient'
            );
        }
    }
    return new AnalysisV2JobExecutionError(
        ANALYSIS_V2_GENERIC_JOB_FAILURE_CODE,
        'permanent'
    );
}

export async function processAnalysisV2TaskDelivery(
    delivery: AnalysisV2TaskDelivery,
    dependencies: {
        store?: AnalysisV2JobStore;
        stateStore?: AnalysisV2DagStateStore;
        executors?: AnalysisV2StageExecutorRegistry;
        progressReporter?: AnalysisV2ProgressReporter | null;
        aiPolicyStore?: AnalysisV2AiPolicyStore;
        handler?: AnalysisV2JobHandler;
        dispatch?: AnalysisV2JobDispatcher;
        terminalFailureFinalizer?: AnalysisV2TerminalFailureFinalizer;
        terminalMediaCleanup?: AnalysisV2TerminalMediaCleanup;
        terminalFailureIntentLoader?: AnalysisV2TerminalFailureIntentLoader;
    } = {}
): Promise<AnalysisV2WorkerOutcome> {
    const store = dependencies.store ?? analysisV2JobStore;
    const handler = dependencies.handler ?? (claim => executeAnalysisV2DagJob(claim, {
        stateStore: dependencies.stateStore,
        executors: dependencies.executors,
        progressReporter: dependencies.progressReporter,
        aiPolicyStore: dependencies.aiPolicyStore,
    }));
    const dispatch = dependencies.dispatch ?? dispatchAnalysisV2Job;
    const claim = await store.claim(delivery);
    if (!claim) return Object.freeze({ status: 'already_terminal' });

    let pendingTerminalFailure: string | null;
    try {
        pendingTerminalFailure = await (
            dependencies.terminalFailureIntentLoader ?? loadTerminalFailureIntent
        )(claim);
    } catch (error) {
        return deferClaimForProviderCleanupRetry(claim, store, error);
    }
    if (pendingTerminalFailure) {
        const cleanupRetry = await finalizeTerminalFailureOrDeferProviderCleanup(
            claim,
            pendingTerminalFailure,
            store,
            dependencies.terminalFailureFinalizer ?? finalizeTerminalFailure
        );
        if (cleanupRetry) return cleanupRetry;
        try {
            await (dependencies.terminalMediaCleanup ?? cleanupTerminalMedia)();
        } catch {
            // The recovery sweep retries exact-generation cleanup after terminalization.
        }
        return Object.freeze({
            status: 'failed',
            errorCode: pendingTerminalFailure,
        });
    }

    let successors: readonly AnalysisV2JobSuccessor[];
    try {
        successors = await handler(claim);
    } catch (error) {
        const failure = classifyAnalysisV2JobFailure(error);
        if (failure.disposition === 'fence') {
            throw new AnalysisV2JobFenceError();
        }
        const maxAttempts = claim.jobKey === ANALYSIS_V2_FINALIZE_JOB_KEY
            ? ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS
            : ANALYSIS_V2_JOB_MAX_ATTEMPTS;
        const exhausted = failure.retryable
            && claim.attemptCount >= maxAttempts;
        if (!failure.retryable || exhausted) {
            const cleanupRetry = await finalizeTerminalFailureOrDeferProviderCleanup(
                claim,
                exhausted ? 'JOB_ATTEMPTS_EXHAUSTED' : failure.code,
                store,
                dependencies.terminalFailureFinalizer ?? finalizeTerminalFailure
            );
            if (cleanupRetry) return cleanupRetry;
            try {
                await (dependencies.terminalMediaCleanup ?? cleanupTerminalMedia)();
            } catch {
                // The recovery sweep retries exact-generation cleanup after terminalization.
            }
            return Object.freeze({
                status: 'failed',
                errorCode: exhausted ? 'JOB_ATTEMPTS_EXHAUSTED' : failure.code,
            });
        }
        const released = await store.releaseClaim(claim, {
            errorCode: failure.code,
            retryable: failure.retryable,
            maxAttempts,
        });
        if (released.status === 'failed' || released.status === 'cancelled') {
            throw new Error('ANALYSIS_V2_TERMINAL_FAILURE_CLEANUP_REQUIRED');
        }
        return Object.freeze({ status: 'retry', errorCode: failure.code });
    }

    const dispatchable = await store.completeAndFanout(claim, successors);
    const settled = await Promise.allSettled(
        dispatchable.map(job => dispatch(job.requestId, job.jobKey))
    );
    const pendingRecoveryCount = settled.filter(result => result.status === 'rejected').length;
    return Object.freeze({
        status: 'completed',
        successorCount: dispatchable.length,
        pendingRecoveryCount,
    });
}
