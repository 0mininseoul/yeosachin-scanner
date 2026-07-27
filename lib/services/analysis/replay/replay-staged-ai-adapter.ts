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
import type { ReplayAiRunner, ReplayInvocation, ReplayMedia, ReplayOutcome } from './replay-runner';
import type { ReplaySupportedAiStagePolicyVersion } from './replay-source-lineage';

interface IssuedReplayRunner {
    policyVersion: ReplaySupportedAiStagePolicyVersion;
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

/** Stateless paid-AI adapter. It imports no Supabase, provider, R2, job, result, or archive module. */
export function createReplayStagedAiAdapter(
    aiStagePolicyVersion: ReplaySupportedAiStagePolicyVersion,
): ReplayAiRunner {
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    const runner: ReplayAiRunner = {
        triage: input => invoke(async state => {
            const aiInput = { media: normalized(input.media) };
            if (aiStagePolicyVersion === 'ai-stage-policy-v2.9') {
                const accounts = [{
                    accountId: createGenderTriageMicrobatchAccountId(aiInput),
                    input: aiInput,
                }];
                const identity = createGenderTriageMicrobatchResultIdentity(accounts);
                const results = await genderTriageMicrobatch(
                    accounts,
                    statelessAudit(requestId, identity, state),
                    { replayCapability },
                );
                return results[0]!.result;
            }
            const identity = createGenderTriageResultIdentity(aiInput, aiStagePolicyVersion);
            return genderTriage(aiInput, statelessAudit(requestId, identity, state), { aiStagePolicyVersion, replayCapability });
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
        feature: runner.feature,
        privateNames: runner.privateNames,
        resolveGender: runner.resolveGender,
    });
    return runner;
}
