import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { VertexDispatchWindow, withVertexDispatchAuthorization } from '@/lib/services/ai/vertex-dispatch-window';
import { createAnalysisV2AiAttemptStore } from '@/lib/services/analysis/v2-ai-attempt-store';
import { createAnalysisV2AiAuditAdapter, createAnalysisV2AiResultIdentity, createAnalysisV2AiResultStore } from '@/lib/services/analysis/v2-ai-result-store';
import { withPaidStandardCapacityJob, paidStandardExpandedCapacityEnabled } from '@/lib/services/analysis/paid-standard-capacity';
import { createAnalysisV2GeminiLeaseStore } from '@/lib/services/analysis/v2-gemini-lease-store';
import { createAnalysisProviderAdmissionStore } from '@/lib/services/analysis/provider-admission-store';
import { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';

const install = readFileSync('supabase/operations/20261126_expand_paid_standard_vertex.sql', 'utf8');
const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const policy = 'ai-stage-policy-v2.11';
const env = {
    NODE_ENV: 'production', K_SERVICE: 'analysis-paid-worker', ANALYSIS_WORKLOAD_ROLE: 'paid',
    PAID_STANDARD_VERTEX_CAPACITY_MODE: 'expanded128', ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true'
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type Database = Awaited<ReturnType<typeof createSharedStandardDatabase>>;

async function seedPaidOrder(db: Database, index: number) {
    const source = await seedProcessingJob(db);
    const order = randomUUID();
    const { rows: [request] } = await db.query<{ user_id: string; preflight_id: string }>(
        'SELECT user_id,preflight_id FROM analysis_requests WHERE id=$1', [source.requestId]);
    const identity = { requestId: source.requestId, jobKey: source.jobKey, claimToken: source.jobClaimToken, inputHash: 'a'.repeat(64) };
    const eligibility = () => db.client().rpc('paid_standard_capacity_approved_v1', {
        p_request_id: identity.requestId,
        p_job_key: identity.jobKey, p_job_claim_token: identity.claimToken
    });
    expect((await eligibility()).data).toBe(false);
    await db.query("UPDATE users SET phone_number=$2,phone_number_normalized=$3,phone_number_verified_at=now(),phone_number_verification_source='kakao_rest_api' WHERE id=$1", [request.user_id, '0100000000' + index, '+82100000000' + index]);
    await db.query(`INSERT INTO earlybird_orders(id,user_id,preflight_id,target_instagram_id,target_followers_count,
        target_following_count,exclusion_decision,plan_id,pricing_version,expected_amount_krw,expected_groble_product_id,
        disclosure_version,disclosure_text,disclosure_accepted_at,status,payment_id,actual_groble_product_id,actual_amount_krw,
        paid_at,buyer_match_policy,seller_reference_confirmed_at) VALUES($1,$2,$3,'capacity_fixture',150,110,'skip','standard',
        'fixture',9900,'fixture','fixture','fixture',now(),'paid',$1::uuid::text,'fixture',4900,now(),'legacy_email',now())`,
        [order, request.user_id, request.preflight_id]);
    await db.query(`UPDATE analysis_requests SET plan_access_mode_snapshot='production',test_entitlement_jti_hash=NULL,
        idempotency_key='earlybird:'||$2::text WHERE id=$1`, [source.requestId, order]);
    await db.query(`UPDATE analysis_preflights p SET access_mode='production',exclusion_decision='skip',exclusion_decided_at=now(),
        status='consumed',ready_at=now(),consumed_at=now(),consumed_request_id=r.id,
        plan_cards_snapshot=r.plan_cards_snapshot,target_followers_count=150,target_following_count=110,target_is_private=false,
        capacity_required_plan_id='basic',required_plan_id='basic',admission_status='ready',admission_generation=1,
        admission_selected_plan_id='standard',admission_entitlement_jti_hash=$2,admission_token=gen_random_uuid(),
        admission_requested_at=now(),admission_refreshed_at=now(),admission_dispatch_generation=1,
        admission_dispatch_state='enqueued',admission_dispatch_token=gen_random_uuid(),admission_dispatch_reserved_at=now(),
        admission_dispatched_at=now(),admission_target_followers_count=150,admission_target_following_count=110,
        admission_capacity_required_plan_id='basic',admission_required_plan_id='basic',admission_plan_cards_snapshot=r.plan_cards_snapshot
        FROM analysis_requests r WHERE p.id=r.preflight_id AND r.id=$1`, [source.requestId, hash('earlybird-fulfillment-admission-v1\n' + order)]);
    await db.query("UPDATE earlybird_orders SET status='analysis_in_progress',result_request_id=$1 WHERE id=$2", [source.requestId, order]);
    await db.query("UPDATE earlybird_fulfillments SET status='analysis_in_progress',operator_admitted_at=now(),request_id=$1 WHERE order_id=$2", [source.requestId, order]);
    expect(await eligibility()).toMatchObject({ data: true, error: null });
    return { source, order, identity, eligibility };
}

native('routes a discounted, verified production Standard order through the real provider and physical admission stores', async () => {
    const db = await createSharedStandardDatabase(8, { production: true });
    try {
        await db.exec(install);
        const rpc = (name: string, params: Record<string, unknown>) => db.client().rpc(name, params);
        const owners: Awaited<ReturnType<typeof seedPaidOrder>>[] = [];
        for (let i = 0; i < 3; i++) owners.push(await seedPaidOrder(db, i));
        const { source, order, identity, eligibility } = owners[0];
        const eligibilityProbe = 'SELECT public.authorize_paid_standard_vertex_dispatch_v1($1,$2,$3,$4) AS ok';
        const probeArgs = [source.requestId, source.jobKey, source.jobClaimToken, 'a'.repeat(64)];
        await db.transaction(async tx => {
            await tx.query('UPDATE analysis_requests SET progress=progress WHERE id=$1', [source.requestId]);
            const {rows} = await db.query<{ok:boolean}>(eligibilityProbe,probeArgs);
            expect(rows).toEqual([{ok:true}]); // The unrelated writer still holds its row lock.
        });
        const recheck = 'SELECT paid_standard_capacity.lock_approved($1,$2,$3) AS ok';
        const currentJob = [source.requestId,source.jobKey,source.jobClaimToken];
        for (const isolation of ['REPEATABLE READ','SERIALIZABLE'] as const) {
            await db.transaction(async tx => {
                await tx.exec('SET TRANSACTION ISOLATION LEVEL ' + isolation);
                expect((await tx.query<{ok:boolean}>(recheck,currentJob)).rows).toEqual([{ok:false}]);
                expect((await tx.query<{ok:boolean}>(eligibilityProbe,probeArgs)).rows).toEqual([{ok:false}]);
            });
        }
        const eligibilityMutations: [string, string[]][] = [
            ["UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [order]],
            ["UPDATE earlybird_fulfillments SET status='manual_review',manual_review_at=now() WHERE order_id=$1", [order]],
            ["UPDATE analysis_preflights SET admission_entitlement_jti_hash=repeat('b',64) WHERE consumed_request_id=$1", [source.requestId]],
            ["UPDATE analysis_requests SET target_instagram_id='changed_owner_target' WHERE id=$1", [source.requestId]],
            ["UPDATE analysis_pipeline_jobs SET lease_token=gen_random_uuid() WHERE request_id=$1 AND job_key=$2", [source.requestId,source.jobKey]],
            ["UPDATE users SET traffic_class='operator' WHERE id=(SELECT user_id FROM analysis_requests WHERE id=$1)", [source.requestId]],
        ];
        for (const [mutation, args] of eligibilityMutations) {
            const rollback = new Error('undo synthetic revocation');
            await expect(db.transaction(async tx => {
                await tx.query(mutation,args);
                expect((await tx.query<{ok:boolean}>(recheck,currentJob)).rows).toEqual([{ok:false}]);
                // A second connection still sees the previously committed purchase. The
                // relevant writer's exclusive lock must nevertheless block its grant.
                await expect(db.query(recheck,currentJob)).rejects.toMatchObject({
                    code:'55P03',message:'PAID_STANDARD_CAPACITY_LOCK_BUSY',
                });
                throw rollback;
            })).rejects.toBe(rollback);
        }
        await db.transaction(async tx => {
            expect((await tx.query<{ok:boolean}>(recheck,currentJob)).rows).toEqual([{ok:true}]);
            await db.query(`UPDATE analysis_pipeline_jobs SET lease_expires_at=lease_expires_at+interval '1 minute'
                WHERE request_id=$1 AND job_key=$2`,[source.requestId,source.jobKey]);
        });
        const names: string[] = [];
        const trackedRpc = (name: string, params: Record<string, unknown>) => { names.push(name); return rpc(name, params); };
        const store = createAnalysisV2GeminiLeaseStore({ env, rpc: trackedRpc, providerAdmissionStore: createAnalysisProviderAdmissionStore({ rpc: trackedRpc }) });
        const acquire = (i: number) => store.acquire({
            ...source, stage: 'featureAnalysis', attempt: 1, aiStagePolicyVersion: policy,
            operationKey: 'feature-analysis:' + hash(String(i)), handlerDeadlineAtMs: performance.now() + 300_000
        });
        let checked = 0;
        const verify = async () => { checked++; return (await eligibility()).data === true; };
        await withPaidStandardCapacityJob(identity, verify, async () => {
            expect(await paidStandardExpandedCapacityEnabled(policy, identity)).toBe(true);
            const leases = [];
            for (let i = 0; i < 9; i++) leases.push(await acquire(i));
            expect(leases[8].slot).toBe(9);
            expect(await store.renew(leases[8])).toMatchObject({ slot: 9 });
            for (const lease of leases) await store.release(lease);
        }, env);
        expect(checked).toBe(1);
        expect(names.filter(n => n === 'acquire_paid_standard_gemini_lease_v1')).toHaveLength(9);
        expect(names).toContain('acquire_paid_standard_provider_admission_v1');
        expect(await withPaidStandardCapacityJob(identity, verify, () => paidStandardExpandedCapacityEnabled(policy, identity),
            { ...env, PAID_STANDARD_VERTEX_CAPACITY_MODE: 'off' })).toBe(false);
        expect(await withPaidStandardCapacityJob(identity, verify, () => paidStandardExpandedCapacityEnabled(policy, identity),
            { ...env, ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'false' })).toBe(false);
        expect(await withPaidStandardCapacityJob(identity, verify, () => paidStandardExpandedCapacityEnabled(policy,
            { ...identity, claimToken: randomUUID() }), env)).toBe(false);
        const race = owners[2];
        const approval = await race.eligibility();
        expect(approval.data).toBe(true);
        let waiting!: Promise<unknown>;
        // A refund commits after the guard first accepts this job while the allocator
        // is waiting for its normal physical lock. No slot may survive that race.
        await db.transaction(async tx => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('analysis-v2-gemini-leases',0))");
            const attempt = db.query(`SELECT outcome FROM public.acquire_paid_standard_gemini_lease_v1(
                $1,$2,$3,'genderResolution',1,$4,240,$5)`, [race.source.requestId, race.source.jobKey,
            'gender-resolution:' + hash('refund-race'), randomUUID(), race.identity.claimToken]);
            waiting = expect(attempt).rejects.toThrow('PAID_STANDARD_CAPACITY_APPROVAL_REQUIRED');
            await expect.poll(async () => {
                const { rows } = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE wait_event='advisory' AND query LIKE 'SELECT outcome FROM public.acquire_paid_standard%'`);
                return rows[0].count;
            }).toBe(1);
            await db.query("UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [race.order]);
            expect((await race.eligibility()).data).toBe(false);
        });
        await waiting;
        const leftovers = await db.query('SELECT slot FROM analysis_v2_gemini_leases WHERE operation_key=$1',
            ['gender-resolution:' + hash('refund-race')]);
        expect(leftovers.rows).toEqual([]);
        // Restore the synthetic order for the independent saturation check.
        await db.query("UPDATE earlybird_orders SET status='analysis_in_progress' WHERE id=$1", [race.order]);
        const cases = { featureAnalysis: 'feature-analysis', genderResolution: 'gender-resolution' } as const;
        const physical = async (index: number, stage: keyof typeof cases, expanded = true) => {
            const owner = owners[index % owners.length];
            const args = {
                p_request_id: owner.source.requestId, p_job_key: owner.source.jobKey, p_stage: stage,
                p_operation_key: cases[stage] + ':' + hash('saturation-' + index), p_attempt: 1, p_claim_token: randomUUID(), p_lease_seconds: 240
            };
            const name = expanded ? 'acquire_paid_standard_gemini_lease_v1' : 'acquire_analysis_v2_scheduler_gemini_lease_v1';
            const reply = await rpc(name, expanded ? { ...args, p_job_claim_token: owner.identity.claimToken } : args);
            expect(reply.error).toBeNull();
            return reply.data;
        };
        for (let i = 0; i < 3; i++) expect(await physical(i, 'featureAnalysis', false)).toMatchObject([{ outcome: 'acquired' }]);
        expect(await physical(3, 'featureAnalysis', false)).toMatchObject([{ outcome: 'capacity_pending' }]);
        for (let i = 3; i < 80; i++) expect(await physical(i, 'featureAnalysis')).toMatchObject([{ outcome: 'acquired' }]);
        expect(await physical(80, 'featureAnalysis')).toMatchObject([{ outcome: 'capacity_pending' }]);
        for (let i = 0; i < 48; i++) expect(await physical(i, 'genderResolution')).toMatchObject([{ outcome: 'acquired' }]);
        expect(await physical(48, 'genderResolution')).toMatchObject([{ outcome: 'resolver_capacity_pending' }]);
        expect((await db.query("SELECT count(*)::int AS num,max(slot)::int AS max FROM analysis_v2_gemini_leases WHERE state='leased'")).rows)
            .toEqual([{ num: 128, max: 128 }]);
        await db.exec(`SELECT release_analysis_v2_gemini_lease_v2(slot,lease_claim_token,fence,operation_key)
            FROM analysis_v2_gemini_leases WHERE slot=128`);
        await withPaidStandardCapacityJob(identity, verify, async () => {
            const lease = await store.acquire({
                ...source, stage: 'genderResolution', attempt: 1, aiStagePolicyVersion: policy,
                operationKey: 'gender-resolution:' + hash('slot-128'), handlerDeadlineAtMs: performance.now() + 300_000,
            });
            expect(lease.slot).toBe(128);
            expect(await store.renew(lease)).toMatchObject({ slot: 128 });
            await store.release(lease);
        }, env);
        const wireArgs = {
p_request_id: source.requestId, p_job_key: source.jobKey,
            p_claim_token: identity.claimToken, p_job_input_hash: 'a'.repeat(64)
};
        expect((await rpc('authorize_paid_standard_vertex_dispatch_v1', wireArgs)).data).toBe(true);
        const revokeBeforeLogical = async (name: string, params: Record<string, unknown>) => {
            if (name === 'acquire_paid_standard_provider_admission_v1') {
                expect(params.p_credential_slot).toBe('gemini-128');
                await db.query("UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [order]);
                const legacy = await rpc('acquire_analysis_provider_admission', params);
                expect(legacy.error?.message).toBe('ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN');
            }
            return rpc(name, params);
        };
        const racedStore = createAnalysisV2GeminiLeaseStore({
env, rpc, providerAdmissionStore:
                createAnalysisProviderAdmissionStore({ rpc: revokeBeforeLogical })
});
        await withPaidStandardCapacityJob(identity, verify, async () => {
            await expect(racedStore.acquire({
...source, stage: 'genderResolution', attempt: 1, aiStagePolicyVersion: policy,
                operationKey: 'gender-resolution:' + hash('logical-refund'), handlerDeadlineAtMs: performance.now() + 300_000
}))
                .rejects.toThrow('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
        }, env);
        expect((await rpc('authorize_paid_standard_vertex_dispatch_v1', wireArgs)).data).toBe(false);
        expect((await db.query("SELECT count(*)::int AS remaining FROM analysis_provider_admission_leases WHERE credential_slot='gemini-128' AND state='leased'")).rows)
            .toEqual([{ remaining: 0 }]);
        expect((await db.query('SELECT state FROM analysis_v2_gemini_leases WHERE slot=128')).rows).toEqual([{ state: 'available' }]);
        // An actual logical commit can lose its HTTP acknowledgement. Revocation
        // before the replay must retain that one hold for the recovery ledger.
        await db.query("UPDATE earlybird_orders SET status='analysis_in_progress' WHERE id=$1", [order]);
        let acknowledgementsLost = 0;
        const loseFirstAcceptedReceipt = async (name: string, params: Record<string, unknown>) => {
            const reply = await rpc(name, params);
            if (name === 'acquire_paid_standard_provider_admission_v1' && !reply.error && acknowledgementsLost === 0) {
                acknowledgementsLost++;
                await db.query("UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [order]);
                return {data:null,error:{code:'NETWORK',message:'synthetic missing receipt'}};
            }
            return reply;
        };
        const uncertainStore = createAnalysisV2GeminiLeaseStore({env,rpc,providerAdmissionStore:
            createAnalysisProviderAdmissionStore({rpc:loseFirstAcceptedReceipt})});
        await withPaidStandardCapacityJob(identity, verify, async () => {
            await expect(uncertainStore.acquire({...source,stage:'genderResolution',attempt:1,aiStagePolicyVersion:policy,
                operationKey:'gender-resolution:'+hash('accepted-before-refund'),handlerDeadlineAtMs:performance.now()+300_000}))
                .rejects.toThrow();
        }, env);
        expect(acknowledgementsLost).toBe(1);
        expect((await db.query("SELECT count(*)::int AS held FROM analysis_provider_admission_leases WHERE credential_slot='gemini-128' AND state='leased'")).rows)
            .toEqual([{held:1}]);
        expect((await db.query('SELECT state FROM analysis_v2_gemini_leases WHERE slot=128')).rows).toEqual([{state:'leased'}]);
        for (const role of ['anon', 'authenticated', 'service_role']) {
            const { rows } = await db.query(`SELECT has_function_privilege($1,'public.acquire_paid_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer,uuid)','EXECUTE') AS endpoint,
                has_function_privilege($1,'paid_standard_capacity.acquire_direct(uuid,text,text,text,integer,uuid,integer)','EXECUTE') AS direct`, [role]);
            expect(rows).toEqual([{ endpoint: role === 'service_role', direct: false }]);
        }
        await db.query("UPDATE earlybird_orders SET actual_amount_krw=0 WHERE id=$1", [order]);
        expect((await eligibility()).data).toBe(false);
        expect((await rpc('acquire_paid_standard_gemini_lease_v1', {
            p_request_id: source.requestId, p_job_key: source.jobKey,
            p_operation_key: 'gender-resolution:' + hash('denied'), p_stage: 'genderResolution', p_attempt: 1,
            p_claim_token: randomUUID(), p_lease_seconds: 240, p_job_claim_token: identity.claimToken
        })).error?.message)
            .toBe('PAID_STANDARD_CAPACITY_APPROVAL_REQUIRED');
    } finally { await db.close(); }
}, 60_000);

native('commits the final paid wire approval with its attempt, and preserves an unacknowledged committed hold', async () => {
    const db = await createSharedStandardDatabase(8, { production: true });
    try {
        await db.exec(install);
        const { identity, order, eligibility } = await seedPaidOrder(db, 1);
        const client = db.client();
        const leaseStore = createAnalysisV2GeminiLeaseStore({ env, rpc: client.rpc,
            providerAdmissionStore: createAnalysisProviderAdmissionStore({ rpc: client.rpc }) });
        const stages = { stage: 'genderTriage', modelName: 'gemini-3.1-flash-lite', thinkingLevel: 'MINIMAL',
            mediaResolution: 'LOW', promptVersion: 'gender-triage-v2', schemaVersion: 2, maxOutputTokens: 2_048 } as const;
        const makeIdentity = (fixture: string) => createAnalysisV2AiResultIdentity({ ...stages, inputHash: hash(fixture),
            mediaSnapshotHash: hash('synthetic media'), cacheScope: 'request' });
        const resultIdentity = makeIdentity('wire fixture');
        const uncertainIdentity = makeIdentity('lost receipt');
        const wireArgs = { p_request_id: identity.requestId, p_job_key: identity.jobKey,
            p_claim_token: identity.claimToken, p_job_input_hash: identity.inputHash };
        async function nextDelivery() {
            identity.claimToken = randomUUID();
            wireArgs.p_claim_token = identity.claimToken;
            await db.query('UPDATE analysis_pipeline_jobs SET lease_token=$3 WHERE request_id=$1 AND job_key=$2',
                [identity.requestId, identity.jobKey, identity.claimToken]);
        }
        let syntheticSends = 0;
        let finalReservations = 0;
        type Mode = 'normal' | 'lose_receipt' | 'lock_final_approval';
        async function invoke(mode: Mode, selectedIdentity = resultIdentity) {
            return withPaidStandardCapacityJob(identity, async () => (await eligibility()).data === true, async () => {
                expect(await paidStandardExpandedCapacityEnabled(policy, identity)).toBe(true);
                const audit = createAnalysisV2AiAuditAdapter({
                    requestId: identity.requestId, jobKey: identity.jobKey, claimToken: identity.claimToken,
                    resultIdentity: selectedIdentity, resultSchema: z.object({}), aiStagePolicyVersion: policy, leaseStore,
                    resultStore: createAnalysisV2AiResultStore(client),
                    handlerDeadlineAtMs: performance.now() + 300_000,
                    attemptStore: createAnalysisV2AiAttemptStore({ async rpc(name, params) {
                        if (name !== 'reserve_paid_standard_ai_attempt_v1') return client.rpc(name, params);
                        finalReservations++;
                        if (mode === 'lock_final_approval') {
                            return db.transaction(async tx => {
                                await tx.query("SELECT pg_advisory_xact_lock(paid_standard_capacity.lock_key('request',$1))",
                                    [identity.requestId]);
                                return client.rpc(name, params);
                            });
                        }
                        const reply = await client.rpc(name, params);
                        if (mode === 'lose_receipt' && !reply.error) throw new Error('synthetic committed acknowledgement loss');
                        return reply;
                    } }),
                });
                if ((await audit.prepare()).result) return;
                await withVertexDispatchAuthorization(async () => {
                    const reply = await client.rpc('authorize_paid_standard_vertex_dispatch_v1', wireArgs);
                    return reply.data === true && !reply.error;
                }, async () => {
                    const window = new VertexDispatchWindow(240_000, () => audit.onBeforeAttempt({
                        ...stages, requestId: identity.requestId, location: 'asia-northeast3', mediaCount: 1,
                        attempt: 1, retryCount: 0,
                    }));
                    await window.prepareFetch();
                    window.markSent();
                    syntheticSends++;
                    await audit.onAttemptTelemetry({
                        ...stages, location: 'asia-northeast3', mediaCount: 1, attempt: 1, retryCount: 0,
                        latencyMs: 1, estimatedCostUsd: 0.000001, usageComplete: true, usageMetadataStatus: 'complete',
                        tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
                        disposition: 'success', finishReason: 'STOP',
                    }, {});
                });
            }, env);
        }
        const ledger = async () => (await db.query(`SELECT
            (SELECT count(*)::int FROM analysis_v2_ai_attempts WHERE request_id=$1) AS attempts,
            (SELECT count(*)::int FROM analysis_v2_gemini_leases WHERE state='leased') AS physical,
            (SELECT count(*)::int FROM analysis_provider_admission_leases WHERE state='leased') AS logical`,
        [identity.requestId])).rows[0];
        let denied!: Promise<void>;
        await db.transaction(async tx => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('analysis-v2-ai-attempt:' || $1 || ':' || $2,0))",
                [identity.requestId, resultIdentity.operationKey]);
            denied = expect(invoke('normal')).rejects.toMatchObject({ reason: 'closed' });
            await expect.poll(async () => (await db.query<{n:number}>(`SELECT count(*)::int n FROM pg_stat_activity
                WHERE wait_event='advisory' AND query LIKE 'SELECT to_jsonb(%reserve_paid_standard_ai_attempt_v1%'`)).rows[0].n)
                .toBe(1);
            await db.query("UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [order]);
        });
        await denied;
        expect(await ledger()).toEqual({ attempts: 0, physical: 0, logical: 0 });
        expect(syntheticSends).toBe(0);
        expect(await client.rpc('paid_standard_capacity_lineage_v1', { p_request_id: identity.requestId }))
            .toMatchObject({ data: true, error: null });
        expect((await eligibility()).data).toBe(false);
        await db.transaction(async tx => {
            await tx.exec('SAVEPOINT recovered_order');
            await tx.query("UPDATE analysis_requests SET idempotency_key=idempotency_key || '.r1' WHERE id=$1", [identity.requestId]);
            await tx.query('DELETE FROM earlybird_fulfillments WHERE order_id=$1', [order]);
            expect((await tx.query('SELECT public.paid_standard_capacity_lineage_v1($1) AS scoped', [identity.requestId])).rows)
                .toEqual([{ scoped: true }]);
            await tx.exec('ROLLBACK TO SAVEPOINT recovered_order');
        });
        await db.query("UPDATE earlybird_orders SET status='analysis_in_progress' WHERE id=$1", [order]);
        await nextDelivery();
        await expect(invoke('lock_final_approval')).rejects.toMatchObject({ reason: 'db_contention' });
        expect(await ledger()).toEqual({ attempts: 0, physical: 0, logical: 0 });
        expect(syntheticSends).toBe(0);
        await nextDelivery();
        await invoke('normal');
        await invoke('normal'); // The published operation reuses its checkpoint.
        expect(await ledger()).toEqual({ attempts: 1, physical: 0, logical: 0 });
        expect(syntheticSends).toBe(1);
        await expect(invoke('lose_receipt', uncertainIdentity)).rejects.toThrow('ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING');
        expect(await ledger()).toEqual({ attempts: 2, physical: 1, logical: 1 });
        await expect(invoke('normal', uncertainIdentity)).rejects.toThrow();
        expect(await ledger()).toEqual({ attempts: 2, physical: 1, logical: 1 });
        expect(finalReservations).toBe(4);
        expect(syntheticSends).toBe(1);
    } finally { await db.close(); }
}, 60_000);
