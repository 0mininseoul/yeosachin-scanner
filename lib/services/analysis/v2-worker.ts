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
    analysisV2JobStore,
    type AnalysisV2JobStore,
    type AnalysisV2JobSuccessor,
    type AnalysisV2TaskDelivery,
    type ClaimedAnalysisV2Job,
} from './v2-job-store';
import { dispatchAnalysisV2Job } from './v2-tasks';

const PROFILE_FETCH_JOB_PATTERN = /^track:profiles:batch:\d+$/;
const PROFILE_AI_JOB_PATTERN = /^track:profile-ai:batch:\d+$/;
const PRIVATE_NAME_JOB_PATTERN = /^track:private-names:batch:\d+$/;

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

export type AnalysisV2WorkerOutcome =
    | Readonly<{ status: 'already_terminal' }>
    | Readonly<{ status: 'retry'; errorCode: string }>
    | Readonly<{ status: 'failed'; errorCode: string }>
    | Readonly<{
        status: 'completed';
        successorCount: number;
        pendingRecoveryCount: number;
    }>;

export class AnalysisV2JobExecutionError extends Error {
    constructor(
        readonly code: string,
        readonly retryable: boolean
    ) {
        super(code);
        this.name = 'AnalysisV2JobExecutionError';
    }
}

const defaultDagStateStore = createSupabaseAnalysisV2DagStateStore();
const EMPTY_EXECUTOR_REGISTRY: AnalysisV2StageExecutorRegistry = Object.freeze({});

function executionError(code: string, retryable: boolean): never {
    throw new AnalysisV2JobExecutionError(code, retryable);
}

function assertBootstrapClaim(job: ClaimedAnalysisV2Job): void {
    if (
        job.jobKey !== ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        || job.track !== 'coordinator'
        || job.kind !== 'bootstrap'
        || job.batch !== null
    ) {
        executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', false);
    }
    if (
        job.inputHash
        !== analysisV2JobInputHash(job.requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY)
    ) {
        executionError('ANALYSIS_V2_JOB_INPUT_MISMATCH', false);
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
    return executionError('ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE', true);
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
            executionError('ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY', true);
        }
        executionError('ANALYSIS_V2_JOB_UNKNOWN', false);
    }
    if (candidate.inputHash !== claim.inputHash) {
        executionError('ANALYSIS_V2_JOB_INPUT_MISMATCH', false);
    }

    let planned: AnalysisV2DagJob;
    try {
        planned = assertAnalysisV2DagJob(plan, claim);
    } catch {
        return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', false);
    }
    if (
        planned.track !== claim.track
        || planned.kind !== claim.kind
        || planned.batch !== claim.batch
    ) {
        executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', false);
    }

    for (const dependencyKey of planned.requiredJobKeys) {
        const dependency = plan.jobs.find(job => job.jobKey === dependencyKey);
        if (!dependency) executionError('ANALYSIS_V2_DAG_PLAN_INVALID', false);
        const dependencyStage = stageForJob(dependency);
        if (!hasPersistedCheckpoint(dependencyStage, dependency, state)) {
            executionError('ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY', true);
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
        return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', false);
    }
    const planned = plannedJobForClaim(claim, plan, state);
    return Object.freeze({ plan, ...planned });
}

async function loadDagState(
    claim: ClaimedAnalysisV2Job,
    store: AnalysisV2DagStateStore
): Promise<AnalysisV2DagState> {
    const state = await store.load(claim.requestId);
    if (!state) executionError('ANALYSIS_V2_DAG_SCOPE_MISSING', false);
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
            executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', false);
        }
        return;
    }
    if (!checkpoint || checkpoint.kind !== CHECKPOINT_KIND_BY_STAGE[stage]) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', false);
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
            executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', false);
        }
    }
}

