import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260719120000_add_profile_provider_canary_journal.sql',
    import.meta.url
), 'utf8');

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const PREFLIGHT_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ONE = '44444444-4444-4444-8444-444444444444';
const RESERVATION_TWO = '55555555-5555-4555-8555-555555555555';
const CLAIM_TOKEN = '66666666-6666-4666-8666-666666666666';
const REPLAY_TOKEN = '77777777-7777-4777-8777-777777777777';
const RECLAIM_TOKEN = '88888888-8888-4888-8888-888888888888';
const RUN_ONE = 'ReplacementRun0001';
const RUN_TWO = 'ReplacementRun0002';
const HMAC = 'a'.repeat(64);
const NO_RUN_EVIDENCE = 'c'.repeat(64);
const SOURCE_PROOF = Object.freeze({
    sourceRunCount: 8,
    candidateCount: 15,
    uniqueCandidateCount: 15,
    publicCandidateCount: 15,
    incompleteCandidateCount: 15,
    unavailableCandidateCount: 0,
    primarySuccessCandidateCount: 0,
    criticalCandidateCount: 3,
});
type SourceProof = { [K in keyof typeof SOURCE_PROOF]: number };
const INVALID_SOURCE_PROOFS: Array<[string, Partial<SourceProof>]> = [
    ['seven source runs', { sourceRunCount: 7 }],
    ['fourteen candidates', { candidateCount: 14 }],
    ['sixteen candidates', { candidateCount: 16 }],
    ['one duplicate candidate', { uniqueCandidateCount: 14 }],
    ['one private candidate', { publicCandidateCount: 14 }],
    ['one non-incomplete candidate', { incompleteCandidateCount: 14 }],
    ['one unavailable candidate', { unavailableCandidateCount: 1 }],
    ['one primary success', { primarySuccessCandidateCount: 1 }],
    ['negative critical count', { criticalCandidateCount: -1 }],
];

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.users (id UUID PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    preflight_id UUID,
    target_instagram_id TEXT NOT NULL,
    pipeline_version TEXT,
    status TEXT NOT NULL,
    selected_plan_id_snapshot TEXT,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash TEXT
);
CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    entitlement_jti_hash TEXT NOT NULL,
    target_instagram_id TEXT NOT NULL,
    operation_slot_map JSONB NOT NULL
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    target_instagram_id TEXT NOT NULL,
    status TEXT NOT NULL,
    access_mode TEXT NOT NULL,
    consumed_request_id UUID REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE
);
ALTER TABLE public.analysis_requests ADD CONSTRAINT analysis_requests_preflight_id_fkey
    FOREIGN KEY (preflight_id) REFERENCES public.analysis_preflights(id) ON DELETE CASCADE;
