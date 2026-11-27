import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { standardCloudSixInstallSql } from '../../../../supabase/dev-ui/standard-cloud-six-install.mjs';
import { createSharedStandardDatabase } from './standard-shared-database';
import { admitCloudSixFixture } from './standard-cloud-six-admitted-fixture';
import { target } from './standard-providers';

const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const wave = 'c'.repeat(64);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Db = Awaited<ReturnType<typeof createSharedStandardDatabase>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

it('the managed Dev installer emits the real periodic recovery job in its single transaction', () => {
    const cli = fileURLToPath(new URL('../../../../supabase/dev-ui/standard-cloud-six-install.mjs', import.meta.url));
    const sql = execFileSync(process.execPath, [cli], {encoding:'utf8'});
    expect(sql).toBe(standardCloudSixInstallSql());
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pg_cron;');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER dev_cloud_six_apify_cron');
    expect(standardCloudSixInstallSql({includeCron:false})).not.toContain('CREATE EXTENSION IF NOT EXISTS pg_cron;');
});

async function seedSixIdentities(db: Db) {
    const owners = Array.from({length:6},()=>randomUUID());
    for (const [i,owner] of owners.entries()) {
        const email = 'dev-six-'+wave.slice(0,16)+'-'+(i+1)+'@example.invalid';
        await db.query(`INSERT INTO auth.users(id,email,raw_app_meta_data,email_confirmed_at) VALUES($1,$2,$3,now())`,
            [owner,email,{provider:'email', dev_cloud_six_v1:wave,dev_cloud_six_slot:i+1}]);
        await db.query("INSERT INTO auth.identities VALUES($1,'email',jsonb_build_object('email',$2::text))",[owner,email]);
    }
    return owners;
}

native('fences six machine buyers, one Standard purchase each and expanded worker claims on native PostgreSQL', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        await db.exec(standardCloudSixInstallSql({includeCron:false}));
        const owners = await seedSixIdentities(db);
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
        const {job,order,preflightId,ordinary} = await admitCloudSixFixture(db,owners[0]!,wave);
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
        expect((await open(wave.slice(0,16)+'b'.repeat(48))).error?.code).toBe('23505');
    } finally { await db.close(); }
},60_000);

