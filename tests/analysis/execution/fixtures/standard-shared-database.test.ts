import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedProcessingJob } from './standard-shared-processing-job';
import {
    createAnalysisV2AiAttemptStore, type AnalysisV2AiStage,
} from '@/lib/services/analysis/v2-ai-attempt-store';
import {
    createAnalysisV2AiMediaSnapshotHashFromParts, createAnalysisV2AiResultIdentity, createAnalysisV2AiResultInputHash,
    createAnalysisV2AiResultStore, type AnalysisV2AiResultIdentity
} from '@/lib/services/analysis/v2-ai-result-store';
import { partnerSafetyModelResponseSchema } from '@/lib/services/ai/v2-staged-analysis';
import { estimateGeminiRequestCostStrict } from '@/lib/services/ai/gemini-cost';
import { syntheticGeneration } from './standard-vertex';
import { getAiStagePolicy } from '@/lib/services/ai/stage-policy';
import { createAnalysisV2GeminiLeaseStore } from '@/lib/services/analysis/v2-gemini-lease-store';
import { createAnalysisProviderAdmissionStore } from '@/lib/services/analysis/provider-admission-store';
import { createSharedStandardDatabase } from './standard-shared-database';

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'shares the installed Dev schema and eight slots across sixteen isolated PostgreSQL sessions', async () => {
        const db = await createSharedStandardDatabase();
        try {
            const { rows } = await db.query(`SELECT
                (SELECT count(*)::int FROM analysis_v2_gemini_leases WHERE state = 'available') AS slots,
                (SELECT max_active FROM analysis_provider_admission_budgets WHERE budget_key = 'paid:gemini:global') AS budget,
                to_regprocedure('public.load_dev_standard_profile_media_ready_v1(uuid,text,uuid,text)') IS NOT NULL AS ready`);
            expect(rows).toEqual([{ slots: 8, budget: 8, ready: true }]);
            const pids = new Set<number>();
            const gate = Promise.withResolvers<void>();
            const deadline = setTimeout(() => gate.reject(new Error('Sixteen live sessions required')), 10_000);
            const reads = Array.from({ length: 16 }, () => db.transaction(async tx => {
                const { rows: [session] } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                pids.add(session.pid);
                if (pids.size === 16) gate.resolve();
                await gate.promise;
            }).catch(error => {
                gate.reject(error);
                throw error;
            }));
            try {
                await Promise.all(reads);
            } finally {
                clearTimeout(deadline);
            }
            expect(pids.size).toBe(16);

            const owner = randomUUID();
            const args = { p_user_id: owner, p_target_instagram_id: 'fixture' };
            const rpc = 'dev_live_owner_start_ready_v4';
            await expect(db.client().rpc(rpc, args)).resolves.toEqual({ data: false, error: null });
            for (const client of [db.client(owner), db.client(null)]) {
                await expect(client.rpc(rpc, args)).resolves.toMatchObject({ data: null, error: { code: '42501' } });
            }
        } finally {
            await db.close();
        }
    }, 60_000,
);

