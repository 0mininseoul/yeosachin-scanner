import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { standardCloudSixInstallSql } from '../../../../supabase/dev-ui/standard-cloud-six-install.mjs';
import { admitCloudSixFixture } from './standard-cloud-six-admitted-fixture';
import { createSharedStandardDatabase } from './standard-shared-database';

const databasePath = '../../../../supabase/dev-ui/';
const wave = 'd'.repeat(64);
const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Database = Awaited<ReturnType<typeof createSharedStandardDatabase>>;
type Job = { requestId: string; jobKey: string; jobClaimToken: string };

async function insertLease(db: Database, job: Job, name: string, options: {
    sameClaim?: boolean; expired?: boolean; state?: 'starting' | 'running' | 'succeeded';
    externalId?: boolean; settled?: boolean; actualUsd?: number;
} = {}) {
    const op = 'profile-fallback:' + hash(name);
    const claim = options.sameClaim ? job.jobClaimToken : randomUUID();
    await db.query(`INSERT INTO public.analysis_provider_admission_leases(
        admission_id,workload_role,logical_provider,credential_slot,budget_key,request_id,job_key,operation_key,
        claim_token,job_claim_token,lease_token,expires_at)
        VALUES(public.analysis_provider_admission_expected_id('paid','apify','secondary',$1,$2,$3),
            'paid','apify','secondary','paid:apify:secondary',$1,$2,$3,$4,$4,gen_random_uuid(),
            clock_timestamp()+($5::int*interval '1 minute'))`,
        [job.requestId,job.jobKey,op,claim,options.expired === false ? 5 : -1]);
    if (options.state) {
        const started = options.state !== 'starting';
        const done = options.state === 'succeeded';
        const runId = started ? (options.externalId ? 'External' : 'CloudQa') + hash(name).slice(0,48) : null;
        await db.query(`INSERT INTO public.analysis_v2_provider_runs(
            request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,logical_provider,actor_id,
            credential_slot,max_charge_usd,status,run_id,reserved_at,run_started_at,terminalized_at,actual_usage_usd,usage_reconciled_at)
            VALUES($1,$2,$3,$4,$5,gen_random_uuid(),'apify','apify/instagram-profile-scraper','secondary',1,$6,$7,
                now()-interval '3 minutes',CASE WHEN $8 THEN now()-interval '2 minutes' END,
                CASE WHEN $9 THEN now()-interval '1 minute' END,CASE WHEN $10 THEN $11::numeric END,CASE WHEN $10 THEN now() END)`,
            [job.requestId,job.jobKey,op,hash(name),claim,options.state,runId,started,done,Boolean(options.settled),options.actualUsd ?? 0]);
    }
    return op;
}

// Stock PostgreSQL 17 does not ship pg_cron. Exercise scheduling triggers and access
// checks against its two catalog operations; the managed Dev installation checks a real tick.
async function loadCronContract(db: Database) {
    await db.exec(`CREATE SCHEMA cron;
        CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname name UNIQUE NOT NULL, username text DEFAULT current_user,
            database text DEFAULT current_database(),schedule text,command text,active boolean DEFAULT true);
        CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
            INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid $$;
        CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$
            DELETE FROM cron.job WHERE jobid=$1 RETURNING true $$;`);
    const file = readFileSync(new URL(databasePath+'standard-cloud-six-apify-recovery-cron.sql', import.meta.url),'utf8');
    const marker = 'CREATE EXTENSION IF NOT EXISTS pg_cron;';
    expect(file.split(marker)).toHaveLength(2);
    await db.exec('BEGIN;'+file.slice(file.indexOf(marker)+marker.length));
}

