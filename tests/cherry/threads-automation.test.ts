import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateBatchDrafts, type DraftRepository } from '@/lib/services/cherry/threads/editorial';

import { type DraftBatch } from '@/lib/contracts/cherry-threads';
import { CHERRY_THREADS_CONSOLE_PATH, NAMCHIN_ADMIN_CONSOLE_PATH, readAdminConsoleDestination } from '@/lib/contracts/admin-console';

const migration = readFileSync(new URL('../../supabase/migrations/20261127210000_cherry_threads_automation.sql', import.meta.url), 'utf8');
const tickMigration = readFileSync(new URL('../../supabase/migrations/20261127210100_schedule_cherry_threads_worker.sql', import.meta.url), 'utf8');
let db: PGlite;

async function value<T>(sql: string, args: unknown[] = []) {
    return (await db.query<{ value: T }>(`select ${sql} as value`, args)).rows[0].value;
}
const sampleDate = (index: number) => new Date(Date.now() + index * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(migration);
});

beforeEach(async () => {
    await db.exec('truncate public.cherry_threads_posts, public.cherry_threads_batches, public.cherry_threads_corrections cascade;');
});

afterAll(async () => { await db.close(); });

async function insertBatch(date: string, state = 'ready', theme = 'crush') {
    return (await db.query<DraftBatch>(`
        insert into public.cherry_threads_batches (run_date, theme, requested_count, state, started_at)
        values ($1, $2, 1, $3, now()) returning *
    `, [date, theme, state])).rows[0];
}

async function insertPost(batch: string, text: string) {
    return (await db.query<{ id: string }>(`
        insert into public.cherry_threads_posts (batch_id, ordinal, body) values ($1, 1, $2) returning id
    `, [batch, text])).rows[0].id;
}

