import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { analysisV2TaskId } from '@/lib/services/analysis/v2-tasks';
import type { StandardConnection } from './standard-database';
import { createSharedStandardDatabase } from './standard-shared-database';
import { seedProcessingJob } from './standard-shared-processing-job';

const pgTest = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');
const markSql = 'SELECT * FROM public.mark_analysis_v2_job_dispatched_v2($1,$2,$3,$4,$5,$6,$7::smallint)';
const migration = 'supabase/migrations/20261127101000_share_active_paid_dispatch_mark_locks.sql';
type Database = Awaited<ReturnType<typeof createSharedStandardDatabase>>;

async function reserve(db: StandardConnection, requestId: string, batch: number) {
    const token = randomUUID();
    const key = 'track:profiles:batch:' + batch;
    await db.query(`INSERT INTO public.analysis_pipeline_jobs
        (request_id, job_key, track, kind, batch, input_hash, status, dispatch_state, dispatch_generation,
         dispatch_reservation_token, dispatch_reserved_at, dispatch_workload_role, dispatch_contract_version, created_at, updated_at)
        VALUES ($1,$2,'profiles','profile_fetch',$3,repeat('a',64),'pending','reserved',1,$4,now(),'paid',2,now(),now())`,
        [requestId, key, batch, token]);
    const name = 'projects/test-project/locations/asia-northeast3/queues/paid/tasks/' + analysisV2TaskId(requestId, key, 1);
    return [requestId, key, 1, token, name, 'paid', 2];
}

async function prepare(db: Database) {
    const { requestId } = await seedProcessingJob(db);
    await db.query(`UPDATE public.analysis_requests SET plan_access_mode_snapshot='production',
        test_entitlement_jti_hash=NULL, background_processing=true, progress_step='V2 analysis queued', current_step='v2_pipeline'
        WHERE id=$1`, [requestId]);
    await db.query(`UPDATE public.analysis_preflights AS p SET access_mode='production', status='consumed', consumed_at=now(),
        consumed_request_id=r.id, exclusion_decision='skip', target_followers_count=1, target_following_count=0,
        target_is_private=false, ready_at=now(), capacity_required_plan_id='basic', required_plan_id='basic',
        plan_cards_snapshot=r.plan_cards_snapshot FROM public.analysis_requests r WHERE r.id=$1 AND p.id=r.preflight_id`, [requestId]);
    return requestId;
}

const enqueued = { marked: true, dispatch_state: 'enqueued' };

for (const schema of ['Dev', 'production']) {
    pgTest(`marks sibling jobs concurrently, keeps cancellation fenced and maintains the ${schema} audit projection`, async () => {
        const db = await createSharedStandardDatabase(8, { production: schema === 'production' });
        try {
            // The shared fixture installed this migration once. It must also accept the installed body.
            await db.exec(readFileSync(migration, 'utf8'));
            const id = await prepare(db);
            const first = await reserve(db, id, 0);
            const second = await reserve(db, id, 1);
            await db.transaction(async held => {
                expect((await held.query(markSql, first)).rows[0]).toMatchObject(enqueued);
                await db.transaction(async sibling => {
                    await sibling.exec("SET LOCAL lock_timeout='400ms'");
                    expect((await sibling.query(markSql, second)).rows[0]).toMatchObject(enqueued);
                });
                await expect(db.transaction(async cancellation => {
                    await cancellation.exec("SET LOCAL lock_timeout='200ms'");
                    await cancellation.query("UPDATE public.analysis_requests SET status='failed' WHERE id=$1", [id]);
                })).rejects.toMatchObject({ code: '55P03' });
            });

            expect((await db.query(markSql, first)).rows[0]).toMatchObject({ ...enqueued, task_name: first[4] });
            await expect(db.query(markSql, [id, first[1], 1, randomUUID(), first[4], 'paid', 2])).rejects.toThrow('FENCE_MISMATCH');
            await expect(db.query(markSql, [...first.slice(0, 4), 'different', 'paid', 2])).rejects.toThrow('FENCE_MISMATCH');
            expect((await db.query(markSql, [...first.slice(0, 5), 'preflight', 2])).rows[0]).toMatchObject({ marked: false });

            const third = await reserve(db, id, 2);
            const fourth = await reserve(db, id, 3);
            await db.query("UPDATE public.analysis_requests SET progress_step='worker progress' WHERE id=$1", [id]);
            // Both jobs enter while the request needs a real projection update. Re-entering
            // the legacy path after releasing shared locks must allow both transactions to finish.
            const transitioning = await Promise.all([db.query(markSql, third), db.query(markSql, fourth)]);
            expect(transitioning.map(({ rows }) => rows[0])).toMatchObject([enqueued, enqueued]);
            expect((await db.query(`SELECT status, background_processing, progress_step, current_step
                FROM public.analysis_requests WHERE id=$1`, [id])).rows).toEqual([{
                status: 'processing', background_processing: true, progress_step: 'V2 analysis queued', current_step: 'v2_pipeline',
            }]);

            const audit = await reserve(db, id, 4);
            await db.query(`INSERT INTO public.analysis_v2_score_audit_scan_locators
                (request_id, locator_class, active, eligible_at, sort_at) VALUES ($1,'missing_intent',true,now(),now())`, [id]);
            await db.query(markSql, audit);
            expect((await db.query('SELECT 1 FROM public.analysis_v2_score_audit_scan_locators WHERE request_id=$1', [id])).rows).toEqual([]);
            const last = await reserve(db, id, 5);
            await db.query("UPDATE public.analysis_requests SET status='failed' WHERE id=$1", [id]);
            await expect(db.query(markSql, last)).rejects.toThrow('FENCE_MISMATCH');
        } finally {
            await db.close();
        }
    }, 45_000);
}

