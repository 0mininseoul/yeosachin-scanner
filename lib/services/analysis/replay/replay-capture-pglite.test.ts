import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const foundationMigration = readFileSync(new URL(
    '../../../../supabase/migrations/20260727021000_add_analysis_v2_replay_capture_foundation.sql',
    import.meta.url,
), 'utf8');
const v28FenceMigration = readFileSync(new URL(
    '../../../../supabase/migrations/20260727033000_fence_replay_capture_to_ai_stage_v28.sql',
    import.meta.url,
), 'utf8');
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = '223e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '423e4567-e89b-42d3-a456-426614174000';
const OTHER_OWNER_ID = '523e4567-e89b-42d3-a456-426614174000';
const TARGET = 'target.account';
const OPERATOR = 'a'.repeat(64);
const EXPECTED_RISK_POLICY = 'risk-policy-v2.4';
const EXPECTED_AI_STAGE_POLICY = 'ai-stage-policy-v2.8';
const POLICY = {
    pipeline: 'v2',
    risk: EXPECTED_RISK_POLICY,
    aiStage: EXPECTED_AI_STAGE_POLICY,
    scheduler: 'ai-scheduler-v1',
};
const PLAN_CARDS = {
    standard: {
        launchStatus: 'production',
        selectionState: 'required',
        detailedMutualLimit: 100,
        relationshipCapacity: { followers: 1000, following: 1000 },
    },
};

