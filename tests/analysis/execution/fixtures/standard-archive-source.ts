import { createHash, randomUUID } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { z } from 'zod';
import {
    buildReadyPreflightSnapshot, currentPreflightCatalogSnapshot, launchStatusSnapshot, preflightPolicyVersions,
} from '@/lib/services/analysis/preflight';
import { APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { APIFY_LIKERS_ACTOR_ID, APIFY_COMMENTS_ACTOR_ID } from '@/lib/services/instagram/providers/apify-interactions';

type SealedReader = {
    readFragment(input: { kind: string; inputKey: string }): Promise<{ value: unknown } | null>;
};
type BootstrapInput = {
    ownerId: string;
    target: string;
    reader: SealedReader;
    profileBatches: readonly number[];
};
type Receipt = {
    job: string;
    track: 'relationships' | 'target_evidence' | 'profiles';
    batch: number | null;
    operation: string;
    inputHash: string;
    run: string;
    actor: string;
};

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const collected = z.object({
    status: z.literal('collected'), provider: z.literal('apify'),
    inputHash: hash, providerRunId: z.string().regex(/^[A-Za-z0-9]{8,64}$/), providerOperationKey: z.string(),
});
const empty = z.object({
    status: z.literal('not_applicable'), inputHash: hash,
    provider: z.null(), providerRunId: z.null(), providerOperationKey: z.null(),
});
const evidence = z.discriminatedUnion('status', [collected, empty]);
const proof = z.object({ providerInputHash: hash, providerOperationKey: z.string() }).strict();
const preflightProfile = z.object({
    username: z.string(), followersCount: z.number().int().nonnegative(),
    followingCount: z.number().int().nonnegative(), isPrivate: z.literal(false),
});
const profileRows = z.array(z.object({
    outcome: z.object({ requestedUsername: z.string(), source: z.literal('apify') }),
})).min(1).max(32);

function digest(value: string) {
    return createHash('sha256').update(value).digest('hex');
}
function identity(parts: readonly (string | number)[]) {
    return digest(JSON.stringify(parts));
}
function invalid(): never {
    throw new Error('Invalid sealed Standard fixture source');
}
async function fragment(reader: SealedReader, kind: string, inputKey: string) {
    const record = await reader.readFragment({ kind, inputKey });
    return record ? record.value : invalid();
}
async function pointed(reader: SealedReader, kind: string, ordinal?: string | number) {
    const pointer = hash.safeParse(await fragment(reader, 'capture-coverage-v1',
        identity(ordinal === undefined ? [kind] : [kind, ordinal])));
    if (!pointer.success) return invalid();
    return { value: await fragment(reader, kind, pointer.data), inputKey: pointer.data };
}
function exactOperation(operation: string, family: string) {
    const [prefix, key, extra] = operation.split(':');
    if (prefix !== family || !hash.safeParse(key).success || extra !== undefined) invalid();
    return operation;
}

// Only proof fields survive this projection. No source owner, request, run accounting or live credential is imported.
async function readSource(input: BootstrapInput) {
    const { target, reader, profileBatches } = input;
    const batches = z.array(z.number().int()).max(32).parse(await fragment(reader, 'capture-summary-v1', identity([target])));
    if (batches.length !== profileBatches.length ||
        batches.some((batch, i) => batch !== i || batch !== profileBatches[i])) invalid();
    const profile = preflightProfile.parse(await fragment(reader, 'preflight-profile-v1', identity([target])));
    if (profile.username !== target) invalid();
    const blite = z.boolean().parse(await fragment(reader, 'preflight-blite-policy-v1', identity([target])));
    const receipts: Receipt[] = [];
    const targetJob = 'track:target-evidence:collect';
    const relationshipJob = 'track:relationships:collect';
    function addEvidence(value: unknown, family: string, actor: string, track: 'relationships' | 'target_evidence') {
        const src = evidence.parse(value);
        if (src.status === 'not_applicable') return;
        receipts.push({
            job: track === 'relationships' ? relationshipJob : targetJob, track, batch: null, actor,
            operation: exactOperation(src.providerOperationKey, family), inputHash: src.inputHash, run: src.providerRunId,
        });
    }
    for (const side of ['followers', 'following'] as const) {
        const data = await pointed(reader, 'relationship-side-v1', side);
        addEvidence(data.value, 'relationship-' + side, APIFY_RELATIONSHIP_ACTOR_ID, 'relationships');
    }
    const sources = z.object({ likerSource: evidence, commentSource: evidence }).parse(
        (await pointed(reader, 'target-evidence-v1')).value,
    );
    addEvidence(sources.likerSource, 'target-likers', APIFY_LIKERS_ACTOR_ID, 'target_evidence');
    addEvidence(sources.commentSource, 'target-comments', APIFY_COMMENTS_ACTOR_ID, 'target_evidence');
    async function addProfile(batch: number | null, usernames: string[]) {
        const job = batch === null ? targetJob : 'track:profiles:batch:' + batch;
        const data = await pointed(reader, 'source-profile-proof-v1', job);
        if (data.inputKey !== identity([target, job, ...usernames])) invalid();
        const src = proof.parse(data.value);
        receipts.push({
            job, track: batch === null ? 'target_evidence' : 'profiles', batch, actor: 'apify/instagram-profile-scraper',
            operation: exactOperation(src.providerOperationKey, batch === null ? 'target-profile' : 'profile-fallback'),
            // The profile proof binds operation + input hash. No external Actor run identifier is stored for these proofs.
            run: randomUUID().replaceAll('-', ''), inputHash: src.providerInputHash,
        });
    }
    await addProfile(null, [target]);
    for (const batch of batches) {
        const data = await pointed(reader, 'candidate-profile-batch-v1', batch);
        const usernames = profileRows.parse(data.value).map(row => row.outcome.requestedUsername);
        if (data.inputKey !== identity([target, batch, ...usernames]) || new Set(usernames).size !== usernames.length) invalid();
        await addProfile(batch, usernames);
    }
    return { profile, blite, receipts };
}

async function installReceipts(tx: Transaction, request: string, receipts: Receipt[]) {
    const jobs = new Map(receipts.map(receipt => [receipt.job, receipt]));
    for (const job of jobs.values()) {
        await tx.query(`INSERT INTO analysis_pipeline_jobs(
                request_id,job_key,track,kind,batch,input_hash,status,completed_at,created_at,updated_at,
                completion_token,completion_fanout_hash
            ) VALUES ($1,$2::text,$3,'collection',$4,$5,'completed',now(),now(),now(),gen_random_uuid(),md5($2::text))`,
        [request, job.job, job.track, job.batch, digest('offline-reference:' + job.job)]);
    }
    for (const receipt of receipts) {
        await tx.query(`INSERT INTO analysis_v2_provider_runs(
                request_id,job_key,operation_key,input_hash,job_claim_token,reservation_token,
                logical_provider,actor_id,credential_slot,max_charge_usd,status,run_id,actual_usage_usd,
                reserved_at,run_started_at,terminalized_at,usage_reconciled_at,updated_at
            ) VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'apify',$5,'secondary',
                0,'succeeded',$6,0,now(),now(),now(),now(),now())`,
        [request, receipt.job, receipt.operation, receipt.inputHash, receipt.actor, receipt.run]);
    }
}

/** Seed only the source lineage and successful provider references consumed by the real Dev archive RPCs. */
export async function bootstrapStandardArchiveSource(db: PGlite, input: BootstrapInput) {
    if (db.dataDir && db.dataDir !== 'memory://') invalid();
    let phase = 'sealed proofs';
    try {
        const { profile, blite, receipts } = await readSource(input);
        const catalog = currentPreflightCatalogSnapshot();
        const ready = buildReadyPreflightSnapshot(profile, 'test_entitlement', catalog);
        if (typeof ready === 'string') invalid();
        const cards = Object.fromEntries(ready.plans.map(({ planId, price: _price, pricingVersion: _version, ...card }) => [planId, card]));
        return await db.transaction(async tx => {
            phase = 'local owner approval';
            const { rows: [grant] } = await tx.query<{ id: string; approved_at: string }>(`
                SELECT approval->>'id' AS id,approval->>'approvedAt' AS approved_at
                FROM public.dev_live_owner_start_v4($1,$2,$3) AS approval`, [input.ownerId, input.target, randomUUID()]);
            if (!grant?.id) invalid();
            const entitlement = digest('analysis-test-entitlement-jti-v1\ndev-live-' + grant.id);
            const admissionToken = randomUUID();
            phase = 'local preflight';
            const { rows: [preflight] } = await tx.query<{ id: string }>(`INSERT INTO analysis_preflights(
                user_id,target_instagram_id,idempotency_key,access_mode,exclusion_decision,exclusion_decided_at,
                status,created_at,expires_at,ready_at,launch_status_snapshot,plan_catalog_snapshot,
                pricing_version,pricing_snapshot,policy_versions_snapshot,plan_cards_snapshot,
                target_followers_count,target_following_count,target_is_private,capacity_required_plan_id,required_plan_id,
                admission_status,admission_generation,admission_selected_plan_id,admission_entitlement_jti_hash,
                admission_token,admission_requested_at,admission_refreshed_at,admission_dispatch_generation,
                admission_dispatch_state,admission_dispatch_token,admission_dispatch_reserved_at,admission_dispatched_at,
                admission_target_followers_count,admission_target_following_count,admission_capacity_required_plan_id,
                admission_required_plan_id,admission_plan_cards_snapshot,precheckout_blite_cohort
            ) VALUES($1,$2,$3,'test_entitlement','skip',now(),'ready',now(),now()+interval '30 minutes',now(),
                $4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13,'ready',1,'standard',$14,$15,now(),now(),1,
                'enqueued',gen_random_uuid(),now(),now(),$10,$11,$12,$13,$9,$16) RETURNING id`,
            [input.ownerId, input.target, 'dev-live:owner:standard:' + grant.id, JSON.stringify(launchStatusSnapshot()),
                JSON.stringify(catalog.plans), catalog.pricingVersion, JSON.stringify(catalog.prices),
                JSON.stringify(preflightPolicyVersions('test_entitlement')), JSON.stringify(cards),
                profile.followersCount, profile.followingCount, ready.capacityRequiredPlan, ready.requiredPlan,
                entitlement, admissionToken, blite]);
            phase = 'local Standard consumption';
            const { rows: [result] } = await tx.query<{ request_id: string }>(
                "SELECT request_id FROM public.consume_analysis_v2_test_entitlement($1,$2,'standard',$3,$4)",
                [preflight!.id, input.ownerId, entitlement, admissionToken],
            );
            const request = result!.request_id;
            phase = 'local source jobs and receipts';
            await tx.query("UPDATE analysis_pipeline_jobs SET status='cancelled',completed_at=clock_timestamp(),recovery_not_before=NULL WHERE request_id=$1", [request]);
            await installReceipts(tx, request, receipts);
            await tx.query("UPDATE analysis_requests SET status='completed',completed_at=clock_timestamp() WHERE id=$1", [request]);
            return { grantId: grant.id, requestId: request, approvedAt: grant.approved_at, receiptCount: receipts.length };
        });
    } catch (error) {
        // Database errors may include private input parameters. Report only static schema identifiers.
        const pg = error as { code?: string; constraint?: string; message?: string };
        const code = pg?.code && /^[A-Z0-9]{5}$/.test(pg.code) ? pg.code : '';
        const constraint = pg?.constraint && /^analysis_[a-z0-9_]+$/.test(pg.constraint) ? pg.constraint : '';
        const reason = pg?.message && /^(?:ANALYSIS_|DEV_|PRECHECKOUT_)[A-Z_0-9]+$/.test(pg.message) ? pg.message : '';
        throw new Error(['Offline Standard source bootstrap failed at ' + phase, code, constraint, reason].filter(Boolean).join(' '));
    }
}