pgTest('keeps strict approvals, recovery locks, legacy task names and service-only execution', async () => {
    const db = await createSharedStandardDatabase();
    try {
        const id = await prepare(db);
        const recovery = await reserve(db, id, 0);
        await db.query(`INSERT INTO public.analysis_v2_provider_cleanup_intents
            (request_id, failed_job_key, failed_job_input_hash, failed_claim_token, error_code)
            VALUES ($1,$2,repeat('a',64),gen_random_uuid(),'SYNTHETIC_RECOVERY')`, [id, recovery[1]]);

        const expectExclusiveFallback = (args: unknown[]) => db.transaction(async reader => {
            await reader.query('SELECT 1 FROM public.analysis_requests WHERE id=$1 FOR SHARE', [id]);
            await expect(db.transaction(async marker => {
                await marker.exec("SET LOCAL lock_timeout='200ms'");
                await marker.query(markSql, args);
            })).rejects.toMatchObject({ code: '55P03' });
        });
        await expectExclusiveFallback(recovery);
        await db.query('UPDATE public.analysis_v2_provider_cleanup_intents SET completed_at=now() WHERE request_id=$1', [id]);
        await db.transaction(async reader => {
            await reader.query('SELECT 1 FROM public.analysis_requests WHERE id=$1 FOR SHARE', [id]);
            await db.transaction(async service => {
                await service.exec("SET LOCAL ROLE service_role; SET LOCAL lock_timeout='400ms'");
                expect((await service.query(markSql, recovery)).rows[0]).toMatchObject(enqueued);
            });
        });

        const legacy = await reserve(db, id, 1);
        legacy[4] = 'legacy-delivery';
        await expectExclusiveFallback(legacy);
        expect((await db.query(markSql, legacy)).rows[0]).toMatchObject({ ...enqueued, task_name: 'legacy-delivery' });
        for (const role of ['anon', 'authenticated']) {
            await expect(db.transaction(async denied => {
                await denied.exec('SET LOCAL ROLE ' + role);
                await denied.query(markSql, legacy);
            })).rejects.toMatchObject({ code: '42501' });
        }

        const strict = await reserve(db, id, 2);
        await db.query(`UPDATE public.analysis_requests SET plan_access_mode_snapshot='test_entitlement',
            test_entitlement_jti_hash=repeat('e',64) WHERE id=$1`, [id]);
        await db.query("UPDATE public.analysis_preflights SET access_mode='test_entitlement' WHERE consumed_request_id=$1", [id]);
        const slots = {
            'target-profile': 'primary', 'relationship-followers': 'tertiary', 'relationship-following': 'quaternary',
            'profile-fallback': 'primary', 'target-likers': 'senary', 'target-comments': 'tertiary', 'candidate-likers': 'quaternary',
        };
        await db.query(`INSERT INTO public.analysis_v2_provider_execution_policies(request_id, mode, policy_version,
            entitlement_jti_hash, target_instagram_id, operation_slot_map, policy_hash)
            VALUES ($1,'test_operation_split','authorized-free-e2e-v1',repeat('e',64),'capacity_fixture',$2,repeat('a',64))`, [id, slots]);
        await expect(db.query(markSql, strict))
            .rejects.toMatchObject({ code: 'P0001', message: 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE' });
        expect((await db.query('SELECT dispatch_state FROM public.analysis_pipeline_jobs WHERE request_id=$1 AND job_key=$2',
            [id, strict[1]])).rows).toEqual([{ dispatch_state: 'reserved' }]);
    } finally {
        await db.close();
    }
}, 45_000);