let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        GRANT service_role TO CURRENT_USER;
        CREATE SCHEMA extensions;
        CREATE SEQUENCE extensions.test_uuid_sequence;
        CREATE FUNCTION extensions.gen_random_uuid() RETURNS UUID LANGUAGE sql AS $$
            SELECT (
                '323e4567-e89b-42d3-a456-'
                || pg_catalog.lpad(
                    pg_catalog.nextval('extensions.test_uuid_sequence')::TEXT,
                    12,
                    '0'
                )
            )::UUID
        $$;
        CREATE FUNCTION extensions.digest(TEXT, TEXT) RETURNS BYTEA LANGUAGE sql AS $$
            SELECT pg_catalog.decode(pg_catalog.md5($1) || pg_catalog.md5($1), 'hex')
        $$;
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY, status TEXT, access_mode TEXT, consumed_request_id UUID,
            expires_at TIMESTAMPTZ, plan_cards_snapshot JSONB, policy_versions_snapshot JSONB,
            target_followers_count INTEGER, target_following_count INTEGER,
            user_id UUID, target_instagram_id TEXT
        );
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY, preflight_id UUID, pipeline_version TEXT, status TEXT,
            selected_plan_id_snapshot TEXT, plan_access_mode_snapshot TEXT,
            policy_versions_snapshot JSONB, plan_cards_snapshot JSONB,
            user_id UUID, target_instagram_id TEXT
        );
        CREATE TABLE public.analysis_v2_result_summaries (
            request_id UUID PRIMARY KEY, target_instagram_id TEXT, plan_id TEXT,
            followers_declared INTEGER, following_declared INTEGER,
            public_mutuals INTEGER, screened_mutuals INTEGER,
            score_policy_version TEXT
        );
        CREATE TABLE public.analysis_v2_provider_runs (
            request_id UUID, job_key TEXT, operation_key TEXT, logical_provider TEXT,
            actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT
        );
        CREATE TABLE public.analysis_preflight_provider_runs (
            preflight_id UUID, operation_key TEXT, logical_provider TEXT,
            actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT
        );
    `);
    await db.exec(foundationMigration);
    await db.exec(v28FenceMigration);
    await db.query(`INSERT INTO public.analysis_preflights VALUES (
        $1, 'ready', 'production', NULL, clock_timestamp() + INTERVAL '1 hour',
        $2::JSONB, $3::JSONB, 1000, 1000, $4, $5
    )`, [
        PREFLIGHT_ID,
        JSON.stringify(PLAN_CARDS),
        JSON.stringify(POLICY),
        OWNER_ID,
        TARGET,
    ]);
});

afterEach(async () => { await db.close(); });

async function arm() {
    const commitments = await db.query<{ policy_hash: string; context_hash: string }>(
        `SELECT
            pg_catalog.encode(extensions.digest($1::JSONB::TEXT, 'sha256'), 'hex') AS policy_hash,
            pg_catalog.encode(extensions.digest(
                'replay-capture-context-v1' || chr(10)
                || $2::TEXT || chr(10) || $3 || chr(10)
                || $1::JSONB::TEXT,
                'sha256'
            ), 'hex') AS context_hash`,
        [JSON.stringify(POLICY), OWNER_ID, TARGET],
    );
    return db.query<{
        capture_id: string;
        write_lease_token: string;
        write_lease_expires_at: Date;
    }>(
        `SELECT * FROM public.arm_analysis_v2_replay_capture(
            $1, $2, $3, $4, 0, 0, 2, $5, 'AUTHORIZED'
        )`,
        [
            PREFLIGHT_ID,
            commitments.rows[0]?.policy_hash,
            commitments.rows[0]?.context_hash,
            'b'.repeat(64),
            OPERATOR,
        ],
    );
}

describe('replay capture authorization fences', () => {
    it('rejects a caller policy hash or target capacity that differs from the ready preflight', async () => {
        await expect(db.query(
            `SELECT public.arm_analysis_v2_replay_capture(
                $1, $2, $3, $4, 0, 0, 2, $5, 'AUTHORIZED'
            )`,
            [
                PREFLIGHT_ID,
                'f'.repeat(64),
                'f'.repeat(64),
                'b'.repeat(64),
                OPERATOR,
            ],
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_POLICY_MISMATCH');
        await db.query(
            'UPDATE public.analysis_preflights SET target_followers_count = 1001 WHERE id = $1',
            [PREFLIGHT_ID],
        );
        await expect(arm()).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_PREFLIGHT_REJECTED');
    });

    it('rejects missing scheduler-v1 at arm', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET policy_versions_snapshot = policy_versions_snapshot - 'scheduler'
             WHERE id = $1`,
            [PREFLIGHT_ID],
        );
        await expect(arm()).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_CAPTURE_PREFLIGHT_REJECTED'
        );
    });

    it('rejects the obsolete risk-policy-v2.3 at arm', async () => {
        await db.query(
            `UPDATE public.analysis_preflights
             SET policy_versions_snapshot =
                 jsonb_set(policy_versions_snapshot, '{risk}', '"risk-policy-v2.3"')
             WHERE id = $1`,
            [PREFLIGHT_ID],
        );
        await expect(arm()).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_CAPTURE_PREFLIGHT_REJECTED'
        );
    });

    it('rejects v2.7, missing keys, and extra policy drift at arm', async () => {
        for (const policy of [
            { ...POLICY, aiStage: 'ai-stage-policy-v2.7' },
            (() => { const value = { ...POLICY }; delete (value as { scheduler?: string }).scheduler; return value; })(),
            { ...POLICY, unexpected: 'drift' },
        ]) {
            await db.query(
                'UPDATE public.analysis_preflights SET policy_versions_snapshot = $2::JSONB WHERE id = $1',
                [PREFLIGHT_ID, JSON.stringify(policy)],
            );
            await expect(arm()).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_CAPTURE_PREFLIGHT_REJECTED',
            );
        }
    });

    it('does not grant direct service-role table access', async () => {
        await db.exec('SET ROLE service_role');
        await expect(db.query(
            'SELECT * FROM public.analysis_v2_replay_capture_authorizations'
        )).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });

    it.each(['anon', 'authenticated'])('does not grant %s capture RPC access', async role => {
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query(
            `SELECT public.arm_analysis_v2_replay_capture(
                $1, $2, $3, $4, 0, 0, 2, $5, 'AUTHORIZED'
            )`,
            [PREFLIGHT_ID, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), OPERATOR],
        )).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });

    it('allows exact registration and a bounded cleanup lease only after retention expiry', async () => {
        const armed = await arm();
        const captureId = armed.rows[0]?.capture_id;
        const armWriteLeaseToken = armed.rows[0]?.write_lease_token;
        expect(captureId).toBeTruthy();
        await db.query(`INSERT INTO public.analysis_requests VALUES (
            $1, $2, 'v2', 'pending', 'standard', 'production',
            $3::JSONB, $4::JSONB, $5, $6
        )`, [
            REQUEST_ID,
            PREFLIGHT_ID,
            JSON.stringify(POLICY),
            JSON.stringify(PLAN_CARDS),
            OWNER_ID,
            TARGET,
        ]);
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2
             WHERE id = $1`,
            [PREFLIGHT_ID, REQUEST_ID],
        );
        const bound = await db.query<{
            write_lease_token: string;
            write_lease_expires_at: Date;
        }>(
            `SELECT * FROM public.bind_analysis_v2_replay_capture(
                $1, $2, $3, 'AUTHORIZED'
            )`,
            [captureId, REQUEST_ID, OPERATOR],
        );
        const writeLeaseToken = bound.rows[0]?.write_lease_token;
        expect(writeLeaseToken).toBeTruthy();
        expect(writeLeaseToken).not.toBe(armWriteLeaseToken);
        expect(bound.rows[0]?.write_lease_expires_at.getTime())
            .toBeGreaterThan(Date.now());
        await expect(db.query(`SELECT public.bind_analysis_v2_replay_capture($1, $2, $3, 'AUTHORIZED')`, [captureId, REQUEST_ID, OPERATOR])).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_BIND_REJECTED');

        const identity = [
            'replay/v1', captureId, 'c'.repeat(64),
            'provider_payload', 'collection', '0', '0',
        ].join('\n');
        const identityDigest = await db.query<{ hash: string }>(
            `SELECT pg_catalog.encode(
                extensions.digest($1, 'sha256'), 'hex'
            ) AS hash`,
            [identity],
        );
        const params = [captureId, writeLeaseToken, 'c'.repeat(64), 'provider_payload', 'collection', 0, 0,
            `replay/v1/${captureId}/${identityDigest.rows[0]?.hash}.enc`,
            'e'.repeat(64), 123, 1, 'd'.repeat(64), OPERATOR, 'AUTHORIZED'];
        const call = `SELECT public.register_analysis_v2_replay_capture_fragment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;
        await expect(db.query(call, params)).resolves.toBeDefined();
        await expect(db.query(call, params)).resolves.toBeDefined();
        await expect(db.query(call, params.map((value, index) => (
            index === 8 ? 'f'.repeat(64) : value
        )))).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_FRAGMENT_CONFLICT');
        await expect(db.query(call, params.map((value, index) => (
            index === 11 ? 'f'.repeat(64) : value
        )))).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_FRAGMENT_CONFLICT');
        await expect(db.query(call, params.map((value, index) => (
            index === 7 ? `replay/v1/${captureId}/${'f'.repeat(64)}.enc` : value
        )))).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_INVALID');

        await expect(db.query(
            `UPDATE public.analysis_v2_replay_capture_fragments
             SET cleanup_status = 'leased',
                 cleanup_lease_token = $2,
                 cleanup_lease_acquired_at = statement_timestamp(),
                 cleanup_lease_expires_at =
                    statement_timestamp() + INTERVAL '15 minutes'
             WHERE capture_id = $1`,
            [captureId, '623e4567-e89b-42d3-a456-426614174000'],
        )).rejects.toThrow(/check constraint/i);
        await expect(db.query(
            `UPDATE public.analysis_v2_replay_capture_fragments
             SET created_at = statement_timestamp() - INTERVAL '25 hours',
                 expires_at = statement_timestamp() - INTERVAL '2 hours',
                 cleanup_status = 'leased',
                 cleanup_lease_token = $2,
                 cleanup_lease_acquired_at = statement_timestamp(),
                 cleanup_lease_expires_at =
                    statement_timestamp() + INTERVAL '15 minutes'
             WHERE capture_id = $1`,
            [captureId, '623e4567-e89b-42d3-a456-426614174000'],
        )).resolves.toBeDefined();
        await expect(db.query(
            `UPDATE public.analysis_v2_replay_capture_fragments
             SET cleanup_lease_expires_at =
                    cleanup_lease_acquired_at + INTERVAL '15 minutes 1 second'
             WHERE capture_id = $1`,
            [captureId],
        )).rejects.toThrow(/check constraint/i);
    });

    it('rotates an expired arm write lease at bind and rejects the old token', async () => {
        const armed = await arm();
        await expect(db.query(
            `UPDATE public.analysis_v2_replay_capture_authorizations
             SET write_lease_expires_at =
                 write_lease_acquired_at + INTERVAL '15 minutes 1 second'
             WHERE capture_id = $1`,
            [armed.rows[0]?.capture_id],
        )).rejects.toThrow(/check constraint/i);
        await db.query(
            `UPDATE public.analysis_v2_replay_capture_authorizations
             SET armed_at = clock_timestamp() - INTERVAL '16 minutes',
                 arm_expires_at = clock_timestamp() + INTERVAL '3 hours',
                 artifact_expires_at = clock_timestamp() + INTERVAL '23 hours',
                 write_lease_acquired_at =
                    clock_timestamp() - INTERVAL '16 minutes',
                 write_lease_expires_at =
                    clock_timestamp() - INTERVAL '1 minute'
             WHERE capture_id = $1`,
            [armed.rows[0]?.capture_id],
        );
        await db.query(`INSERT INTO public.analysis_requests VALUES (
            $1, $2, 'v2', 'pending', 'standard', 'production',
            $3::JSONB, $4::JSONB, $5, $6
        )`, [
            REQUEST_ID, PREFLIGHT_ID, JSON.stringify(POLICY),
            JSON.stringify(PLAN_CARDS), OWNER_ID, TARGET,
        ]);
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2 WHERE id = $1`,
            [PREFLIGHT_ID, REQUEST_ID],
        );
        const bound = await db.query<{
            write_lease_token: string;
            write_lease_expires_at: Date;
        }>(
            `SELECT * FROM public.bind_analysis_v2_replay_capture(
                $1, $2, $3, 'AUTHORIZED'
            )`,
            [armed.rows[0]?.capture_id, REQUEST_ID, OPERATOR],
        );
        expect(bound.rows[0]?.write_lease_token)
            .not.toBe(armed.rows[0]?.write_lease_token);
        expect(bound.rows[0]?.write_lease_expires_at.getTime())
            .toBeGreaterThan(Date.now());
        const identity = [
            'replay/v1', armed.rows[0]?.capture_id, 'c'.repeat(64),
            'provider_payload', 'collection', '0', '0',
        ].join('\n');
        const identityDigest = await db.query<{ hash: string }>(
            `SELECT pg_catalog.encode(
                extensions.digest($1, 'sha256'), 'hex'
            ) AS hash`,
            [identity],
        );
        await expect(db.query(
            `SELECT public.register_analysis_v2_replay_capture_fragment(
                $1,$2,$3,'provider_payload','collection',0,0,$4,$5,123,
                1::SMALLINT,$6,$7,'AUTHORIZED'
            )`,
            [
                armed.rows[0]?.capture_id,
                armed.rows[0]?.write_lease_token,
                'c'.repeat(64),
                `replay/v1/${armed.rows[0]?.capture_id}/`
                    + `${identityDigest.rows[0]?.hash}.enc`,
                'e'.repeat(64),
                'd'.repeat(64),
                OPERATOR,
            ],
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_REGISTER_REJECTED');
        await expect(db.query(
            `SELECT public.register_analysis_v2_replay_capture_fragment(
                $1,$2,$3,'provider_payload','collection',0,0,$4,$5,123,
                1::SMALLINT,$6,$7,'AUTHORIZED'
            )`,
            [
                armed.rows[0]?.capture_id,
                bound.rows[0]?.write_lease_token,
                'c'.repeat(64),
                `replay/v1/${armed.rows[0]?.capture_id}/`
                    + `${identityDigest.rows[0]?.hash}.enc`,
                'e'.repeat(64),
                'd'.repeat(64),
                OPERATOR,
            ],
        )).resolves.toBeDefined();
    });

    it.each([
        ['owner', OTHER_OWNER_ID, TARGET, POLICY],
        ['target', OWNER_ID, 'other.target', POLICY],
        ['scheduler', OWNER_ID, TARGET, { ...POLICY, scheduler: 'wrong' }],
    ])('rejects request %s mismatch at bind', async (
        _case,
        requestOwner,
        requestTarget,
        requestPolicy,
    ) => {
        const armed = await arm();
        await db.query(`INSERT INTO public.analysis_requests VALUES (
            $1, $2, 'v2', 'pending', 'standard', 'production',
            $3::JSONB, $4::JSONB, $5, $6
        )`, [
            REQUEST_ID, PREFLIGHT_ID, JSON.stringify(requestPolicy),
            JSON.stringify(PLAN_CARDS), requestOwner, requestTarget,
        ]);
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'consumed', consumed_request_id = $2 WHERE id = $1`,
            [PREFLIGHT_ID, REQUEST_ID],
        );
        await expect(db.query(
            `SELECT public.bind_analysis_v2_replay_capture($1, $2, $3, 'AUTHORIZED')`,
            [armed.rows[0]?.capture_id, REQUEST_ID, OPERATOR],
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_CAPTURE_BIND_REJECTED');
    });
});
