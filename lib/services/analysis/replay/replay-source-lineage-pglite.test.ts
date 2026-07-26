import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const initialMigration = readFileSync(
    new URL(
        '../../../../supabase/migrations/20260727010000_add_analysis_v2_replay_capture_source.sql',
        import.meta.url,
    ),
    'utf8',
);
const forwardMigration = readFileSync(
    new URL(
        '../../../../supabase/migrations/20260727013000_expand_analysis_v2_replay_source_lineage.sql',
        import.meta.url,
    ),
    'utf8',
);
const v28FenceMigration = readFileSync(
    new URL(
        '../../../../supabase/migrations/20260727033000_fence_replay_capture_to_ai_stage_v28.sql',
        import.meta.url,
    ),
    'utf8',
);

const PLUS_REQUEST = '10000000-0000-4000-8000-000000000001';
const PLUS_PREFLIGHT = '20000000-0000-4000-8000-000000000001';
const STANDARD_REQUEST = '10000000-0000-4000-8000-000000000002';
const STANDARD_PREFLIGHT = '20000000-0000-4000-8000-000000000002';
const INVALID_REQUEST = '10000000-0000-4000-8000-000000000003';
const INVALID_PREFLIGHT = '20000000-0000-4000-8000-000000000003';
const V28_REQUEST = '10000000-0000-4000-8000-000000000007';
const V28_PREFLIGHT = '20000000-0000-4000-8000-000000000007';
const PLUS_POLICY = '{"pipeline":"v2","risk":"risk-policy-v2.2","aiStage":"ai-stage-policy-v2.4"}';
const STANDARD_POLICY = '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}';
const INVALID_POLICY = '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}';
const V28_POLICY = '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.8","scheduler":"ai-scheduler-v1"}';
const STANDARD_CARDS = JSON.stringify({
    standard: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
    },
});

let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY, target_instagram_id TEXT, status TEXT,
            pipeline_version TEXT, selected_plan_id_snapshot TEXT,
            plan_access_mode_snapshot TEXT, preflight_id UUID,
            completed_at TIMESTAMPTZ, policy_versions_snapshot JSONB
        );
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY, status TEXT, access_mode TEXT,
            consumed_request_id UUID, target_instagram_id TEXT,
            target_is_private BOOLEAN, policy_versions_snapshot JSONB,
            target_full_name TEXT, target_bio TEXT, target_profile_image_url TEXT,
            target_followers_count INTEGER, target_following_count INTEGER,
            plan_cards_snapshot JSONB
        );
        CREATE TABLE public.analysis_v2_result_summaries (
            request_id UUID PRIMARY KEY,
            target_instagram_id TEXT,
            plan_id TEXT,
            followers_declared INTEGER,
            following_declared INTEGER,
            public_mutuals INTEGER,
            screened_mutuals INTEGER,
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
    await db.exec(initialMigration);
    await db.exec(forwardMigration);
    await db.exec(v28FenceMigration);
    await db.exec(`
        INSERT INTO public.analysis_requests VALUES
        (
            '${PLUS_REQUEST}', 'plus_source', 'completed', 'v2', 'plus', 'production',
            '${PLUS_PREFLIGHT}', '2026-07-27T00:00:00Z', '${PLUS_POLICY}'
        ),
        (
            '${STANDARD_REQUEST}', 'standard_source', 'completed', 'v2', 'standard',
            'production', '${STANDARD_PREFLIGHT}', '2026-07-27T00:01:00Z',
            '${STANDARD_POLICY}'
        ),
        (
            '${INVALID_REQUEST}', 'invalid_source', 'completed', 'v2', 'plus',
            'production', '${INVALID_PREFLIGHT}', '2026-07-27T00:02:00Z',
            '${INVALID_POLICY}'
        ),
        (
            '${V28_REQUEST}', 'v28_source', 'completed', 'v2', 'standard',
            'production', '${V28_PREFLIGHT}', '2026-07-27T00:03:00Z',
            '${V28_POLICY}'
        );
        INSERT INTO public.analysis_preflights VALUES
        (
            '${PLUS_PREFLIGHT}', 'consumed', 'production', '${PLUS_REQUEST}',
            'plus_source', FALSE, '${PLUS_POLICY}', 'Plus Source', 'bio',
            'https://example.com/plus.jpg', 800, 800, '${STANDARD_CARDS}'
        ),
        (
            '${STANDARD_PREFLIGHT}', 'consumed', 'production', '${STANDARD_REQUEST}',
            'standard_source', FALSE, '${STANDARD_POLICY}', 'Standard Source', 'bio',
            'https://example.com/standard.jpg', 10, 20, '${STANDARD_CARDS}'
        ),
        (
            '${INVALID_PREFLIGHT}', 'consumed', 'production', '${INVALID_REQUEST}',
            'invalid_source', FALSE, '${INVALID_POLICY}', 'Invalid Source', 'bio',
            'https://example.com/invalid.jpg', 10, 20, '${STANDARD_CARDS}'
        ),
        (
            '${V28_PREFLIGHT}', 'consumed', 'production', '${V28_REQUEST}',
            'v28_source', FALSE, '${V28_POLICY}', 'V28 Source', 'bio',
            'https://example.com/v28.jpg', 10, 20, '${STANDARD_CARDS}'
        );
        INSERT INTO public.analysis_v2_result_summaries VALUES (
            '${PLUS_REQUEST}', 'plus_source', 'plus', 800, 800, 600, 600,
            'risk-policy-v2.2'
        );
    `);
});