native('authorizes through unrelated row locks and serializes synthetic revocation with the last dispatch check', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        await db.exec(standardCloudSixInstallSql({includeCron:false}));
        const owners = await seedSixIdentities(db);
        expect((await db.client().rpc('dev_cloud_six_open_v1', { p_wave: wave })).data).toBe(6);
        const { job, preflightId, order, ordinary } = await admitCloudSixFixture(db, owners[0]!, wave);
        const { requestId, jobKey, jobClaimToken } = job;
        const upgrade = readFileSync(new URL('../../../../supabase/dev-ui/standard-cloud-six-authorization.sql', import.meta.url), 'utf8');
        await db.exec(upgrade);
        const check = async (connection: Pick<Tx, 'query'> = db, claim = jobClaimToken, inputHash = 'a'.repeat(64)) => {
            const result = await connection.query<{ allowed: boolean }>(
                'SELECT public.authorize_dev_cloud_six_vertex_dispatch_v1($1,$2,$3,$4,$5) AS allowed',
                [wave, requestId, jobKey, claim, inputHash],
            );
            return result.rows[0]!.allowed;
        };
        expect(await check(db, jobClaimToken, hash('wrong input'))).toBe(false);
        const attempt = {
            p_wave: wave, p_request_id: requestId, p_job_key: jobKey, p_claim_token: jobClaimToken,
            p_operation_key: 'feature-analysis:' + hash('authorization'), p_attempt: 1, p_reservation_token: randomUUID(),
            p_metadata: {model_name:'fixture',location:'global',stage:'featureAnalysis',thinking_level:'MINIMAL',media_count:0,
                media_resolution:null,prompt_version:'fixture',schema_version:1,max_output_tokens:1024,retry_count:0},
        };
        const reserve = (inputHash: string) => db.client().rpc('reserve_dev_cloud_six_ai_attempt_v1',
            {...attempt,p_job_input_hash:inputHash});
        const attemptCount = async () => (await db.query<{n:number}>(
            'SELECT count(*)::int AS n FROM analysis_v2_ai_attempts WHERE request_id=$1', [requestId])).rows[0]!.n;
        expect((await reserve(hash('wrong input'))).error?.message).toBe('ANALYSIS_V2_VERTEX_DISPATCH_STOPPED');
        expect(await attemptCount()).toBe(0);
        expect(await reserve('a'.repeat(64))).toMatchObject({error:null, data:{created:true}});
        expect(await reserve('a'.repeat(64))).toMatchObject({error:null, data:{created:false}});
        expect((await reserve(hash('wrong replay'))).error?.message).toBe('ANALYSIS_V2_VERTEX_DISPATCH_STOPPED');
        expect(await attemptCount()).toBe(1);
        // The native progress checkpoint and provider reserve acquire these rows independently.
        // A sibling may hold all three without changing the capability used by this request.
        await db.transaction(async tx => {
            await tx.query('SELECT id FROM analysis_preflights WHERE id=$1 FOR UPDATE', [preflightId]);
            await tx.query('SELECT id FROM analysis_requests WHERE id=$1 FOR UPDATE', [requestId]);
            await tx.query('SELECT job_key FROM analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2 FOR UPDATE', [requestId, jobKey]);
            expect(await check()).toBe(true);
        });
        const tentative = new Error('roll back test mutation');
        async function rollback(mutate: (tx: Tx) => Promise<void>) {
            await expect(db.transaction(async tx => {
                await mutate(tx);
                throw tentative;
            })).rejects.toBe(tentative);
        }
        async function writerBusy(action: (tx: Tx) => Promise<unknown>) {
            await expect(db.transaction(async tx => {
                await tx.exec("SET LOCAL lock_timeout='150ms'");
                await action(tx);
            })).rejects.toMatchObject({ code: '55P03' });
        }
        const stop = (tx: Tx) => tx.query(`INSERT INTO public.analysis_v2_provider_cleanup_intents
            (request_id,failed_job_key,failed_job_input_hash,failed_claim_token,error_code)
            VALUES ($1,$2,$3,$4,'TEST_CLEANUP')`, [requestId, jobKey, 'a'.repeat(64), jobClaimToken]);
        // Writes may take a row lock before their AFTER trigger. They cannot commit revocation while
        // a positive grant is held, and a grant cannot commit against their uncommitted revocation.
        await db.transaction(async tx => {
            expect(await check(tx)).toBe(true);
            await writerBusy(other => other.query("UPDATE analysis_pipeline_jobs SET lease_token=gen_random_uuid() WHERE request_id=$1 AND job_key=$2", [requestId, jobKey]));
            await writerBusy(other => other.query('UPDATE analysis_preflights SET admission_entitlement_jti_hash=$2 WHERE id=$1', [preflightId, hash('different')]));
            await writerBusy(stop);
            await writerBusy(other => other.query('UPDATE dev_cloud_six.waves SET closed_at=now() WHERE digest=$1', [wave]));
            await writerBusy(other => other.query("INSERT INTO auth.identities VALUES($1,'other','{}')", [owners[0]]));
            await writerBusy(other => other.query("UPDATE earlybird_fulfillments SET operator_admitted_at=now() WHERE order_id=$1", [order]));
            // Holding the would-be guard of a normal buyer must not serialize their own Auth
            // identity or worker writes. Only a private QA receipt or roster row activates a guard.
            await tx.query(`SELECT pg_advisory_xact_lock_shared(dev_cloud_six.authority_key('owner',user_id)),
                pg_advisory_xact_lock_shared(dev_cloud_six.authority_key('job',id,$2))
                FROM analysis_requests WHERE id=$1`, [ordinary.requestId,ordinary.jobKey]);
            await db.transaction(async other => {
                await other.exec("SET LOCAL lock_timeout='150ms'");
                await other.query("INSERT INTO auth.identities SELECT user_id,'other','{}' FROM analysis_requests WHERE id=$1", [ordinary.requestId]);
                await other.query("UPDATE analysis_pipeline_jobs SET lease_expires_at=lease_expires_at+interval '1 minute' WHERE request_id=$1 AND job_key=$2", [requestId, jobKey]);
                await other.query("UPDATE analysis_requests SET progress=progress+1 WHERE id=$1", [requestId]);
                await other.query('UPDATE analysis_pipeline_jobs SET lease_token=gen_random_uuid() WHERE request_id=$1 AND job_key=$2', [ordinary.requestId, ordinary.jobKey]);
            });
        });
        for (const revoke of [
            stop,
            (tx: Tx) => tx.query('UPDATE analysis_requests SET selected_plan_id_snapshot=\'basic\' WHERE id=$1', [requestId]),
            (tx: Tx) => tx.query('UPDATE analysis_pipeline_jobs SET lease_expires_at=clock_timestamp() WHERE request_id=$1 AND job_key=$2', [requestId, jobKey]),
            (tx: Tx) => tx.query("INSERT INTO auth.identities VALUES($1,'other','{}')", [owners[0]]),
        ]) {
            await rollback(async tx => {
                await revoke(tx);
                await expect(check()).rejects.toMatchObject({ code: '55P03' });
            });
        }
        expect(await check()).toBe(true);
        await db.transaction(async tx => {
            await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            expect(await check(tx)).toBe(false);
        });
        const newClaim = randomUUID();
        await db.query('UPDATE analysis_pipeline_jobs SET lease_token=$3 WHERE request_id=$1 AND job_key=$2', [requestId, jobKey, newClaim]);
        expect(await check()).toBe(false);
        expect(await check(db, newClaim)).toBe(true);
        await stop(db);
        expect(await check(db, newClaim)).toBe(false);
        expect((await db.query(`SELECT has_function_privilege('service_role','dev_cloud_six.serialize_revocation()','EXECUTE') AS trigger_public,
            has_function_privilege('authenticated','public.authorize_dev_cloud_six_vertex_dispatch_v1(text,uuid,text,uuid,text)','EXECUTE') AS owner_dispatch,
            has_function_privilege('service_role','public.authorize_dev_cloud_six_vertex_dispatch_v1(text,uuid,text,uuid,text)','EXECUTE') AS worker_dispatch`)).rows)
            .toEqual([{ trigger_public: false, owner_dispatch: false, worker_dispatch: true }]);
    } finally {
        await db.close();
    }
}, 60_000);
