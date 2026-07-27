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
    type StagedAiAuditContext,
} from '@/lib/services/ai/v2-staged-analysis';
import { analyzePrivateAccountNames, type PrivateNameAnalysisAudit } from '@/lib/services/ai/private-name-analysis';
import { classifyGeminiGenerationError } from '@/lib/services/ai/gemini-generation-policy';
import type { GeminiAttemptStartTelemetry, GeminiAttemptTelemetry } from '@/lib/services/ai/gemini';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import { ANALYSIS_V2_SCHEDULER_V1_POLICY } from '@/lib/services/analysis/v2-ai-scheduler-runtime';
import type {
    ReplayAiRunner,
    ReplayInvocation,
    ReplayMedia,
    ReplayOutcome,
    ReplayTriageBatch,
    ReplayTriageInput,
} from './replay-runner';
import type { ReplaySupportedAiStagePolicyVersion } from './replay-source-lineage';

interface IssuedReplayRunner {
    policyVersion: ReplaySupportedAiStagePolicyVersion;
    triage: ReplayAiRunner['triage'];
    triageMany: ReplayAiRunner['triageMany'];
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
        || runner.triageMany !== issued.triageMany
        || runner.feature !== issued.feature
        || runner.privateNames !== issued.privateNames
        || runner.resolveGender !== issued.resolveGender
    ) {
        return undefined;
    }
    return issued.policyVersion;
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

async function runBounded<T>(
    values: readonly T[],
    concurrency: number,
    task: (value: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    await Promise.all(Array.from(
        { length: Math.min(concurrency, values.length) },
        async () => {
            while (next < values.length) {
                await task(values[next++]!);
            }
        },
    ));
}

/** Stateless paid-AI adapter. It imports no Supabase, provider, R2, job, result, or archive module. */
export function createReplayStagedAiAdapter(
    aiStagePolicyVersion: ReplaySupportedAiStagePolicyVersion,
): ReplayAiRunner {
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    const runner: ReplayAiRunner = {
        ...(aiStagePolicyVersion === 'ai-stage-policy-v2.9' ? {
            async triageMany(inputs: readonly ReplayTriageInput[]) {
                const members = inputs.map(input => {
                    const aiInput = { media: normalized(input.media) };
                    return {
                        accountId: createGenderTriageMicrobatchAccountId(aiInput),
                        value: { input, aiInput },
                    };
                });
                const batches = planGenderTriageMicrobatches(members);
                const ordinalsByAccount = new Map<string, number[]>();
                for (const member of members) {
                    const ordinals = ordinalsByAccount.get(member.accountId) ?? [];
                    ordinals.push(member.value.input.ordinal);
                    ordinalsByAccount.set(member.accountId, ordinals);
                }
                const completed = new Array<ReplayTriageBatch>(batches.length);
                await runBounded(
                    batches.map((batch, index) => ({ batch, index })),
                    ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency,
                    async ({ batch, index }) => {
                        const accounts = batch.map(member => ({
                            accountId: member.accountId,
                            input: member.value.aiInput,
                        }));
                        const ordinals = batch.flatMap(member => (
                            ordinalsByAccount.get(member.accountId) ?? []
                        ));
                        const invocation = await invoke(async state => {
                            const identity =
                                createGenderTriageMicrobatchResultIdentity(accounts);
                            const results = await genderTriageMicrobatch(
                                accounts,
                                statelessAudit(requestId, identity, state),
                                { replayCapability },
                            );
                            const byAccount = new Map(results.map(result => [
                                result.accountId,
                                result.result,
                            ]));
                            return batch.flatMap(member => {
                                const result = byAccount.get(member.accountId);
                                if (!result) {
                                    throw new Error(
                                        'ANALYSIS_V2_GENDER_TRIAGE_MICROBATCH_RESULT_MISSING',
                                    );
                                }
                                return (ordinalsByAccount.get(member.accountId) ?? [])
                                    .map(ordinal => ({ ordinal, result }));
                            });
                        });
                        completed[index] = { ordinals, invocation };
                    },
                );
                return completed;
            },
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
        feature: input => invoke(async state => {
            const aiInput = { triage: input.triage, bio: input.bio, media: normalized(input.media), captions: [...input.captions] };
            const identity = createFeatureAnalysisResultIdentity(aiInput, aiStagePolicyVersion);
            return featureAnalysis(aiInput, statelessAudit(requestId, identity, state), { aiStagePolicyVersion, replayCapability });
        }),
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
            }), { abortSignal: input.signal, aiStagePolicyVersion, replayCapability });
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
        triage: runner.triage,
        triageMany: runner.triageMany,
        feature: runner.feature,
        privateNames: runner.privateNames,
        resolveGender: runner.resolveGender,
    });
    return runner;
}
