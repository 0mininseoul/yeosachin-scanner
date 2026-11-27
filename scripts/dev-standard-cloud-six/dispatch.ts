import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { preflightStore as store } from '@/lib/services/analysis/preflight';
import { preflightTargetInputHash } from '@/lib/services/analysis/preflight-identity';
import { enqueuePreflightTask } from '@/lib/services/analysis/preflight-tasks';
import { admitAndAdvanceEarlybirdFulfillment } from '@/lib/services/earlybird/fulfillment-store';
import { target } from '../../tests/analysis/execution/fixtures/standard-providers';
import { dbOrigin, origin, project, region, service, taskPath, type QaRole } from '../../services/dev-standard-qa-worker/scope';
import { buyerIdentity } from './identity.mjs';

const buyers = z.array(z.object({ slot: z.number().int().min(1).max(6), owner_id: z.uuid(),
    preflight_id: z.uuid().nullable(), order_id: z.uuid().nullable(), request_id: z.uuid().nullable(),
    preflight_status: z.string().nullable(), request_status: z.string().nullable(), order_status: z.string().nullable(),
})).length(6);

function checkEnvironment(role: QaRole) {
    const e = process.env;
    const wave = e.DEV_STANDARD_QA_WAVE;
    const prefix = role === 'paid' ? 'ANALYSIS_V2_TASKS_' : 'PREFLIGHT_TASKS_';
    const expected: Record<string,string> = {
        CLOUD_RUN_JOB: 'dev-standard-six-dispatch-' + role, GOOGLE_CLOUD_PROJECT: project,
        NEXT_PUBLIC_SUPABASE_URL: dbOrigin, CLOUD_RUN_TASK_COUNT: '1', CLOUD_RUN_TASK_INDEX: '0',
        [prefix+'ENABLED']: 'true', [prefix+'PROJECT']: project, [prefix+'LOCATION']: region,
        [prefix+'QUEUE']: service(role), [prefix+'TARGET_URL']: origin(role)+taskPath(role),
        [prefix+'OIDC_AUDIENCE']: origin(role),
        [prefix+'SERVICE_ACCOUNT_EMAIL']: 'dev-live-'+role+'-invoker@'+project+'.iam.gserviceaccount.com',
    };
    if (!wave || !/^[0-9a-f]{64}$/.test(wave) || Object.entries(expected).some(([k,v])=>e[k]!==v))
        throw new Error('SIX_DRIVER_ENVIRONMENT_REJECTED');
    return wave;
}
async function rpc(name: string, args: Record<string,unknown>) {
    const { data,error } = await supabaseAdmin.rpc(name,args);
    if (error) throw new Error('SIX_DRIVER_RPC_'+name+'_'+String(error.code).replace(/[^A-Z0-9]/g,''));
    return data;
}

