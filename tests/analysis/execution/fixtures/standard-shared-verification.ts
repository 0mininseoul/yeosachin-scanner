import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { expect } from 'vitest';
import { GET as result } from '@/app/api/analysis/v2/result/[requestId]/route';
import { GET as image } from '@/app/api/image-proxy/route';
import { ANALYSIS_V2_SCHEMA_VERSION, storedAnalysisResultPageV1Schema } from '@/lib/contracts/analysis-v2';
import { verifyAnalysisV2ResultImageProxyToken } from '@/lib/services/media/image-proxy-token';
import { PREFLIGHT_PROVIDER_FINISH_STABILITY_MS, reconcileSettledPreflightProviderCosts } from '@/lib/services/analysis/preflight-provider-run';
import { reconcileAnalysisV2ProviderUsage } from '@/lib/services/analysis/v2-provider-lifecycle';
import { analysisV2RevenueCostProviderRunSettlement } from '@/lib/services/analysis/revenue-cost-provider-run-reconciliation';
import type { StandardConnection } from './standard-database';
import { assertOwnerPage } from './standard-result-page';
import { matchesSharedResultImage } from './standard-shared-image-source';
import { target, type SyntheticActorStart } from './standard-providers';

const origin = 'https://fixture.invalid';
type Database = Pick<StandardConnection, 'query'>;
type AsUser = <T>(id: string | null, run: () => Promise<T>) => Promise<T>;

/** The production ledger deliberately defers final usage until the provider receipt has aged. */
export async function settleSharedActorReceipts(db: Database) {
    const { rows: [clock] } = await db.query<{ age_ms: number }>(`
        SELECT floor(extract(epoch FROM (clock_timestamp() - max(terminalized_at))) * 1000)::int AS age_ms
        FROM (
            SELECT terminalized_at FROM analysis_v2_provider_runs
            UNION ALL SELECT terminalized_at FROM analysis_preflight_provider_runs
        ) AS provider_finishes
    `);
    if (clock?.age_ms == null) throw new Error('Missing provider terminal timestamps');
    const wait = Math.max(0, PREFLIGHT_PROVIDER_FINISH_STABILITY_MS - clock.age_ms + 25);
    if (wait > 0) await sleep(wait);
    const preflight = await reconcileSettledPreflightProviderCosts();
    expect(preflight.failed).toBe(0);
    expect(preflight.hasMore).toBe(false); // This fixture admits at most 16 buyers with one preflight Actor each.
    const reconcilePaid = () => reconcileAnalysisV2ProviderUsage({ revenueCostSettlement: analysisV2RevenueCostProviderRunSettlement });
    let paid;
    do {
        paid = await reconcilePaid();
        expect(paid.failed).toBe(0);
    } while (paid.hasMore);
    expect((await reconcilePaid()).eligible).toBe(0);
    expect((await reconcileSettledPreflightProviderCosts()).eligible).toBe(0);
}

async function verifyActorReceipts(db: Database, requestId: string, preflightId: string,
    paidStarts: SyntheticActorStart[], preflightStarts: SyntheticActorStart[]) {
    type Receipt = { phase: 'paid' | 'preflight'; run_id: string | null; actor_id: string; actual_usd: number | null; reconciled: boolean };
    const { rows } = await db.query<Receipt>(`
        SELECT 'paid' AS phase,run_id,actor_id,actual_usage_usd::float8 AS actual_usd,
            (status='succeeded' AND terminalized_at IS NOT NULL AND usage_reconciled_at IS NOT NULL) AS reconciled
        FROM analysis_v2_provider_runs WHERE request_id=$1
        UNION ALL
        SELECT 'preflight',run_id,actor_id,actual_usage_usd::float8,
            (status='succeeded' AND terminalized_at IS NOT NULL AND usage_reconciled_at IS NOT NULL)
        FROM analysis_preflight_provider_runs WHERE preflight_id=$2
    `, [requestId, preflightId]);
    expect(new Set(rows.map(row => row.run_id)).size).toBe(rows.length);
    function verify(phase: Receipt['phase'], starts: SyntheticActorStart[]) {
        const receipts = rows.filter(row => row.phase === phase);
        expect(starts.length).toBeGreaterThan(0);
        expect(receipts.length).toBe(starts.length);
        const byId = new Map(starts.map(start => [start.runId, start]));
        expect(byId.size).toBe(starts.length);
        expect(new Set(starts.map(start => start.actor + ':' + start.inputHash)).size).toBe(starts.length);
        for (const row of receipts) {
            const start = row.run_id ? byId.get(row.run_id) : undefined;
            if (!start || row.actor_id !== start.actor) throw new Error('Provider receipt has no matching scoped Actor start');
            expect(row.reconciled).toBe(true);
            expect(row.actual_usd).toBe(start.usageUsd);
            expect(row.actual_usd).toBeGreaterThan(0);
            byId.delete(start.runId);
        }
        expect(byId.size).toBe(0);
        return { matched: receipts.length, simulatedMicros: Math.round(starts.reduce((total, run) => total + run.usageUsd, 0) * 1_000_000) };
    }
    return { paid: verify('paid', paidStarts), preflight: verify('preflight', preflightStarts) };
}