function leaseHarness(
    db: Awaited<ReturnType<typeof createSharedStandardDatabase>>,
    slots: 8 | 48 | 56,
    job: Awaited<ReturnType<typeof seedProcessingJob>>,
) {
    const { rpc } = db.client();
    const providerAdmissionStore = createAnalysisProviderAdmissionStore({ rpc });
    const store = createAnalysisV2GeminiLeaseStore({
        rpc, providerAdmissionStore,
        env: { NODE_ENV: 'test', STANDARD_SHARED_VERTEX_SLOTS: String(slots), ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' }
    });
    let ordinal = 0;
    const identities = new Map<string, AnalysisV2AiResultIdentity>();
    const acquire = (stage: AnalysisV2AiStage) => {
        const policy = getAiStagePolicy('ai-stage-policy-v2.11', stage);
        const identity = createAnalysisV2AiResultIdentity({
            stage, modelName: policy.model,
            thinkingLevel: policy.thinkingLevel, mediaResolution: policy.mediaResolution,
            schemaVersion: policy.schemaVersion, promptVersion: policy.promptVersion,
            maxOutputTokens: policy.maxOutputTokens, inputHash: createAnalysisV2AiResultInputHash(String(++ordinal)),
            mediaSnapshotHash: createAnalysisV2AiMediaSnapshotHashFromParts([]), cacheScope: 'request'
        });
        identities.set(identity.operationKey, identity);
        return store.acquire({
            ...job, operationKey: identity.operationKey, stage, attempt: 1,
            aiStagePolicyVersion: 'ai-stage-policy-v2.11', handlerDeadlineAtMs: performance.now() + 300_000
        });
    };
    return { rpc, providerAdmissionStore, store, identities, acquire };
}

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1').each([48, 56] as const)(
    'runs high-numbered slot admission, stage limits, dispatch fencing and quarantine recovery with %i physical slots', async slots => {
        const db = await createSharedStandardDatabase(slots);
        try {
            const job = await seedProcessingJob(db);
            const { rpc, providerAdmissionStore, store, identities, acquire } = leaseHarness(db, slots, job);
            const attempts = createAnalysisV2AiAttemptStore({ rpc });
            const acquireStage = async (stage: AnalysisV2AiStage, count: number) => {
                const leases = [];
                for (let i = 0; i < count; i++) leases.push(await acquire(stage));
                return leases;
            };
            const feature = await acquireStage('featureAnalysis', slots === 48 ? 32 : 40);
            await expect(acquire('featureAnalysis')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            const triage = await acquireStage('genderTriage', 12);
            await expect(acquire('genderTriage')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            const privateNames = await acquireStage('privateAccountName', 2);
            await expect(acquire('privateAccountName')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            for (const lease of [...privateNames, ...triage.splice(-2)]) await store.release(lease);
            const resolver = await acquireStage('genderResolution', 6);
            await expect(acquire('genderResolution')).rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
            await expect(acquire('partnerSafety')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');

            const leases = [...feature, ...triage, ...resolver];
            expect(new Set(leases.map(l => l.slot)).size).toBe(slots);
            const wireGate = (token: string) => rpc('authorize_analysis_v2_vertex_dispatch_v1', {
                p_request_id: job.requestId, p_job_key: job.jobKey, p_claim_token: token, p_job_input_hash: 'a'.repeat(64),
            });
            const high = resolver.at(-1)!;
            expect(high.slot).toBe(slots);
            const metadata = (identity: AnalysisV2AiResultIdentity) => ({
                requestId: job.requestId, jobKey: job.jobKey, claimToken: job.jobClaimToken,
                operationKey: identity.operationKey, stage: identity.stage, attempt: 1, retryCount: 0,
                modelName: identity.modelName, thinkingLevel: identity.thinkingLevel, mediaResolution: identity.mediaResolution,
                mediaCount: 0, location: 'global', promptVersion: identity.promptVersion,
                schemaVersion: identity.schemaVersion, maxOutputTokens: identity.maxOutputTokens,
            });
            const input = metadata(identities.get(high.operationKey!)!);
            const reservation = await attempts.reserve(input);
            expect(reservation.created).toBe(true);
            expect(await wireGate(job.jobClaimToken)).toEqual({ data: true, error: null });
            expect(await store.cutoffAttempt({
                lease: high, attempt: {
                    ...input, reservationToken: reservation.reservationToken,
                    status: 'cutoff', usageMetadataStatus: 'missing', usageComplete: false, tokenUsage: null,
                    latencyMs: 2, estimatedCostUsd: null, finishReason: null
                }
            })).toBe('cutoff');
            expect(await wireGate(randomUUID())).toEqual({ data: false, error: null });
            await expect(store.renew({ ...high, claimToken: randomUUID() })).rejects.toThrow('ANALYSIS_V2_GEMINI_LEASE_FENCE');
            expect(await store.reapCutoff()).toBe(0);
            await db.query(`UPDATE analysis_v2_gemini_leases SET acquired_at=now()-interval '10 minutes',
                expires_at=now()-interval '1 second' WHERE slot=$1 AND state='quarantined'`, [slots]);
            expect(await store.reapCutoff()).toBe(1);
            await providerAdmissionStore.release(high.providerAdmissionLease!);
            const reused = await acquire('genderResolution');
            expect(reused.slot).toBe(slots);
            expect(reused.fence).toBeGreaterThan(high.fence);
            await expect(store.renew(high)).rejects.toThrow('ANALYSIS_V2_GEMINI_LEASE_FENCE');
            for (const lease of [...feature, ...triage, ...resolver.slice(0, -1), reused]) await store.release(lease);

            // A single ungated-by-stage operation type exercises every physical slot with the same model schema.
            const resultStore = createAnalysisV2AiResultStore({ rpc });
            const publishing = await acquireStage('partnerSafety', slots);
            for (const lease of publishing) {
                const renewed = await store.renew(lease);
                expect(renewed.providerAdmissionLease?.credentialSlot).toBe('gemini-' + lease.slot);
                const identity = identities.get(lease.operationKey!)!;
                const input = metadata(identity);
                const reservation = await attempts.reserve(input);
                expect(reservation.created).toBe(true);
                expect(await wireGate(job.jobClaimToken)).toEqual({ data: true, error: null });
                const response = syntheticGeneration({
                    contents: { parts: [] }, config: {
                        responseJsonSchema: {
                            properties: { companionPattern: {} },
                        }
                    }
                });
                const result = partnerSafetyModelResponseSchema.parse(JSON.parse(response.text));
                const tokenUsage = {
                    promptTokens: response.usageMetadata.promptTokenCount,
                    completionTokens: response.usageMetadata.candidatesTokenCount, thinkingTokens: 0,
                    totalTokens: response.usageMetadata.totalTokenCount
                };
                const terminal = {
                    requestId: job.requestId, jobKey: job.jobKey, claimToken: job.jobClaimToken,
                    resultIdentity: identity, attempt: 1, retryCount: 0, reservationToken: reservation.reservationToken,
                    location: 'global', mediaCount: 0, usageMetadataStatus: 'complete' as const, usageComplete: true, tokenUsage,
                    estimatedCostUsd: estimateGeminiRequestCostStrict(tokenUsage, identity.modelName).totalCostUsd,
                    latencyMs: 2, finishReason: 'STOP' as const, result
                };
                const checkpoint = await resultStore.terminalizeSuccess(terminal, partnerSafetyModelResponseSchema);
                expect(checkpoint.chargeStatus).toBe('generated_complete');
                const duplicate = await resultStore.terminalizeSuccess(terminal, partnerSafetyModelResponseSchema);
                expect(duplicate.resultHash).toBe(checkpoint.resultHash);
                await store.release(lease);
            }
            expect((await db.query(`SELECT
                (SELECT count(*)::int FROM analysis_v2_gemini_leases WHERE state = 'available') AS free,
                (SELECT count(*)::int FROM analysis_provider_admission_leases WHERE state <> 'released') AS active,
                (SELECT count(*)::int FROM analysis_v2_ai_attempts WHERE status='success' AND usage_complete) AS success,
                (SELECT count(*)::int FROM analysis_v2_ai_result_checkpoints WHERE source='generated') AS checkpoints,
                (SELECT count(*)::int FROM analysis_v2_ai_attempts WHERE status='cutoff' AND estimated_cost_usd IS NULL) AS cutoff,
                (SELECT count(*)::int FROM analysis_provider_admission_budgets WHERE logical_provider='gemini'
                    AND credential_slot IS NOT NULL AND window_count > 0 AND max_active=1 AND rate_limit_per_minute=15) AS used,
                (SELECT rate_limit_per_minute FROM analysis_provider_admission_budgets WHERE budget_key='paid:gemini:global') AS rpm`)).rows)
                .toEqual([{ free: slots, active: 0, success: slots, checkpoints: slots, cutoff: 1, used: slots, rpm: 240 }]);

            const budgetCount = async (key: string) => (await db.query<{ starts: number }>(
                'SELECT window_count AS starts FROM analysis_provider_admission_budgets WHERE budget_key=$1', [key],
            )).rows[0].starts;
            const globalKey = 'paid:gemini:global';
            const remainingStarts = 240 - await budgetCount(globalKey);
            for (let remaining = remainingStarts; remaining > 0; remaining -= slots) {
                const wave = await acquireStage('partnerSafety', Math.min(remaining, slots));
                for (const lease of wave) await store.release(lease);
            }
            await expect(acquire('partnerSafety')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            expect(await budgetCount(globalKey)).toBe(240);
        } finally {
            await db.close();
        }
    }, 60_000,
);

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1').each([8, 48, 56] as const)(
    'compares the sixteenth serial acquire with a fresh and spent minute on %i slots', async slots => {
        const db = await createSharedStandardDatabase(slots);
        try {
            const job = await seedProcessingJob(db);
            const { acquire, store } = leaseHarness(db, slots, job);
            const globalKey = 'paid:gemini:global';
            const acquirePartner = () => acquire('partnerSafety');
            const budgetCount = async (key: string) => (await db.query<{ count: number }>(
                'SELECT window_count AS count FROM analysis_provider_admission_budgets WHERE budget_key=$1', [key],
            )).rows[0].count;
            for (let i = 0; i < 15; i++) {
                const lease = await acquirePartner();
                expect(lease.slot).toBe(1);
                await store.release(lease);
            }
            if (slots === 8) {
                await expect(acquirePartner()).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
                expect(await budgetCount(globalKey)).toBe(15);
                expect(await budgetCount('paid:gemini:gemini-2')).toBe(0);
                return;
            }
            const sixteenth = await acquirePartner();
            expect(sixteenth.slot).toBe(2);
            await store.release(sixteenth);
            expect(await budgetCount(globalKey)).toBe(16);
            expect(await budgetCount('paid:gemini:gemini-1')).toBe(15);

            // Serial starts fill 16 distinct credential windows before the global budget binds.
            for (let ordinal = 17; ordinal <= 240; ordinal++) {
                const lease = await acquirePartner();
                expect(lease.slot).toBe(Math.ceil(ordinal / 15));
                await store.release(lease);
            }
            await expect(acquirePartner()).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            expect(await budgetCount(globalKey)).toBe(240);

            // Move only these two local fixture clocks across the boundary. The
            // authoritative admission function must reset them on the next start.
            await db.exec(`UPDATE analysis_provider_admission_budgets SET window_started_at=now()-interval '61 seconds'
                WHERE budget_key IN ('paid:gemini:global','paid:gemini:gemini-1')`);
            const rolled = await acquirePartner();
            expect(rolled.slot).toBe(1);
            await store.release(rolled);
            expect(await budgetCount('paid:gemini:gemini-1')).toBe(1);
            expect(await budgetCount(globalKey)).toBe(1);
            expect(await budgetCount('paid:gemini:gemini-2')).toBe(15);

            // Seed staggered prior-window usage; exercise both limits with actual,
            // simultaneous acquire transactions and keep the winners leased as evidence.
            const seedLimits = async (globalStarts: number, perSlot: number) => db.query(`UPDATE analysis_provider_admission_budgets
                SET window_started_at = now(), window_count = CASE WHEN credential_slot IS NULL THEN $1::int ELSE $2::int END
                WHERE logical_provider = 'gemini' AND workload_role = 'paid'`, [globalStarts, perSlot]);
            const race = async (expected: number) => {
                const outcomes = await Promise.allSettled(Array.from({ length: 8 }, acquirePartner));
                const leases = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
                for (const outcome of outcomes) {
                    if (outcome.status === 'rejected') expect(outcome.reason.message).toBe('ANALYSIS_V2_AI_CAPACITY_PENDING');
                }
                expect(leases).toHaveLength(expected);
                expect(new Set(leases.map(lease => lease.slot)).size).toBe(expected);
                expect((await db.query(`SELECT count(*)::int AS active, count(DISTINCT credential_slot)::int AS distinct_slots
                    FROM analysis_provider_admission_leases WHERE state = 'leased'`)).rows)
                    .toEqual([{ active: expected, distinct_slots: expected }]);
                for (const lease of leases) await store.release(lease);
                return leases;
            };
            await seedLimits(239, 0);
            await race(1);
            expect(await budgetCount(globalKey)).toBe(240);

            await seedLimits(100, 15);
            await race(0);
            expect(await budgetCount(globalKey)).toBe(100);

            await db.exec(`UPDATE analysis_provider_admission_budgets SET window_count=14
                WHERE budget_key IN ('paid:gemini:gemini-1','paid:gemini:gemini-2')`);
            const winners = await race(2);
            expect(winners.map(lease => lease.slot).sort()).toEqual([1, 2]);
            expect(await budgetCount(globalKey)).toBe(102);
            expect((await db.query(`SELECT max(window_count) AS peak, min(window_count) AS floor
                FROM analysis_provider_admission_budgets WHERE logical_provider='gemini' AND credential_slot IS NOT NULL`)).rows)
                .toEqual([{ peak: 15, floor: 15 }]);
            expect((await db.query("SELECT count(*)::int AS remaining FROM analysis_v2_gemini_leases WHERE state <> 'available'")).rows)
                .toEqual([{ remaining: 0 }]);
        } finally {
            await db.close();
        }
    }, 60_000,
);
