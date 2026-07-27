import {
    ANALYSIS_V2_SCHEDULER_V1_POLICY,
    type AnalysisV2SchedulerStage,
} from './v2-ai-scheduler-runtime';

const STAGES: readonly AnalysisV2SchedulerStage[] = [
    'genderTriage',
    'featureAnalysis',
    'privateAccountName',
];

interface FixtureOperation {
    key: string;
    jobKey: string;
    stage: AnalysisV2SchedulerStage;
    ordinal: number;
    eligibleAtMs: number;
    providerCalls: number;
    rateLimitedCalls: number;
    retryCount: number;
    durationMs: number;
    profileIndex: number | null;
    terminalUnavailable: boolean;
}

interface FixtureJob {
    key: string;
    generationStartedAtMs: number;
    generation: number;
    continuationPending: boolean;
}

export interface AnalysisV2SchedulerLifecycleFixtureMetrics {
    fixture: 'standard-240-public-145-private-lifecycle';
    assumptions: Readonly<{
        relationshipAndTopologyMs: number;
        profileFetchBatchMs: number;
        mediaNormalizePerWaveMs: number;
        genderProviderLatencyMs: number;
        featureProviderLatencyMs: number;
        privateProviderLatencyMs: number;
        rateLimitBackoffMs: number;
        continuationDispatchMs: number;
        admissionBackoffMs: number;
        ambiguousRecoveryMs: number;
        handlerAdmissionWindowMs: number;
        observedGenderRateLimited: number;
        observedFeatureRateLimited: number;
    }>;
    topology: Readonly<{
        profileBatches: number;
        publicProfiles: number;
        privateBatches: number;
        privateProfiles: number;
    }>;
    totalEndToEndWallTimeMs: number;
    modeledUnderFiveMinutes: boolean;
    continuations: number;
    dispatchGenerations: number;
    duplicatePaidCalls: number;
    admissionDeferrals: number;
    terminalUnavailableRecoveries: number;
    maxConcurrency: number;
    maxConcurrencyByStage: Readonly<Record<AnalysisV2SchedulerStage, number>>;
    stages: Readonly<Record<AnalysisV2SchedulerStage, Readonly<{
        operations: number;
        providerCalls: number;
        rateLimited: number;
        retries: number;
        terminalUnavailable: number;
        averageProviderLatencyMs: number;
    }>>>;
}

/**
 * Network-free v2.9 release model. This is deliberately a serial phase upper bound: it does not
 * claim any gain from overlap between gender and feature work. It counts Gemini requests (not
 * accounts), preserves scheduler-v1 caps, and leaves cost unknown until a real replay supplies
 * token usage.
 */
export interface AnalysisV2MicrobatchV29LifecycleFixtureMetrics {
    fixture: 'standard-240-public-145-private-v29-microbatch';
    assumptions: Readonly<{
        relationshipAndTopologyMs: number;
        profileFetchBatchMs: number;
        genderAccountsPerProviderCall: 2;
        genderProviderLatencyMs: number;
        confirmedFemalePersonalProfiles: number;
        featureProviderLatencyMs: number;
        privateProviderLatencyMs: number;
        handlerAdmissionWindowMs: number;
        observedPaidRetries: 0;
        observedAmbiguousPaidResponses: 0;
        costStatus: 'unknown_without_replay_token_usage';
    }>;
    topology: Readonly<{ publicProfiles: number; privateProfiles: number }>;
    totalEndToEndWallTimeMs: number;
    modeledUnderFiveMinutes: boolean;
    modeledOnly: true;
    duplicatePaidCalls: number;
    continuationDeadlineViolations: number;
    maxConcurrency: number;
    maxConcurrencyByStage: Readonly<Record<AnalysisV2SchedulerStage, number>>;
    stages: Readonly<Record<AnalysisV2SchedulerStage, Readonly<{
        logicalAccounts: number;
        operations: number;
        providerCalls: number;
        paidRetries: number;
        averageProviderLatencyMs: number;
    }>>>;
}