async function participants(wave: string) {
    const rows = buyers.parse(await rpc('dev_cloud_six_order_state_v1',{p_wave:wave}));
    if (new Set(rows.map(row=>row.slot)).size!==6 || new Set(rows.map(row=>row.owner_id)).size!==6)
        throw new Error('SIX_DRIVER_PARTICIPANTS_INVALID');
    return rows;
}
async function prepare(wave: string) {
    const enrolled = await rpc('dev_cloud_six_open_v1',{p_wave:wave});
    if (enrolled!==6) throw new Error('SIX_DRIVER_ENROLLMENT_FAILED');
    const rows = await participants(wave);
    await allSlots(rows,async row=>{
        const scope = await rpc('dev_cloud_six_scope_v1',{p_wave:wave,p_owner_id:row.owner_id});
        if (scope!==row.slot) throw new Error('SIX_DRIVER_SCOPE');
        const created = await store.createOrReplay({userId:row.owner_id, email:buyerIdentity(wave,row.slot).email,
            authProvider:'email',targetInstagramId:target, targetInputHash:preflightTargetInputHash(target),
            idempotencyKey:'dev-cloud-six:'+wave+':'+row.slot,accessMode:'production'});
        if (row.preflight_id && created.preflightId!==row.preflight_id) throw new Error('SIX_DRIVER_REPLAY_CONFLICT');
        if (await rpc('dev_cloud_six_scope_v1',{p_wave:wave,p_owner_id:row.owner_id,p_preflight_id:created.preflightId})!==row.slot)
            throw new Error('SIX_DRIVER_CREATED_SCOPE');
        const dispatch=await store.reserveDispatch(created.preflightId,row.owner_id);
        if (!dispatch.shouldEnqueue) return;
        if (!dispatch.reservationToken) throw new Error('SIX_DRIVER_DISPATCH_FENCE');
        await enqueuePreflightTask(created.preflightId,dispatch.generation,{reservationToken:dispatch.reservationToken});
        await store.markDispatched({preflightId:created.preflightId,userId:row.owner_id,
            generation:dispatch.generation,reservationToken:dispatch.reservationToken});
    });
}
type Buyer = z.infer<typeof buyers>[number];
function reason(err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    return /^(?:SIX_DRIVER_[A-Za-z_0-9]+|[A-Z][A-Z0-9_]{3,85})$/.test(msg) ? msg : 'SIX_DRIVER_STEP_FAILED';
}
async function allSlots(rows: Buyer[], act:(row:Buyer)=>Promise<void>) {
    const results=await Promise.allSettled(rows.map(act));
    const failed=results.flatMap((r,i)=>r.status==='rejected'?[{slot:rows[i].slot,code:reason(r.reason)}]:[]);
    console.log(JSON.stringify({role:process.env.ANALYSIS_WORKLOAD_ROLE,completed:rows.length-failed.length,failed}));
    if (failed.length) throw new Error('SIX_DRIVER_PARTIAL');
}
async function begin(wave: string) {
    const rows=await participants(wave);
    if (!rows.every(r=>r.preflight_id && (r.preflight_status==='ready' || (r.order_id && r.preflight_status==='consumed'))))
        throw new Error('SIX_DRIVER_WAITING_FOR_PREFLIGHT');
    // Prepare all six synthetic orders before starting any of their active-analysis clocks.
    await allSlots(rows,async row=>{
        if (row.order_id) return;
        await store.setExclusion({preflightId:row.preflight_id!,userId:row.owner_id,decision:'skip',excludedInstagramId:null});
        z.uuid().parse(await rpc('dev_cloud_six_create_order_v1',{p_wave:wave,p_owner_id:row.owner_id,p_preflight_id:row.preflight_id}));
    });
    const ordered=await participants(wave);
    if (!ordered.every(r=>r.order_id)) throw new Error('SIX_DRIVER_ORDERS_INCOMPLETE');
    await allSlots(ordered,async row=>{
        const scope=await rpc('dev_cloud_six_scope_v1',{p_wave:wave,p_owner_id:row.owner_id,p_order_id:row.order_id});
        if (scope!==row.slot) throw new Error('SIX_DRIVER_ORDER_SCOPE');
        for (let attempt = 1; attempt <= 8; attempt++) {
            const admitted = await admitAndAdvanceEarlybirdFulfillment(row.order_id!);
            const action = admitted.nextAction;
            console.log(JSON.stringify({ slot: row.slot, admission: action, attempt }));
            if (['wait_for_fresh_admission', 'monitor_analysis', 'completed'].includes(action)) return;
            if (action !== 'retry_handoff' && action !== 'wait_for_capacity') {
                throw new Error('SIX_DRIVER_ADMISSION_' + action.toUpperCase());
            }
            if (attempt === 8) throw new Error('SIX_DRIVER_PENDING_' + action.toUpperCase());
            await sleep(action === 'wait_for_capacity' ? 5_000 : 500 * attempt);
        }
    });
}
async function run() {
    const role=process.env.ANALYSIS_WORKLOAD_ROLE;
    if (role!=='preflight' && role!=='paid') throw new Error('SIX_DRIVER_ROLE_REJECTED');
    const wave=checkEnvironment(role);
    if (role==='preflight') await prepare(wave);
    else await begin(wave);
}
void run().catch(e=>{console.error(reason(e));process.exitCode=1;});
