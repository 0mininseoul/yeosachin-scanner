import { randomUUID } from 'node:crypto';
import {
    createFeatureAnalysisResultIdentity,
    createGenderTriageMicrobatchAccountId,
    createGenderTriageMicrobatchResultIdentity,
    createGenderResolutionResultIdentity,
    createGenderTriageResultIdentity,
    featureAnalysis,
    genderResolution,
    genderTriage,
    genderTriageMicrobatch,
    type GenderTriageResult,
    type StagedAiAuditContext,
} from '@/lib/services/ai/v2-staged-analysis';
import { analyzePrivateAccountNames, type PrivateNameAnalysisAudit } from '@/lib/services/ai/private-name-analysis';
import { classifyGeminiGenerationError } from '@/lib/services/ai/gemini-generation-policy';
import type { GeminiAttemptStartTelemetry, GeminiAttemptTelemetry } from '@/lib/services/ai/gemini';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import { aiStagePolicySupports } from '@/lib/services/ai/stage-policy';
import { ANALYSIS_V2_SCHEDULER_V1_POLICY } from '@/lib/services/analysis/v2-ai-scheduler-runtime';
import type {
    ReplayAiRunner,
    ReplayInvocation,
    ReplayMedia,
    ReplayOutcome,
    ReplayTriageInput,
} from './replay-runner';
import type { ReplaySupportedAiStagePolicyVersion } from './replay-source-lineage';
import {
    isFeatureConcurrencyExperimentCliCapability,
    type FeatureConcurrencyExperimentCliCapability,
} from './feature-concurrency-experiment-capability';

interface IssuedReplayRunner {
    policyVersion: ReplaySupportedAiStagePolicyVersion;
    featureAnalysisConcurrency: 3 | 4;
    triage: ReplayAiRunner['triage'];
    feature: ReplayAiRunner['feature'];
    privateNames: ReplayAiRunner['privateNames'];
    resolveGender: ReplayAiRunner['resolveGender'];
}

const issuedReplayRunners = new WeakMap<ReplayAiRunner, IssuedReplayRunner>();

/** Non-issuing lookup used by the paid runner admission check. */
export function lookupReplayStagedAiAdapterPolicy(
    runner: ReplayAiRunner,
): ReplaySupportedAiStagePolicyVersion | undefined {
    const issued = issuedReplayRunners.get(runner);
    if (
        !issued
        || !Object.isFrozen(runner)
        || runner.triage !== issued.triage
        || runner.feature !== issued.feature
        || runner.privateNames !== issued.privateNames
        || runner.resolveGender !== issued.resolveGender
    ) {
        return undefined;
    }
    return issued.policyVersion;
}

/** Non-issuing lookup used to bind baseline/experiment reporting to the adapter. */
export function lookupReplayStagedAiAdapterFeatureConcurrency(
    runner: ReplayAiRunner,
): 3 | 4 | undefined {
    const issued = issuedReplayRunners.get(runner);
    return issued
        && lookupReplayStagedAiAdapterPolicy(runner) === issued.policyVersion
        ? issued.featureAnalysisConcurrency
        : undefined;
}

interface InvocationTelemetry {
    calls: number;
    retries: number;
    attempts: number;
    rateLimited: number;
    failureDisposition: Record<string, number>;
    attemptLatenciesMs: number[];
}

function normalized(media: readonly ReplayMedia[]) {
    return media.map(item => ({
        selectionId: item.selectionId,
        kind: item.kind,
        normalizedJpegBase64: item.jpegBase64,
        ...(item.postId ? { postId: item.postId } : {}),
    }));
}

function outcome(error: unknown, telemetry: InvocationTelemetry): ReplayOutcome {
    if (telemetry.rateLimited > 0) return 'rate_limited';
    if (
        error instanceof Error
        && error.message === 'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'
    ) return 'capacity_skipped';
    const disposition = classifyGeminiGenerationError(error);
    return disposition === 'rate_limited' ? 'rate_limited'
        : disposition === 'rejected' ? 'rejected' : 'failed';
}

function recordStart(state: InvocationTelemetry, value: GeminiAttemptStartTelemetry): void {
    state.calls++;
    state.attempts++;
    if (value.retryCount > 0) state.retries++;
}

function recordTerminal(state: InvocationTelemetry, value: GeminiAttemptTelemetry): void {
    state.attemptLatenciesMs.push(Math.max(0, value.latencyMs));
    if (value.disposition === 'rate_limited') state.rateLimited++;
    if (value.disposition !== 'success') {
        state.failureDisposition[value.disposition] =
            (state.failureDisposition[value.disposition] ?? 0) + 1;
    }
}

