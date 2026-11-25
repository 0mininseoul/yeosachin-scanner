import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';
import { localDatabaseClient } from './standard-database';

const rpc = 'load_dev_standard_profile_media_ready_v1';

interface ReadyResult {
    readyOperations: { operationKey: string; stage: string; result: { number: number; sameJob: boolean } }[];
}

export async function verifyDevProfileReadyRead(db: PGlite, args: Readonly<Record<string, unknown>>) {
    const service = localDatabaseClient(db);
    for (const subject of [null, randomUUID()]) {
        const rejected = await localDatabaseClient(db, subject).rpc(rpc, args);
        expect(rejected).toMatchObject({ data: null, error: { code: '42501' } });
    }
    for (const override of [{ p_claim_token: randomUUID() }, { p_input_hash: 'e'.repeat(64) }]) {
        const rejected = await service.rpc(rpc, { ...args, ...override });
        expect(rejected.error?.message).toBe('ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH');
    }
    const initial = await service.rpc(rpc, args);
    const original = await service.rpc('load_analysis_v2_profile_media_inputs', args);
    expect(original.error).toBeNull();
    expect(initial).toEqual({ error: null, data: { ...(original.data as object), readyOperations: [] } });

    // Roll back every synthetic scheduler row before the application resumes its real claim.
    await db.transaction(async tx => {
        const result = await tx.query(`
            WITH other_job AS (
                SELECT job_key FROM public.analysis_pipeline_jobs
                WHERE request_id=$1 AND job_key<>$2 ORDER BY job_key LIMIT 1
            ), fixtures(stage, prefix, job_key, numbers, status) AS (
                VALUES
                    ('genderTriage','gender-triage',$2::text,31,'ready'),
                    ('featureAnalysis','feature-analysis',$2::text,31,'ready'),
                    ('privateAccountName','private-account-name',$2::text,1,'ready'),
                    ('genderTriage','gender-triage',$2::text,1,'claimed'),
                    ('genderTriage','gender-triage',$2::text,1,'terminal_unavailable'),
                    ('genderTriage','gender-triage',(SELECT job_key FROM other_job),1,'ready')
            )
            INSERT INTO public.analysis_v2_scheduler_operations
                (request_id, job_key, operation_key, stage, status, claim_token, lease_expires_at, result_json, completed_at)
            SELECT $1, f.job_key, f.prefix || ':' || encode(sha256(convert_to(
                    concat_ws(':',f.stage,f.job_key,f.status,n), 'UTF8')), 'hex'), f.stage, f.status,
                gen_random_uuid(), now()+interval '5 minutes',
                CASE WHEN f.status='ready' THEN jsonb_build_object('number', n, 'sameJob', f.job_key=$2) END,
                CASE WHEN f.status='ready' THEN now() END
            FROM fixtures f CROSS JOIN LATERAL generate_series(1,f.numbers) AS n
        `, [args.p_request_id, args.p_job_key]);
        expect(result.affectedRows).toBe(66);
        const values = [args.p_request_id, args.p_job_key, args.p_claim_token, args.p_input_hash];
        await tx.exec('SET LOCAL ROLE service_role');
        const load = async () => (await tx.query<{ data: ReadyResult }>(
            'SELECT public.load_dev_standard_profile_media_ready_v1($1,$2,$3,$4) AS data', values,
        )).rows[0]!.data;
        const loaded = await load();
        expect(await load()).toEqual(loaded);
        expect(loaded.readyOperations).toHaveLength(60);
        for (const stage of ['genderTriage', 'featureAnalysis']) {
            expect(loaded.readyOperations.filter(row => row.stage === stage)).toHaveLength(30);
        }
        for (const row of loaded.readyOperations) {
            expect(Object.keys(row).sort()).toEqual(['operationKey', 'result', 'stage']);
            expect(row.result).toEqual({ number: expect.any(Number), sameJob: true });
        }
        await tx.exec('RESET ROLE');
        const oversized = 'gender-triage:' + '0'.repeat(64);
        await tx.query(`
            INSERT INTO public.analysis_v2_scheduler_operations
                (request_id,job_key,operation_key,stage,status,claim_token,lease_expires_at,result_json,completed_at)
            VALUES ($1,$2,$3,'genderTriage','ready',gen_random_uuid(),now()+interval '5 minutes',
                jsonb_build_object('outlier',repeat('x',32768)),now())
        `, [args.p_request_id, args.p_job_key, oversized]);
        const other = (await tx.query<{ operation_key: string }>(
            `SELECT operation_key FROM public.analysis_v2_scheduler_operations
             WHERE request_id=$1 AND job_key<>$2 AND status='ready' LIMIT 1`, values.slice(0, 2),
        )).rows[0]!.operation_key;
        await tx.exec('SET LOCAL ROLE service_role');
        expect((await load()).readyOperations.map(row => row.operationKey)).not.toContain(oversized);
        const token = randomUUID();
        const claim = (key: string) => tx.query<{ decision: string; result_json: unknown }>(
            `SELECT decision,result_json FROM public.claim_analysis_v2_scheduler_operation(
                $1,$2,$3,$4,'genderTriage',$5,330)`, [...values.slice(0, 3), key, token],
        );
        expect((await claim(oversized)).rows[0]).toEqual({
            decision: 'ready', result_json: { outlier: 'x'.repeat(32768) },
        });
        await tx.exec('SAVEPOINT foreign_operation');
        await expect(claim(other)).rejects.toThrow('ANALYSIS_V2_SCHEDULER_OPERATION_IDENTITY_CONFLICT');
        await tx.exec('ROLLBACK TO SAVEPOINT foreign_operation');

        const key = 'gender-triage:' + 'f'.repeat(64);
        const commit = (data: object) => tx.query<{ accepted: boolean }>(
            `SELECT public.commit_analysis_v2_scheduler_operation(
                $1,$2,$3,$4,'genderTriage',$5,$6::jsonb) AS accepted`,
            [...values.slice(0, 3), key, token, JSON.stringify(data)],
        );
        expect((await claim(key)).rows[0]?.decision).toBe('execute');
        expect((await commit({ exact: true })).rows[0]?.accepted).toBe(true);
        expect((await commit({ exact: true })).rows[0]?.accepted).toBe(true);
        await tx.exec('SAVEPOINT different_result');
        await expect(commit({ exact: false })).rejects.toThrow('ANALYSIS_V2_SCHEDULER_OPERATION_RESULT_CONFLICT');
        await tx.exec('ROLLBACK TO SAVEPOINT different_result');
        expect((await claim(key)).rows).toEqual([{ decision: 'ready', result_json: { exact: true } }]);

        await tx.exec('RESET ROLE');
        await tx.exec('SAVEPOINT expired_parent');
        await tx.query(`UPDATE public.analysis_pipeline_jobs SET lease_expires_at = updated_at + interval '1 microsecond'
            WHERE request_id=$1 AND job_key=$2`, values.slice(0, 2));
        await tx.exec('SET LOCAL ROLE service_role');
        await expect(load()).rejects.toThrow('ANALYSIS_V2_PROFILE_GENDER_PLAN_FENCE_MISMATCH');
        await tx.exec('ROLLBACK TO SAVEPOINT expired_parent');
        await tx.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await tx.exec('SET LOCAL ROLE service_role');
        await expect(load()).rejects.toThrow('ANALYSIS_V2_PROFILE_GENDER_PLAN_POLICY_MISMATCH');
        await tx.rollback();
    });
    expect(await service.rpc(rpc, args)).toEqual(initial);
}
