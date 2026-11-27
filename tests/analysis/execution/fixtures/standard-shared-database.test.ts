import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAnalysisV2EvidenceStore, createAnalysisV2RelationshipResultHash } from '@/lib/services/analysis/v2-evidence-store';
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
import { sharedStandardCapacities, sharedStandardCapacity } from './standard-shared-capacities.mjs';

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
    slots: ReturnType<typeof sharedStandardCapacity>['slots'],
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

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1').each(sharedStandardCapacities.filter(c => c.slots !== 8))(
    'runs high-numbered slot admission, stage limits, dispatch fencing and quarantine recovery with $preset', async ({ slots, features, resolvers, preset }) => {
        const db = await createSharedStandardDatabase(preset);
        try {
            const job = await seedProcessingJob(db);
            const { rpc, providerAdmissionStore, store, identities, acquire } = leaseHarness(db, slots, job);
            const attempts = createAnalysisV2AiAttemptStore({ rpc });
            const acquireStage = async (stage: AnalysisV2AiStage, count: number) => {
                const leases = [];
                for (let i = 0; i < count; i++) leases.push(await acquire(stage));
                return leases;
            };
            const feature = await acquireStage('featureAnalysis', features);
            await expect(acquire('featureAnalysis')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            // Keep ten triage leases active alongside the full resolver pool.
            for (const lease of feature.splice(slots - resolvers - 10)) await store.release(lease);
            const triage = await acquireStage('genderTriage', 12);
            await expect(acquire('genderTriage')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            const privateNames = await acquireStage('privateAccountName', 2);
            await expect(acquire('privateAccountName')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');
            for (const lease of [...privateNames, ...triage.splice(-2)]) await store.release(lease);
            const resolver = await acquireStage('genderResolution', resolvers);
            await expect(acquire('genderResolution')).rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
            await expect(acquire('partnerSafety')).rejects.toThrow('ANALYSIS_V2_AI_CAPACITY_PENDING');

            const leases = [...feature, ...triage, ...resolver];
            expect(new Set(leases.map(l => l.slot)).size).toBe(slots);
            const wireGate = (token: string) => rpc('authorize_analysis_v2_vertex_dispatch_v1', {
                p_request_id: job.requestId, p_job_key: job.jobKey, p_claim_token: token, p_job_input_hash: 'a'.repeat(64),
            });
            const high = resolver.at(-1)!;
            expect(high.slot).toBe(slots);
            await expect(db.query('SELECT * FROM public.release_analysis_v2_gemini_lease($1,$2,$3)',
                [slots + 1, high.claimToken, high.fence])).rejects.toMatchObject({
                code: 'P0001', message: 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            });
            const nextCredential = 'gemini-' + (slots + 1);
            await expect(db.query(`SELECT public.acquire_analysis_provider_admission(
                    public.analysis_provider_admission_expected_id('paid','gemini',$1,$2,$3,$4),
                    'paid','gemini',$1,'paid:gemini:global',$2,$3,$4,$5,$6,$7,gen_random_uuid(),240)`,
            [nextCredential, job.requestId, job.jobKey, high.providerAdmissionLease!.operationKey,
                job.jobClaimToken, high.claimToken, high.fence])).rejects.toMatchObject({
                code: 'P0001', message: 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN',
            });
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

            // The first wave spent starts in its own minute. Begin the independent full-pool
            // proof in a fresh local window; both waves together may exceed 240 starts.
            await db.exec(`UPDATE analysis_provider_admission_budgets
                SET window_started_at=now()-interval '61 seconds'
                WHERE logical_provider='gemini' AND workload_role='paid'`);
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

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1').each(sharedStandardCapacities)(
    'compares the sixteenth serial acquire with a fresh and spent minute on $preset', async ({ slots, preset }) => {
        const db = await createSharedStandardDatabase(preset);
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

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'persists progress alongside sibling parent readers while fencing cancellation and claim changes', async () => {
        const db = await createSharedStandardDatabase(8);
        try {
            const job = await seedProcessingJob(db);
            const tracks = JSON.stringify({
                relationshipAi: { state: 'running', stageCode: 'PUBLIC_PROFILES_COLLECTING', done: 1, total: 4, progressBp: 2500 },
                interactions: { state: 'pending', stageCode: 'INTERACTIONS_QUEUED', done: 0, total: 2, progressBp: 0 },
                finalization: { state: 'pending', stageCode: 'FINALIZATION_QUEUED', done: 0, total: 3, progressBp: 0 },
            });
            await db.query(`UPDATE public.analysis_preflights p SET status='consumed',consumed_at=now(),
                consumed_request_id=r.id,exclusion_decision='skip',target_followers_count=1,target_following_count=0,
                target_is_private=false,ready_at=now(),capacity_required_plan_id='basic',required_plan_id='basic',
                plan_cards_snapshot=r.plan_cards_snapshot FROM public.analysis_requests r
                WHERE r.id=$1 AND p.id=r.preflight_id`, [job.requestId]);
            await db.query(`INSERT INTO public.analysis_progress_state(request_id,revision,status,progress_bp,
                background_processing,tracks,last_event_seq,snapshot_fingerprint)
                VALUES($1,1,'processing',1800,true,$2,0,repeat('0',64))`, [job.requestId, tracks]);
            const checkpoint = `SELECT public.checkpoint_analysis_v2_progress(
                $1,$2,$3,repeat('a',64),'processing',1800,true,$4,NULL,NULL,repeat('0',64)) AS result`;
            const args = [job.requestId, job.jobKey, job.jobClaimToken, tracks];
            await db.transaction(async reader => {
                await reader.query(`SELECT id FROM public.analysis_preflights WHERE consumed_request_id=$1 FOR SHARE`, [job.requestId]);
                await reader.query(`SELECT id FROM public.analysis_requests WHERE id=$1 FOR SHARE`, [job.requestId]);
                await db.transaction(async writer => {
                    await writer.exec("SET LOCAL lock_timeout='250ms'");
                    await writer.exec('SET LOCAL ROLE service_role');
                    const result = await writer.query(checkpoint, args);
                    expect(result.rows[0].result).toMatchObject({ snapshot: { revision: 1, progressBp: 1800 } });
                });
            });
            await db.transaction(async writer => {
                await writer.query(checkpoint, args);
                await expect(db.transaction(async cancellation => {
                    await cancellation.exec("SET LOCAL lock_timeout='100ms'");
                    await cancellation.query('SELECT id FROM public.analysis_requests WHERE id=$1 FOR UPDATE', [job.requestId]);
                })).rejects.toMatchObject({ code: '55P03' });
            });
            await expect(db.query(checkpoint, [job.requestId, job.jobKey, randomUUID(), tracks]))
                .rejects.toMatchObject({ message: 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH' });
        } finally { await db.close(); }
    }, 45_000,
);
it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'keeps an active request receipt writable when another cost source is busy', async () => {
        const db = await createSharedStandardDatabase();
        try {
            const { requestId } = await seedProcessingJob(db);
            await db.transaction(async busy => {
                await busy.exec('LOCK TABLE public.vertex_ai_budget_reservations IN ACCESS EXCLUSIVE MODE');
                await db.transaction(async worker => {
                    await worker.exec("SET LOCAL statement_timeout='500ms'");
                    await worker.query('SELECT public.analysis_v2_refresh_cost_rollup_snapshot($1)', [requestId]);
                });
            });
            const unchanged = await db.query('SELECT count(*)::int AS n FROM public.analysis_v2_cost_rollup_snapshots WHERE request_id=$1', [requestId]);
            expect(unchanged.rows).toEqual([{ n: 0 }]);
        } finally { await db.close(); }
    }, 45_000,
);

it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1')(
    'reads the original ordered relationship evidence for six concurrent Standard requests and detects source deletion', async () => {
        const db = await createSharedStandardDatabase();
        const jobKey = 'track:relationships:collect';
        const reader = 'public.load_analysis_v2_relationship_staging';
        const read = (requestId: string) => createAnalysisV2EvidenceStore(db.client()).loadRelationshipStaging({ requestId, jobKey });
        try {
            // Only the reference is restored from the baseline. Exercise the RPC installed by the normal fixture.
            const baseline = readFileSync('supabase/dev-ui/production-baseline.sql', 'utf8');
            const start = baseline.indexOf('CREATE FUNCTION ' + reader + '(');
            const end = baseline.indexOf('\n$_$;', start);
            expect(start).toBeGreaterThan(-1);
            expect(end).toBeGreaterThan(start);
            const ids: string[] = [];
            for (let i = 0; i < 6; i++) {
                const job = await seedProcessingJob(db);
                const id = job.requestId;
                ids.push(id);
                await db.query(`UPDATE public.analysis_preflights p SET status='consumed', consumed_at=now(), consumed_request_id=r.id,
                    exclusion_decision='skip', target_followers_count=601, target_following_count=601, target_is_private=false,
                    ready_at=now(), capacity_required_plan_id='basic', required_plan_id='basic', plan_cards_snapshot=r.plan_cards_snapshot
                    FROM public.analysis_requests r WHERE r.id=$1 AND p.id=r.preflight_id`, [id]);
                await db.query("UPDATE public.analysis_pipeline_jobs SET job_key=$2, kind='collection', batch=NULL WHERE request_id=$1 AND job_key=$3",
                    [id, jobKey, job.jobKey]);
                const members = Array.from({ length: 601 }, (_, k) => ({
                    username: 'fixture_' + k, isPrivate: k === 142, isVerified: k % 5 === 2,
                    fullName: k % 3 ? '사용자 ' + k : null, profilePicUrl: k % 7 ? 'https://fixture.invalid/' + k : null,
                }));
                for (const side of ['followers', 'following'] as const) {
                    const rows = side === 'followers' ? members : [...members].reverse();
                    await db.query(`INSERT INTO public.analysis_v2_relationship_sides
                        (request_id,job_key,side,job_claim_token,provider,provider_run_id,provider_operation_key,provider_credential_slot,
                        declared_count,collected_count,coverage_bps,input_hash,result_hash,completed_at,created_at,updated_at)
                        VALUES ($1,$2,$3::text,$4,'apify','fixtureRun','relationship-'||$3||':'||repeat('b',64),'secondary',
                        601,601,10000,repeat('a',64),$5,now(),now(),now())`,
                        [id, jobKey, side, job.jobClaimToken, createAnalysisV2RelationshipResultHash(side, rows)]);
                    await db.query(`INSERT INTO public.analysis_v2_relationship_rows
                        (request_id,job_key,side,ordinal,username,is_private,is_verified,full_name,profile_pic_url)
                        SELECT $1,$2,$3,ordinality,v->>'username',(v->>'isPrivate')::boolean,(v->>'isVerified')::boolean,
                               v->>'fullName',v->>'profilePicUrl' FROM jsonb_array_elements($4) WITH ORDINALITY x(v,ordinality)`,
                        [id, jobKey, side, JSON.stringify(rows)]);
                }
                await db.query(`SELECT public.freeze_analysis_v2_relationships($1,$2,$3,repeat('a',64),
                    (analysis_scope_snapshot->>'detailedMutualLimit')::integer) FROM public.analysis_requests WHERE id=$1`,
                    [id, jobKey, job.jobClaimToken]);
            }
            const results = await Promise.all(ids.map(read));
            expect(results.every(s => s?.mutualRows.length === 601 && s.privateMutualRows.length === 1)).toBe(true);
            await db.transaction(async tx => {
                // The previous RPC exists only in this connection, with all original arrays and sort keys.
                const original = baseline.slice(start, end + '\n$_$;'.length).replace(reader, 'pg_temp.original_relationship_read');
                await tx.exec(original);
                const versions = await tx.query(`SELECT
                    (SELECT md5(prosrc) FROM pg_proc WHERE oid='pg_temp.original_relationship_read(uuid,text)'::regprocedure) AS previous,
                    (SELECT md5(prosrc) FROM pg_proc WHERE oid=$1::regprocedure) AS installed`, [reader + '(uuid,text)']);
                expect(versions.rows).toEqual([{
                    previous: '49950faf19bf83282cc5a422702d6964', installed: '2ae784476f9ee92c95895c63a98eccf5',
                }]);
                const result = await tx.query(`SELECT bool_and(${reader}(id,$2)=pg_temp.original_relationship_read(id,$2)) AS same
                    FROM unnest($1::uuid[]) AS fixture(id)`, [ids, jobKey]);
                expect(result.rows).toEqual([{ same: true }]);
            });
            const grants = await db.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') AS anon,
                 has_function_privilege('authenticated',$1,'EXECUTE') AS member,
                 has_function_privilege('service_role',$1,'EXECUTE') AS worker`, [reader + '(uuid,text)']);
            expect(grants.rows).toEqual([{ anon: false, member: false, worker: true }]);
            await db.query("DELETE FROM public.analysis_v2_relationship_rows WHERE request_id=$1 AND side='followers' AND ordinal=3", [ids[0]]);
            await expect(read(ids[0])).rejects.toThrow('followers relationship staging drift');
            await db.query('UPDATE public.analysis_v2_mutual_rows SET full_name=NULL WHERE request_id=$1 AND mutual_ordinal=2', [ids[1]]);
            await expect(read(ids[1])).rejects.toThrow('relationship staging drift');
            await db.query("DELETE FROM public.analysis_v2_relationship_sides WHERE request_id=$1 AND side='following'", [ids[2]]);
            await expect(db.query('SELECT ' + reader + '($1,$2)', [ids[2], jobKey])).rejects.toMatchObject({ code: 'P0002' });
            await db.query('DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id=$1', [ids[3]]);
            expect(await read(ids[3])).toBeNull();
            await db.query('DELETE FROM public.analysis_v2_mutual_rows WHERE request_id=$1', [ids[4]]);
            const empty = await db.query(`SELECT s->'mutualRows' AS mutual, s->'privateMutualRows' AS private,
                s->'privateMutualUsernames' AS names, s->'detailedPublicUsernames' AS detailed
                FROM ${reader}($1,$2) AS s`, [ids[4], jobKey]);
            expect(empty.rows).toEqual([{ mutual: [], private: [], names: [], detailed: [] }]);
            await expect(read(ids[4])).rejects.toThrow('relationship staging drift');
            await expect(db.query('SELECT ' + reader + '($1,$2)', [null, jobKey])).rejects.toMatchObject({ code: 'P0001' });
        } finally {
            await db.close();
        }
    }, 45_000,
);
