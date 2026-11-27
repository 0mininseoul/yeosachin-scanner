import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { standardCloudSixInstallSql } from '../../../../supabase/dev-ui/standard-cloud-six-install.mjs';
import { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';
import { target } from './standard-providers';

const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const wave = 'c'.repeat(64);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Db = Awaited<ReturnType<typeof createSharedStandardDatabase>>;

async function admitFixture(db: Db, owner: string) {
    const template = await seedProcessingJob(db);
    const { rows: [preflight] } = await db.query<{ id: string }>(`INSERT INTO analysis_preflights
        (user_id,idempotency_key,target_instagram_id,access_mode,exclusion_decision,exclusion_decided_at,status,created_at,
         expires_at,ready_at,launch_status_snapshot,plan_catalog_snapshot,pricing_version,pricing_snapshot,policy_versions_snapshot,
         target_followers_count,target_following_count,target_is_private,capacity_required_plan_id,required_plan_id,plan_cards_snapshot)
        SELECT $2,$3,$4,'production','skip',now(),'ready',now(),now()+interval '30 minutes',now(),p.launch_status_snapshot,
            p.plan_catalog_snapshot,p.pricing_version,p.pricing_snapshot,p.policy_versions_snapshot,150,110,false,'basic','basic',
            r.plan_cards_snapshot FROM analysis_preflights p JOIN analysis_requests r ON r.preflight_id=p.id
        WHERE r.id=$1 RETURNING id`,[template.requestId,owner,'dev-cloud-six:'+wave+':1',target]);
    const admin = db.client();
    const orderArgs = {p_wave:wave,p_owner_id:owner,p_preflight_id:preflight.id};
    const create = () => admin.rpc('dev_cloud_six_create_order_v1', orderArgs);
    const [one,two] = await Promise.all([create(),create()]);
    expect(one.error).toBeNull();
    expect(two).toEqual(one);
    const order = String(one.data);
    const {rows:[admission]}=await db.query<{fulfillment_status:string}>('SELECT * FROM public.admit_earlybird_fulfillment($1)',[order]);
    expect(admission.fulfillment_status).toBe('admission_pending');
    expect((await db.query('SELECT claim_paid_analysis_capacity_v1($1) AS state',[order])).rows).toEqual([{state:'ready'}]);
    const dispatch = randomUUID();
    await db.query(`UPDATE analysis_preflights SET admission_status='ready',admission_generation=1,admission_selected_plan_id='standard',
        admission_entitlement_jti_hash=$2,admission_token=gen_random_uuid(),admission_requested_at=now(),admission_refreshed_at=now(),
        admission_dispatch_generation=1,admission_dispatch_state='enqueued',admission_dispatch_token=$3,admission_dispatch_reserved_at=now(),
        admission_dispatched_at=now(),admission_target_followers_count=150,admission_target_following_count=110,
        admission_capacity_required_plan_id='basic',admission_required_plan_id='basic',
        admission_plan_cards_snapshot=plan_cards_snapshot,admission_dispatch_workload_role='paid',admission_dispatch_contract_version=2 WHERE id=$1`,
        [preflight.id,hash('earlybird-fulfillment-admission-v1\n'+order),dispatch]);
    const handoff = () => admin.rpc('handoff_dev_cloud_six_fulfillment_v1',{
        p_wave:wave,p_preflight_id:preflight.id,p_generation:1,p_dispatch_generation:1,p_dispatch_token:dispatch
    });
    const result = await handoff();
    expect(result.error).toBeNull();
    expect(typeof result.data).toBe('string');
    expect(await handoff()).toEqual(result);
    const requestId = String(result.data), jobClaimToken = randomUUID(), jobKey=template.jobKey;
    await db.query(`INSERT INTO analysis_pipeline_jobs(request_id,job_key,track,kind,batch,input_hash,status,
        lease_token,lease_expires_at,created_at,updated_at,recovery_not_before,dispatch_state,dispatch_generation,
        dispatch_reservation_token,dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,attempt_count,first_started_at)
        SELECT $2,job_key,track,kind,batch,input_hash,status,$3,lease_expires_at,created_at,updated_at,recovery_not_before,
          dispatch_state,dispatch_generation,gen_random_uuid(),dispatch_reserved_at,dispatched_at,dispatch_task_name,delivered_at,
          attempt_count,first_started_at FROM analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$4`,
        [template.requestId,requestId,jobClaimToken,jobKey]);
    return {order,preflightId:preflight.id,ordinary:template,job:{requestId,jobKey,jobClaimToken}};
}

native('fences six machine buyers, one Standard purchase each and expanded worker claims on native PostgreSQL', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        await db.exec(standardCloudSixInstallSql());
        const owners = Array.from({length:6},()=>randomUUID());
        for (const [i,owner] of owners.entries()) {
            const email = 'dev-six-'+wave.slice(0,16)+'-'+(i+1)+'@example.invalid';
            await db.query(`INSERT INTO auth.users(id,email,raw_app_meta_data,email_confirmed_at) VALUES($1,$2,$3,now())`,
                [owner,email,{provider:'email', dev_cloud_six_v1:wave,dev_cloud_six_slot:i+1}]);
            await db.query("INSERT INTO auth.identities VALUES($1,'email',jsonb_build_object('email',$2::text))",[owner,email]);
        }
        const admin = db.client();
        const open = (w: string) => admin.rpc('dev_cloud_six_open_v1',{p_wave:w});
        await db.query("UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",[owners[5]]);
        expect((await open(wave)).error?.message).toBe('DEV_CLOUD_SIX_BUYERS_INCOMPLETE');
        await db.query("UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1",[owners[5]]);
        expect(await open(wave)).toMatchObject({data:6,error:null});
        expect(await open(wave)).toMatchObject({data:6,error:null});
        expect((await open('a'.repeat(64))).error?.message).toBe('DEV_CLOUD_SIX_BUSY');
        const scope = (args: Record<string,unknown>) => admin.rpc('dev_cloud_six_scope_v1',{p_wave:wave,...args});
        for (let i=0;i<6;i++) expect((await scope({p_owner_id:owners[i]})).data).toBe(i+1);
        expect((await scope({})).data).toBeNull();
        expect((await scope({p_owner_id:randomUUID()})).data).toBeNull();
        const {job,order,preflightId,ordinary} = await admitFixture(db,owners[0]!);
        expect(await scope({p_owner_id:owners[0],p_preflight_id:preflightId,p_order_id:order,p_request_id:job.requestId})).toMatchObject({data:1,error:null});
        expect((await scope({p_owner_id:owners[1],p_request_id:job.requestId})).data).toBeNull();
        const resultArgs={p_wave:wave,p_request_id:job.requestId};
        const ownerRpc='dev_cloud_six_result_owner_v1';
        expect(await db.client(owners[0]).rpc(ownerRpc,resultArgs)).toMatchObject({data:true,error:null});
        expect(await db.client(owners[1]).rpc(ownerRpc,resultArgs)).toMatchObject({data:false,error:null});
        expect((await db.client(null).rpc(ownerRpc,resultArgs)).error?.code).toBe('42501');
        expect((await db.client(owners[0]).rpc('dev_cloud_six_open_v1',{p_wave:wave})).error?.code).toBe('42501');
        const args={...resultArgs,p_job_key:job.jobKey,p_job_claim_token:job.jobClaimToken};
        expect((await admin.rpc('dev_cloud_six_capacity_approved_v1',args)).data).toBe(true);
        expect((await admin.rpc('dev_cloud_six_capacity_approved_v1',{...args,p_job_claim_token:randomUUID()})).data).toBe(false);
        const budgetArgs={p_wave:wave,p_run_id:job.requestId,p_order_id:null,p_operation_key:'feature-a',p_attempt:1,
            p_reservation_key:job.requestId+':feature-a:1',p_route:'default',p_model_name:'gemini-3.1-flash-lite',p_location:'global',
            p_input_tokens:100,p_max_output_tokens:512,p_estimated_cost_usd:0.1,p_day_key:null,p_per_run_limit_usd:1,
            p_per_order_limit_usd:1,p_daily_limit_usd:0.15};
        const reserve=()=>admin.rpc('reserve_dev_cloud_six_vertex_budget_v1',budgetArgs);
        const first=await reserve();
        expect(first.error).toBeNull();
        expect(await reserve()).toEqual(first);
        const [receipt]=first.data as {order_id:string;reservation_key:string;reservation_id:string}[];
        expect(receipt.order_id).toBe(order);
        expect((await admin.rpc('reserve_dev_cloud_six_vertex_budget_v1',{...budgetArgs,p_operation_key:'feature-b',
            p_reservation_key:job.requestId+':feature-b:1'})).error?.message).toMatch(/^VERTEX_AI_BUDGET_EXCEEDED:day:/);
        const settle={p_wave:wave,p_reservation_key:receipt.reservation_key,p_reservation_id:receipt.reservation_id,p_actual_cost_usd:0.08};
        expect((await admin.rpc('settle_dev_cloud_six_vertex_budget_v1',{...settle,p_wave:'b'.repeat(64)})).error?.message)
            .toBe('VERTEX_AI_BUDGET_RESERVATION_UNKNOWN');
        expect((await admin.rpc('settle_dev_cloud_six_vertex_budget_v1',settle)).error).toBeNull();
        expect((await db.query('SELECT count(*)::int AS n FROM public.vertex_ai_budget_reservations')).rows).toEqual([{n:0}]);
        expect((await db.query('SELECT count(*)::int AS n FROM dev_live_budget.reservations')).rows).toEqual([{n:0}]);
        const state=await admin.rpc('dev_cloud_six_order_state_v1',{p_wave:wave});
        expect(state.error).toBeNull();
        expect(state.data).toHaveLength(6);
        expect((state.data as unknown[])[0]).toMatchObject({slot:1,owner_id:owners[0],preflight_id:preflightId,order_id:order,request_id:job.requestId,
            seat_at:expect.anything(),published_at:null});
        for (let i=0;i<9;i++) {
            const operation='feature-analysis:'+hash(String(i)),claim=randomUUID(),slot='gemini-'+(i+1);
            const lease=await admin.rpc('acquire_dev_cloud_six_gemini_lease_v1',{...args,p_operation_key:operation,
                p_stage:'featureAnalysis',p_attempt:1,p_claim_token:claim,p_lease_seconds:240});
            expect(lease).toMatchObject({error:null,data:[{outcome:'acquired',slot:i+1}]});
            const logicalOp='gemini:'+operation+':attempt:1';
            const {rows:[id]}=await db.query<{key:string}>(`SELECT
                public.analysis_provider_admission_expected_id('paid','gemini',$1,$2,$3,$4) AS key`,[slot,job.requestId,job.jobKey,logicalOp]);
            const logicalArgs={...args,p_admission_id:id.key,
                p_workload_role:'paid',p_logical_provider:'gemini',p_credential_slot:slot,p_budget_key:'paid:gemini:'+slot,
                p_operation_key:logicalOp,p_claim_token:claim,p_provider_fence:(lease.data as {fence:number}[])[0].fence,p_lease_token:randomUUID(),p_lease_seconds:240};
            const logical=await admin.rpc('acquire_dev_cloud_six_provider_admission_v1',logicalArgs);
            expect(logical.error).toBeNull();
            expect(logical.data).toMatchObject({outcome:'acquired'});
            if (i===8) {
                const {rows:[ordinaryId]}=await db.query<{key:string}>(`SELECT
                    public.analysis_provider_admission_expected_id('paid','gemini',$1,$2,$3,$4) AS key`,
                    [slot,ordinary.requestId,ordinary.jobKey,logicalOp]);
                const baseArgs={...logicalArgs,p_admission_id:ordinaryId.key,p_request_id:ordinary.requestId,
                    p_job_key:ordinary.jobKey,p_job_claim_token:ordinary.jobClaimToken};
                const {p_wave:_,...ordinaryArgs}=baseArgs;
                expect(_).toBe(wave);
                expect((await admin.rpc('acquire_analysis_provider_admission',ordinaryArgs)).error?.message)
                    .toBe('ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN');
                expect((await admin.rpc('dev_cloud_six_capacity_approved_v1',{...args,p_request_id:ordinary.requestId,
                    p_job_claim_token:ordinary.jobClaimToken})).data).toBe(false);
                expect((await admin.rpc('acquire_dev_cloud_six_provider_admission_v1',baseArgs)).error).not.toBeNull();
            }
        }
        const physical=(i:number,stage:string)=>admin.rpc('acquire_dev_cloud_six_gemini_lease_v1',{
            ...args,p_operation_key:(stage==='featureAnalysis'?'feature-analysis:':'gender-resolution:')+hash(String(i)),
            p_stage:stage,p_attempt:1,p_claim_token:randomUUID(),p_lease_seconds:240});
        for (let i=9;i<80;i++) expect((await physical(i,'featureAnalysis')).data).toMatchObject([{outcome:'acquired',slot:i+1}]);
        expect((await physical(80,'featureAnalysis')).data).toMatchObject([{outcome:'capacity_pending'}]);
        for (let i=80;i<128;i++) expect((await physical(i,'genderResolution')).data).toMatchObject([{outcome:'acquired',slot:i+1}]);
        expect((await physical(128,'genderResolution')).data).toMatchObject([{outcome:'resolver_capacity_pending'}]);
        expect((await db.query(`SELECT has_function_privilege('service_role',
            'public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)','EXECUTE') AS live_wide,
             (SELECT count(*) FROM dev_live_budget.grants)::int AS grants`)).rows).toEqual([{live_wide:false,grants:0}]);
        expect((await admin.rpc('complete_dev_cloud_six_order_v1',resultArgs)).data).toBe(false);
        await db.query(`INSERT INTO analysis_v2_result_summaries(request_id,target_instagram_id,plan_id,followers_declared,
            followers_collected,following_declared,following_collected,detected_mutuals,public_mutuals,private_mutuals,screened_mutuals,
            not_screened_mutuals,fetch_unavailable_count,media_unavailable_count,exclusion_applied,score_policy_version,
            finalizer_input_hash,male_count,female_count,unknown_count) VALUES($1,$2,'standard',0,0,0,0,0,0,0,0,0,0,0,
            false,'risk-policy-v2.5',$3,0,0,0)`,[job.requestId,target,hash('summary')]);
        await db.query("UPDATE analysis_requests SET status='completed',completed_at=now() WHERE id=$1",[job.requestId]);
        expect((await db.query('SELECT analysis_result_publication_authorized($1) AS published',[job.requestId])).rows)
            .toEqual([{published:false}]);
        const [done,replay]=await Promise.all([admin.rpc('complete_dev_cloud_six_order_v1',resultArgs),
            admin.rpc('complete_dev_cloud_six_order_v1',resultArgs)]);
        expect(done).toMatchObject({data:true,error:null});
        expect(replay).toEqual(done);
        expect(await admin.rpc('complete_dev_cloud_six_order_v1',resultArgs)).toEqual(done);
        expect((await db.query('SELECT analysis_result_publication_authorized($1) AS published',[job.requestId])).rows)
            .toEqual([{published:true}]);
        expect((await db.query('SELECT paid_result_email_available($1,$2) AS email',[order,owners[0]])).rows).toEqual([{email:false}]);
        expect((await db.client(owners[0]).rpc(ownerRpc,resultArgs)).data).toBe(true);
        expect((await db.client(owners[1]).rpc(ownerRpc,resultArgs)).data).toBe(false);
        const publishedState=await admin.rpc('dev_cloud_six_order_state_v1',{p_wave:wave});
        expect((publishedState.data as unknown[])[0]).toMatchObject({request_status:'completed',order_status:'completed',published_at:expect.anything()});
        expect((await db.query("SELECT count(*)::int AS n FROM public.earlybird_payment_discord_outbox WHERE order_id=$1",[order])).rows)
            .toEqual([{n:0}]);
        await db.transaction(async tx=>{
            await tx.exec("UPDATE dev_cloud_six.waves SET opened_at=opened_at-interval '4 hours',expires_at=expires_at-interval '4 hours'");
            expect((await tx.query('SELECT dev_cloud_six_scope_v1($1,NULL,NULL,NULL,$2) AS slot',[wave,job.requestId])).rows)
                .toEqual([{slot:null}]);
            await tx.exec("UPDATE dev_cloud_six.waves SET opened_at=opened_at+interval '4 hours',expires_at=expires_at+interval '4 hours'");
        });
        expect((await admin.rpc('dev_cloud_six_close_v1',{p_wave:wave})).data).toBe(true);
        expect((await admin.rpc('dev_cloud_six_close_v1',{p_wave:wave})).data).toBe(true);
        expect((await db.client(owners[0]).rpc(ownerRpc,resultArgs)).data).toBe(false);
        expect((await admin.rpc('dev_cloud_six_capacity_approved_v1',args)).data).toBe(false);
        expect((await admin.rpc('dev_cloud_six_capacity_lineage_v1',resultArgs)).data).toBe(true);
        expect((await open(wave)).error?.message).toBe('DEV_CLOUD_SIX_CLOSED');
    } finally { await db.close(); }
},60_000);