export async function sharedStandardEffects(db: Database, requestId: string, orderId: string, ownerId: string) {
    const { rows } = await db.query<Record<string, number>>(`
        WITH jobs AS (SELECT * FROM analysis_pipeline_jobs WHERE request_id=$1),
        attempts AS (SELECT * FROM analysis_v2_ai_attempts WHERE request_id=$1),
        holds AS (SELECT * FROM vertex_ai_budget_reservations WHERE run_id=$1::uuid::text),
        settled AS (SELECT * FROM holds WHERE state='settled'),
        admissions AS (SELECT * FROM analysis_provider_admission_leases WHERE request_id=$1 AND workload_role='paid')
        SELECT
            (SELECT count(*)::int FROM analysis_requests WHERE id=$1 AND user_id=$3) AS requests,
            (SELECT count(*)::int FROM earlybird_orders WHERE id=$2 AND user_id=$3 AND result_request_id=$1) AS orders,
            (SELECT count(*)::int FROM earlybird_fulfillments WHERE order_id=$2 AND request_id=$1) AS fulfillments,
            (SELECT count(*)::int FROM payment_events WHERE order_id=$2 AND event_type='payment.completed'
                AND disposition='accepted') AS mirrored_payments,
            (SELECT count(*)::int FROM earlybird_webhook_events WHERE order_id=$2 AND event_type='payment.completed'
                AND disposition='accepted') AS webhook_payments,
            (SELECT count(*)::int FROM analysis_v2_test_entitlement_consumptions WHERE request_id=$1) AS test_entitlements,
            (SELECT analysis_count FROM users WHERE id=$3) AS quota,
            (SELECT count(*)::int FROM analysis_v2_result_summaries WHERE request_id=$1) AS summaries,
            (SELECT count(*)::int FROM analysis_progress_events WHERE request_id=$1 AND event_code='ANALYSIS_COMPLETED') AS publications,
            (SELECT count(*)::int FROM analysis_v2_result_image_manifests WHERE request_id=$1 AND sealed_at IS NOT NULL) AS manifests,
            (SELECT count(*)::int FROM analysis_v2_result_image_objects WHERE request_id=$1 AND status='ready') AS images,
            (SELECT count(*)::int FROM jobs) AS jobs,
            (SELECT count(*)::int FROM jobs WHERE status='completed') AS completed_jobs,
            (SELECT coalesce(sum(attempt_count),0)::int FROM jobs) AS job_attempts,
            (SELECT count(*)::int FROM analysis_v2_provider_runs WHERE request_id=$1) AS provider_runs,
            (SELECT count(*)::int FROM attempts) AS ai_attempts,
            (SELECT count(*)::int FROM attempts WHERE status='success' AND usage_complete AND terminalized_at IS NOT NULL) AS successes,
            (SELECT count(*)::int FROM attempts WHERE status='response_rejected' AND stage='highRiskNarrative'
                AND usage_complete AND terminalized_at IS NOT NULL AND finish_reason='STOP') AS repaired_narrative_attempts,
            (SELECT count(*)::int FROM analysis_v2_female_results WHERE request_id=$1 AND analysis_depth='narrative'
                AND narrative_line_one IS NOT NULL AND narrative_line_two IS NOT NULL) AS published_narratives,
            (SELECT count(*)::int - count(DISTINCT (job_key,operation_key))::int FROM attempts) AS duplicate_attempts,
            (SELECT coalesce(sum(total_tokens),0)::int FROM attempts) AS attempt_tokens,
            (SELECT count(*)::int FROM gemini_token_usage WHERE request_id=$1) AS usage_rows,
            (SELECT coalesce(sum(total_tokens),0)::int FROM gemini_token_usage WHERE request_id=$1) AS usage_tokens,
            (SELECT count(*)::int FROM admissions) AS provider_admissions,
            (SELECT count(*)::int FROM admissions WHERE state<>'released') AS open_provider_leases,
            (SELECT count(*)::int FROM analysis_v2_gemini_leases WHERE request_id=$1 AND state<>'available') AS open_model_slots,
            (SELECT count(*)::int FROM attempts a WHERE NOT EXISTS (
                SELECT FROM admissions p WHERE p.logical_provider='gemini' AND p.state='released'
                AND p.job_key=a.job_key AND p.job_claim_token=a.job_claim_token
                AND p.operation_key='gemini:'||a.operation_key||':attempt:'||a.attempt::text)) AS unlinked_attempts,
            (SELECT count(*)::int FROM holds) AS reservations,
            (SELECT count(*)::int FROM holds WHERE state='reserved') AS open_reservations,
            (SELECT count(*)::int FROM settled) AS settlements,
            (SELECT count(*)::int FROM holds WHERE state='cancelled') AS cancelled,
            (SELECT count(*)::int FROM holds WHERE order_id IS DISTINCT FROM $2::uuid::text) AS wrong_order,
            (SELECT count(*)::int FROM settled WHERE usage_unknown OR actual_cost_usd IS NULL OR actual_cost_usd<=0) AS unpriced,
            (SELECT coalesce(round(sum(actual_cost_usd)*1000000),0)::int FROM settled) AS charged_micros,
            (SELECT count(*)::int FROM attempts a WHERE NOT EXISTS (
                SELECT FROM settled h WHERE h.operation_key=a.operation_key AND h.attempt=a.attempt)) AS unsettled_attempts,
            (SELECT count(*)::int FROM settled h WHERE NOT EXISTS (
                SELECT FROM attempts a WHERE a.operation_key=h.operation_key AND a.attempt=h.attempt)) AS unmatched_settlements,
            (SELECT count(*)::int - count(DISTINCT (operation_key,attempt))::int FROM settled) AS duplicate_settlements,
            (SELECT count(*)::int FROM settled h JOIN attempts a USING (operation_key,attempt)
                WHERE h.actual_cost_usd IS DISTINCT FROM a.estimated_cost_usd) AS mismatched_settlement_costs
    `, [requestId, orderId, ownerId]);
    return rows[0]!;
}

