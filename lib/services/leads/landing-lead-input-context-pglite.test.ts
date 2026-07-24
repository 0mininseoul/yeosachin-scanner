import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (file: string): string =>
    readFileSync(new URL(file, migrationsDirectory), 'utf8');

const createLandingLeads = migration('20260719160000_add_landing_leads.sql');
const addInputContext = migration(
    '20260725021500_add_landing_lead_input_context.sql',
);
const databases: PGlite[] = [];

async function createDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA extensions;
        CREATE FUNCTION extensions.gen_random_uuid()
        RETURNS UUID LANGUAGE sql VOLATILE
        AS $$ SELECT pg_catalog.gen_random_uuid() $$;
    `);
    await db.exec(createLandingLeads);
    return db;
}

async function withRole<T>(
    db: PGlite,
    role: 'anon' | 'authenticated' | 'service_role',
    operation: () => Promise<T>,
): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await operation();
    } finally {
        await db.exec('RESET ROLE');
    }
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('landing_leads input context database behavior', () => {
    it('backfills targets, deduplicates exclusion replays, and leaves target appends intact', async () => {
        const db = await createDatabase();
        await withRole(db, 'service_role', () => db.query(
            `INSERT INTO public.landing_leads(instagram_id, raw_input)
             VALUES ('legacy.target', '@Legacy.Target')`,
        ));

        await db.exec(addInputContext);

        const legacy = await withRole(db, 'service_role', () => db.query<{
            input_context: string;
            source_preflight_id: string | null;
        }>(
            `SELECT input_context, source_preflight_id
             FROM public.landing_leads
             WHERE instagram_id = 'legacy.target'`,
        ));
        expect(legacy.rows).toEqual([{
            input_context: 'target',
            source_preflight_id: null,
        }]);

        const preflightId = '123e4567-e89b-42d3-a456-426614174000';
        await withRole(db, 'service_role', () => db.query(
            `INSERT INTO public.landing_leads(
                instagram_id, input_context, source_preflight_id
             ) VALUES ('excluded.account', 'excluded', $1)`,
            [preflightId],
        ));
        await expect(withRole(db, 'service_role', () => db.query(
            `INSERT INTO public.landing_leads(
                instagram_id, input_context, source_preflight_id
             ) VALUES ('excluded.account', 'excluded', $1)`,
            [preflightId],
        ))).rejects.toThrow();

        await withRole(db, 'service_role', () => db.query(
            `INSERT INTO public.landing_leads(instagram_id)
             VALUES ('repeat.target'), ('repeat.target')`,
        ));
        const counts = await withRole(db, 'service_role', () => db.query<{
            input_context: string;
            count: number;
        }>(
            `SELECT input_context, COUNT(*)::INTEGER AS count
             FROM public.landing_leads
             GROUP BY input_context
             ORDER BY input_context`,
        ));
        expect(counts.rows).toEqual([
            { input_context: 'excluded', count: 1 },
            { input_context: 'target', count: 3 },
        ]);
    });

    it('rejects malformed context rows and keeps client roles locked out', async () => {
        const db = await createDatabase();
        await db.exec(addInputContext);

        await expect(withRole(db, 'service_role', () => db.query(
            `INSERT INTO public.landing_leads(
                instagram_id, input_context, source_preflight_id, raw_input
             ) VALUES (
                'excluded.account',
                'excluded',
                '123e4567-e89b-42d3-a456-426614174000',
                '@Excluded.Account'
             )`,
        ))).rejects.toThrow();

        for (const role of ['anon', 'authenticated'] as const) {
            await expect(withRole(db, role, () => db.query(
                `INSERT INTO public.landing_leads(instagram_id)
                 VALUES ('forbidden.account')`,
            ))).rejects.toThrow();
            await expect(withRole(db, role, () => db.query(
                'SELECT instagram_id FROM public.landing_leads',
            ))).rejects.toThrow();
        }
    });
});
