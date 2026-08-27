import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createDemoFixture, DEMO_FIXTURE_VERSION } from './demo-analysis';

const migration = (name: string) => readFileSync(
    new URL(`../../../supabase/migrations/${name}`, import.meta.url),
    'utf8',
);

const migrationPaths = [
    '20260726050000_add_demo_analysis_runs.sql',
    '20260730010000_demo_analysis_editable_fixture_authority.sql',
    '20260730030000_restore_demo_fixture_authority_after_v4.sql',
    '20260730040000_upgrade_demo_fixture_v2_realism.sql',
];

const correctionMigration = '20260827055405_reconcile_junho_demo_ranked_copy.sql';
const userId = '123e4567-e89b-42d3-a456-426614174000';

function oldV2Payload() {
    const fixture = createDemoFixture('v2-copy-correction-fixture', DEMO_FIXTURE_VERSION);
    const publicAccounts = fixture.publicAccounts.map((account, index) => index < 10
        ? {
            ...account,
            oneLineOverview: '공개 범위에서 최근 좋아요와 댓글 흐름을 함께 확인했습니다. 수집 범위 밖의 맥락은 포함하지 않아 단정할 수 없습니다.',
            highRiskNarrative: index === 0
                ? [
                    '공개 범위에서 최근 맞팔 흐름과 프로필 정보를 함께 확인했습니다.',
                    '좋아요와 댓글 등 공개 상호작용은 수집 범위 밖의 맥락을 담지 않으므로 관계나 의도를 단정할 수 없습니다.',
                ]
                : null,
        }
        : account);
    return {
        target: {
            username: 'junho_dem', fullName: '김도윤', bio: null,
            profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false,
        },
        summary: fixture.summary,
        public: publicAccounts,
        private: fixture.privateAccounts,
    };
}

function quotedPayload(payload: unknown): string {
    return JSON.stringify(payload).replace(/'/g, "''");
}

type V2Payload = ReturnType<typeof oldV2Payload>;

async function databaseAtV2Head(): Promise<PGlite> {
    const database = await PGlite.create();
    await database.exec(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        INSERT INTO auth.users (id) VALUES ('${userId}');
    `);
    for (const path of migrationPaths) await database.exec(migration(path));
    return database;
}

async function publishOldV2Payload(database: PGlite, payload = oldV2Payload()): Promise<void> {
    const quoted = quotedPayload(payload);
    await database.exec(`
        SELECT public.create_demo_analysis_fixture_draft('operator-editable-fixture-v2', '${quoted}'::jsonb);
        SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-v2', '${quoted}'::jsonb);
    `);
}

describe('junho_dem v2 demo copy correction migration', () => {
    it('changes only the ranked copy fields and is idempotent on exact replay', async () => {
        const database = await databaseAtV2Head();
        try {
            const oldPayload = oldV2Payload();
            await publishOldV2Payload(database, oldPayload);
            const before = await database.query<{ version: string; status: string; payload: V2Payload }>(`
                SELECT version, status, payload
                FROM public.demo_analysis_fixtures
                WHERE version = 'operator-editable-fixture-v2'
            `);
            expect(before.rows).toHaveLength(1);

            await database.exec(migration(correctionMigration));
            const after = await database.query<{ version: string; status: string; payload: V2Payload }>(`
                SELECT version, status, payload
                FROM public.demo_analysis_fixtures
                WHERE version = 'operator-editable-fixture-v2'
            `);
            const beforeRow = before.rows[0]!;
            const afterRow = after.rows[0]!;
            const expected = createDemoFixture('v2-copy-correction-expected', DEMO_FIXTURE_VERSION);

            expect(afterRow.version).toBe(beforeRow.version);
            expect(afterRow.status).toBe(beforeRow.status);
            expect(afterRow.payload.target).toEqual(beforeRow.payload.target);
            expect(afterRow.payload.summary).toEqual(beforeRow.payload.summary);
            expect(afterRow.payload.private).toEqual(beforeRow.payload.private);
            expect(afterRow.payload.public.slice(10)).toEqual(beforeRow.payload.public.slice(10));
            afterRow.payload.public.slice(0, 10).forEach((account, index) => {
                const previous = beforeRow.payload.public[index]!;
                const expectedAccount = expected.publicAccounts[index]!;
                expect({
                    ...account,
                    oneLineOverview: previous.oneLineOverview,
                    ...(index === 0 ? { highRiskNarrative: previous.highRiskNarrative } : {}),
                }).toEqual(previous);
                expect(account.oneLineOverview).toBe(expectedAccount.oneLineOverview);
                if (index === 0) expect(account.highRiskNarrative).toEqual(expectedAccount.highRiskNarrative);
            });
            const trigger = await database.query<{ enabled: string }>(`
                SELECT trigger.tgenabled AS enabled
                FROM pg_trigger AS trigger
                INNER JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
                INNER JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = 'public'
                  AND relation.relname = 'demo_analysis_fixtures'
                  AND trigger.tgname = 'prevent_immutable_demo_analysis_fixture'
            `);
            expect(trigger.rows).toEqual([{ enabled: 'O' }]);
            await expect(database.exec(`
                UPDATE public.demo_analysis_fixtures
                SET payload = payload
                WHERE version = 'operator-editable-fixture-v2'
            `)).rejects.toThrow(/immutable/i);

            const firstResult = JSON.stringify(afterRow);
            await database.exec(migration(correctionMigration));
            const replay = await database.query<{ version: string; status: string; payload: V2Payload }>(`
                SELECT version, status, payload
                FROM public.demo_analysis_fixtures
                WHERE version = 'operator-editable-fixture-v2'
            `);
            expect(JSON.stringify(replay.rows[0])).toBe(firstResult);
        } finally {
            await database.close();
        }
    }, 30_000);

    it('fails safely without changing a published row when its payload fingerprint drifts', async () => {
        const database = await databaseAtV2Head();
        try {
            const driftedPayload = oldV2Payload();
            driftedPayload.public[10] = {
                ...driftedPayload.public[10]!,
                fullName: '운영자 수정',
            };
            await publishOldV2Payload(database, driftedPayload);
            const before = await database.query<{ status: string; payload: V2Payload }>(`
                SELECT status, payload
                FROM public.demo_analysis_fixtures
                WHERE version = 'operator-editable-fixture-v2'
            `);

            await expect(database.exec(migration(correctionMigration))).rejects.toThrow(/fingerprint|drift|expected/i);

            const after = await database.query<{ status: string; payload: V2Payload }>(`
                SELECT status, payload
                FROM public.demo_analysis_fixtures
                WHERE version = 'operator-editable-fixture-v2'
            `);
            expect(after.rows[0]).toEqual(before.rows[0]);
        } finally {
            await database.close();
        }
    }, 30_000);
});