interface SharedVerification {
    db: Database;
    ownerId: string;
    otherOwnerId: string;
    requestId: string;
    preflightId: string;
    orderId: string;
    asUser: AsUser;
    modelCalls: number;
    paidActorStarts: SyntheticActorStart[];
    preflightActorStarts: SyntheticActorStart[];
    paymentMode: 'webhook' | 'fixture';
    expectedPublic: number;
    expectedPrivate: number;
}

function readPage(requestId: string, femaleCursor?: string | null, privateCursor?: string | null) {
    const url = new URL('/api/analysis/v2/result/' + requestId, origin);
    if (femaleCursor) url.searchParams.set('femaleCursor', femaleCursor);
    if (privateCursor) url.searchParams.set('privateCursor', privateCursor);
    return result(new Request(url), { params: Promise.resolve({ requestId }) });
}

async function verifyOwner(input: SharedVerification, scorePolicy: string) {
    const { db, requestId, expectedPublic, expectedPrivate } = input;
    const { rows: objects } = await db.query<{
        kind: string; candidate_locator: string; sha256: string; byte_size: number; member: string | null;
    }>(`
        SELECT i.kind,i.candidate_locator,i.sha256,i.byte_size,coalesce(f.instagram_id,p.instagram_id) AS member
        FROM analysis_v2_result_image_objects i
        LEFT JOIN analysis_v2_female_results f ON i.kind='female' AND f.request_id=i.request_id
            AND f.candidate_id=i.candidate_locator
        LEFT JOIN analysis_v2_private_results p ON i.kind='private' AND p.request_id=i.request_id
            AND p.candidate_id=i.candidate_locator
        WHERE i.request_id=$1 AND i.status='ready'
    `, [requestId]);
    const expected = new Map(objects.map(obj => [obj.kind + '/' + obj.candidate_locator, obj]));
    const urls: URL[] = [];
    async function verifyImage(path: string | null, kind: 'target' | 'female' | 'private', member: string | null = null) {
        if (!path) throw new Error('Published synthetic row lacks its required image');
        const url = new URL(path, origin);
        expect(url.origin === origin && url.pathname === '/api/image-proxy').toBe(true);
        const locator = verifyAnalysisV2ResultImageProxyToken(url.searchParams.get('result') ?? '', url.searchParams.get('expires') ?? '');
        expect(locator?.kind === kind && locator.requestId === requestId).toBe(true);
        const key = kind + '/' + (locator!.candidateId ?? 'target');
        const object = expected.get(key);
        if (!object || object.member !== member) throw new Error('Signed locator does not match its published member');
        const response = await image(new NextRequest(url));
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/webp');
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.length).toBe(object.byte_size);
        expect(createHash('sha256').update(bytes).digest('hex') === object.sha256).toBe(true);
        expect((await sharp(bytes).metadata()).format).toBe('webp');
        expect(await matchesSharedResultImage(bytes, member ?? target), 'Owner WebP has the wrong original profile').toBe(true);
        expected.delete(key);
        urls.push(url);
    }

    let publicRows = 0, privateRows = 0, pages = 0;
    let femaleCursor: string | null = null, privateCursor: string | null = null;
    const cursorPairs = new Set<string>();
    const members = new Set<string>();
    let firstPublic: string | undefined, firstPrivate: string | undefined;
    do {
        const pair = JSON.stringify([femaleCursor, privateCursor]);
        if (cursorPairs.has(pair)) throw new Error('Repeated owner result cursor');
        cursorPairs.add(pair);
        const response = await readPage(requestId, femaleCursor, privateCursor);
        expect(response.status).toBe(200);
        const body = storedAnalysisResultPageV1Schema.parse(await response.json());
        expect(body.requestId === requestId && body.schemaVersion === ANALYSIS_V2_SCHEMA_VERSION).toBe(true);
        expect(body.summary).toMatchObject({ planId: 'standard', scorePolicyVersion: scorePolicy, targetInstagramId: target });
        if (pages === 0) {
            await verifyImage(body.summary.targetProfileImage, 'target');
            firstPublic = body.femaleAccounts[0]?.instagramId;
            firstPrivate = body.privateAccounts[0]?.instagramId;
        }
        for (const kind of ['female', 'private'] as const) {
            if (pages && !(kind === 'female' ? femaleCursor : privateCursor)) continue;
            const collection = kind === 'female' ? body.femaleAccounts : body.privateAccounts;
            for (const account of collection) {
                if (members.has(account.instagramId)) throw new Error('Duplicate published result member');
                members.add(account.instagramId);
                await verifyImage(account.profileImage, kind, account.instagramId);
            }
            if (kind === 'female') { publicRows += collection.length; femaleCursor = body.femaleNextCursor; }
            else { privateRows += collection.length; privateCursor = body.privateNextCursor; }
        }
        pages++;
    } while (femaleCursor || privateCursor);
    expect([publicRows, privateRows, expected.size]).toEqual([expectedPublic, expectedPrivate, 0]);

    // The JSDOM helper renders the actual ResultPage, switches tabs and reads its
    // image src. Call the per-owner verifier serially after all dispatches drain.
    const pageUrl = origin + '/result/' + requestId + '?pipeline=v2';
    for (const [member, kind] of [[firstPublic, 'public'], [firstPrivate, 'private']] as const) {
        if (!member) continue;
        const path = await assertOwnerPage(requestId, member, kind, false, pageUrl);
        const src = new URL(path);
        const signed = verifyAnalysisV2ResultImageProxyToken(src.searchParams.get('result') ?? '', src.searchParams.get('expires') ?? '');
        expect(src.origin === origin && src.pathname === '/api/image-proxy' && signed?.requestId === requestId
            && objects.some(object => object.kind === signed.kind && object.member === member
                && object.candidate_locator === signed.candidateId)).toBe(true);
    }
    return { urls, pages, publicRows, privateRows };
}