describe('체리 Threads 서버 자동화', () => {
    it('모바일 교정 저장과 동일한 RPC에서 다음 초안 생성과 교정 이력까지 연결한다', async () => {
        const old = await insertBatch(sampleDate(1));
        const post = await insertPost(old.id, '짝남한테 나도 갈래 보낼까?');
        const edited = '짝남이 먼저 같이 가자고 해줬으면 좋겠다...';
        const why = '먼저 제안해주길 기다리는 말투로';
        expect(await value<boolean>('public.cherry_threads_correct($1,1,$2,null,$3)', [post, edited, why])).toBe(true);
        expect(await value<boolean>('public.cherry_threads_correct($1,1,$2,null,$3)', [post, '오래된 버전', why])).toBe(false);
        await db.query(`insert into public.cherry_threads_corrections (theme,before_text,after_text,reason,active)
            values ('ex','x','다른 관계','다른 관계',true), ('crush','y','제외 사례','비활성',false)`);

        const batch = await insertBatch(sampleDate(2), 'generating');
        const output = '짝남이 전시 보러 간다는데 나도 같이 가자고 먼저 말해줬으면 좋겠다...';
        const fetcher = vi.fn<typeof fetch>(async (url, req) => {
            expect(url).toBe('https://api.openai.com/v1/responses');
            const payload = JSON.parse(String(req?.body));
            expect(payload.store).toBe(false);
            const input = JSON.parse(payload.input);
            expect(input).toMatchObject({ theme: '짝남', count: 1, corrections: [{
                before: '짝남한테 나도 갈래 보낼까?', after: edited, reason: why,
            }] });
            expect(payload.input).not.toContain('다른 관계');
            expect(payload.input).not.toContain('제외 사례');
            return Response.json({ status: 'completed', output: [{ type: 'message', content: [
                { type: 'output_text', text: JSON.stringify({ posts: [{ body: output }] }) },
            ] }] });
        });
        const repo: DraftRepository = {
            async corrections(theme) {
                return (await db.query<Awaited<ReturnType<DraftRepository['corrections']>>[number]>(
                    'select * from public.cherry_threads_corrections where theme = $1 order by created_at desc', [theme],
                )).rows;
            },
            async examples() { return []; },
            save: (row, posts, corrections) => value('public.cherry_threads_save_drafts($1,$2,$3,$4)', [
                row.id, row.started_at, JSON.stringify(posts), corrections,
            ]),
        };
        vi.stubEnv('CHERRY_OPENAI_API_KEY', 'fixture-key');
        try {
            await expect(generateBatchDrafts(batch, repo, fetcher)).resolves.toBe(true);
            expect(fetcher).toHaveBeenCalledTimes(1);
        } finally {
            vi.unstubAllEnvs();
        }
        expect(await value('(select body from public.cherry_threads_posts where batch_id=$1)', [batch.id])).toBe(output);
        const evidence = await value<string[]>('(select correction_ids from public.cherry_threads_batches where id=$1)', [batch.id]);
        expect(evidence).toHaveLength(1);
        expect(await value('(select reason from public.cherry_threads_corrections where id=$1)', evidence)).toBe(why);
    });

    it('과거 버전과 슬롯 충돌은 승인하지 않으며 교정한 예약을 발행 후보에서 뺀다', async () => {
        const date = sampleDate(2);
        const batch = await insertBatch(date);
        const a = await insertPost(batch.id, '가');
        const b = (await db.query<{ id: string }>(`insert into public.cherry_threads_posts
            (batch_id, ordinal, body) values ($1,2,'나') returning id`, [batch.id])).rows[0].id;
        const slot = date + 'T20:00:00+09:00';
        const approve = (items: { id: string; version: number; slot: string }[]) =>
            value<boolean>('public.cherry_threads_approve($1,$2)', [batch.id, JSON.stringify(items)]);
        expect(await approve([{ id: a, version: 1, slot }, { id: b, version: 1, slot }])).toBe(false);
        expect(await value('(select count(*)::int from public.cherry_threads_posts where state=\'scheduled\')')).toBe(0);
        expect(await approve([{ id: a, version: 2, slot }])).toBe(false);
        expect(await approve([{ id: a, version: 1, slot: date + 'T20:11:00+09:00' }])).toBe(false);
        expect(await approve([{ id: a, version: 1, slot }])).toBe(true);
        await db.query("update public.cherry_threads_posts set container_id = 'old-body-container' where id = $1", [a]);
        expect(await value('public.cherry_threads_correct($1,1,$2,null,$3)', [a, '수정', '교정 사유'])).toBe(true);
        expect(await value('(select state from public.cherry_threads_posts where id=$1)', [a])).toBe('draft');
        expect(await value('(select approved_version from public.cherry_threads_posts where id=$1)', [a])).toBeNull();
        expect(await approve([{ id: a, version: 2, slot }])).toBe(true);
        expect(await value('(select container_id from public.cherry_threads_posts where id=$1)', [a])).toBeNull();
    });

    it('같은 20분 슬롯에서 승인된 원글 한 편만 청구하고 구 버전을 건드리지 않는다', async () => {
        const date = await value<string>("(now() at time zone 'Asia/Seoul')::date::text");
        const batch = await insertBatch(date);
        await db.query(`insert into public.cherry_threads_posts
            (batch_id, ordinal, body, state, scheduled_at, approved_version, version)
            values ($1,1,'이전 버전','scheduled',now()-interval '60 minutes',1,2),
                ($1,2,'첫 승인','scheduled',now()-interval '40 minutes',1,1),
                ($1,3,'두 번째 승인','scheduled',now()-interval '20 minutes',1,1)`, [batch.id]);
        expect((await db.query<{ body: string }>('select body from public.cherry_threads_claim_post()')).rows)
            .toEqual([{ body: '첫 승인' }]);
        expect((await db.query('select * from public.cherry_threads_claim_post()')).rows).toHaveLength(0);
    });

    it('게시 결과를 잃은 뒤 가져온 기존 글과 초안을 한 행으로 통합하고 첫 답글만 대기시킨다', async () => {
        const batch = await insertBatch(sampleDate(1));
        const post = await insertPost(batch.id, '짝남이 먼저 같이 가자고 해줬으면 좋겠다...');
        await db.query("update public.cherry_threads_posts set state = 'review', reply = '체리 안내' where id = $1", [post]);
        const discovered = [{
            media_id: 'main-threads-id', body: '짝남이 먼저 같이 가자고 해줬으면 좋겠다...',
            observed_theme: 'crush', published_at: new Date().toISOString(), permalink: 'https://www.threads.com/example',
        }];
        expect(await value('public.cherry_threads_import($1)', [JSON.stringify(discovered)])).toBe(1);
        await db.exec("update public.cherry_threads_posts set views=10, measured_at=now() where media_id='main-threads-id'");
        await db.exec('set role service_role');
        try {
            expect(await value('public.cherry_threads_confirm_published($1,$2)', [post, discovered[0].media_id])).toBe(true);
            expect(await value('public.cherry_threads_confirm_published($1,$2)', [post, discovered[0].media_id])).toBe(false);
        } finally {
            await db.exec('reset role');
        }
        expect(await value('public.cherry_threads_import($1)', [JSON.stringify(discovered)])).toBe(0);
        expect((await db.query('select id,state,reply_state,views::int from public.cherry_threads_posts')).rows)
            .toEqual([{ id: post, state: 'published', reply_state: 'pending', views: 10 }]);
        expect(await value("has_function_privilege('authenticated','public.cherry_threads_confirm_published(uuid,text)','execute')"))
            .toBe(false);
    });

    it('모바일에서 로그인이 필요한 경우 Threads 화면으로 돌아온다', () => {
        expect(readAdminConsoleDestination(CHERRY_THREADS_CONSOLE_PATH)).toBe(CHERRY_THREADS_CONSOLE_PATH);
        expect(readAdminConsoleDestination(CHERRY_THREADS_CONSOLE_PATH + '&view=threads')).toBe(NAMCHIN_ADMIN_CONSOLE_PATH);
    });

    it('크레딧 부족을 실패로 돌려보내며 이전 교정과 초안을 저장하지 않는다', async () => {
        const fetcher = vi.fn<typeof fetch>(async () => Response.json({
            error: { code: 'credit_balance_exhausted' },
        }, { status: 429 }));
        const save = vi.fn<DraftRepository['save']>();
        const batch = await insertBatch(sampleDate(1), 'generating');
        vi.stubEnv('CHERRY_OPENAI_API_KEY', 'fixture-key');
        try {
            await expect(generateBatchDrafts(batch, {
                corrections: async () => [], examples: async () => [], save,
            }, fetcher)).rejects.toMatchObject({ code: 'ai_credits' });
            expect(save).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('20분 Cron이 빈 작업에서는 HTTP 워커를 호출하지 않는다', async () => {
        await db.exec(`
            create schema if not exists cron;
            create schema if not exists vault;
            create schema if not exists net;
            create table if not exists vault.decrypted_secrets(name text, decrypted_secret text);
            create table if not exists net.fixture_requests(target text);
            create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
            create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
                returns bigint language sql as 'insert into net.fixture_requests values ($1) returning 1::bigint';
            insert into vault.decrypted_secrets values
                ('cherry_threads_worker_url','https://example.org/worker'), ('cherry_threads_worker_secret','fixture');
        `);
        expect(tickMigration).toContain("'*/20 * * * *'");
        await db.exec(tickMigration.replace(/^create extension.*;$/gm, ''));
        await db.exec('select public.cherry_threads_dispatch_tick()');
        expect(await value('(select count(*)::int from net.fixture_requests)')).toBe(0);
        await insertBatch(sampleDate(1), 'queued');
        await db.exec('select public.cherry_threads_dispatch_tick()');
        expect(await value('(select count(*)::int from net.fixture_requests)')).toBe(1);
    });
});
