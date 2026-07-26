import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../../supabase/migrations/20260727021000_add_analysis_v2_replay_capture_foundation.sql',
    import.meta.url,
), 'utf8');
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = '223e4567-e89b-42d3-a456-426614174000';
const OPERATOR = 'a'.repeat(64);

let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        GRANT service_role TO CURRENT_USER;
        CREATE SCHEMA extensions;
        CREATE FUNCTION extensions.gen_random_uuid() RETURNS UUID LANGUAGE sql AS $$
            SELECT '323e4567-e89b-42d3-a456-426614174000'::UUID
        $$;
        CREATE FUNCTION extensions.digest(TEXT, TEXT) RETURNS BYTEA LANGUAGE sql AS $$
            SELECT pg_catalog.decode(pg_catalog.md5($1) || pg_catalog.md5($1), 'hex')
        $$;
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY, status TEXT, access_mode TEXT, consumed_request_id UUID,
            expires_at TIMESTAMPTZ, plan_cards_snapshot JSONB, policy_versions_snapshot JSONB
        );
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY, preflight_id UUID, pipeline_version TEXT, status TEXT,
            selected_plan_id_snapshot TEXT, plan_access_mode_snapshot TEXT,
            policy_versions_snapshot JSONB, plan_cards_snapshot JSONB
        );
    `);
    await db.exec(migration);
    await db.query(`INSERT INTO public.analysis_preflights VALUES (
        $1, 'ready', 'production', NULL, clock_timestamp() + INTERVAL '1 hour',
        $2::JSONB, '{"pipeline":"v2"}'::JSONB
    )`, [PREFLIGHT_ID, JSON.stringify({
        standard: {
            launchStatus: 'production', selectionState: 'required', detailedMutualLimit: 100,
            relationshipCapacity: { followers: 1000, following: 1000 },
        },
    })]);
});

afterEach(async () => { await db.close(); });

async function arm() {
    return db.query<{ capture_id: string }>(
        `SELECT public.arm_analysis_v2_replay_capture($1, $2, 0, 0, 2, $3, 'AUTHORIZED') AS capture_id`,
        [PREFLIGHT_ID, 'b'.repeat(64), OPERATOR],
    );
}

describe('replay capture authorization fences', () => {
    it('does not grant direct service-role table access', async () => {
        await db.exec('SET ROLE service_role');
        await expect(db.query(
            'SELECT * FROM public.analysis_v2_replay_capture_authorizations'
        )).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });

    it('allows one bound request and exact-idempotent fragment registration only', async () => {
        const armed = await arm();
        const captureId = armed.rows[0]?.capture_id;
        expect(captureId).toBeTruthy();
        await db.query(`INSERT INTO public.analysis_requests VALUES (
            $1, $2, 'v2', 'pending', 'standard', 'production',
            '{"pipeline":"v2"}'::JSONB, $3::JSONB
        )`, [REQUEST_ID, PREFLIGHT_ID, JSON.stringify({
            standard: {
                launchStatus: 'production', selectionState: 'required', detailedMutualLimit: 100,
                relationshipCapacity: { followers: 1000, following: 1000 },
            },
        })]);
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2
             WHERE id = $1`,
            [PREFLIGHT_ID, REQUEST_ID],
        );
        await expect(db.query(`SELECT public.bind_analysis_v2_replay_capture($1, $2, $3, 'AUTHORIZED')`, [captureId, REQUEST_ID, OPERATOR])).resolves.toBeDefined();
        await expect(db.query(`SELECT public.bind_analysis_v2_replay_capture($1, $2, $3, 'AUTHORIZED')`, [captureId, REQUEST_ID, OPERATOR])).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_BIND_REJECTED');

        const params = [captureId, 'c'.repeat(64), 'provider_payload', 'collection', 0, 0,
            `replay/v1/${captureId}/${'d'.repeat(64)}.enc`, 'e'.repeat(64), 123, 1, OPERATOR, 'AUTHORIZED'];
        const call = `SELECT public.register_analysis_v2_replay_capture_fragment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
        await expect(db.query(call, params)).resolves.toBeDefined();
        await expect(db.query(call, params)).resolves.toBeDefined();
        await expect(db.query(call, params.map((value, index) => (
            index === 7 ? 'f'.repeat(64) : value
        )))).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_FRAGMENT_CONFLICT');
    });
});