function statelessAudit(
    requestId: string,
    identity: StagedAiAuditContext['resultIdentity'],
    state: InvocationTelemetry,
    observer: {
        onAttemptStart?: (value: GeminiAttemptStartTelemetry) => void;
        onAttemptTelemetry?: (value: GeminiAttemptTelemetry) => void;
    } = {},
): StagedAiAuditContext {
    return {
        requestId,
        operationKey: identity.operationKey,
        resultIdentity: identity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: telemetry => {
            recordStart(state, telemetry);
            observer.onAttemptStart?.(telemetry);
        },
        onAttemptTelemetry: telemetry => {
            recordTerminal(state, telemetry);
            observer.onAttemptTelemetry?.(telemetry);
        },
    };
}

async function invoke<T>(task: (state: InvocationTelemetry) => Promise<T>): Promise<ReplayInvocation<T>> {
    const started = performance.now();
    const state: InvocationTelemetry = {
        calls: 0,
        retries: 0,
        attempts: 0,
        rateLimited: 0,
        failureDisposition: {},
        attemptLatenciesMs: [],
    };
    try {
        const value = await task(state);
        return {
            outcome: 'ok',
            value,
            calls: state.calls,
            rateLimited: state.rateLimited,
            failureDisposition: state.failureDisposition,
            attemptLatenciesMs: state.attemptLatenciesMs,
            attempts: state.attempts,
            retries: state.retries,
            elapsedMs: Math.round(performance.now() - started),
        };
    } catch (error) {
        return {
            outcome: outcome(error, state),
            calls: state.calls,
            rateLimited: state.rateLimited,
            failureDisposition: state.failureDisposition,
            attemptLatenciesMs: state.attemptLatenciesMs,
            attempts: state.attempts || (state.calls ? 1 : 0),
            retries: state.retries,
            elapsedMs: Math.round(performance.now() - started),
        };
    }
}

function createSemaphore(limit: number) {
    let active = 0;
    const waiters: Array<() => void> = [];
    return async function run<T>(task: () => Promise<T>): Promise<T> {
        if (active >= limit) {
            await new Promise<void>(resolve => waiters.push(resolve));
        }
        active++;
        try {
            return await task();
        } finally {
            active--;
            waiters.shift()?.();
        }
    };
}

