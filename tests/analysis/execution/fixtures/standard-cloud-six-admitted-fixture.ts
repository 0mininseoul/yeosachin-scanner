import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';
import { target } from './standard-providers';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Db = Awaited<ReturnType<typeof createSharedStandardDatabase>>;

export async function admitCloudSixFixture(db: Db, owner: string, wave: string) {
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
