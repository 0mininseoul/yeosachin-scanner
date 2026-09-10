import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { buildAccountDeletionCanonicalProjection } from '../../../scripts/backfill-account-deletion-canonical';

const commerceMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql',
    import.meta.url,
), 'utf8');
const accountDeletionMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260910020205_prepare_account_deletion_canonical_wave.sql',
    import.meta.url,
), 'utf8');

const accountId = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';
const secondAccountId = '7d809496-1cb8-4e4f-a081-8efc14a7a64c';

function withoutAclStatements(sql: string): string {
    return sql
        .replace(/^REVOKE[^;]*;\n?/gm, '')
        .replace(/^GRANT[^;]*;\n?/gm, '');
}

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE SCHEMA extensions;
        CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
        CREATE TABLE public.users(id uuid PRIMARY KEY);
        CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
        CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
    `);
    await db.exec(withoutAclStatements(commerceMigration));
    await db.exec(`
        CREATE TABLE public.account_deletion_jobs (
            account_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
            state TEXT NOT NULL DEFAULT 'requested' CHECK (
                state IN ('requested', 'objects_purged', 'database_purged', 'completed')
            ),
            requested_at TIMESTAMPTZ NOT NULL,
            objects_purged_at TIMESTAMPTZ,
            database_purged_at TIMESTAMPTZ,
            completed_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL,
            CONSTRAINT account_deletion_jobs_state_shape_check CHECK (
                (state = 'requested' AND objects_purged_at IS NULL AND database_purged_at IS NULL AND completed_at IS NULL)
                OR (state = 'objects_purged' AND objects_purged_at IS NOT NULL AND database_purged_at IS NULL AND completed_at IS NULL)
                OR (state = 'database_purged' AND objects_purged_at IS NOT NULL AND database_purged_at IS NOT NULL AND completed_at IS NULL)
                OR (state = 'completed' AND objects_purged_at IS NOT NULL AND database_purged_at IS NOT NULL AND completed_at IS NOT NULL)
            )
        );
    `);
    await db.exec(withoutAclStatements(accountDeletionMigration));
});

afterAll(async () => {
    await db.close();
});

async function seedCompleted(id: string): Promise<void> {
    await db.query(`INSERT INTO public.users(id) VALUES ($1)`, [id]);
    await db.query(`
        INSERT INTO public.account_deletion_jobs(
            account_id, state, requested_at, objects_purged_at,
            database_purged_at, completed_at, updated_at
        ) VALUES (
            $1, 'completed', '2026-09-01T00:00:00.000Z',
            '2026-09-01T00:01:00.000Z', '2026-09-01T00:02:00.000Z',
            '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z'
        )
    `, [id]);
}

describe('account deletion canonical migration PGlite contract', () => {
    it('maps a completed source row idempotently without persisting the account id', async () => {
        await seedCompleted(accountId);

        await expect(db.query(
            `SELECT public.mirror_account_deletion_job_v1($1) AS result`,
            [accountId],
        )).resolves.toMatchObject({
            rows: [{ result: { status: 'mirrored', duplicate: false, state: 'completed' } }],
        });

        const first = await db.query<{
            kind: string;
            state: string;
            target_key_hash: string;
            payload: Record<string, unknown>;
            content_hash: string;
            terminal_at: Date | null;
        }>(`SELECT kind,state,target_key_hash,payload,content_hash,terminal_at
            FROM public.maintenance_jobs`);
        expect(first.rows).toHaveLength(1);
        expect(first.rows[0]).toMatchObject({
            kind: 'purge',
            state: 'succeeded',
            target_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            content_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        const projection = buildAccountDeletionCanonicalProjection({
            accountId,
            state: 'completed',
            requestedAt: '2026-09-01T00:00:00.000Z',
            objectsPurgedAt: '2026-09-01T00:01:00.000Z',
            databasePurgedAt: '2026-09-01T00:02:00.000Z',
            completedAt: '2026-09-01T00:03:00.000Z',
            updatedAt: '2026-09-01T00:03:00.000Z',
        });
        expect(first.rows[0].target_key_hash).toBe(projection.targetKeyHash);
        expect(first.rows[0].content_hash).toBe(projection.contentHash);
        expect(first.rows[0].payload).toMatchObject({
            source_table: 'account_deletion_jobs',
            legacy_state: 'completed',
        });
        expect(first.rows[0].payload).not.toHaveProperty('account_id');
        expect(first.rows[0].terminal_at).toBeTruthy();

        await expect(db.query(
            `SELECT public.mirror_account_deletion_job_v1($1) AS result`,
            [accountId],
        )).resolves.toMatchObject({
            rows: [{ result: { status: 'mirrored', duplicate: true, state: 'completed' } }],
        });
        expect((await db.query(`SELECT count(*)::int AS count FROM public.maintenance_jobs`)).rows[0])
            .toEqual({ count: 1 });
    });

    it('maps an in-progress source row to queued and blocks a source regression', async () => {
        await db.query(`INSERT INTO public.users(id) VALUES ($1)`, [secondAccountId]);
        await db.query(`
            INSERT INTO public.account_deletion_jobs(account_id, state, requested_at, updated_at)
            VALUES ($1, 'requested', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')
        `, [secondAccountId]);

        await db.query(`SELECT public.mirror_account_deletion_job_v1($1)`, [secondAccountId]);
        expect((await db.query<{ state: string }>(
            `SELECT state FROM public.maintenance_jobs WHERE payload->>'legacy_state' = 'requested'`,
        )).rows[0]).toEqual({ state: 'queued' });

        await seedCompleted('8d809496-1cb8-4e4f-a081-8efc14a7a64c');
        const regressionId = '8d809496-1cb8-4e4f-a081-8efc14a7a64c';
        await db.query(`SELECT public.mirror_account_deletion_job_v1($1)`, [regressionId]);
        await db.query(`
            UPDATE public.account_deletion_jobs
            SET state = 'requested', objects_purged_at = NULL,
                database_purged_at = NULL, completed_at = NULL,
                updated_at = '2026-09-03T00:00:00.000Z'
            WHERE account_id = $1
        `, [regressionId]);
        await db.query(`SELECT public.mirror_account_deletion_job_v1($1)`, [regressionId]);

        expect((await db.query<{ state: string; last_error_code: string }>(
            `SELECT state,last_error_code FROM public.maintenance_jobs
             WHERE payload->>'legacy_state' = 'requested' AND last_error_code IS NOT NULL`,
        )).rows[0]).toEqual({
            state: 'blocked',
            last_error_code: 'ACCOUNT_DELETION_SOURCE_REGRESSION',
        });
    });
});
