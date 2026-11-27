import { sharedPaidPlan } from './standard-shared-admission';
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
import { ANALYSIS_V2_AI_STAGES, type AnalysisV2AiStage } from '@/lib/services/analysis/v2-ai-attempt-store';
import type { StandardConnection, StandardDatabase } from './standard-database';
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
    if (clock?.age_ms == null) return ['actor_terminal_timestamps_missing'];
    const wait = Math.max(0, PREFLIGHT_PROVIDER_FINISH_STABILITY_MS - clock.age_ms + 25);
    if (wait > 0) await sleep(wait);
    const issues: string[] = [];
    try {
        const preflight = await reconcileSettledPreflightProviderCosts();
        if (preflight.failed) issues.push('actor_preflight_settlement_failed');
        if (preflight.hasMore || (await reconcileSettledPreflightProviderCosts()).eligible) issues.push('actor_preflight_settlement_remaining');
    } catch {
        issues.push('actor_preflight_settlement_query_failed');
    }
    try {
        const reconcilePaid = () => reconcileAnalysisV2ProviderUsage({ revenueCostSettlement: analysisV2RevenueCostProviderRunSettlement });
        let paid;
        do {
            paid = await reconcilePaid();
            if (paid.failed) issues.push('actor_paid_settlement_failed');
        } while (!paid.failed && paid.hasMore);
        if ((await reconcilePaid()).eligible) issues.push('actor_paid_settlement_remaining');
    } catch {
        issues.push('actor_paid_settlement_query_failed');
    }
    return issues;
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
    const ledgerIssues: string[] = [];
    if (new Set(rows.map(row => row.run_id)).size !== rows.length) ledgerIssues.push('actor_duplicate_run_id');
    function verify(phase: Receipt['phase'], starts: SyntheticActorStart[]) {
        const receipts = rows.filter(row => row.phase === phase);
        const byId = new Map(starts.map(start => [start.runId, start]));
        const duplicateStarts = starts.length - byId.size;
        const duplicateInputs = starts.length - new Set(starts.map(start => start.actor + ':' + start.inputHash)).size;
        let matched = 0, unreconciled = 0, wrongCost = 0;
        for (const row of receipts) {
            const start = row.run_id ? byId.get(row.run_id) : undefined;
            if (!row.reconciled) unreconciled++;
            if (!start || row.actor_id !== start.actor) continue;
            matched++;
            if (row.actual_usd !== start.usageUsd || !(row.actual_usd > 0)) wrongCost++;
            byId.delete(start.runId);
        }
        const unmatchedReceipts = receipts.length - matched, missingReceipts = byId.size;
        const defects = { no_starts: Number(starts.length === 0), duplicate_starts: duplicateStarts, duplicate_inputs: duplicateInputs,
            missing_receipts: missingReceipts, unmatched_receipts: unmatchedReceipts, unreconciled, wrong_cost: wrongCost };
        for (const [code, count] of Object.entries(defects)) if (count) ledgerIssues.push('actor_' + phase + '_' + code);
        return { matched, starts: starts.length, receipts: receipts.length, duplicateStarts, duplicateInputs, missingReceipts,
            unmatchedReceipts, unreconciled, wrongCost, simulatedMicros: Math.round(starts.reduce((total, run) => total + run.usageUsd, 0) * 1_000_000) };
    }
    return { paid: verify('paid', paidStarts), preflight: verify('preflight', preflightStarts), ledgerIssues };
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

export function sharedStandardLedgerIssues(e: Record<string, number>, modelCalls: number, provenUnsentCutoffs = 0) {
    // A single cancelled hold matched to a proven unsent cutoff needs no usage or charge.
    // The caller records every owner's functional proof before failing the combined run.
    const expected: Record<string, number> = {
        ai_attempts: modelCalls + provenUnsentCutoffs, usage_rows: modelCalls, settlements: modelCalls, duplicate_attempts: 0,
        open_reservations: 0, wrong_order: 0, unpriced: 0, unsettled_attempts: provenUnsentCutoffs, unmatched_settlements: 0,
        duplicate_settlements: 0, mismatched_settlement_costs: 0, open_provider_leases: 0, open_model_slots: 0,
        unlinked_attempts: 0, usage_tokens: e.attempt_tokens, reservations: e.settlements + e.cancelled,
    };
    const issues = Object.keys(expected).filter(name => e[name] !== expected[name]);
    if (!(modelCalls > 0)) issues.push('missing_model_calls');
    if (e.successes + e.repaired_narrative_attempts !== modelCalls) issues.push('incomplete_model_outcomes');
    if (!(e.attempt_tokens > 0)) issues.push('missing_attempt_tokens');
    if (!(e.charged_micros > 0)) issues.push('missing_charged_cost');
    return issues;
}