native('reclaims only fenced Dev fixture admissions and disarms the periodic job on close or expiry', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        await db.exec(standardCloudSixInstallSql({includeCron:false}));
        // The delta must also install on an already provisioned Dev and be repeatable.
        await db.exec(readFileSync(new URL(databasePath+'standard-cloud-six-apify-recovery.sql',import.meta.url),'utf8'));
        await loadCronContract(db);
        const cronRows = () => db.query<{command:string;username:string}>('SELECT command,username FROM cron.job');
        const tick = async () => (await db.query<{n:number}>('SELECT dev_cloud_six.apify_recovery_tick_v1() AS n')).rows[0]!.n;
        expect((await cronRows()).rows).toEqual([]);
        expect(await tick()).toBe(0);
        const owners = Array.from({length:6},()=>randomUUID());
        for (const [i,id] of owners.entries()) {
            const email='dev-six-'+wave.slice(0,16)+'-'+(i+1)+'@example.invalid';
            await db.query('INSERT INTO auth.users(id,email,raw_app_meta_data,email_confirmed_at) VALUES($1,$2,$3,now())',
                [id,email,{provider:'email',dev_cloud_six_v1:wave,dev_cloud_six_slot:i+1}]);
            await db.query("INSERT INTO auth.identities VALUES($1,'email',jsonb_build_object('email',$2::text))",[id,email]);
        }
        const open=()=>db.client().rpc('dev_cloud_six_open_v1',{p_wave:wave});
        expect((await open()).error).toBeNull();
        expect((await open()).error).toBeNull();
        expect((await cronRows()).rows).toEqual([{command:"SET statement_timeout='8s'; SET lock_timeout='1s'; SELECT dev_cloud_six.apify_recovery_tick_v1()",username:'postgres'}]);
        const {job,ordinary}=await admitCloudSixFixture(db,owners[0]!,wave);
        await insertLease(db,job,'running',{state:'running'});
        await db.transaction(async busy => {
            await busy.exec('LOCK TABLE auth.identities IN ACCESS EXCLUSIVE MODE');
            const observed = await db.transaction(async cron => {
                await cron.exec("SET LOCAL statement_timeout='500ms'");
                return cron.query<{n:number}>('SELECT dev_cloud_six.apify_recovery_tick_v1() AS n');
            });
            expect(observed.rows).toEqual([{n:0}]);
        });
        const missing=await insertLease(db,job,'expired with no provider row');
        const terminal=await insertLease(db,job,'complete synthetic cost',{state:'succeeded',settled:true});
        await insertLease(db,job,'live writer missing',{sameClaim:true});
        await insertLease(db,job,'future expiry',{expired:false});
        const costPending=await insertLease(db,job,'confirmed fixture run with deferred cost',{state:'succeeded'});
        await insertLease(db,job,'nonzero external charge',{state:'succeeded',settled:true,actualUsd:0.02});
        await insertLease(db,job,'real run',{state:'succeeded',settled:true,externalId:true});
        await insertLease(db,job,'ambiguous',{state:'starting'});
        await insertLease(db,ordinary,'other owner');
        const original = () => db.query<{digest:string}>(`SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.operation_key)::text) AS digest
            FROM public.analysis_v2_provider_runs r`);
        const before=(await original()).rows;
        const wrong=await db.query<{n:number}>('SELECT dev_cloud_six.reclaim_apify_admissions_v1($1) AS n',['e'.repeat(64)]);
        expect(wrong.rows).toEqual([{n:0}]);
        await db.transaction(async owner => {
            // The worker holds the order preflight while trying to reach a job. A separate
            // reconciler owns one terminal provider row. Recover the unrelated terminal only.
            await owner.query("SELECT p.id FROM analysis_preflights p JOIN analysis_requests r ON r.preflight_id=p.id WHERE r.id=$1 FOR UPDATE OF p",[job.requestId]);
            await owner.query('SELECT 1 FROM analysis_v2_provider_runs WHERE request_id=$1 AND operation_key=$2 FOR UPDATE',[job.requestId,terminal]);
            const independent=await db.transaction(async sweep => {
                await sweep.exec("SET LOCAL statement_timeout='2s'");
                return sweep.query<{n:number}>('SELECT dev_cloud_six.apify_recovery_tick_v1() AS n');
            });
            expect(independent.rows).toEqual([{n:1}]);
            const kept=await owner.query<{operation_key:string}>("SELECT operation_key FROM analysis_provider_admission_leases WHERE state='released'");
            expect(kept.rows).toEqual([{operation_key:costPending}]);
        });
        const releaseCounts=await Promise.all([tick(),tick()]);
        expect(releaseCounts.reduce((sum,n)=>sum+n,0)).toBe(2);
        expect(await tick()).toBe(0);
        expect((await original()).rows).toEqual(before);
        const released=await db.query<{operation_key:string;resolution_source:string}>(`SELECT operation_key,resolution_source
            FROM public.analysis_provider_admission_leases WHERE state='released' ORDER BY resolution_source,operation_key`);
        expect(released.rows).toEqual([{operation_key:missing,resolution_source:'provider_ledger_absent'},
            ...[terminal,costPending].sort().map(operation_key=>({operation_key,resolution_source:'provider_ledger_terminal'}))]);
        const preserved=await db.query('SELECT actual_usage_usd,usage_reconciled_at FROM public.analysis_v2_provider_runs WHERE operation_key=$1',[costPending]);
        expect(preserved.rows).toEqual([{actual_usage_usd:null,usage_reconciled_at:null}]);
        const rights=await db.query<{allowed:boolean}>(`SELECT bool_or(has_function_privilege(r.name,p.oid,'EXECUTE')) AS allowed
            FROM (VALUES ('anon'::name),('authenticated'::name),('service_role'::name)) r(name)
            CROSS JOIN pg_proc p WHERE p.pronamespace='dev_cloud_six'::regnamespace
            AND p.proname IN ('reclaim_apify_admissions_v1','apify_recovery_tick_v1','sync_apify_recovery_cron_v1','on_wave_apify_schedule_v1')`);
        expect(rights.rows).toEqual([{allowed:false}]);
        await db.query("UPDATE dev_cloud_six.waves SET opened_at=opened_at-interval '4 hours',expires_at=expires_at-interval '4 hours' WHERE digest=$1",[wave]);
        expect(await tick()).toBe(0);
        expect((await cronRows()).rows).toEqual([]);
        await db.query("UPDATE dev_cloud_six.waves SET opened_at=opened_at+interval '4 hours',expires_at=expires_at+interval '4 hours' WHERE digest=$1",[wave]);
        await db.query('SELECT dev_cloud_six.sync_apify_recovery_cron_v1()');
        expect((await cronRows()).rows).toHaveLength(1);
        expect((await db.client().rpc('dev_cloud_six_close_v1',{p_wave:wave})).data).toBe(true);
        expect((await cronRows()).rows).toEqual([]);
        expect(await tick()).toBe(0);
    } finally { await db.close(); }
},60_000);
