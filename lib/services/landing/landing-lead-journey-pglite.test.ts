import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (file: string): string => readFileSync(new URL(file, migrationDirectory), 'utf8');
const createLandingLeads = migration('20260719160000_add_landing_leads.sql');
const addInputContext = migration('20260725021500_add_landing_lead_input_context.sql');
const addJourneyContract = migration('20260909095950_add_landing_lead_journey_contract.sql');
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
        CREATE TABLE public.users(
            id UUID PRIMARY KEY,
            lifecycle TEXT NOT NULL DEFAULT 'active'
        );
    `);
    await db.exec(createLandingLeads);
    await db.exec(addInputContext);
    await db.exec(addJourneyContract);
    return db;
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('landing lead journey database contract', () => {
    it('maps target and excluded rows to one journey and replays idempotently', async () => {
        const db = await createDatabase();
        const journeyId = '123e4567-e89b-42d3-a456-426614174000';
        const replayJourneyId = '223e4567-e89b-42d3-a456-426614174000';
        const preflightId = '323e4567-e89b-42d3-a456-426614174000';
        const tokenHash = 'a'.repeat(64);
        const principalHash = 'b'.repeat(64);

        const first = await db.query<{ journey_id: string; created: boolean }>(
            `SELECT * FROM public.create_or_replay_landing_lead_capture($1, $2, 'target', $3, $4)`,
            [journeyId, 'target.user', principalHash, tokenHash],
        );
        expect(first.rows).toEqual([{ journey_id: journeyId, created: true }]);

        const replay = await db.query<{ journey_id: string; created: boolean }>(
            `SELECT * FROM public.create_or_replay_landing_lead_capture($1, $2, 'target', $3, $4)`,
            [replayJourneyId, 'different.user', principalHash, tokenHash],
        );
        expect(replay.rows).toEqual([{ journey_id: journeyId, created: false }]);

        await db.query(`SELECT public.bind_landing_lead_journey_to_preflight($1, $2)`, [journeyId, preflightId]);
        await db.query(`SELECT public.create_or_replay_landing_lead_exclusion($1, $2)`, [preflightId, 'excluded.user']);
        const journeyRows = await db.query<{ journey_id: string; input_context: string; source_preflight_id: string }>(
            `SELECT journey_id, input_context, source_preflight_id
             FROM public.landing_leads
             ORDER BY input_context`,
        );
        expect(journeyRows.rows).toEqual([
            { journey_id: journeyId, input_context: 'excluded', source_preflight_id: preflightId },
            { journey_id: journeyId, input_context: 'target', source_preflight_id: preflightId },
        ]);

        const duplicate = await db.query(`SELECT public.create_or_replay_landing_lead_exclusion($1, $2)`, [preflightId, 'excluded.user']);
        expect(duplicate.rows[0]).toEqual({ create_or_replay_landing_lead_exclusion: true });
        const count = await db.query<{ count: number }>(`SELECT COUNT(*)::INTEGER AS count FROM public.landing_leads`);
        expect(count.rows[0]?.count).toBe(2);

        const targetProjection = await db.query<{ payload: { rows: Array<{ rowCountInJourney: number }> } }>(
            `SELECT public.load_landing_lead_admin_projection('target', NULL, NULL, NULL, NULL, NULL, NULL, 25) AS payload`,
        );
        expect(targetProjection.rows[0]?.payload.rows[0]?.rowCountInJourney).toBe(2);
    }, 30_000);

    it('claims monotonically, rejects a different owner, and fences deleted journeys permanently', async () => {
        const db = await createDatabase();
        const journeyId = '423e4567-e89b-42d3-a456-426614174000';
        const ownerId = '523e4567-e89b-42d3-a456-426614174000';
        const otherOwnerId = '623e4567-e89b-42d3-a456-426614174000';
        await db.query(`INSERT INTO public.users(id) VALUES ($1), ($2)`, [ownerId, otherOwnerId]);
        await db.query(`INSERT INTO public.landing_leads(instagram_id, journey_id, capture_token_hash)
                        VALUES ('target.user', $1, $2)`, [journeyId, 'c'.repeat(64)]);

        await expect(db.query(`SELECT public.claim_landing_lead_journey($1, $2)`, [journeyId, ownerId]))
            .resolves.toMatchObject({ rows: [{ claim_landing_lead_journey: true }] });
        await expect(db.query(`SELECT public.claim_landing_lead_journey($1, $2)`, [journeyId, ownerId]))
            .resolves.toMatchObject({ rows: [{ claim_landing_lead_journey: true }] });
        await expect(db.query(`SELECT public.claim_landing_lead_journey($1, $2)`, [journeyId, otherOwnerId]))
            .rejects.toThrow('LANDING_LEAD_JOURNEY_CLAIM_CONFLICT');

        await db.query(`SELECT public.unlink_landing_lead_journey_after_deletion($1)`, [ownerId]);
        const fenced = await db.query<{ mapping_status: string; auth_user_id: string | null }>(
            `SELECT mapping_status, auth_user_id FROM public.landing_leads WHERE journey_id = $1`,
            [journeyId],
        );
        expect(fenced.rows).toEqual([{ mapping_status: 'unlinked_after_deletion', auth_user_id: null }]);
        await expect(db.query(`SELECT public.claim_landing_lead_journey($1, $2)`, [journeyId, otherOwnerId]))
            .resolves.toMatchObject({ rows: [{ claim_landing_lead_journey: false }] });
    }, 30_000);
});