export async function sharedStandardLedgerStages(db: Database, requestId: string, orderId: string) {
    // Aggregate holds before joining so a duplicate settlement cannot inflate the attempt count.
    type Stage = { stage: AnalysisV2AiStage | 'unattributed' } & Record<
        'attempts' | 'cutoffs' | 'unknown_cost_cutoffs' | 'priced_cutoffs_missing_attempt_cost' | 'cutoffs_missing_tokens'
        | 'unsettled_attempts' | 'other_cost_mismatches' | 'unknown_settlements' | 'unknown_reserved_estimate_micros'
        | 'known_settled_micros' | 'wrong_order' | 'open_reservations' | 'duplicate_settlements' | 'unmatched_settlements'
        | 'cutoffs_cancelled_only' | 'cutoffs_without_budget_row' | 'cutoffs_with_unexpired_admission'
        | 'cutoffs_with_expired_admission' | 'cutoffs_with_recovery_required_admission'
        | 'cutoffs_with_unexpired_slot' | 'cutoffs_with_expired_slot' | 'cutoffs_with_quarantined_slot'
        | 'unreleased_leases' | 'unexpired_leases' | 'expired_leases' | 'recovery_required_leases', number>;
    const { rows } = await db.query<Stage>(`
        WITH attempts AS (SELECT * FROM analysis_v2_ai_attempts WHERE request_id=$1),
        charges AS (
            SELECT operation_key,attempt,count(*)::int AS holds,
                count(*) FILTER (WHERE order_id IS DISTINCT FROM $2::uuid::text)::int AS wrong_order,
                count(*) FILTER (WHERE state='reserved')::int AS open_reservations,
                count(*) FILTER (WHERE state='cancelled')::int AS cancelled,
                count(*) FILTER (WHERE state='settled')::int AS settlements,
                count(*) FILTER (WHERE state='settled' AND usage_unknown AND actual_cost_usd IS NULL)::int AS settled_unknown,
                sum(actual_cost_usd) FILTER (WHERE state='settled') AS actual_cost,
                sum(estimated_cost_usd) FILTER (WHERE state='settled' AND usage_unknown AND actual_cost_usd IS NULL) AS unknown_reserved_estimate
            FROM vertex_ai_budget_reservations WHERE run_id=$1::uuid::text GROUP BY operation_key,attempt
        ), leases AS (
            SELECT job_key,job_claim_token,operation_key,count(*) FILTER (WHERE state<>'released')::int AS unreleased,
                count(*) FILTER (WHERE state='leased' AND expires_at > statement_timestamp())::int AS unexpired,
                count(*) FILTER (WHERE state='leased' AND expires_at <= statement_timestamp())::int AS expired,
                count(*) FILTER (WHERE state='recovery_required')::int AS recovery_required
            FROM analysis_provider_admission_leases WHERE request_id=$1 AND workload_role='paid' AND logical_provider='gemini'
            GROUP BY job_key,job_claim_token,operation_key
        ), physical_slots AS (
            SELECT job_key,operation_key,attempt,stage, bool_or(expires_at > statement_timestamp()) AS unexpired,
                bool_or(expires_at <= statement_timestamp()) AS expired, bool_or(state='quarantined') AS quarantined
            FROM analysis_v2_gemini_leases WHERE request_id=$1 AND state IN ('leased','quarantined')
            GROUP BY job_key,operation_key,attempt,stage
        )
        SELECT CASE WHEN a.stage=ANY($3::text[]) THEN a.stage ELSE 'unattributed' END AS stage,
            count(a.operation_key)::int AS attempts, count(*) FILTER (WHERE a.status='cutoff')::int AS cutoffs,
            count(*) FILTER (WHERE a.status='cutoff' AND c.settled_unknown>0)::int AS unknown_cost_cutoffs,
            count(*) FILTER (WHERE a.status='cutoff' AND c.actual_cost>0 AND a.estimated_cost_usd IS NULL)::int AS priced_cutoffs_missing_attempt_cost,
            count(*) FILTER (WHERE a.status='cutoff' AND a.total_tokens IS NULL)::int AS cutoffs_missing_tokens,
            count(*) FILTER (WHERE a.status='cutoff' AND c.holds=c.cancelled)::int AS cutoffs_cancelled_only,
            count(*) FILTER (WHERE a.status='cutoff' AND c.holds IS NULL)::int AS cutoffs_without_budget_row,
            count(*) FILTER (WHERE a.status='cutoff' AND l.unexpired>0)::int AS cutoffs_with_unexpired_admission,
            count(*) FILTER (WHERE a.status='cutoff' AND l.expired>0)::int AS cutoffs_with_expired_admission,
            count(*) FILTER (WHERE a.status='cutoff' AND l.recovery_required>0)::int AS cutoffs_with_recovery_required_admission,
            count(*) FILTER (WHERE a.status='cutoff' AND s.unexpired)::int AS cutoffs_with_unexpired_slot,
            count(*) FILTER (WHERE a.status='cutoff' AND s.expired)::int AS cutoffs_with_expired_slot,
            count(*) FILTER (WHERE a.status='cutoff' AND s.quarantined)::int AS cutoffs_with_quarantined_slot,
            count(*) FILTER (WHERE a.operation_key IS NOT NULL AND coalesce(c.settlements,0)=0)::int AS unsettled_attempts,
            count(*) FILTER (WHERE a.status<>'cutoff' AND c.settlements=1 AND c.actual_cost IS DISTINCT FROM a.estimated_cost_usd)::int AS other_cost_mismatches,
            coalesce(sum(c.settled_unknown),0)::int AS unknown_settlements,
            coalesce(round(sum(c.unknown_reserved_estimate)*1000000),0)::int AS unknown_reserved_estimate_micros,
            coalesce(round(sum(c.actual_cost)*1000000),0)::int AS known_settled_micros,
            coalesce(sum(c.wrong_order),0)::int AS wrong_order, coalesce(sum(c.open_reservations),0)::int AS open_reservations,
            coalesce(sum(greatest(c.settlements-1,0)),0)::int AS duplicate_settlements,
            coalesce(sum(c.settlements) FILTER (WHERE a.operation_key IS NULL),0)::int AS unmatched_settlements,
            coalesce(sum(l.unreleased),0)::int AS unreleased_leases, coalesce(sum(l.unexpired),0)::int AS unexpired_leases,
            coalesce(sum(l.expired),0)::int AS expired_leases, coalesce(sum(l.recovery_required),0)::int AS recovery_required_leases
        FROM attempts a FULL JOIN charges c USING (operation_key,attempt)
        LEFT JOIN leases l ON l.job_key=a.job_key AND l.job_claim_token=a.job_claim_token
            AND l.operation_key='gemini:'||a.operation_key||':attempt:'||a.attempt::text
        LEFT JOIN physical_slots s ON s.job_key=a.job_key AND s.operation_key=a.operation_key AND s.attempt=a.attempt AND s.stage=a.stage
        GROUP BY 1 ORDER BY 1`, [requestId, orderId, [...ANALYSIS_V2_AI_STAGES]]);
    return rows;
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
    provenUnsentCutoffs: number;
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

type OwnerReadInput = Pick<SharedVerification, 'db' | 'requestId' | 'expectedPublic' | 'expectedPrivate'>;

async function readOwnerResult(input: OwnerReadInput, scorePolicy: string) {
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
    let lastImageTime: { startToLastOwnerWebpMs: number | null; paidToLastOwnerWebpMs: number } | undefined;
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
        if (expected.size === 1) {
            // The byte stream is complete. Sample the same PG clock as the paid/slot timestamps
            // before the subsequent digest, image decoding, rendering and negative-access checks.
            const { rows } = await db.query<NonNullable<typeof lastImageTime>>(`
                SELECT round(1000 * extract(epoch FROM (statement_timestamp() - f.capacity_first_started_at)))::int AS "startToLastOwnerWebpMs",
                    round(1000 * extract(epoch FROM (statement_timestamp() - o.paid_at)))::int AS "paidToLastOwnerWebpMs"
                FROM earlybird_fulfillments f JOIN earlybird_orders o ON o.id=f.order_id
                WHERE f.request_id=$1 AND f.status='completed' AND o.result_request_id=f.request_id
            `, [requestId]);
            expect(rows).toHaveLength(1);
            lastImageTime = rows[0];
        }
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
        expect(body.summary).toMatchObject({ planId: sharedPaidPlan, scorePolicyVersion: scorePolicy, targetInstagramId: target });
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

    if (!lastImageTime) throw new Error('SHARED_OWNER_LAST_WEBP_TIME_MISSING');
    return { urls, pages, publicRows, privateRows, firstPublic, firstPrivate, objects, scorePolicy, ...lastImageTime };
}

type OwnerRead = Awaited<ReturnType<typeof readOwnerResult>>;

// A reconciliation may finish several orders. Begin every eligible owner's HTTP reads immediately
// in their own auth context. The result-page renderer below uses a shared DOM and stays serial.
export function observeSharedOwnerReads(
    db: Database, orders: { requestId: string; owner: { id: string } }[], asUser: AsUser,
    expectedPublic: number, expectedPrivate: number,
) {
    const pending = new Map(orders.map(order => [order.requestId, order.owner.id]));
    const reads = new Map<string, Promise<OwnerRead>>();
    async function scan() {
        if (!pending.size) return;
        const { rows } = await db.query<{ request_id: string; score_policy_version: string }>(`
            SELECT f.request_id, s.score_policy_version FROM earlybird_fulfillments f
            JOIN analysis_v2_result_summaries s ON s.request_id=f.request_id
            WHERE f.request_id=ANY($1::uuid[]) AND f.status='completed' AND f.completed_at IS NOT NULL
        `, [[...pending.keys()]]);
        for (const row of rows) {
            const ownerId = pending.get(row.request_id);
            if (!ownerId) continue;
            pending.delete(row.request_id);
            const read = asUser(ownerId, () => readOwnerResult(
                { db, requestId: row.request_id, expectedPublic, expectedPrivate }, row.score_policy_version));
            reads.set(row.request_id, read);
            // A worker or the periodic sweep can launch this well before the test joins the proof.
            void read.catch(() => undefined);
        }
    }
    return { scan, get remaining() { return pending.size; },
        async finish() {
            await scan();
            if (pending.size) throw new Error('SHARED_OWNER_FULFILLMENT_INCOMPLETE');
            return new Map(await Promise.all([...reads].map(async ([id, read]) => [id, await read] as const)));
        },
        async stop() {
            const settled = await Promise.allSettled(orders.map(order => reads.get(order.requestId)));
            return settled.flatMap((result, index) => {
                if (result.status !== 'fulfilled' || !result.value) return [];
                const read = result.value;
                return [{ owner: index + 1, images: read.urls.length,
                    fromSeatMs: read.startToLastOwnerWebpMs, fromPaymentMs: read.paidToLastOwnerWebpMs }];
            });
        },
    };
}

export async function verifyRenderedOwner(requestId: string, { firstPublic, firstPrivate, objects }: OwnerRead) {
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
}

// Exercise the real notification claim against the published synthetic orders without sending
// mail or leaving an outstanding delivery. Only aggregate counts go into the receipt.
export async function countVerifiedResultEmailClaims(db: StandardDatabase, requestIds: string[]) {
    return db.transaction(async tx => {
        await tx.exec('SAVEPOINT verify_result_email');
        try {
            let verified = 0;
            for (let attempt = 0; attempt < requestIds.length + 1; attempt++) {
                const { rows: [row] } = await tx.query<{ claimed: number; matched: number }>(`
                    SELECT count(*)::int AS claimed, count(*) FILTER (
                        WHERE mail.request_id=ANY($1::uuid[]) AND mail.order_id=o.id
                          AND mail.recipient=lower(trim(a.email)) AND mail.target=s.target_instagram_id
                          AND mail.target=o.target_instagram_id
                    )::int AS matched
                    FROM public.claim_paid_result_email(gen_random_uuid()) mail
                    LEFT JOIN public.earlybird_orders o ON o.id=mail.order_id AND o.result_request_id=mail.request_id
                    LEFT JOIN auth.users a ON a.id=o.user_id
                    LEFT JOIN public.analysis_v2_result_summaries s ON s.request_id=mail.request_id
                `, [requestIds]);
                expect(row?.claimed).toBe(attempt < requestIds.length ? 1 : 0);
                expect(row?.matched).toBe(row?.claimed);
                verified += row!.matched;
            }
            return verified;
        } finally {
            await tx.exec('ROLLBACK TO SAVEPOINT verify_result_email');
            await tx.exec('RELEASE SAVEPOINT verify_result_email');
        }
    });
}

export async function verifySharedStandardRequest(input: SharedVerification, owner: OwnerRead) {
    const { db, requestId, orderId, ownerId, preflightId, asUser, modelCalls } = input;
    expect(input.otherOwnerId !== ownerId).toBe(true);
    const effects = await sharedStandardEffects(db, requestId, orderId, ownerId);
    expect(effects).toMatchObject({
        requests: 1, orders: 1, fulfillments: 1, test_entitlements: 0,
        summaries: 1, publications: 1, manifests: 1, images: 1 + input.expectedPublic + input.expectedPrivate,
    });
    expect(input.paymentMode === 'webhook' ? effects.webhook_payments : effects.mirrored_payments).toBe(1);
    if (input.paymentMode === 'fixture') expect(effects.webhook_payments).toBe(0);
    expect(effects.published_narratives).toBeGreaterThanOrEqual(effects.repaired_narrative_attempts);
    expect(effects.completed_jobs).toBeGreaterThan(0);
    expect(effects.jobs).toBe(effects.completed_jobs);
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
            o.status='completed' AND o.plan_id=$6 AND o.result_request_id=r.id AND o.paid_at IS NOT NULL
                AND o.expected_amount_krw>0 AND o.expected_amount_krw=o.actual_amount_krw AS paid,
            f.status='completed' AND f.completed_at IS NOT NULL AND f.request_id=r.id AS fulfilled,
            e.payment_id=o.payment_id AND e.amount_krw=o.actual_amount_krw AS receipt,
            r.policy_versions_snapshot->>'aiStage' AS ai_policy, s.score_policy_version AS score_policy
        FROM analysis_requests r JOIN analysis_preflights p ON p.id=r.preflight_id JOIN earlybird_orders o ON o.id=$2 AND o.preflight_id=$4 AND o.user_id=r.user_id
        JOIN earlybird_fulfillments f ON f.order_id=o.id JOIN analysis_v2_result_summaries s ON s.request_id=r.id
        JOIN accepted_payment e ON e.order_id=o.id
        WHERE r.id=$1 AND r.user_id=$3
    `, [requestId, orderId, ownerId, preflightId, input.paymentMode, sharedPaidPlan]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ published: true, complete: true, consumed: true, paid: true, fulfilled: true, receipt: true });
    expect(rows[0]!.ai_policy).toBe('ai-stage-policy-v2.11');
    expect(owner.scorePolicy).toBe(rows[0]!.score_policy);
    for (const [viewer, expectedStatus] of [[input.otherOwnerId, 404], [null, 401]] as const) {
        await asUser(viewer, async () => {
            expect((await readPage(requestId)).status).toBe(expectedStatus);
            for (const url of owner.urls) expect((await image(new NextRequest(url))).status).toBe(403);
        });
    }
    expect(await sharedStandardEffects(db, requestId, orderId, ownerId)).toEqual(effects);
    const actorReceipts = await verifyActorReceipts(db, requestId, preflightId, input.paidActorStarts, input.preflightActorStarts);
    const ledgerByStage = await sharedStandardLedgerStages(db, requestId, orderId);
    const ledgerIssues = [...sharedStandardLedgerIssues(effects, modelCalls, input.provenUnsentCutoffs), ...actorReceipts.ledgerIssues];
    return {
        ...effects, modelCalls, provenUnsentCutoffs: input.provenUnsentCutoffs, actorReceipts, ledgerIssues, ledgerByStage, pages: owner.pages, publicRows: owner.publicRows, privateRows: owner.privateRows,
        ownerWebp: owner.urls.length, originalImagesMatched: owner.urls.length, otherImageDenied: owner.urls.length, anonymousImageDenied: owner.urls.length,
        payments: 1, paymentMode: input.paymentMode, ownerResult: 200, otherResult: 404, anonymousResult: 401, pipelineVersion: 'v2',
        resultSchemaVersion: ANALYSIS_V2_SCHEMA_VERSION, policy: rows[0]!.ai_policy, scorePolicy: rows[0]!.score_policy
    };
}