CREATE TABLE public.analysis_v2_test_entitlement_consumptions (
    entitlement_jti_hash TEXT PRIMARY KEY,
    preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    request_id UUID NOT NULL UNIQUE REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    selected_plan_id TEXT NOT NULL
);
CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    PRIMARY KEY (request_id, job_key, operation_key)
);
`;

interface JsonRow<T> { result: T }
interface ExperimentJson {
    sourceRequestId: string;
    orderedSetHmac: string | null;
    sourceRunCount: number;
    candidateCount: number;
    uniqueCandidateCount: number;
    publicCandidateCount: number;
    incompleteCandidateCount: number;
    unavailableCandidateCount: number;
    primarySuccessCandidateCount: number;
    criticalCandidateCount: number;
    state: string;
    terminalReason: string | null;
    rep2ApprovalDeadlineAt: string | null;
    cleanupClaimToken: string | null;
    cleanupLeaseExpiresAt: string | null;
    sourceKvsCleanupState: string;
    sourceDatasetCleanupState: string;
    sourceRequestQueueCleanupState: string;
}
interface RunJson {
    repetition: number;
    state: string;
    runId: string | null;
    gatePassed: boolean | null;
    actualUsageUsd: number | null;
    restrictedAccessVerified: boolean;
    costStatus: string;
    cleanupCompletedAt: string | null;
}
interface ReservationJson {
    created: boolean;
    experiment: ExperimentJson;
    run: RunJson;
}

let db: PGlite;

async function serviceQuery<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function seedSource(overrides: { policyTarget?: string; runCount?: number } = {}) {
    await db.query(`INSERT INTO public.users VALUES ($1, 'operator@example.test')`, [OWNER_ID]);
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, access_mode,
            consumed_request_id, pii_scrubbed_at
         ) VALUES ($1, $2, 'retained.33333333333343338333',
            'consumed', 'test_entitlement', NULL, pg_catalog.clock_timestamp())`,
        [PREFLIGHT_ID, OWNER_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, preflight_id, target_instagram_id, pipeline_version,
            status, selected_plan_id_snapshot, plan_access_mode_snapshot,
            test_entitlement_jti_hash
         ) VALUES ($1, $2, $3, 'retained.22222222222242228222',
            'v2', 'failed', 'standard', 'test_entitlement', $4)`,
        [SOURCE_REQUEST_ID, OWNER_ID, PREFLIGHT_ID, 'e'.repeat(64)]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $1 WHERE id = $2`,
        [SOURCE_REQUEST_ID, PREFLIGHT_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_execution_policies (
            request_id, mode, policy_version, entitlement_jti_hash,
            target_instagram_id, operation_slot_map
         ) VALUES ($1, 'test_operation_split', 'authorized-free-e2e-v1',
            $2, $3, '{"profile-fallback":"tertiary"}'::JSONB)`,
        [SOURCE_REQUEST_ID, 'e'.repeat(64), overrides.policyTarget ?? '0_min._.00']
    );
    await db.query(
        `INSERT INTO public.analysis_v2_test_entitlement_consumptions (
            entitlement_jti_hash, preflight_id, request_id, user_id, selected_plan_id
         ) VALUES ($1, $2, $3, $4, 'standard')`,
        ['e'.repeat(64), PREFLIGHT_ID, SOURCE_REQUEST_ID, OWNER_ID]
    );
    for (let index = 0; index < (overrides.runCount ?? 8); index++) {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, status, run_id,
                actor_id, credential_slot, max_charge_usd
             ) VALUES ($1, $2, $3, 'succeeded', $4,
                'apify/instagram-profile-scraper', 'tertiary', 0.078)`,
            [
                SOURCE_REQUEST_ID,
                `track:profiles:batch:${index}`,
                `profile-fallback:${String(index).repeat(64)}`,
                `SourceRun${String(index).padStart(8, '0')}`,
            ]
        );
    }
}

async function reserve(
    repetition: 1 | 2,
    token: string,
    hmac = HMAC,
    proofOverrides: Partial<SourceProof> = {}
) {
    const proof = { ...SOURCE_PROOF, ...proofOverrides };
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_profile_provider_canary_run(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12
        ) AS result`,
        [
            SOURCE_REQUEST_ID, repetition,
            proof.sourceRunCount, proof.candidateCount, proof.uniqueCandidateCount,
            proof.publicCandidateCount, proof.incompleteCandidateCount,
            proof.unavailableCandidateCount, proof.primarySuccessCandidateCount,
            proof.criticalCandidateCount, hmac, token,
        ]
    );
    return result.rows[0].result;
}

async function resolveNoRun(
    repetition: 1 | 2,
    reservationToken: string,
    evidence = NO_RUN_EVIDENCE
): Promise<RunJson> {
    await serviceQuery(
        `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
            $1, $2, $3
        )`,
        [SOURCE_REQUEST_ID, repetition, reservationToken]
    );
    const resolved = await db.query<JsonRow<RunJson>>(
        `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
            $1, $2, $3, $4
        ) AS result`,
        [SOURCE_REQUEST_ID, repetition, reservationToken, evidence]
    );
    return resolved.rows[0].result;
}

async function finishFirstRun(): Promise<void> {
    await finishRun(1, RESERVATION_ONE, RUN_ONE);
}

async function finishRun(
    repetition: 1 | 2,
    reservationToken: string,
    runId: string,
    counts: { success: number; unavailable: number; critical: number } = {
        success: 15, unavailable: 0, critical: 3,
    },
    actualUsageUsd = 0.04,
    restrictedAccessVerified = true
): Promise<void> {
    await serviceQuery(
        `SELECT public.checkpoint_analysis_v2_profile_provider_canary_run_started(
            $1, $2, $3, $4
        )`,
        [SOURCE_REQUEST_ID, repetition, reservationToken, runId]
    );
    await serviceQuery(
        `SELECT public.terminalize_analysis_v2_profile_provider_canary_run(
            $1, $2, $3, $4, 15, $5, $6, 0, 0, $7, 40000, TRUE, $8
        )`,
        [
            SOURCE_REQUEST_ID, repetition, reservationToken, runId,
            counts.success, counts.unavailable, counts.critical, restrictedAccessVerified,
        ]
    );
    await serviceQuery(
        `SELECT public.reconcile_analysis_v2_profile_provider_canary_run_usage(
            $1, $2, $3, $4, $5
        )`,
        [SOURCE_REQUEST_ID, repetition, reservationToken, runId, actualUsageUsd]
    );
    for (const storage of ['kvs', 'dataset', 'request_queue']) {
        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_run_storage_clean(
                $1, $2, $3, $4, $5
            )`,
            [SOURCE_REQUEST_ID, repetition, reservationToken, runId, storage]
        );
    }
}

