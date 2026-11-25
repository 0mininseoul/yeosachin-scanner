import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { bootstrapStandardArchiveSource, createStandardArchiveDatabase } from './standard-archive-source';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const target = 'offline_target';
const profileBatches = Array.from({ length: 8 }, (_, i) => i);
function referenceArchive() {
    const entries = new Map<string, unknown>();
    function put(kind: string, parts: (string | number)[], value: unknown, pointer?: (string | number)[]) {
        const id = hash(JSON.stringify(parts));
        entries.set(kind + id, value);
        if (pointer) entries.set('capture-coverage-v1' + hash(JSON.stringify([kind, ...pointer])), id);
    }
    function proof(job: string, accounts: string[], family: string) {
        const providerInputHash = hash(job + '/input');
        put('source-profile-proof-v1', [target, job, ...accounts], {
            providerInputHash, providerOperationKey: family + ':' + hash(job),
        }, [job]);
    }
    function source(family: string, n: number) {
        return {
            status: 'collected', provider: 'apify', inputHash: hash('input/' + n),
            providerRunId: 'SealedRun' + n, providerOperationKey: family + ':' + hash('op/' + n),
        };
    }
    put('capture-summary-v1', [target], profileBatches);
    put('preflight-profile-v1', [target], { username: target, followersCount: 238, followingCount: 238, isPrivate: false });
    put('preflight-blite-policy-v1', [target], true);
    for (const [n, side] of ['followers', 'following'].entries()) {
        put('relationship-side-v1', [target, side, 238, 'standard'], source('relationship-' + side, n), [side]);
    }
    put('target-evidence-v1', [target, 'synthetic-key'], {
        likerSource: source('target-likers', 2),
        commentSource: source('target-comments', 3),
    }, []);
    proof('track:target-evidence:collect', [target], 'target-profile');
    for (const batch of profileBatches) {
        const names = Array.from({ length: batch === 7 ? 28 : 30 }, (_, i) => 'member_' + batch + '_' + i);
        put('candidate-profile-batch-v1', [target, batch, ...names], names.map(requestedUsername => ({
            outcome: { requestedUsername, source: 'apify' },
        })), [batch]);
        proof('track:profiles:batch:' + batch, names, 'profile-fallback');
    }
    return {
        entries,
        async readFragment({ kind, inputKey }: { kind: string; inputKey: string }) {
            const value = entries.get(kind + inputKey);
            return value === undefined ? null : { value };
        },
    };
}

it('rejects an unregistered database before opening sealed inputs', async () => {
    const db = await PGlite.create();
    const reader = { readFragment: vi.fn() };
    try {
        await expect(bootstrapStandardArchiveSource(db, { ownerId: randomUUID(), target, reader, profileBatches }))
            .rejects.toThrow('Unverified archive fixture database');
        expect(reader.readFragment).not.toHaveBeenCalled();
    } finally {
        await db.close();
    }
});

it('bootstraps eight authenticated profile groups and independent source lineage without a capture run', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('External network disabled'); });
    const db = await createStandardArchiveDatabase();
    try {
        const ownerId = randomUUID();
        const email = 'offline@example.invalid';
        await db.query(`INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,'{"provider":"kakao","analysis_test_runner_v1":"basic"}')`, [ownerId, email]);
        await db.query(`INSERT INTO auth.identities VALUES($1,'kakao',jsonb_build_object('email',$2::text,'email_verified',true))`, [ownerId, email]);
        await db.exec(`INSERT INTO account_ledger_rollout_state(singleton,paid_ever_state,classification_command_version,classification_completed_at)
            VALUES(true,'active','dev-live-basic-v1',now())`);
        await db.query("SELECT * FROM provision_e2e_test_runner_v1($1,$2,'basic','dev-live-basic-v1')", [ownerId, email]);
        await db.query(`INSERT INTO account_classification_audit(account_id,command_version,reason_code,previous_account_class,previous_traffic_class,
            previous_lifecycle,next_account_class,next_traffic_class,next_lifecycle)
            VALUES($1,'dev-live-basic-v1','DEV_LIVE_BASIC_TESTER','production','external','active','e2e_test','e2e_test','active')`, [ownerId]);
        await db.query('INSERT INTO dev_live_budget.standard_owner_policy(target_instagram_id) VALUES($1)', [target]);
        const reader = referenceArchive();
        const input = { ownerId, target, reader, profileBatches };
        const result = await bootstrapStandardArchiveSource(db, input);
        expect(result.receiptCount).toBe(13);
        expect((await db.query(`SELECT count(*)::int AS receipts,count(*) FILTER(WHERE job_key LIKE 'track:profiles:batch:%')::int AS profiles,
            sum(actual_usage_usd)::int AS spend FROM analysis_v2_provider_runs WHERE request_id=$1`, [result.requestId])).rows)
            .toEqual([{ receipts: 13, profiles: 8, spend: 0 }]);
        expect((await db.query(`SELECT p.status AS preflight,r.status AS request,p.precheckout_blite_cohort AS blite,
            (SELECT count(*)::int FROM analysis_v2_test_entitlement_consumptions WHERE request_id=r.id) AS consumed
            FROM analysis_requests r JOIN analysis_preflights p ON p.id=r.preflight_id WHERE r.id=$1`, [result.requestId])).rows)
            .toEqual([{ preflight: 'consumed', request: 'completed', blite: true, consumed: 1 }]);
        expect((await db.query('SELECT count(*)::int AS n FROM dev_live_budget.reservations')).rows).toEqual([{ n: 0 }]);
        reader.entries.delete('capture-coverage-v1' + hash(JSON.stringify(['candidate-profile-batch-v1', 7])));
        await expect(bootstrapStandardArchiveSource(db, input)).rejects.toThrow('sealed proofs');
        expect((await db.query('SELECT count(*)::int AS n FROM dev_live_budget.owner_starts')).rows).toEqual([{ n: 1 }]);
        const slotHash = hash('local fixture slot');
        const replay = await db.query<{ matches: boolean }>(`
            SELECT approval->'archiveReplay'->>'sourceGrantId'=$4::text
                AND approval->'archiveReplay'->>'slotHash'=$5 AS matches
            FROM public.dev_live_standard_archive_replay_start_v1($1,$2,$3,$4::uuid,$5) AS approval`,
        [ownerId, target, randomUUID(), result.grantId, slotHash]);
        expect(replay.rows).toEqual([{ matches: true }]);
    } finally {
        await db.close();
        vi.unstubAllGlobals();
    }
}, 60_000);