export function runAnalysisV2MicrobatchV29LifecycleFixture(input: Partial<{
    relationshipAndTopologyMs: number;
    profileFetchBatchMs: number;
    genderProviderLatencyMs: number;
    confirmedFemalePersonalProfiles: number;
    featureProviderLatencyMs: number;
    privateProviderLatencyMs: number;
}> = {}): AnalysisV2MicrobatchV29LifecycleFixtureMetrics {
    const assumptions = Object.freeze({
        relationshipAndTopologyMs: input.relationshipAndTopologyMs ?? 20_000,
        profileFetchBatchMs: input.profileFetchBatchMs ?? 25_000,
        genderAccountsPerProviderCall: 2 as const,
        // A bounded two-account response is conservatively modeled 400ms slower than v2.8's
        // individual triage call; it is not a measured provider latency.
        genderProviderLatencyMs: input.genderProviderLatencyMs ?? 3_400,
        // This is an explicit planning assumption, not an unknown-rate claim or replay result.
        confirmedFemalePersonalProfiles: input.confirmedFemalePersonalProfiles ?? 72,
        featureProviderLatencyMs: input.featureProviderLatencyMs ?? 6_000,
        privateProviderLatencyMs: input.privateProviderLatencyMs ?? 8_000,
        handlerAdmissionWindowMs:
            300_000 - ANALYSIS_V2_SCHEDULER_V1_POLICY.admissionReserveMs,
        observedPaidRetries: 0 as const,
        observedAmbiguousPaidResponses: 0 as const,
        costStatus: 'unknown_without_replay_token_usage' as const,
    });
    if (
        !Number.isSafeInteger(assumptions.confirmedFemalePersonalProfiles)
        || assumptions.confirmedFemalePersonalProfiles < 0
        || assumptions.confirmedFemalePersonalProfiles > 240
        || Object.values(assumptions).some(value => (
            typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)
        ))
    ) {
        throw new Error('ANALYSIS_V2_MICROBATCH_V29_FIXTURE_INVALID_ASSUMPTIONS');
    }

    const publicProfiles = 240;
    const privateProfiles = 145;
    const genderCalls = Math.ceil(
        publicProfiles / assumptions.genderAccountsPerProviderCall,
    );
    const featureCalls = assumptions.confirmedFemalePersonalProfiles;
    const privateCalls = 2;
    const genderWaves = Math.ceil(
        genderCalls / ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency,
    );
    const featureWaves = Math.ceil(
        featureCalls / ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
    );

    // Each 30-profile DAG job owns <=15 microbatches. The worst feature distribution is all
    // confirmed candidates in one job (10 waves at concurrency 3), still beneath the 75s
    // admission window. The serial wall-time bound below is therefore continuation-safe too.
    const worstPerJobGenderMs = Math.ceil(15 / 6) * assumptions.genderProviderLatencyMs;
    const worstPerJobFeatureMs = Math.ceil(Math.min(featureCalls, 30) / 3)
        * assumptions.featureProviderLatencyMs;
    const continuationDeadlineViolations = (
        worstPerJobGenderMs > assumptions.handlerAdmissionWindowMs
        || worstPerJobFeatureMs > assumptions.handlerAdmissionWindowMs
    ) ? 1 : 0;
    const totalEndToEndWallTimeMs = assumptions.relationshipAndTopologyMs
        + assumptions.profileFetchBatchMs
        + genderWaves * assumptions.genderProviderLatencyMs
        + featureWaves * assumptions.featureProviderLatencyMs
        + assumptions.privateProviderLatencyMs;
    return Object.freeze({
        fixture: 'standard-240-public-145-private-v29-microbatch' as const,
        assumptions,
        topology: Object.freeze({ publicProfiles, privateProfiles }),
        totalEndToEndWallTimeMs,
        modeledUnderFiveMinutes: totalEndToEndWallTimeMs <= 300_000
            && continuationDeadlineViolations === 0,
        modeledOnly: true as const,
        duplicatePaidCalls: 0,
        continuationDeadlineViolations,
        // Serial bound intentionally never claims concurrent overlap, but the configured caps
        // remain the same DB-global scheduler-v1 ceilings used by runtime admission.
        maxConcurrency: Math.max(
            ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency,
            ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
            ANALYSIS_V2_SCHEDULER_V1_POLICY.privateAccountNameConcurrency,
        ),
        maxConcurrencyByStage: Object.freeze({
            genderTriage: ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency,
            featureAnalysis: ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
            privateAccountName: ANALYSIS_V2_SCHEDULER_V1_POLICY.privateAccountNameConcurrency,
        }),
        stages: Object.freeze({
            genderTriage: Object.freeze({
                logicalAccounts: publicProfiles,
                operations: genderCalls,
                providerCalls: genderCalls,
                paidRetries: 0,
                averageProviderLatencyMs: assumptions.genderProviderLatencyMs,
            }),
            featureAnalysis: Object.freeze({
                logicalAccounts: featureCalls,
                operations: featureCalls,
                providerCalls: featureCalls,
                paidRetries: 0,
                averageProviderLatencyMs: assumptions.featureProviderLatencyMs,
            }),
            privateAccountName: Object.freeze({
                logicalAccounts: privateProfiles,
                operations: privateCalls,
                providerCalls: privateCalls,
                paidRetries: 0,
                averageProviderLatencyMs: assumptions.privateProviderLatencyMs,
            }),
        }),
    });
}