async function markSourceCleanupAndComplete(claimToken: string): Promise<ExperimentJson> {
    for (const storage of ['kvs', 'dataset', 'request_queue']) {
        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_source_storage_clean(
                $1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, claimToken, storage]
        );
    }
    const completed = await serviceQuery<JsonRow<ExperimentJson>>(
        `SELECT public.complete_analysis_v2_profile_provider_canary_cleanup(
            $1, $2
        ) AS result`,
        [SOURCE_REQUEST_ID, claimToken]
    );
    return completed.rows[0].result;
}

type RecoverableTerminalReason = 'strict_failure' | 'completed' | 'aborted_by_operator';

async function prepareRecoverableTerminalization(
    reason: RecoverableTerminalReason
): Promise<number> {
    await seedSource();
    await reserve(1, RESERVATION_ONE);
    if (reason === 'strict_failure') {
        await finishRun(1, RESERVATION_ONE, RUN_ONE, {
            success: 14, unavailable: 1, critical: 3,
        });
    } else {
        await finishFirstRun();
        if (reason === 'completed') {
            await reserve(2, RESERVATION_TWO);
            await finishRun(2, RESERVATION_TWO, RUN_TWO);
        }
    }
    await serviceQuery(
        `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
            $1, $2, $3
        )`,
        [SOURCE_REQUEST_ID, reason, CLAIM_TOKEN]
    );
    await serviceQuery(
        `SELECT public.mark_analysis_v2_profile_provider_canary_source_storage_clean(
            $1, $2, 'kvs'
        )`,
        [SOURCE_REQUEST_ID, CLAIM_TOKEN]
    );
    await db.query(
        `UPDATE public.analysis_v2_profile_provider_canary_experiments
         SET created_at = pg_catalog.clock_timestamp() - INTERVAL '20 minutes',
             cleanup_claimed_at = pg_catalog.clock_timestamp() - INTERVAL '11 minutes',
             cleanup_lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
         WHERE source_request_id = $1`,
        [SOURCE_REQUEST_ID]
    );
    const runs = await db.query<{ count: number }>(
        `SELECT pg_catalog.count(*)::INTEGER AS count
         FROM public.analysis_v2_profile_provider_canary_runs`
    );
    return runs.rows[0].count;
}