/** Stateless paid-AI adapter. It imports no Supabase, provider, R2, job, result, or archive module. */
export function createReplayStagedAiAdapter(
    aiStagePolicyVersion: ReplaySupportedAiStagePolicyVersion,
    experiment?: Readonly<{
        featureAnalysisConcurrency: 4;
        featureConcurrencyExperimentCapability:
            FeatureConcurrencyExperimentCliCapability;
    }>,
): ReplayAiRunner {
    if (
        experiment !== undefined
        && (
            experiment.featureAnalysisConcurrency !== 4
            || !isFeatureConcurrencyExperimentCliCapability(
                experiment.featureConcurrencyExperimentCapability,
            )
        )
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_FEATURE_CONCURRENCY_AUTHORIZATION_REQUIRED',
        );
    }
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    const supportsGenderTriageMicrobatch = aiStagePolicySupports(
        aiStagePolicyVersion,
        'genderTriageMicrobatchV29',
    );
    const runFeature = supportsGenderTriageMicrobatch
        ? createSemaphore(
            experiment?.featureAnalysisConcurrency
                ?? ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
        )
        : async <T>(task: () => Promise<T>) => task();
    type PendingTriage = {
        accountId: string;
        aiInput: {
            media: ReturnType<typeof normalized>;
            accountProfile?: ReplayTriageInput['accountProfile'];
        };
        waiters: Array<{
            resolve(value: ReplayInvocation<GenderTriageResult>): void;
        }>;
    };
    const pendingTriage = new Map<string, PendingTriage>();
    let triageFlushScheduled = false;

    const flushTriage = async () => {
        triageFlushScheduled = false;
        const pending = [...pendingTriage.values()];
        pendingTriage.clear();
        const batches = planGenderTriageMicrobatches(pending.map(item => ({
            accountId: item.accountId,
            value: item,
        })));
        await Promise.all(batches.map(async batch => {
            const accounts = batch.map(member => ({
                accountId: member.accountId,
                input: member.value.aiInput,
            }));
            const invocation = await invoke(async state => {
                const identity =
                    createGenderTriageMicrobatchResultIdentity(
                        accounts,
                        aiStagePolicyVersion,
                    );
                return genderTriageMicrobatch(
                    accounts,
                    statelessAudit(requestId, identity, state),
                    { aiStagePolicyVersion, replayCapability },
                );
            });
            const byAccount = new Map(invocation.value?.map(result => [
                result.accountId,
                result.result,
            ]));
            let metricsOwned = false;
            for (const member of batch) {
                const result = byAccount.get(member.accountId);
                for (const waiter of member.value.waiters) {
                    const ownsMetrics = !metricsOwned;
                    metricsOwned = true;
                    waiter.resolve({
                        outcome: invocation.outcome,
                        ...(result ? { value: result } : {}),
                        calls: ownsMetrics ? invocation.calls : 0,
                        rateLimited: ownsMetrics ? invocation.rateLimited : 0,
                        failureDisposition: ownsMetrics
                            ? invocation.failureDisposition
                            : {},
                        attemptLatenciesMs: ownsMetrics
                            ? invocation.attemptLatenciesMs
                            : [],
                        attempts: ownsMetrics ? invocation.attempts : 0,
                        retries: ownsMetrics ? invocation.retries : 0,
                        elapsedMs: ownsMetrics ? invocation.elapsedMs : 0,
                    });
                }
            }
        }));
    };

    const queueTriage = (input: ReplayTriageInput) => {
        const aiInput = {
            media: normalized(input.media),
            ...(input.accountProfile
                ? { accountProfile: input.accountProfile }
                : {}),
        };
        const accountId = createGenderTriageMicrobatchAccountId(
            aiInput,
            aiStagePolicyVersion,
        );
        return new Promise<ReplayInvocation<GenderTriageResult>>(resolve => {
            const existing = pendingTriage.get(accountId);
            if (existing) {
                existing.waiters.push({ resolve });
            } else {
                pendingTriage.set(accountId, {
                    accountId,
                    aiInput,
                    waiters: [{ resolve }],
                });
            }
            if (!triageFlushScheduled) {
                triageFlushScheduled = true;
                setTimeout(() => void flushTriage(), 0);
            }
        });
    };
    const runner: ReplayAiRunner = {
        ...(supportsGenderTriageMicrobatch ? {
            triage: queueTriage,
        } : {
            triage: (input: ReplayTriageInput) => invoke(async state => {
                const aiInput = { media: normalized(input.media) };
                const identity = createGenderTriageResultIdentity(
                    aiInput,
                    aiStagePolicyVersion,
                );
                return genderTriage(
                    aiInput,
                    statelessAudit(requestId, identity, state),
                    { aiStagePolicyVersion, replayCapability },
                );
            }),
        }),
        feature: input => runFeature(() => invoke(async state => {
            const aiInput = {
                triage: input.triage,
                bio: input.bio,
                ...(input.accountProfile
                    ? { accountProfile: input.accountProfile }
                    : {}),
                media: normalized(input.media),
                captions: [...input.captions],
            };
            const identity = createFeatureAnalysisResultIdentity(aiInput, aiStagePolicyVersion);
            return featureAnalysis(aiInput, statelessAudit(requestId, identity, state), { aiStagePolicyVersion, replayCapability });
        })),
        resolveGender: input => invoke(async state => {
            const aiInput = { media: normalized(input.media) };
            const identity = createGenderResolutionResultIdentity(
                aiInput,
                aiStagePolicyVersion,
            );
            return genderResolution(aiInput, statelessAudit(requestId, identity, state, {
                onAttemptStart: value => input.onAttemptStart?.({
                    attempt: value.attempt,
                    retryCount: value.retryCount,
                }),
                onAttemptTelemetry: value => input.onAttemptTelemetry?.({
                    attempt: value.attempt,
                    retryCount: value.retryCount,
                    disposition: value.disposition,
                    latencyMs: value.latencyMs,
                }),
            }), {
                abortSignal: input.signal,
                aiStagePolicyVersion,
                replayCapability,
            });
        }),
        privateNames: accounts => invoke(async state => {
            const audit: PrivateNameAnalysisAudit = {
                forChunk(identity) {
                    return {
                        requestId,
                        operationKey: identity.operationKey,
                        resultIdentity: identity.resultIdentity,
                        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
                        onBeforeAttempt: telemetry => recordStart(state, telemetry),
                        onAttemptTelemetry: telemetry => recordTerminal(state, telemetry),
                    };
                },
            };
            return analyzePrivateAccountNames([...accounts], requestId, audit, { aiStagePolicyVersion, replayCapability });
        }),
    };
    Object.freeze(runner);
    issuedReplayRunners.set(runner, {
        policyVersion: aiStagePolicyVersion,
        featureAnalysisConcurrency: experiment?.featureAnalysisConcurrency
            ?? ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
        triage: runner.triage,
        feature: runner.feature,
        privateNames: runner.privateNames,
        resolveGender: runner.resolveGender,
    });
    return runner;
}
