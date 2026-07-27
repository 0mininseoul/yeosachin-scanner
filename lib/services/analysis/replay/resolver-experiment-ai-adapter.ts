import { randomUUID } from 'node:crypto';
import {
    createGenderTriageMicrobatchAccountId,
    createGenderTriageMicrobatchResultIdentity,
    genderTriageMicrobatch,
    type GenderTriageResult,
    type StagedAiAuditContext,
} from '@/lib/services/ai/v2-staged-analysis';
import { analyzeWithGemini } from '@/lib/services/ai/gemini';
import { projectGenderResolutionMedia } from '@/lib/services/ai/gender-resolution-pure';
import {
    createAnalysisV2AiMediaSnapshotHashFromParts,
    createAnalysisV2AiResultIdentity,
    createAnalysisV2AiResultInputHash,
} from '@/lib/services/analysis/v2-ai-result-identity';
import { getAiStagePolicy } from '@/lib/services/ai/stage-policy';
import { classifyGeminiGenerationError } from '@/lib/services/ai/gemini-generation-policy';
import type {
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import type {
    ReplayAiRunner,
    ReplayInvocation,
    ReplayMedia,
    ReplayOutcome,
    ReplayTriageInput,
} from './replay-runner';

const experimentRunnerBrand = Symbol('strong-uncertain-resolver-runner');
const issuedExperimentRunners = new WeakSet<object>();
type ExperimentRunner = Pick<ReplayAiRunner, 'triage' | 'resolveGender'> & {
    readonly [experimentRunnerBrand]: true;
};
type InvocationState = {
    calls: number;
    retries: number;
    attempts: number;
    rateLimited: number;
    failureDisposition: Record<string, number>;
    attemptLatenciesMs: number[];
};

function normalized(media: readonly ReplayMedia[]) {
    return media.map(item => ({
        selectionId: item.selectionId,
        kind: item.kind,
        normalizedJpegBase64: item.jpegBase64,
        ...(item.postId ? { postId: item.postId } : {}),
    }));
}
function recordStart(state: InvocationState, value: GeminiAttemptStartTelemetry) {
    state.calls++;
    state.attempts++;
    if (value.retryCount > 0) state.retries++;
}
function recordTerminal(state: InvocationState, value: GeminiAttemptTelemetry) {
    state.attemptLatenciesMs.push(Math.max(0, value.latencyMs));
    if (value.disposition === 'rate_limited') state.rateLimited++;
    if (value.disposition !== 'success') {
        state.failureDisposition[value.disposition] =
            (state.failureDisposition[value.disposition] ?? 0) + 1;
    }
}
function audit(
    requestId: string,
    identity: StagedAiAuditContext['resultIdentity'],
    state: InvocationState,
): StagedAiAuditContext {
    return {
        requestId,
        operationKey: identity.operationKey,
        resultIdentity: identity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: value => recordStart(state, value),
        onAttemptTelemetry: value => recordTerminal(state, value),
    };
}

function resolverIdentity(media: ReturnType<typeof normalized>) {
    const projected = projectGenderResolutionMedia(media);
    const policy = getAiStagePolicy('ai-stage-policy-v2.9', 'genderResolution');
    return createAnalysisV2AiResultIdentity({
        stage: 'genderResolution',
        modelName: 'gemini-3-flash-preview',
        thinkingLevel: 'HIGH',
        mediaResolution: 'HIGH',
        promptVersion: policy.promptVersion,
        schemaVersion: policy.schemaVersion,
        maxOutputTokens: 512,
        inputHash: createAnalysisV2AiResultInputHash(projected.prompt),
        mediaSnapshotHash: createAnalysisV2AiMediaSnapshotHashFromParts(projected.media),
        cacheScope: 'request',
    });
}

async function resolveGender(
    requestId: string,
    media: ReturnType<typeof normalized>,
    state: InvocationState,
    replayCapability: ReturnType<typeof issueReplayStatelessCapability>,
    signal: AbortSignal,
) {
    const projected = projectGenderResolutionMedia(media);
    const identity = resolverIdentity(media);
    const context = audit(requestId, identity, state);
    const assessment = projected.schema.parse(await analyzeWithGemini(
        projected.prompt,
        projected.media.map(item => item.normalizedJpegBase64),
        {
            schema: projected.schema,
            analysisType: 'v2_gender_resolution',
            stage: 'genderResolution',
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            requestId,
            startingAttempt: 1,
            abortSignal: signal,
            onBeforeAttempt: context.onBeforeAttempt,
            onAttemptTelemetry: context.onAttemptTelemetry,
            skipTokenLog: true,
            replayCapability,
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            maxOutputTokens: 512,
        },
    ));
    return {
        assessment: projected.finalize(assessment),
        analyzedSelectionIds: projected.media.map(item => item.selectionId),
    };
}
function outcome(error: unknown, state: InvocationState): ReplayOutcome {
    if (state.rateLimited) return 'rate_limited';
    if (
        error instanceof Error
        && error.message === 'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'
    ) return 'capacity_skipped';
    const disposition = classifyGeminiGenerationError(error);
    return disposition === 'rate_limited' ? 'rate_limited'
        : disposition === 'rejected' ? 'rejected' : 'failed';
}
async function invoke<T>(
    task: (state: InvocationState) => Promise<T>,
): Promise<ReplayInvocation<T>> {
    const started = performance.now();
    const state: InvocationState = {
        calls: 0, retries: 0, attempts: 0, rateLimited: 0,
        failureDisposition: {}, attemptLatenciesMs: [],
    };
    try {
        const value = await task(state);
        return {
            outcome: 'ok', value, calls: state.calls,
            rateLimited: state.rateLimited, retries: state.retries,
            attempts: state.attempts,
            failureDisposition: state.failureDisposition,
            attemptLatenciesMs: state.attemptLatenciesMs,
            elapsedMs: Math.round(performance.now() - started),
        };
    } catch (error) {
        return {
            outcome: outcome(error, state), calls: state.calls,
            rateLimited: state.rateLimited, retries: state.retries,
            attempts: state.attempts,
            failureDisposition: state.failureDisposition,
            attemptLatenciesMs: state.attemptLatenciesMs,
            elapsedMs: Math.round(performance.now() - started),
        };
    }
}

/** Returns the only runnable shape carrying the module-private experiment brand. */
export function createStrongUncertainResolverExperimentAdapter(): ExperimentRunner {
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    type Pending = {
        accountId: string;
        input: {
            media: ReturnType<typeof normalized>;
            accountProfile?: ReplayTriageInput['accountProfile'];
        };
        resolve(value: ReplayInvocation<GenderTriageResult>): void;
    };
    let scheduled = false;
    const pending: Pending[] = [];
    const flush = async () => {
        scheduled = false;
        const queued = pending.splice(0);
        const batches = planGenderTriageMicrobatches(queued.map(item => ({
            accountId: item.accountId,
            value: item,
        })));
        await Promise.all(batches.map(async batch => {
            const accounts = batch.map(member => ({
                accountId: member.accountId,
                input: member.value.input,
            }));
            const invocation = await invoke(async state => {
                const identity = createGenderTriageMicrobatchResultIdentity(accounts);
                return genderTriageMicrobatch(
                    accounts,
                    audit(requestId, identity, state),
                    { replayCapability },
                );
            });
            const results = new Map(invocation.value?.map(value => [
                value.accountId, value.result,
            ]));
            let ownsMetrics = true;
            for (const member of batch) {
                const value = results.get(member.accountId);
                const metrics = ownsMetrics;
                ownsMetrics = false;
                member.value.resolve({
                    outcome: value ? invocation.outcome : 'failed',
                    ...(value ? { value } : {}),
                    calls: metrics ? invocation.calls : 0,
                    rateLimited: metrics ? invocation.rateLimited : 0,
                    retries: metrics ? invocation.retries : 0,
                    attempts: metrics ? invocation.attempts : 0,
                    failureDisposition: metrics ? invocation.failureDisposition : {},
                    attemptLatenciesMs: metrics ? invocation.attemptLatenciesMs : [],
                    elapsedMs: metrics ? invocation.elapsedMs : 0,
                });
            }
        }));
    };
    const triage = (input: ReplayTriageInput) => new Promise<
        ReplayInvocation<GenderTriageResult>
    >(resolve => {
        const aiInput = {
            media: normalized(input.media),
            ...(input.accountProfile ? { accountProfile: input.accountProfile } : {}),
        };
        pending.push({
            accountId: createGenderTriageMicrobatchAccountId(aiInput),
            input: aiInput,
            resolve,
        });
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => void flush());
        }
    });
    const runner: ExperimentRunner = {
        [experimentRunnerBrand]: true,
        triage,
        resolveGender: input => invoke(async state => {
            const aiInput = { media: normalized(input.media) };
            return resolveGender(
                requestId,
                aiInput.media,
                state,
                replayCapability,
                input.signal,
            );
        }),
    };
    Object.freeze(runner);
    issuedExperimentRunners.add(runner);
    return runner;
}

export function isStrongUncertainResolverExperimentAdapter(
    runner: Pick<ReplayAiRunner, 'triage' | 'resolveGender'>,
): runner is ExperimentRunner {
    return Object.isFrozen(runner) && issuedExperimentRunners.has(runner);
}