afterAll(async () => db.close());

async function seedHistoricalPlusSource(input: {
    requestId: string;
    preflightId: string;
    target: string;
    followers?: number;
    following?: number;
    publicMutuals?: number;
    includeSummary?: boolean;
}) {
    const followers = input.followers ?? 800;
    const following = input.following ?? 800;
    await db.query(
        `INSERT INTO public.analysis_requests VALUES
        ($1, $2, 'completed', 'v2', 'plus', 'production', $3,
         '2026-07-27T01:00:00Z', $4::jsonb)`,
        [input.requestId, input.target, input.preflightId, PLUS_POLICY],
    );
    await db.query(
        `INSERT INTO public.analysis_preflights VALUES
        ($1, 'consumed', 'production', $2, $3, FALSE, $4::jsonb,
         'Plus Workload Source', 'bio', 'https://example.com/plus-workload.jpg',
         $5, $6, $7::jsonb)`,
        [
            input.preflightId,
            input.requestId,
            input.target,
            PLUS_POLICY,
            followers,
            following,
            STANDARD_CARDS,
        ],
    );
    if (input.includeSummary ?? true) {
        await db.query(
            `INSERT INTO public.analysis_v2_result_summaries VALUES
            ($1, $2, 'plus', $3, $4, $5, 600, 'risk-policy-v2.2')`,
            [
                input.requestId,
                input.target,
                followers,
                following,
                input.publicMutuals ?? 600,
            ],
        );
    }
}

async function expectWorkloadMismatch(target: string, requestId: string) {
    await db.exec('SET ROLE service_role');
    await expect(db.query(
        `SELECT public.read_analysis_v2_replay_capture_source($1, $2)`,
        [target, requestId],
    )).rejects.toThrow('ANALYSIS_V2_REPLAY_SOURCE_WORKLOAD_MISMATCH');
    await db.exec('RESET ROLE');
}