export async function verifySharedStandardRequest(input: SharedVerification) {
    const { db, requestId, orderId, ownerId, preflightId, asUser, modelCalls } = input;
    expect(input.otherOwnerId !== ownerId).toBe(true);
    const actorReceipts = await verifyActorReceipts(db, requestId, preflightId, input.paidActorStarts, input.preflightActorStarts);
    const effects = await sharedStandardEffects(db, requestId, orderId, ownerId);
    expect(modelCalls).toBeGreaterThan(0);
    expect(effects).toMatchObject({
        requests: 1, orders: 1, fulfillments: 1, test_entitlements: 0,
        summaries: 1, publications: 1, manifests: 1, images: 1 + input.expectedPublic + input.expectedPrivate,
        ai_attempts: modelCalls, usage_rows: modelCalls, duplicate_attempts: 0,
        settlements: modelCalls, open_reservations: 0, wrong_order: 0, unpriced: 0, unsettled_attempts: 0,
        unmatched_settlements: 0, duplicate_settlements: 0, mismatched_settlement_costs: 0,
        open_provider_leases: 0, open_model_slots: 0, unlinked_attempts: 0,
    });
    expect(input.paymentMode === 'webhook' ? effects.webhook_payments : effects.mirrored_payments).toBe(1);
    if (input.paymentMode === 'fixture') expect(effects.webhook_payments).toBe(0);
    expect(effects.successes + effects.repaired_narrative_attempts).toBe(modelCalls);
    expect(effects.published_narratives).toBeGreaterThanOrEqual(effects.repaired_narrative_attempts);
    expect(effects.completed_jobs).toBeGreaterThan(0);
    expect(effects.jobs).toBe(effects.completed_jobs);
    expect(effects.attempt_tokens).toBeGreaterThan(0);
    expect(effects.usage_tokens).toBe(effects.attempt_tokens);
    expect(effects.charged_micros).toBeGreaterThan(0);
    expect(effects.reservations).toBe(effects.settlements + effects.cancelled);
    const { rows } = await db.query<{
        published: boolean; complete: boolean; consumed: boolean; paid: boolean; fulfilled: boolean;
        receipt: boolean; ai_policy: string; score_policy: string;
    }>(`
        WITH accepted_payment AS (
            SELECT payment_id,order_id,amount_krw FROM earlybird_webhook_events
            WHERE $5='webhook' AND order_id=$2 AND event_type='payment.completed' AND disposition='accepted'
            UNION ALL
            SELECT payment_id,order_id,amount_krw FROM payment_events
            WHERE $5='fixture' AND order_id=$2 AND event_type='payment.completed' AND disposition='accepted')
        SELECT public.analysis_result_publication_authorized(r.id) AS published,
            r.status='completed' AND r.pipeline_version='v2' AND r.completed_at IS NOT NULL AND r.test_entitlement_jti_hash IS NULL AS complete,
            p.status='consumed' AND p.consumed_request_id=r.id AND p.user_id=r.user_id AS consumed,
            o.status='completed' AND o.plan_id='standard' AND o.result_request_id=r.id AND o.paid_at IS NOT NULL
                AND o.expected_amount_krw>0 AND o.expected_amount_krw=o.actual_amount_krw AS paid,
            f.status='completed' AND f.completed_at IS NOT NULL AND f.request_id=r.id AS fulfilled,
            e.payment_id=o.payment_id AND e.amount_krw=o.actual_amount_krw AS receipt,
            r.policy_versions_snapshot->>'aiStage' AS ai_policy, s.score_policy_version AS score_policy
        FROM analysis_requests r JOIN analysis_preflights p ON p.id=r.preflight_id JOIN earlybird_orders o ON o.id=$2 AND o.preflight_id=$4 AND o.user_id=r.user_id
        JOIN earlybird_fulfillments f ON f.order_id=o.id JOIN analysis_v2_result_summaries s ON s.request_id=r.id
        JOIN accepted_payment e ON e.order_id=o.id
        WHERE r.id=$1 AND r.user_id=$3
    `, [requestId, orderId, ownerId, preflightId, input.paymentMode]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ published: true, complete: true, consumed: true, paid: true, fulfilled: true, receipt: true });
    expect(rows[0]!.ai_policy).toBe('ai-stage-policy-v2.11');
    const owner = await asUser(ownerId, () => verifyOwner(input, rows[0]!.score_policy));
    for (const [viewer, expectedStatus] of [[input.otherOwnerId, 404], [null, 401]] as const) {
        await asUser(viewer, async () => {
            expect((await readPage(requestId)).status).toBe(expectedStatus);
            for (const url of owner.urls) expect((await image(new NextRequest(url))).status).toBe(403);
        });
    }
    expect(await sharedStandardEffects(db, requestId, orderId, ownerId)).toEqual(effects);
    return {
        ...effects, actorReceipts, pages: owner.pages, publicRows: owner.publicRows, privateRows: owner.privateRows,
        ownerWebp: owner.urls.length, originalImagesMatched: owner.urls.length, otherImageDenied: owner.urls.length, anonymousImageDenied: owner.urls.length,
        payments: 1, paymentMode: input.paymentMode, ownerResult: 200, otherResult: 404, anonymousResult: 401, pipelineVersion: 'v2',
        resultSchemaVersion: ANALYSIS_V2_SCHEMA_VERSION, policy: rows[0]!.ai_policy, scorePolicy: rows[0]!.score_policy
    };
}
