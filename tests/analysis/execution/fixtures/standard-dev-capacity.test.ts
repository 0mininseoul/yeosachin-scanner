import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';

type Database = Awaited<ReturnType<typeof createSharedStandardDatabase>>;
const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const install = readFileSync('supabase/dev-ui/live-standard-capacity.sql', 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// Bind a second synthetic request to the actual owner approval, preflight consumption and active job.
async function seedOwnerStandard(db: Database, template: Awaited<ReturnType<typeof seedProcessingJob>>) {
    const owner = { id: randomUUID(), email: 'capacity-owner@example.invalid', target: 'capacity_fixture' };
    await db.query(`INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,'{"provider":"kakao","analysis_test_runner_v1":"basic"}')`, [owner.id, owner.email]);
    await db.query(`INSERT INTO auth.identities VALUES($1,'kakao',jsonb_build_object('email',$2::text,'email_verified',true))`, [owner.id, owner.email]);
    await db.exec(`INSERT INTO account_ledger_rollout_state(singleton,paid_ever_state,classification_command_version,classification_completed_at)
        VALUES(true,'active','dev-live-basic-v1',now())`);
    await db.query("SELECT * FROM provision_e2e_test_runner_v1($1,$2,'basic','dev-live-basic-v1')", [owner.id, owner.email]);
    await db.query(`INSERT INTO account_classification_audit(account_id,command_version,reason_code,previous_account_class,previous_traffic_class,
        previous_lifecycle,next_account_class,next_traffic_class,next_lifecycle)
        VALUES($1,'dev-live-basic-v1','DEV_LIVE_BASIC_TESTER','production','external','active','e2e_test','e2e_test','active')`, [owner.id]);
    await db.query('INSERT INTO dev_live_budget.standard_owner_policy(target_instagram_id) VALUES($1)', [owner.target]);
    const {rows:[grant]} = await db.query<{id:string}>("SELECT dev_live_owner_start_v4($1,$2,$3)->>'id' AS id",[owner.id, owner.target, randomUUID()]);
    const entitlement = hash('analysis-test-entitlement-jti-v1\ndev-live-' + grant.id);
    const admission = randomUUID();
    const {rows:[preflight]} = await db.query<{id:string}>(`INSERT INTO analysis_preflights(
        user_id,target_instagram_id,idempotency_key,access_mode,exclusion_decision,exclusion_decided_at,
        status,created_at,expires_at,ready_at,launch_status_snapshot,plan_catalog_snapshot,
        pricing_version,pricing_snapshot,policy_versions_snapshot,plan_cards_snapshot,
        target_followers_count,target_following_count,target_is_private,capacity_required_plan_id,required_plan_id,
        admission_status,admission_generation,admission_selected_plan_id,admission_entitlement_jti_hash,
        admission_token,admission_requested_at,admission_refreshed_at,admission_dispatch_generation,
        admission_dispatch_state,admission_dispatch_token,admission_dispatch_reserved_at,admission_dispatched_at,
        admission_target_followers_count,admission_target_following_count,admission_capacity_required_plan_id,
        admission_required_plan_id,admission_plan_cards_snapshot)
        SELECT $5,r.target_instagram_id,$2,'test_entitlement','skip',now(),'ready',now(),now()+interval '30 minutes',
            now(),p.launch_status_snapshot,p.plan_catalog_snapshot,p.pricing_version,p.pricing_snapshot,r.policy_versions_snapshot,
            r.plan_cards_snapshot,150,110,false,'basic','basic','ready',1,'standard',$3,$4,now(),now(),1,
            'enqueued',gen_random_uuid(),now(),now(),150,110,'basic','basic',r.plan_cards_snapshot
        FROM analysis_requests r JOIN analysis_preflights p ON p.id=r.preflight_id WHERE r.id=$1 RETURNING id`,
        [template.requestId, 'dev-live:owner:standard:' + grant.id, entitlement, admission, owner.id]);
    const {rows:[created]} = await db.query<{request_id:string}>(`SELECT request_id FROM consume_analysis_v2_test_entitlement(
        $1,$2,'standard',$3,$4)`, [preflight.id,owner.id,entitlement,admission]);
    await db.query("UPDATE analysis_requests SET status='processing' WHERE id=$1", [created.request_id]);
    await db.query(`INSERT INTO analysis_pipeline_jobs(request_id,job_key,track,kind,batch,input_hash,status,lease_token,
        lease_expires_at,created_at,updated_at,recovery_not_before,dispatch_state,dispatch_generation,dispatch_reservation_token,
        dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,attempt_count,first_started_at)
        SELECT $1,job_key,track,kind,batch,input_hash,status,gen_random_uuid(),lease_expires_at,created_at,updated_at,
        recovery_not_before,dispatch_state,dispatch_generation,gen_random_uuid(),dispatch_reserved_at,dispatched_at,
        'expanded-fixture',delivered_at,attempt_count,first_started_at FROM analysis_pipeline_jobs WHERE request_id=$2 AND job_key=$3`,
        [created.request_id,template.requestId,template.jobKey]);
    return created.request_id;
}

native(
    'installs only on the idle Dev baseline, retaining old allocators and binding all expanded calls to an owner grant', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        await db.exec("UPDATE analysis_provider_admission_budgets SET window_count=7 WHERE budget_key='paid:gemini:global'");
        await db.exec('UPDATE analysis_v2_gemini_leases SET fence=17 WHERE slot=2');
        await db.exec(install);
        await db.exec(install);
        expect((await db.query('SELECT fence::int FROM analysis_v2_gemini_leases WHERE slot=2')).rows).toEqual([{ fence: 17 }]);
        expect((await db.query(`SELECT (SELECT count(*)::int FROM analysis_v2_gemini_leases) slots,
            max_active,rate_limit_per_minute,window_count FROM analysis_provider_admission_budgets WHERE budget_key='paid:gemini:global'`)).rows)
            .toEqual([{ slots:128, max_active:128, rate_limit_per_minute:240, window_count:7 }]);
        const job = await seedProcessingJob(db);
        const current = 'acquire_analysis_v2_gemini_lease_v2';
        const scheduler = 'acquire_analysis_v2_scheduler_gemini_lease_v1';
        const expanded = 'acquire_dev_standard_gemini_lease_v1';
        const expandedScheduler = 'acquire_dev_standard_scheduler_gemini_lease_v1';
        const stageKeys = { featureAnalysis: 'feature-analysis', genderResolution: 'gender-resolution', genderTriage: 'gender-triage' };
        const lease = (name: string, request: string, index: number, stage: keyof typeof stageKeys = 'featureAnalysis', token=randomUUID()) =>
            db.client().rpc(name, { p_request_id:request, p_job_key:job.jobKey, p_claim_token:token,
                p_stage:stage, p_operation_key: stageKeys[stage] + ':' + hash(String(index)),
                p_attempt:1, p_lease_seconds:240 });
        for (const name of [expanded,expandedScheduler]) {
            expect((await lease(name,job.requestId,0)).error?.message).toBe('DEV_STANDARD_CAPACITY_APPROVAL_REQUIRED');
        }
        for (let i=1;i<=6;i++) expect((await lease(scheduler,job.requestId,i)).data).toMatchObject([{ outcome:'acquired',slot:i }]);
        expect((await lease(scheduler,job.requestId,7)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        for (let i=7;i<=8;i++) expect((await lease(current,job.requestId,i)).data).toMatchObject([{ outcome:'acquired',slot:i }]);
        expect((await lease(current,job.requestId,9)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        expect((await db.client().rpc('acquire_analysis_v2_gemini_lease', {
            p_request_id:job.requestId,p_job_key:'old-job',p_attempt:1,p_claim_token:randomUUID(),
        })).data).toMatchObject([{ outcome:'capacity_pending' }]);
        const approved = await seedOwnerStandard(db,job);
        const sameToken = randomUUID();
        const first = await lease(expandedScheduler,approved,9,'featureAnalysis',sameToken);
        expect(first).toMatchObject({ data:[{ outcome:'acquired',slot:9 }],error:null });
        expect((await lease(expandedScheduler,approved,9,'featureAnalysis',sameToken)).data).toEqual(first.data);
        expect((await lease(scheduler,approved,9,'featureAnalysis',sameToken)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        expect((await lease(current,approved,9,'featureAnalysis',sameToken)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        expect((await lease(expanded,approved,10,'genderResolution')).data).toMatchObject([{ outcome:'acquired',slot:10 }]);
        expect((await lease(expanded,approved,11,'featureAnalysis')).error?.message).toBe('DEV_STANDARD_CAPACITY_STAGE_MISMATCH');
        for (let i = 1; i <= 7; i++) expect((await lease(expandedScheduler, approved, 100 + i)).data)
            .toMatchObject([{ outcome: 'acquired' }]);
        for (let i = 1; i <= 3; i++) expect((await lease(expanded, approved, 200 + i, 'genderResolution')).data)
            .toMatchObject([{ outcome: 'acquired' }]);
        const releaseRange = (condition: string) => db.exec(`SELECT released FROM public.analysis_v2_gemini_leases l
            CROSS JOIN LATERAL public.release_analysis_v2_gemini_lease_v2(l.slot,l.lease_claim_token,l.fence,l.operation_key)
            WHERE l.state='leased' AND ${condition}`);
        await releaseRange('l.slot <= 8');
        // Legacy should still acquire low slots with eight feature and four resolver leases in the high range.
        expect((await lease(scheduler, job.requestId, 30)).data).toMatchObject([{ outcome:'acquired', slot:1 }]);
        expect((await lease(current, job.requestId, 31, 'genderResolution')).data).toMatchObject([{ outcome:'acquired', slot:2 }]);
        for (let i = 1; i <= 12; i++) expect((await lease(expandedScheduler, approved, 300 + i, 'genderTriage')).data)
            .toMatchObject([{ outcome: 'acquired' }]);
        expect((await lease(expandedScheduler, approved, 313, 'genderTriage')).data).toMatchObject([{ outcome:'capacity_pending' }]);
        await releaseRange("l.stage = 'genderTriage'");
        for (let i = 1; i <= 71; i++) expect((await lease(expandedScheduler, approved, 400 + i)).data)
            .toMatchObject([{ outcome: 'acquired' }]);
        expect((await lease(expandedScheduler, approved, 472)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        expect((await lease(current, job.requestId, 472)).data).toMatchObject([{ outcome:'capacity_pending' }]);
        for (let i = 1; i <= 43; i++) expect((await lease(expanded, approved, 500 + i, 'genderResolution')).data)
            .toMatchObject([{ outcome: 'acquired' }]);
        expect((await lease(expanded, approved, 544, 'genderResolution')).data).toMatchObject([{ outcome:'resolver_capacity_pending' }]);
        expect((await db.query("SELECT count(*)::int AS n,max(slot)::int AS maximum FROM analysis_v2_gemini_leases WHERE state='leased'")).rows)
            .toEqual([{ n:128, maximum:128 }]);
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled=false');
        for (const name of [expanded,expandedScheduler]) {
            expect((await lease(name,approved,9,'featureAnalysis',sameToken)).error?.message).toBe('DEV_STANDARD_CAPACITY_APPROVAL_REQUIRED');
        }
        await expect(db.exec(install)).rejects.toThrow('DEV_STANDARD_CAPACITY_REQUIRES_IDLE_WORKERS');
    } finally { await db.close(); }
}, 60_000);

native('rolls back a partial install on digest drift and rejects expanded grant options on reapply', async () => {
    const db = await createSharedStandardDatabase(8);
    const body = install.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
    const installInTransaction = () => db.transaction(tx => tx.exec(body));
    try {
        const old = 'public.renew_analysis_v2_gemini_lease(integer,uuid,bigint,integer)';
        const {rows:[original]} = await db.query<{definition:string}>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [old]);
        await db.exec('ALTER FUNCTION ' + old + " SET work_mem = '8MB'");
        await expect(installInTransaction()).rejects.toThrow('DEV_STANDARD_CAPACITY_SOURCE_DRIFT');
        expect((await db.query(`SELECT (SELECT count(*)::int FROM analysis_v2_gemini_leases) AS slots,
            to_regprocedure('public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)') IS NULL AS absent`)).rows)
            .toEqual([{ slots:8, absent:true }]);
        await db.exec(original.definition);
        await db.exec(install);
        await db.exec('GRANT EXECUTE ON FUNCTION public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer) TO service_role WITH GRANT OPTION');
        await expect(installInTransaction()).rejects.toThrow('DEV_STANDARD_CAPACITY_SCOPED_RPC_DRIFT');
    } finally { await db.close(); }
}, 60_000);
