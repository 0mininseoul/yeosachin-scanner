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
import {
    AI_AMBIGUOUS_GENERATION_ERROR_PREFIX,
    AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX,
    AI_RATE_LIMIT_ERROR_PREFIX,
    classifyGeminiGenerationError,
} from '@/lib/services/ai/gemini-generation-policy';
import type { GeminiAttemptStartTelemetry, GeminiAttemptTelemetry } from '@/lib/services/ai/gemini';
import { issueReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import { planGenderTriageMicrobatches } from '@/lib/services/ai/gender-triage-microbatch-plan';
import {
    AI_STAGE_POLICY_V212_VERSION,
    aiStagePolicySupports,
} from '@/lib/services/ai/stage-policy';
import { ANALYSIS_V2_SCHEDULER_V1_POLICY } from '@/lib/services/analysis/v2-ai-scheduler-runtime';
import type {
    ReplayAiRunner,
    ReplayInvocation,
    ReplayMedia,
    ReplayOutcome,
    ReplayTriageInput,
} from './replay-runner';
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

const V212_RESOLVER_CAPACITY_SKIP_CODE =
    'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED';

type V212ResolverTerminalDisposition =
    | 'ambiguous'
    | 'rate_limited'
    | 'rejected'
    | 'response_rejected';

function isV212ResolverCapacitySkip(error: unknown): boolean {
    return error instanceof Error
        && error.message === V212_RESOLVER_CAPACITY_SKIP_CODE;
}

function expectedV212ResolverTerminalDisposition(
    error: unknown,
): V212ResolverTerminalDisposition | null {
    if (!(error instanceof Error)) return null;
    if (error.message.startsWith(AI_AMBIGUOUS_GENERATION_ERROR_PREFIX)) {
        return 'ambiguous';
    }
    if (error.message.startsWith(AI_RATE_LIMIT_ERROR_PREFIX)) {
        return 'rate_limited';
    }
    if (error.message.startsWith(AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX)) {
        return 'response_rejected';
    }
    if (error.message.startsWith('AI_GENERATION_REQUEST_ERROR:')) {
        return 'rejected';
    }
    return null;
}

/**
 * v2.12 isolates only terminal provider/admission outcomes. A known provider
 * marker is sufficient when the provider fails before its telemetry callback;
 * the aggregate-safe disposition is then recorded locally. Raw adapter/audit
 * faults remain outside this allowlist and escape the replay boundary.
 */
function isolateExpectedV212ResolverFailure(
    error: unknown,
    telemetry: InvocationTelemetry,
): boolean {
    if (isV212ResolverCapacitySkip(error)) return true;
    const disposition = expectedV212ResolverTerminalDisposition(error);
    if (disposition === null) return false;
    telemetry.failureDisposition[disposition] = Math.max(
        1,
        telemetry.failureDisposition[disposition] ?? 0,
    );
    return true;
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
        && (
            error.message === 'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'
            || error.message === 'ANALYSIS_V2_AI_CAPACITY_PENDING'
        )
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

async function invoke<T>(
    task: (state: InvocationTelemetry) => Promise<T>,
    isolateError: (error: unknown, telemetry: InvocationTelemetry) => boolean = () => true,
): Promise<ReplayInvocation<T>> {
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
        if (!isolateError(error, state)) throw error;
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

export function createReplayProviderAttemptSemaphore(limit: number) {
    let active = 0;
    const waiters: Array<() => void> = [];
    return async function run<T>(task: () => Promise<T>): Promise<T> {
        const execute = async () => {
            try {
                return await task();
            } finally {
                active--;
                waiters.shift()?.();
            }
        };
        // Preserve immediate provider dispatch for a free slot. Apart from
        // avoiding an unnecessary microtask, resolver cutoff accounting relies
        // on the admitted task beginning before the caller moves to its cutoff
        // phase.
        if (active < limit && waiters.length === 0) {
            active++;
            return execute();
        }
        await new Promise<void>(resolve => waiters.push(() => {
            active++;
            resolve();
        }));
        return execute();
    };
}

export function createReplayAbortableBoundedSemaphore(limit: number) {
    let active = 0;
    const waiters: Array<() => void> = [];
    return async function run<T>(
        task: () => Promise<T>,
        signal: AbortSignal,
        deadlineAtMs: number,
    ): Promise<T> {
        if (signal.aborted || performance.now() >= deadlineAtMs) {
            throw new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        }
        let acquired = false;
        const release = () => {
            if (!acquired) return;
            acquired = false;
            active--;
            waiters.shift()?.();
        };
        const execute = async () => {
            if (signal.aborted || performance.now() >= deadlineAtMs) {
                release();
                throw new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
            }
            try {
                return await task();
            } finally {
                release();
            }
        };
        if (active < limit && waiters.length === 0) {
            active++;
            acquired = true;
            return execute();
        }
        await new Promise<void>((resolve, reject) => {
            const waiter = () => {
                cleanup();
                active++;
                acquired = true;
                resolve();
            };
            const onAbort = () => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
                cleanup();
                reject(new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'));
            };
            const onDeadline = () => onAbort();
            const timer = setTimeout(
                onDeadline,
                Math.max(0, deadlineAtMs - performance.now()),
            );
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            waiters.push(waiter);
        });
        return execute();
    };
}

/** Stateless paid-AI adapter. It imports no Supabase, provider, R2, job, result, or archive module. */
export function createReplayStagedAiAdapter(
    aiStagePolicyVersion: ReplaySupportedAiStagePolicyVersion,
): ReplayAiRunner {
    const requestId = randomUUID();
    const replayCapability = issueReplayStatelessCapability();
    const supportsGenderTriageMicrobatch = aiStagePolicySupports(
        aiStagePolicyVersion,
        'genderTriageMicrobatchV29',
    );
    const genderQualityV211 = aiStagePolicySupports(
        aiStagePolicyVersion,
        'genderQualityV211',
    );
    const strictV212Resolver = aiStagePolicyVersion === AI_STAGE_POLICY_V212_VERSION;
    // Replay remains stateless, but v2.11 uses the same bounded call shape as scheduler-v1.
    // Waiting is local admission only: no provider attempt exists before the semaphore opens.
    const runTriage = genderQualityV211
        ? createReplayProviderAttemptSemaphore(ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency)
        : async <T>(task: () => Promise<T>) => task();
    // v2.11 replay uses one deployment-wide provider fence in addition to per-stage fences.
    // It wraps provider invocations, so queued work has not made a paid attempt yet.
    const runShared = genderQualityV211
        ? createReplayProviderAttemptSemaphore(ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency)
        : async <T>(task: () => Promise<T>) => task();
    const runResolver = genderQualityV211
        ? createReplayAbortableBoundedSemaphore(2)
        : null;
    const runResolverShared = genderQualityV211
        ? createReplayAbortableBoundedSemaphore(
            ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency,
        )
        : null;
    const runFeature = supportsGenderTriageMicrobatch
        ? createReplayProviderAttemptSemaphore(
            ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
        )
        : async <T>(task: () => Promise<T>) => task();
    const runPrivate = genderQualityV211
        ? createReplayProviderAttemptSemaphore(
            ANALYSIS_V2_SCHEDULER_V1_POLICY.privateAccountNameConcurrency,
        )
        : async <T>(task: () => Promise<T>) => task();
    const runTriageProviderAttempt = genderQualityV211
        ? <T>(task: () => Promise<T>) => runTriage(() => runShared(task))
        : undefined;
    const runFeatureProviderAttempt = genderQualityV211
        ? <T>(task: () => Promise<T>) => runFeature(() => runShared(task))
        : undefined;
    const runPrivateProviderAttempt = genderQualityV211
        ? <T>(task: () => Promise<T>) => runPrivate(() => runShared(task))
        : undefined;
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
                    createGenderTriageMicrobatchResultIdentity(accounts);
                return genderTriageMicrobatch(
                    accounts,
                    statelessAudit(requestId, identity, state),
                    {
                        aiStagePolicyVersion,
                        replayCapability,
                        ...(runTriageProviderAttempt
                            ? { runProviderAttempt: runTriageProviderAttempt }
                            : {}),
                    },
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
        const accountId = createGenderTriageMicrobatchAccountId(aiInput);
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
        feature: input => (genderQualityV211 ? invoke(async state => {
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
            return featureAnalysis(aiInput, statelessAudit(requestId, identity, state), {
                aiStagePolicyVersion,
                replayCapability,
                ...(runFeatureProviderAttempt
                    ? { runProviderAttempt: runFeatureProviderAttempt }
                    : {}),
            });
        }) : runFeature(() => invoke(async state => {
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
            return featureAnalysis(aiInput, statelessAudit(requestId, identity, state), {
                aiStagePolicyVersion,
                replayCapability,
            });
        }))),
        resolveGender: input => (runResolver && runResolverShared
            ? (() => {
                const deadlineAtMs = performance.now() + 5_000;
                const invocation = runResolver(() => runResolverShared(() => invoke(async state => {
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
                        admissionDeadlineAtMs: deadlineAtMs,
                        aiStagePolicyVersion,
                        replayCapability,
                    });
                }, strictV212Resolver ? isolateExpectedV212ResolverFailure : undefined), input.signal, deadlineAtMs), input.signal, deadlineAtMs);
                return strictV212Resolver
                    ? invocation.catch(error => {
                        if (!isV212ResolverCapacitySkip(error)) throw error;
                        return {
                            outcome: 'capacity_skipped' as const,
                            attempts: 0, retries: 0, elapsedMs: 0,
                        };
                    })
                    : invocation.catch(() => ({
                        outcome: 'capacity_skipped' as const,
                        attempts: 0, retries: 0, elapsedMs: 0,
                    }));
            })()
            : invoke(async state => {
                const aiInput = { media: normalized(input.media) };
                const identity = createGenderResolutionResultIdentity(aiInput, aiStagePolicyVersion);
                return genderResolution(aiInput, statelessAudit(requestId, identity, state, {
                    onAttemptStart: value => input.onAttemptStart?.({ attempt: value.attempt, retryCount: value.retryCount }),
                    onAttemptTelemetry: value => input.onAttemptTelemetry?.({ attempt: value.attempt, retryCount: value.retryCount, disposition: value.disposition, latencyMs: value.latencyMs }),
                }), { abortSignal: input.signal, aiStagePolicyVersion, replayCapability });
            })),
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
            return analyzePrivateAccountNames([...accounts], requestId, audit, {
                aiStagePolicyVersion,
                replayCapability,
                ...(runPrivateProviderAttempt
                    ? { runProviderAttempt: runPrivateProviderAttempt }
                    : {}),
            });
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