describe('profile provider replacement canary journal PGlite', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`TRUNCATE
            public.analysis_v2_profile_provider_canary_runs,
            public.analysis_v2_profile_provider_canary_experiments,
            public.analysis_v2_provider_runs,
            public.analysis_v2_test_entitlement_consumptions,
            public.analysis_v2_provider_execution_policies,
            public.analysis_preflights,
            public.analysis_requests,
            public.users`);
    });

    afterAll(async () => db.close());

    it('loads only the exact authorized source with eight terminal source runs', async () => {
        await seedSource();
        const loaded = await serviceQuery<JsonRow<{ runs: unknown[] }>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_source(
                $1, $2, 'operator@example.test'
            ) AS result`,
            [SOURCE_REQUEST_ID, OWNER_ID]
        );
        expect(loaded.rows[0].result.runs).toHaveLength(8);

        await db.exec(`TRUNCATE public.analysis_v2_profile_provider_canary_runs,
            public.analysis_v2_profile_provider_canary_experiments,
            public.analysis_v2_provider_runs,
            public.analysis_v2_test_entitlement_consumptions,
            public.analysis_v2_provider_execution_policies,
            public.analysis_preflights,
            public.analysis_requests,
            public.users`);
        await seedSource({ policyTarget: 'wrong.target' });
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_profile_provider_canary_source(
                $1, $2, 'operator@example.test'
            )`,
            [SOURCE_REQUEST_ID, OWNER_ID]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_SOURCE_NOT_FOUND');
    });

    it.each(INVALID_SOURCE_PROOFS)(
        'rejects app replay proof with %s before either journal row is written',
        async (_caseName, proofOverrides) => {
            await seedSource();

            await expect(reserve(
                1, RESERVATION_ONE, HMAC, proofOverrides
            )).rejects.toThrow('PROFILE_PROVIDER_CANARY_RUN_INVALID');
            const counts = await db.query<{ experiments: number; runs: number }>(
                `SELECT
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_v2_profile_provider_canary_experiments) AS experiments,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_v2_profile_provider_canary_runs) AS runs`
            );
            expect(counts.rows[0]).toEqual({ experiments: 0, runs: 0 });
        }
    );

    it.each(['job_key', 'run_id'] as const)(
        'rechecks eight distinct source %s values at reservation time',
        async column => {
            await seedSource();
            await db.query(
                `UPDATE public.analysis_v2_provider_runs
                 SET ${column} = (
                    SELECT ${column} FROM public.analysis_v2_provider_runs
                    WHERE request_id = $1 AND job_key = 'track:profiles:batch:0'
                 )
                 WHERE request_id = $1 AND job_key = 'track:profiles:batch:7'`,
                [SOURCE_REQUEST_ID]
            );

            await expect(reserve(1, RESERVATION_ONE)).rejects.toThrow(
                'PROFILE_PROVIDER_CANARY_RUN_NOT_FOUND'
            );
        }
    );

    it('requires actual cost and all three storage verifications before repetition two', async () => {
        await seedSource();
        expect(await reserve(1, RESERVATION_ONE)).toMatchObject({
            created: true,
            experiment: SOURCE_PROOF,
            run: { repetition: 1, state: 'starting' },
        });
        await expect(reserve(2, RESERVATION_TWO)).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT'
        );
        await finishFirstRun();
        await expect(reserve(2, RESERVATION_TWO, 'b'.repeat(64))).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_RUN_HMAC_CONFLICT'
        );
        await expect(reserve(2, RESERVATION_TWO)).resolves.toMatchObject({
            created: true,
            experiment: {
                state: 'active',
                rep2ApprovalDeadlineAt: null,
            },
            run: { repetition: 2, state: 'starting' },
        });
        await expect(reserve(2, REPLAY_TOKEN)).resolves.toMatchObject({
            created: false,
            run: { repetition: 2, state: 'starting' },
        });
    });

    it('keeps ambiguous adoption and verified absence database-owner-only', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
                $1, 1, $2
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE]
        );
        await expect(serviceQuery(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                $1, 1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, 'c'.repeat(64)]
        )).rejects.toThrow(/permission denied/i);

        const adopted = await db.query<JsonRow<RunJson>>(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_adopt_run(
                $1, 1, $2, $3, 'apify/instagram-scraper', '0.0.692',
                'primary', pg_catalog.clock_timestamp(), $4, $5
            ) AS result`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE, HMAC, 'd'.repeat(64)]
        );
        expect(adopted.rows[0].result).toMatchObject({
            state: 'running', runId: RUN_ONE,
        });
    });

    it.each([
        ['accepts', "INTERVAL '1 minute'", true],
        ['rejects', "INTERVAL '1 minute 1 millisecond'", false],
    ] as const)(
        '%s owner adoption at the ambiguity upper-fence boundary',
        async (_caseName, upperFenceOffset, shouldAdopt) => {
            await seedSource();
            await reserve(1, RESERVATION_ONE);
            await serviceQuery(
                `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
                    $1, 1, $2
                )`,
                [SOURCE_REQUEST_ID, RESERVATION_ONE]
            );
            await db.query(
                `UPDATE public.analysis_v2_profile_provider_canary_runs
                 SET reserved_at = pg_catalog.clock_timestamp() - INTERVAL '10 minutes',
                     ambiguous_at = pg_catalog.clock_timestamp() - INTERVAL '5 minutes',
                     updated_at = pg_catalog.clock_timestamp()
                 WHERE source_request_id = $1 AND repetition = 1`,
                [SOURCE_REQUEST_ID]
            );

            const adoption = db.query<JsonRow<RunJson>>(
                `SELECT public.resolve_analysis_v2_profile_provider_canary_adopt_run(
                    $1, 1, $2, $3, 'apify/instagram-scraper', '0.0.692',
                    'primary', (
                        SELECT ambiguous_at + ${upperFenceOffset}
                        FROM public.analysis_v2_profile_provider_canary_runs
                        WHERE source_request_id = $1 AND repetition = 1
                    ), $4, $5
                ) AS result`,
                [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE, HMAC, 'd'.repeat(64)]
            );

            if (shouldAdopt) {
                await expect(adoption).resolves.toMatchObject({
                    rows: [expect.objectContaining({
                        result: expect.objectContaining({ state: 'running', runId: RUN_ONE }),
                    })],
                });
            } else {
                await expect(adoption).rejects.toThrow(
                    'PROFILE_PROVIDER_CANARY_RESOLUTION_IDENTITY_CONFLICT'
                );
                const unchanged = await serviceQuery<JsonRow<RunJson>>(
                    `SELECT public.load_analysis_v2_profile_provider_canary_run($1, 1) AS result`,
                    [SOURCE_REQUEST_ID]
                );
                expect(unchanged.rows[0].result.state).toBe('ambiguous');
            }
        }
    );

    it.each([1, 2] as const)(
        'atomically hands repetition %s verified-no-run to immediate cleanup and retries idempotently',
        async repetition => {
            await seedSource();
            await reserve(1, RESERVATION_ONE);
            if (repetition === 2) {
                await finishFirstRun();
                await reserve(2, RESERVATION_TWO);
            }
            const reservationToken = repetition === 1 ? RESERVATION_ONE : RESERVATION_TWO;
            const runCountBefore = await db.query<{ count: number }>(
                `SELECT pg_catalog.count(*)::INTEGER AS count
                 FROM public.analysis_v2_profile_provider_canary_runs`
            );

            await expect(resolveNoRun(repetition, reservationToken)).resolves.toMatchObject({
                repetition, state: 'verified_no_run', runId: null,
            });
            const handedOff = await serviceQuery<JsonRow<ExperimentJson>>(
                `SELECT public.load_analysis_v2_profile_provider_canary_experiment($1) AS result`,
                [SOURCE_REQUEST_ID]
            );
            expect(handedOff.rows[0].result).toMatchObject({
                state: 'terminalizing',
                terminalReason: 'verified_no_run',
                cleanupClaimToken: reservationToken,
                orderedSetHmac: HMAC,
            });
            expect(Date.parse(handedOff.rows[0].result.cleanupLeaseExpiresAt!))
                .toBeLessThanOrEqual(Date.now());

            await expect(db.query<JsonRow<RunJson>>(
                `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                    $1, $2, $3, $4
                ) AS result`,
                [SOURCE_REQUEST_ID, repetition, reservationToken, NO_RUN_EVIDENCE]
            )).resolves.toMatchObject({
                rows: [expect.objectContaining({
                    result: expect.objectContaining({ state: 'verified_no_run' }),
                })],
            });
            await expect(db.query(
                `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                    $1, $2, $3, $4
                )`,
                [SOURCE_REQUEST_ID, repetition, reservationToken, 'f'.repeat(64)]
            )).rejects.toThrow('PROFILE_PROVIDER_CANARY_RESOLUTION_CONFLICT');

            const claimed = await serviceQuery<JsonRow<ExperimentJson[]>>(
                `SELECT public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
                    4, $1
                ) AS result`,
                [RECLAIM_TOKEN]
            );
            expect(claimed.rows[0].result).toEqual([
                expect.objectContaining({
                    state: 'terminalizing',
                    terminalReason: 'verified_no_run',
                    cleanupClaimToken: RECLAIM_TOKEN,
                }),
            ]);
            const inventory = await serviceQuery<JsonRow<{
                sourceRuns: unknown[];
                canaryRuns: unknown[];
            }>>(
                `SELECT public.load_analysis_v2_profile_provider_canary_cleanup_inventory(
                    $1, $2
                ) AS result`,
                [SOURCE_REQUEST_ID, RECLAIM_TOKEN]
            );
            expect(inventory.rows[0].result.sourceRuns).toHaveLength(8);
            expect(inventory.rows[0].result.canaryRuns).toHaveLength(repetition === 1 ? 0 : 1);

            const completed = await markSourceCleanupAndComplete(RECLAIM_TOKEN);
            expect(completed).toMatchObject({
                state: 'experiment_terminal',
                terminalReason: 'verified_no_run',
                orderedSetHmac: null,
            });
            await expect(db.query<JsonRow<RunJson>>(
                `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                    $1, $2, $3, $4
                ) AS result`,
                [SOURCE_REQUEST_ID, repetition, reservationToken, NO_RUN_EVIDENCE]
            )).resolves.toMatchObject({
                rows: [expect.objectContaining({
                    result: expect.objectContaining({ state: 'verified_no_run' }),
                })],
            });
            const runDelta = await db.query<{ count: number; started: number }>(
                `SELECT pg_catalog.count(*)::INTEGER AS count,
                    pg_catalog.count(run_id)::INTEGER AS started
                 FROM public.analysis_v2_profile_provider_canary_runs`
            );
            expect(runDelta.rows[0].count).toBe(runCountBefore.rows[0].count);
            expect(runDelta.rows[0].started).toBe(repetition === 1 ? 0 : 1);
        }
    );

    it('fails closed when no-run resolution sees a non-ambiguous run or non-active experiment', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await expect(db.query(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                $1, 1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, NO_RUN_EVIDENCE]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT');

        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
                $1, 1, $2
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE]
        );
        await db.query(
            `UPDATE public.analysis_v2_profile_provider_canary_experiments
             SET state = 'awaiting_repetition_2',
                 rep2_approval_deadline_at = pg_catalog.clock_timestamp() + INTERVAL '1 hour'
             WHERE source_request_id = $1`,
            [SOURCE_REQUEST_ID]
        );
        await expect(db.query(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                $1, 1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, NO_RUN_EVIDENCE]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_RESOLUTION_STATE_CONFLICT');
        const unchanged = await serviceQuery<JsonRow<RunJson>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_run($1, 1) AS result`,
            [SOURCE_REQUEST_ID]
        );
        expect(unchanged.rows[0].result.state).toBe('ambiguous');
    });

    it('cleans and terminalizes an owner-adopted run that fails the strict gate', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
                $1, 1, $2
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE]
        );
        await db.query(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_adopt_run(
                $1, 1, $2, $3, 'apify/instagram-scraper', '0.0.692',
                'primary', pg_catalog.clock_timestamp(), $4, $5
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE, HMAC, 'd'.repeat(64)]
        );

        await finishRun(1, RESERVATION_ONE, RUN_ONE, {
            success: 14, unavailable: 1, critical: 3,
        });
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'strict_failure', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'strict_failure', orderedSetHmac: null,
        });
    });

    it('claims an expired repetition-two wait once without reserving repetition two', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishFirstRun();
        await db.query(
            `UPDATE public.analysis_v2_profile_provider_canary_experiments
             SET created_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours',
                 rep2_approval_deadline_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
             WHERE source_request_id = $1`,
            [SOURCE_REQUEST_ID]
        );

        const first = await serviceQuery<JsonRow<ExperimentJson[]>>(
            `SELECT public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
                4, $1
            ) AS result`,
            [CLAIM_TOKEN]
        );
        const second = await serviceQuery<JsonRow<ExperimentJson[]>>(
            `SELECT public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
                4, $1
            ) AS result`,
            ['88888888-8888-4888-8888-888888888888']
        );
        expect(first.rows[0].result).toEqual([
            expect.objectContaining({
                terminalReason: 'expired_waiting_for_repetition',
                cleanupClaimToken: CLAIM_TOKEN,
            }),
        ]);
        expect(second.rows[0].result).toEqual([]);
        const rep2 = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_profile_provider_canary_runs
             WHERE repetition = 2`
        );
        expect(rep2.rows[0].count).toBe(0);
    });

    it('fails closed when cleanup inventory no longer has the exact eight source runs', async () => {
        await prepareRecoverableTerminalization('strict_failure');
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET status = 'failed'
             WHERE request_id = $1 AND job_key = 'track:profiles:batch:7'`,
            [SOURCE_REQUEST_ID]
        );

        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_profile_provider_canary_cleanup_inventory(
                $1, $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CLEANUP_INVENTORY_INVALID');
    });

    it.each([
        'strict_failure', 'completed', 'aborted_by_operator',
    ] as const)(
        'reclaims expired %s partial source cleanup without changing reason or starting a run',
        async reason => {
            const runCountBefore = await prepareRecoverableTerminalization(reason);

            const reclaimed = await serviceQuery<JsonRow<ExperimentJson[]>>(
                `SELECT public.claim_expired_analysis_v2_profile_provider_canary_cleanup(
                    4, $1
                ) AS result`,
                [RECLAIM_TOKEN]
            );

            expect(reclaimed.rows[0].result).toEqual([
                expect.objectContaining({
                    state: 'terminalizing',
                    terminalReason: reason,
                    cleanupClaimToken: RECLAIM_TOKEN,
                    sourceKvsCleanupState: 'verified_absent',
                    sourceDatasetCleanupState: 'pending',
                    sourceRequestQueueCleanupState: 'pending',
                }),
            ]);
            const runs = await db.query<{ count: number }>(
                `SELECT pg_catalog.count(*)::INTEGER AS count
                 FROM public.analysis_v2_profile_provider_canary_runs`
            );
            expect(runs.rows[0].count).toBe(runCountBefore);
            await expect(markSourceCleanupAndComplete(RECLAIM_TOKEN)).resolves.toMatchObject({
                state: 'experiment_terminal', terminalReason: reason, orderedSetHmac: null,
            });
        }
    );

    it('records bounded actual usage above max charge, fails the gate, and still cleans', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishRun(1, RESERVATION_ONE, RUN_ONE, undefined, 0.2);
        const stored = await serviceQuery<JsonRow<RunJson>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_run($1, 1) AS result`,
            [SOURCE_REQUEST_ID]
        );
        expect(stored.rows[0].result).toMatchObject({
            state: 'succeeded', actualUsageUsd: 0.2,
            costStatus: 'actual', gatePassed: false, cleanupCompletedAt: expect.any(String),
        });
        await expect(reserve(2, RESERVATION_TWO)).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT'
        );
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'strict_failure', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'strict_failure', orderedSetHmac: null,
        });
    });

    it('persists false terminal access evidence, blocks repetition two, and still cleans', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishRun(1, RESERVATION_ONE, RUN_ONE, undefined, 0.04, false);
        const stored = await serviceQuery<JsonRow<RunJson>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_run($1, 1) AS result`,
            [SOURCE_REQUEST_ID]
        );
        expect(stored.rows[0].result).toMatchObject({
            state: 'succeeded',
            restrictedAccessVerified: false,
            actualUsageUsd: 0.04,
            gatePassed: false,
            cleanupCompletedAt: expect.any(String),
        });
        await expect(reserve(2, RESERVATION_TWO)).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT'
        );
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'strict_failure', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'strict_failure', orderedSetHmac: null,
        });
    });

    it('rejects observed actual usage above the incident bound without blocking later cleanup', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await serviceQuery(
            `SELECT public.checkpoint_analysis_v2_profile_provider_canary_run_started(
                $1, 1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE]
        );
        await serviceQuery(
            `SELECT public.terminalize_analysis_v2_profile_provider_canary_run(
                $1, 1, $2, $3, 15, 15, 0, 0, 0, 3, 40000, TRUE, TRUE
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE]
        );
        await expect(serviceQuery(
            `SELECT public.reconcile_analysis_v2_profile_provider_canary_run_usage(
                $1, 1, $2, $3, 1.01
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_RUN_INVALID');
        await serviceQuery(
            `SELECT public.reconcile_analysis_v2_profile_provider_canary_run_usage(
                $1, 1, $2, $3, 1.0
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE]
        );
        for (const storage of ['kvs', 'dataset', 'request_queue']) {
            await serviceQuery(
                `SELECT public.mark_analysis_v2_profile_provider_canary_run_storage_clean(
                    $1, 1, $2, $3, $4
                )`,
                [SOURCE_REQUEST_ID, RESERVATION_ONE, RUN_ONE, storage]
            );
        }
        const stored = await serviceQuery<JsonRow<RunJson>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_run($1, 1) AS result`,
            [SOURCE_REQUEST_ID]
        );
        expect(stored.rows[0].result).toMatchObject({
            actualUsageUsd: 1, costStatus: 'actual', gatePassed: false,
        });
    });

    it('terminalizes a strict repetition-one failure without creating repetition two', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishRun(1, RESERVATION_ONE, RUN_ONE, {
            success: 14, unavailable: 1, critical: 3,
        });
        await expect(reserve(2, RESERVATION_TWO)).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_RUN_STATE_CONFLICT'
        );
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'strict_failure', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'strict_failure', orderedSetHmac: null,
        });
    });

    it('terminalizes only after two successful exact repetitions and source cleanup', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishFirstRun();
        await reserve(2, RESERVATION_TWO);
        await finishRun(2, RESERVATION_TWO, RUN_TWO);
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'completed', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'completed', orderedSetHmac: null,
        });
        await expect(serviceQuery<JsonRow<ExperimentJson>>(
            `SELECT public.complete_analysis_v2_profile_provider_canary_cleanup(
                $1, $2
            ) AS result`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({
                result: expect.objectContaining({
                    state: 'experiment_terminal', terminalReason: 'completed', orderedSetHmac: null,
                }),
            })],
        });
    });

    it('allows cleanup-only operator abandonment after repetition one and starts no repetition two', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await finishFirstRun();
        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'aborted_by_operator', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        const rep2 = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_profile_provider_canary_runs WHERE repetition = 2`
        );
        expect(rep2.rows[0].count).toBe(0);
        await expect(markSourceCleanupAndComplete(CLAIM_TOKEN)).resolves.toMatchObject({
            state: 'experiment_terminal', terminalReason: 'aborted_by_operator',
        });
    });

    it('clears the HMAC only after terminal source cleanup is fully verified', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await serviceQuery(
            `SELECT public.mark_analysis_v2_profile_provider_canary_run_ambiguous(
                $1, 1, $2
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE]
        );
        await db.query(
            `SELECT public.resolve_analysis_v2_profile_provider_canary_no_run(
                $1, 1, $2, $3
            )`,
            [SOURCE_REQUEST_ID, RESERVATION_ONE, 'c'.repeat(64)]
        );
        await expect(serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'completed', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT');
        await expect(serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'expired_waiting_for_repetition', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT');
        await expect(serviceQuery(
            `SELECT public.complete_analysis_v2_profile_provider_canary_cleanup($1, $2)`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CLEANUP_IDENTITY_CONFLICT');

        await serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'verified_no_run', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        );
        const completed = await markSourceCleanupAndComplete(CLAIM_TOKEN);
        expect(completed).toMatchObject({
            state: 'experiment_terminal',
            orderedSetHmac: null,
        });
    });

    it('never reclassifies an expired terminalizing experiment to a different reason', async () => {
        await seedSource();
        await reserve(1, RESERVATION_ONE);
        await resolveNoRun(1, RESERVATION_ONE);

        await expect(serviceQuery(
            `SELECT public.begin_analysis_v2_profile_provider_canary_terminalization(
                $1, 'strict_failure', $2
            )`,
            [SOURCE_REQUEST_ID, CLAIM_TOKEN]
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CLEANUP_STATE_CONFLICT');

        const unchanged = await serviceQuery<JsonRow<ExperimentJson>>(
            `SELECT public.load_analysis_v2_profile_provider_canary_experiment($1) AS result`,
            [SOURCE_REQUEST_ID]
        );
        expect(unchanged.rows[0].result).toMatchObject({
            state: 'terminalizing',
            terminalReason: 'verified_no_run',
            cleanupClaimToken: RESERVATION_ONE,
        });
    });

    it('denies both tables and all service RPCs to user roles', async () => {
        await seedSource();
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`SET ROLE ${role}`);
            try {
                await expect(db.query(
                    'SELECT * FROM public.analysis_v2_profile_provider_canary_experiments'
                )).rejects.toThrow(/permission denied/i);
                await expect(db.query(
                    `SELECT public.reserve_analysis_v2_profile_provider_canary_run(
                        $1, 1, 8, 15, 15, 15, 15, 0, 0, 3, $2, TRUE, $3
                    )`,
                    [SOURCE_REQUEST_ID, HMAC, RESERVATION_ONE]
                )).rejects.toThrow(/permission denied/i);
            } finally {
                await db.exec('RESET ROLE');
            }
        }
    });
});