/**
 * Network-free lifecycle model for the measured Standard shape. Unlike the old idealized queue
 * fixture this includes external profile batches, media normalization, gender→feature dependency,
 * the observed rate-limit retry volume, 75-second admission windows, and redispatch overhead.
 * Assumptions are deliberately explicit; this is a release-planning bound, not production proof.
 */
export function runAnalysisV2SchedulerLifecycleFixture(input: Partial<{
    relationshipAndTopologyMs: number;
    profileFetchBatchMs: number;
    mediaNormalizePerWaveMs: number;
    genderProviderLatencyMs: number;
    featureProviderLatencyMs: number;
    privateProviderLatencyMs: number;
    rateLimitBackoffMs: number;
    continuationDispatchMs: number;
    admissionBackoffMs: number;
    ambiguousRecoveryMs: number;
}> = {}): AnalysisV2SchedulerLifecycleFixtureMetrics {
    const assumptions = Object.freeze({
        relationshipAndTopologyMs: input.relationshipAndTopologyMs ?? 20_000,
        profileFetchBatchMs: input.profileFetchBatchMs ?? 25_000,
        mediaNormalizePerWaveMs: input.mediaNormalizePerWaveMs ?? 600,
        genderProviderLatencyMs: input.genderProviderLatencyMs ?? 3_000,
        featureProviderLatencyMs: input.featureProviderLatencyMs ?? 6_000,
        privateProviderLatencyMs: input.privateProviderLatencyMs ?? 8_000,
        rateLimitBackoffMs: input.rateLimitBackoffMs ?? 1_000,
        continuationDispatchMs: input.continuationDispatchMs ?? 1_500,
        admissionBackoffMs: input.admissionBackoffMs ?? 5_000,
        ambiguousRecoveryMs: input.ambiguousRecoveryMs ?? 360_000,
        handlerAdmissionWindowMs:
            300_000 - ANALYSIS_V2_SCHEDULER_V1_POLICY.admissionReserveMs,
        observedGenderRateLimited: 210,
        observedFeatureRateLimited: 119,
    });
    if (Object.values(assumptions).some(value => (
        !Number.isSafeInteger(value) || value < 0
    ))) {
        throw new Error('ANALYSIS_V2_SCHEDULER_FIXTURE_INVALID_ASSUMPTIONS');
    }

    const jobs = new Map<string, FixtureJob>();
    const pending: FixtureOperation[] = [];
    let ordinal = 0;
    for (let batch = 0; batch < 8; batch++) {
        const jobKey = `track:profile-ai:batch:${batch}`;
        const startedAt = assumptions.relationshipAndTopologyMs
            + assumptions.profileFetchBatchMs;
        jobs.set(jobKey, {
            key: jobKey,
            generationStartedAtMs: startedAt,
            generation: 1,
            continuationPending: false,
        });
        for (let local = 0; local < 30; local++) {
            const profileIndex = batch * 30 + local;
            const retry = profileIndex < assumptions.observedGenderRateLimited;
            pending.push({
                key: `gender:${profileIndex}`,
                jobKey,
                stage: 'genderTriage',
                ordinal: ordinal++,
                eligibleAtMs: startedAt
                    + Math.floor(local / 6) * assumptions.mediaNormalizePerWaveMs,
                providerCalls: retry ? 2 : 1,
                rateLimitedCalls: retry ? 1 : 0,
                retryCount: retry ? 1 : 0,
                durationMs: assumptions.genderProviderLatencyMs * (retry ? 2 : 1)
                    + (retry ? assumptions.rateLimitBackoffMs : 0),
                profileIndex,
                terminalUnavailable: false,
            });
        }
    }
    for (let batch = 0; batch < 2; batch++) {
        const jobKey = `track:private-names:batch:${batch}`;
        jobs.set(jobKey, {
            key: jobKey,
            generationStartedAtMs: assumptions.relationshipAndTopologyMs,
            generation: 1,
            continuationPending: false,
        });
        pending.push({
            key: `private:${batch}`,
            jobKey,
            stage: 'privateAccountName',
            ordinal: ordinal++,
            eligibleAtMs: assumptions.relationshipAndTopologyMs
                + (batch === 0 ? assumptions.admissionBackoffMs : 0),
            providerCalls: 1,
            rateLimitedCalls: 0,
            retryCount: 0,
            durationMs: assumptions.privateProviderLatencyMs,
            profileIndex: null,
            terminalUnavailable: false,
        });
    }

    const limits: Record<AnalysisV2SchedulerStage, number> = {
        genderTriage: ANALYSIS_V2_SCHEDULER_V1_POLICY.genderTriageConcurrency,
        featureAnalysis: ANALYSIS_V2_SCHEDULER_V1_POLICY.featureAnalysisConcurrency,
        privateAccountName:
            ANALYSIS_V2_SCHEDULER_V1_POLICY.privateAccountNameConcurrency,
    };
    const active: Array<{ operation: FixtureOperation; completesAtMs: number }> = [];
    const activeByStage: Record<AnalysisV2SchedulerStage, number> = {
        genderTriage: 0,
        featureAnalysis: 0,
        privateAccountName: 0,
    };
    const peaks = { ...activeByStage };
    const stats: Record<AnalysisV2SchedulerStage, {
        operations: number;
        providerCalls: number;
        rateLimited: number;
        retries: number;
        providerLatencyTotalMs: number;
        terminalUnavailable: number;
    }> = {
        genderTriage: {
            operations: 0, providerCalls: 0, rateLimited: 0,
            retries: 0, providerLatencyTotalMs: 0,
            terminalUnavailable: 0,
        },
        featureAnalysis: {
            operations: 0, providerCalls: 0, rateLimited: 0,
            retries: 0, providerLatencyTotalMs: 0,
            terminalUnavailable: 0,
        },
        privateAccountName: {
            operations: 0, providerCalls: 0, rateLimited: 0,
            retries: 0, providerLatencyTotalMs: 0,
            terminalUnavailable: 0,
        },
    };
    let now = 0;
    let stageCursor = 0;
    let peakTotal = 0;
    let continuations = 0;

    const activeForJob = (jobKey: string) => active.some(
        item => item.operation.jobKey === jobKey
    );
    const isOpen = (operation: FixtureOperation) => {
        const job = jobs.get(operation.jobKey)!;
        return now >= job.generationStartedAtMs
            && now < job.generationStartedAtMs + assumptions.handlerAdmissionWindowMs;
    };

    for (let guard = 0; pending.length > 0 || active.length > 0; guard++) {
        if (guard > 100_000) {
            throw new Error('ANALYSIS_V2_SCHEDULER_FIXTURE_DID_NOT_CONVERGE');
        }
        let admitted = false;
        while (active.length < ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency) {
            let selectedIndex = -1;
            for (let offset = 0; offset < STAGES.length; offset++) {
                const stageIndex = (stageCursor + offset) % STAGES.length;
                const stage = STAGES[stageIndex]!;
                if (activeByStage[stage] >= limits[stage]) continue;
                selectedIndex = pending.findIndex(operation => (
                    operation.stage === stage
                    && operation.eligibleAtMs <= now
                    && isOpen(operation)
                ));
                if (selectedIndex >= 0) {
                    stageCursor = (stageIndex + 1) % STAGES.length;
                    break;
                }
            }
            if (selectedIndex < 0) break;
            admitted = true;
            const operation = pending.splice(selectedIndex, 1)[0]!;
            const stageStats = stats[operation.stage];
            stageStats.operations++;
            stageStats.providerCalls += operation.providerCalls;
            stageStats.rateLimited += operation.rateLimitedCalls;
            stageStats.retries += operation.retryCount;
            if (operation.terminalUnavailable) stageStats.terminalUnavailable++;
            const latency = operation.stage === 'genderTriage'
                ? assumptions.genderProviderLatencyMs
                : operation.stage === 'featureAnalysis'
                    ? assumptions.featureProviderLatencyMs
                    : assumptions.privateProviderLatencyMs;
            stageStats.providerLatencyTotalMs += latency * operation.providerCalls;
            activeByStage[operation.stage]++;
            peaks[operation.stage] = Math.max(
                peaks[operation.stage],
                activeByStage[operation.stage]
            );
            peakTotal = Math.max(peakTotal, active.length + 1);
            active.push({ operation, completesAtMs: now + operation.durationMs });
        }
        if (admitted) continue;

        for (const job of jobs.values()) {
            const hasPending = pending.some(operation => operation.jobKey === job.key);
            const cutoffAt = job.generationStartedAtMs
                + assumptions.handlerAdmissionWindowMs;
            if (
                hasPending
                && !activeForJob(job.key)
                && now >= cutoffAt
                && !job.continuationPending
            ) {
                job.generation++;
                continuations++;
                job.generationStartedAtMs = now + assumptions.continuationDispatchMs;
                job.continuationPending = true;
            }
            if (job.continuationPending && now >= job.generationStartedAtMs) {
                job.continuationPending = false;
            }
        }

        const nextActiveAt = active.length > 0
            ? Math.min(...active.map(item => item.completesAtMs))
            : Number.POSITIVE_INFINITY;
        const nextPendingAt = active.length
            >= ANALYSIS_V2_SCHEDULER_V1_POLICY.sharedConcurrency
            ? Number.POSITIVE_INFINITY
            : pending
            .filter(operation => activeByStage[operation.stage] < limits[operation.stage])
            .map(operation => {
                const job = jobs.get(operation.jobKey)!;
                const start = Math.max(operation.eligibleAtMs, job.generationStartedAtMs);
                return start > now
                    && start < job.generationStartedAtMs
                        + assumptions.handlerAdmissionWindowMs
                    ? start
                    : Number.POSITIVE_INFINITY;
            })
            .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
        const nextCutoffAt = pending
            .map(operation => jobs.get(operation.jobKey)!)
            .filter(job => !activeForJob(job.key))
            .map(job => job.generationStartedAtMs + assumptions.handlerAdmissionWindowMs)
            .filter(value => value > now)
            .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
        const next = Math.min(nextActiveAt, nextPendingAt, nextCutoffAt);
        if (!Number.isFinite(next) && active.length === 0 && pending.length > 0) {
            const pendingJobs = new Set(pending.map(operation => operation.jobKey));
            pendingJobs.forEach(jobKey => {
                const job = jobs.get(jobKey)!;
                job.generation++;
                continuations++;
                job.generationStartedAtMs = now + assumptions.continuationDispatchMs;
                job.continuationPending = true;
            });
            continue;
        }
        if (!Number.isFinite(next) || next < now) {
            throw new Error('ANALYSIS_V2_SCHEDULER_FIXTURE_INVALID_EVENT');
        }
        now = next;

        const completed = active
            .filter(item => item.completesAtMs === now)
            .sort((left, right) => left.operation.ordinal - right.operation.ordinal);
        for (const item of completed) {
            active.splice(active.indexOf(item), 1);
            activeByStage[item.operation.stage]--;
            if (item.operation.stage === 'genderTriage') {
                const profileIndex = item.operation.profileIndex!;
                const retry = profileIndex < assumptions.observedFeatureRateLimited;
                pending.push({
                    key: `feature:${profileIndex}`,
                    jobKey: item.operation.jobKey,
                    stage: 'featureAnalysis',
                    ordinal: ordinal++,
                    eligibleAtMs: now + (
                        profileIndex === 239 ? assumptions.ambiguousRecoveryMs : 0
                    ),
                    providerCalls: retry ? 2 : 1,
                    rateLimitedCalls: retry ? 1 : 0,
                    retryCount: retry ? 1 : 0,
                    durationMs: profileIndex === 239
                        ? 0
                        : assumptions.featureProviderLatencyMs * (retry ? 2 : 1)
                            + (retry ? assumptions.rateLimitBackoffMs : 0),
                    profileIndex,
                    terminalUnavailable: profileIndex === 239,
                });
            }
        }
    }

    const stageMetrics = Object.fromEntries(STAGES.map(stage => {
        const stageStats = stats[stage];
        return [stage, Object.freeze({
            operations: stageStats.operations,
            providerCalls: stageStats.providerCalls,
            rateLimited: stageStats.rateLimited,
            retries: stageStats.retries,
            terminalUnavailable: stageStats.terminalUnavailable,
            averageProviderLatencyMs: stageStats.providerCalls === 0
                ? 0
                : stageStats.providerLatencyTotalMs / stageStats.providerCalls,
        })];
    })) as AnalysisV2SchedulerLifecycleFixtureMetrics['stages'];
    return Object.freeze({
        fixture: 'standard-240-public-145-private-lifecycle',
        assumptions,
        topology: Object.freeze({
            profileBatches: 8,
            publicProfiles: 240,
            privateBatches: 2,
            privateProfiles: 145,
        }),
        totalEndToEndWallTimeMs: now,
        modeledUnderFiveMinutes: now <= 300_000,
        continuations,
        dispatchGenerations: [...jobs.values()]
            .reduce((total, job) => total + job.generation, 0),
        duplicatePaidCalls: 0,
        admissionDeferrals: 1,
        terminalUnavailableRecoveries: 1,
        maxConcurrency: peakTotal,
        maxConcurrencyByStage: Object.freeze(peaks),
        stages: Object.freeze(stageMetrics),
    });
}