describe('read_analysis_v2_replay_capture_source lineage allowlist', () => {
    it.each([
        ['plus_source', PLUS_REQUEST, 'plus', 'ai-stage-policy-v2.4', 'risk-policy-v2.2'],
        ['standard_source', STANDARD_REQUEST, 'standard', 'ai-stage-policy-v2.7', 'risk-policy-v2.4'],
        ['v28_source', V28_REQUEST, 'standard', 'ai-stage-policy-v2.8', 'risk-policy-v2.4'],
    ])(
        'returns the exact supported %s source lineage',
        async (target, requestId, selectedPlanId, aiStage, risk) => {
            await db.exec('SET ROLE service_role');
            const result = await db.query<{ source: {
                selectedPlanId: string;
                policyVersions: { aiStage: string; risk: string };
            } }>(
                `SELECT public.read_analysis_v2_replay_capture_source(
                    '${target}', '${requestId}'
                ) AS source`,
            );
            await db.exec('RESET ROLE');
            expect(result.rows[0]?.source).toMatchObject({
                selectedPlanId,
                policyVersions: { aiStage, risk },
            });
        },
    );

    it('rejects an unlisted cross-product instead of broadening plan or policy support', async () => {
        await db.exec('SET ROLE service_role');
        await expect(db.query(
            `SELECT public.read_analysis_v2_replay_capture_source(
                'invalid_source', '${INVALID_REQUEST}'
            )`,
        )).rejects.toThrow('ANALYSIS_V2_REPLAY_SOURCE_NOT_FOUND');
        await db.exec('RESET ROLE');
    });

    it.each([
        [
            'v27_extra_drift',
            '10000000-0000-4000-8000-000000000008',
            '20000000-0000-4000-8000-000000000008',
            { pipeline: 'v2', risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.7', scheduler: 'ai-scheduler-v1', drift: 'x' },
        ],
        [
            'v28_missing_scheduler',
            '10000000-0000-4000-8000-000000000009',
            '20000000-0000-4000-8000-000000000009',
            { pipeline: 'v2', risk: 'risk-policy-v2.4', aiStage: 'ai-stage-policy-v2.8' },
        ],
    ] as const)(
        'rejects an exact-source policy with %s',
        async (target, requestId, preflightId, policy) => {
            await db.query(
                `INSERT INTO public.analysis_requests VALUES
                ($1, $2, 'completed', 'v2', 'standard', 'production', $3,
                 '2026-07-27T02:00:00Z', $4::JSONB)`,
                [requestId, target, preflightId, JSON.stringify(policy)],
            );
            await db.query(
                `INSERT INTO public.analysis_preflights VALUES
                ($1, 'consumed', 'production', $2, $3, FALSE, $4::JSONB,
                 'Drift Source', 'bio', 'https://example.com/drift.jpg',
                 10, 20, $5::JSONB)`,
                [preflightId, requestId, target, JSON.stringify(policy), STANDARD_CARDS],
            );
            await db.exec('SET ROLE service_role');
            await expect(db.query(
                'SELECT public.read_analysis_v2_replay_capture_source($1, $2)',
                [target, requestId],
            )).rejects.toThrow('ANALYSIS_V2_REPLAY_SOURCE_NOT_FOUND');
            await db.exec('RESET ROLE');
        },
    );

    it.each(['anon', 'authenticated'])('does not grant %s source RPC access', async role => {
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query(
            `SELECT public.read_analysis_v2_replay_capture_source(
                'standard_source', '${STANDARD_REQUEST}'
            )`,
        )).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });

    it('rejects historical Plus source counts above the immutable Standard capacity', async () => {
        const requestId = '10000000-0000-4000-8000-000000000004';
        const preflightId = '20000000-0000-4000-8000-000000000004';
        await seedHistoricalPlusSource({
            requestId,
            preflightId,
            target: 'capacity_overflow',
            followers: 801,
        });

        await expectWorkloadMismatch('capacity_overflow', requestId);
    });

    it('rejects historical Plus public workload above the immutable Standard detailed limit', async () => {
        const requestId = '10000000-0000-4000-8000-000000000005';
        const preflightId = '20000000-0000-4000-8000-000000000005';
        await seedHistoricalPlusSource({
            requestId,
            preflightId,
            target: 'public_overflow',
            publicMutuals: 601,
        });

        await expectWorkloadMismatch('public_overflow', requestId);
    });

    it('rejects historical Plus source when its completed result summary is missing', async () => {
        const requestId = '10000000-0000-4000-8000-000000000006';
        const preflightId = '20000000-0000-4000-8000-000000000006';
        await seedHistoricalPlusSource({
            requestId,
            preflightId,
            target: 'missing_summary',
            includeSummary: false,
        });

        await expectWorkloadMismatch('missing_summary', requestId);
    });
});