async function executeRegisteredStage<S extends AnalysisV2StageId>(
    stage: S,
    registry: AnalysisV2StageExecutorRegistry,
    context: Omit<AnalysisV2StageExecutorContext<S>, 'stage'>
): Promise<AnalysisV2StageCheckpointMap[S]> {
    const executor = registry[stage] as AnalysisV2StageExecutor<S> | undefined;
    if (!executor) executionError('ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE', true);
    const result = await executor({ stage, ...context });
    if (!result || !Object.prototype.hasOwnProperty.call(result, 'checkpoint')) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_MISMATCH', false);
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
    } = {}
): Promise<readonly AnalysisV2JobSuccessor[]> {
    const stateStore = dependencies.stateStore ?? defaultDagStateStore;
    const executors = dependencies.executors ?? EMPTY_EXECUTOR_REGISTRY;

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
                executionError('ANALYSIS_V2_JOB_DEFINITION_MISMATCH', false);
            }
        } catch (error) {
            if (error instanceof AnalysisV2JobExecutionError) throw error;
            return executionError('ANALYSIS_V2_DAG_PLAN_INVALID', false);
        }
        return successorsForAnalysisV2Job(plan, claim);
    }

    const state = await loadDagState(claim, stateStore);
    const current = canonicalPlan(claim, state);
    if (hasPersistedCheckpoint(current.stage, current.job, state)) {
        return successorsForAnalysisV2Job(current.plan, claim);
    }

    const checkpoint = await executeRegisteredStage(current.stage, executors, {
        claim,
        job: current.job,
        state,
    });
    assertCheckpointMatchesJob(current.stage, current.job, checkpoint);
    if (checkpoint) await stateStore.checkpointManifest(claim, checkpoint);

    const persistedState = await loadDagState(claim, stateStore);
    const persisted = canonicalPlan(claim, persistedState);
    if (
        current.stage !== 'finalize'
        && !hasPersistedCheckpoint(persisted.stage, persisted.job, persistedState)
    ) {
        executionError('ANALYSIS_V2_STAGE_CHECKPOINT_NOT_VISIBLE', true);
    }
    return successorsForAnalysisV2Job(persisted.plan, claim);
}

/** Compatibility alias retained for callers created with the Phase C foundation. */
export async function executeAnalysisV2FoundationJob(
    job: ClaimedAnalysisV2Job,
    dependencies: {
        stateStore?: AnalysisV2DagStateStore;
        executors?: AnalysisV2StageExecutorRegistry;
    } = {}
): Promise<readonly AnalysisV2JobSuccessor[]> {
    return executeAnalysisV2DagJob(job, dependencies);
}

function executionFailure(error: unknown): AnalysisV2JobExecutionError {
    if (error instanceof AnalysisV2JobExecutionError) return error;
    if (error instanceof AnalysisV2DagStateConflictError) {
        return new AnalysisV2JobExecutionError('ANALYSIS_V2_DAG_STATE_CONFLICT', false);
    }
    if (error instanceof AnalysisV2DagScopeMissingError) {
        return new AnalysisV2JobExecutionError('ANALYSIS_V2_DAG_SCOPE_MISSING', false);
    }
    if (error instanceof AnalysisV2DagStateFenceError) {
        return new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH',
            false
        );
    }
    if (
        error instanceof Error
        && error.message.startsWith('ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR:')
    ) {
        return new AnalysisV2JobExecutionError(
            'ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR',
            true
        );
    }
    return new AnalysisV2JobExecutionError('ANALYSIS_V2_JOB_HANDLER_FAILED', true);
}

export async function processAnalysisV2TaskDelivery(
    delivery: AnalysisV2TaskDelivery,
    dependencies: {
        store?: AnalysisV2JobStore;
        stateStore?: AnalysisV2DagStateStore;
        executors?: AnalysisV2StageExecutorRegistry;
        handler?: AnalysisV2JobHandler;
        dispatch?: AnalysisV2JobDispatcher;
    } = {}
): Promise<AnalysisV2WorkerOutcome> {
    const store = dependencies.store ?? analysisV2JobStore;
    const handler = dependencies.handler ?? (claim => executeAnalysisV2DagJob(claim, {
        stateStore: dependencies.stateStore,
        executors: dependencies.executors,
    }));
    const dispatch = dependencies.dispatch ?? dispatchAnalysisV2Job;
    const claim = await store.claim(delivery);
    if (!claim) return Object.freeze({ status: 'already_terminal' });

    let successors: readonly AnalysisV2JobSuccessor[];
    try {
        successors = await handler(claim);
    } catch (error) {
        const failure = executionFailure(error);
        const released = await store.releaseClaim(claim, {
            errorCode: failure.code,
            retryable: failure.retryable,
        });
        if (released.status === 'failed' || released.status === 'cancelled') {
            return Object.freeze({ status: 'failed', errorCode: failure.code });
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
