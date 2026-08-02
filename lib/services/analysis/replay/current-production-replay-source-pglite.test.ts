import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../../supabase/migrations/20260801200000_add_current_production_replay_source.sql',
    import.meta.url,
), 'utf8');
const policy = JSON.stringify({
    pipeline: 'v2',
    risk: 'risk-policy-v2.5',
    aiStage: 'ai-stage-policy-v2.10',
    scheduler: 'ai-scheduler-v1',
});
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY, user_id UUID, status TEXT, completed_at TIMESTAMPTZ,
            pipeline_version TEXT, selected_plan_id_snapshot TEXT,
            plan_access_mode_snapshot TEXT, test_entitlement_jti_hash TEXT,
            preflight_id UUID, policy_versions_snapshot JSONB
        );
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY, user_id UUID, status TEXT, access_mode TEXT,
            consumed_request_id UUID, policy_versions_snapshot JSONB,
            pii_scrubbed_at TIMESTAMPTZ, target_instagram_id TEXT,
            target_full_name TEXT, target_bio TEXT, target_profile_image_url TEXT,
            exclusion_decision TEXT, excluded_instagram_id TEXT
        );
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY, user_id UUID, preflight_id UUID,
            result_request_id UUID, plan_id TEXT, status TEXT, payment_id TEXT,
            paid_at TIMESTAMPTZ, seller_reference_confirmed_at TIMESTAMPTZ,
            expected_groble_product_id TEXT, actual_groble_product_id TEXT,
            expected_amount_krw INTEGER, actual_amount_krw INTEGER
        );
        CREATE TABLE public.earlybird_fulfillments (
            order_id UUID PRIMARY KEY, request_id UUID, status TEXT,
            completed_at TIMESTAMPTZ
        );
        CREATE TABLE public.earlybird_webhook_events (
            event_id TEXT PRIMARY KEY, order_id UUID, event_type TEXT,
            disposition TEXT, payment_id TEXT, product_id TEXT, amount_krw INTEGER
        );
        CREATE TABLE public.analysis_v2_result_summaries (
            request_id UUID PRIMARY KEY, plan_id TEXT, score_policy_version TEXT
        );
        CREATE TABLE public.analysis_v2_provider_runs (
            request_id UUID, job_key TEXT, operation_key TEXT,
            logical_provider TEXT, actor_id TEXT, credential_slot TEXT,
            status TEXT, run_id TEXT, terminalized_at TIMESTAMPTZ,
            actual_usage_usd NUMERIC, usage_reconciled_at TIMESTAMPTZ
        );
        CREATE TABLE public.analysis_preflight_provider_runs (
            preflight_id UUID, operation_key TEXT, logical_provider TEXT,
            actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT,
            terminalized_at TIMESTAMPTZ, actual_usage_usd NUMERIC,
            usage_reconciled_at TIMESTAMPTZ
        );
    `);
    await db.exec(migration);
});

afterAll(async () => db.close());

async function insertSource(overrides: {
    requestAccess?: string;
    preflightAccess?: string;
    preflightUserId?: string;
    policy?: string;
    scrubbed?: boolean;
    orderStatus?: string;
    fulfillmentStatus?: string;
    resultRisk?: string;
    acceptedPayment?: boolean;
    providerStatus?: string;
    reconciled?: boolean;
} = {}) {
    const requestId = crypto.randomUUID();
    const preflightId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const orderId = crypto.randomUUID();
    const exactPolicy = overrides.policy ?? policy;
    const scrubbed = overrides.scrubbed ?? true;
    const retained = `retained.${preflightId.replaceAll('-', '').slice(0, 20)}`;
    await db.query(`
        INSERT INTO public.analysis_requests VALUES
        ($1, $2, 'completed', '2026-08-01T12:00:00Z', 'v2', 'standard', $3, NULL, $4, $5::JSONB)
    `, [requestId, userId, overrides.requestAccess ?? 'production', preflightId, exactPolicy]);
    await db.query(`
        INSERT INTO public.analysis_preflights VALUES
        ($1, $2, 'consumed', $3, $4, $5::JSONB, $6, $7, $8, $9, $10, 'skip', NULL)
    `, [
        preflightId,
        overrides.preflightUserId ?? userId,
        overrides.preflightAccess ?? 'production',
        requestId,
        exactPolicy,
        scrubbed ? '2026-08-01T12:00:00Z' : null,
        scrubbed ? retained : 'raw_target',
        scrubbed ? null : 'Target',
        scrubbed ? null : 'bio',
        scrubbed ? null : 'https://example.com/image.jpg',
    ]);
    await db.query(`
        INSERT INTO public.earlybird_orders VALUES
        ($1, $2, $3, $4, 'standard', $5, 'payment-1', '2026-08-01T10:00:00Z',
         '2026-08-01T10:01:00Z', 'standard-product', 'standard-product', 9900, 9900)
    `, [orderId, userId, preflightId, requestId, overrides.orderStatus ?? 'completed']);
    await db.query(`
        INSERT INTO public.earlybird_fulfillments VALUES
        ($1, $2, $3, '2026-08-01T12:00:00Z')
    `, [orderId, requestId, overrides.fulfillmentStatus ?? 'completed']);
    if (overrides.acceptedPayment ?? true) {
        await db.query(`
            INSERT INTO public.earlybird_webhook_events VALUES
            ($1, $2, 'payment.completed', 'accepted', 'payment-1', 'standard-product', 9900)
        `, [crypto.randomUUID(), orderId]);
    }
    await db.query(`
        INSERT INTO public.analysis_v2_result_summaries VALUES ($1, 'standard', $2)
    `, [requestId, overrides.resultRisk ?? 'risk-policy-v2.5']);
    const reconciledAt = (overrides.reconciled ?? true)
        ? '2026-08-01T11:00:00Z'
        : null;
    await db.query(`
        INSERT INTO public.analysis_preflight_provider_runs VALUES
        ($1, 'target-profile-fallback', 'apify', 'apify/instagram-profile-scraper',
         'primary', $2, 'PreflightRun1', '2026-08-01T10:05:00Z', 0.0026, $3)
    `, [preflightId, overrides.providerStatus ?? 'succeeded', reconciledAt]);
    await db.query(`
        INSERT INTO public.analysis_v2_provider_runs VALUES
        ($1, 'relationships', $2, 'apify', 'apify/instagram-followers-following-scraper',
         'primary', $3, 'RequestRun1', '2026-08-01T11:00:00Z', 0.01, $4)
    `, [
        requestId,
        `relationship-followers:${'a'.repeat(64)}`,
        overrides.providerStatus ?? 'succeeded',
        reconciledAt,
    ]);
    return { requestId };
}

async function read(requestId: string) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<{ source: Record<string, unknown> }>(
            'SELECT public.read_analysis_v2_current_production_replay_source($1) AS source',
            [requestId],
        );
    } finally {
        await db.exec('RESET ROLE');
    }
}

describe('read_analysis_v2_current_production_replay_source', () => {
    it('is a UUID-only STABLE reader with service-role-only execute ACL', () => {
        expect(migration).toContain(
            'read_analysis_v2_current_production_replay_source(\n    p_request_id UUID',
        );
        expect(migration).toMatch(/LANGUAGE plpgsql\s+STABLE/);
        const body = migration.split('AS $$')[1]!.split('$$;')[0]!;
        expect(body).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
        expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
        expect(migration).toContain('TO service_role;');
    });

    it('returns only opaque exact lineage and reconciled provider metadata', async () => {
        const { requestId } = await insertSource();
        const result = await read(requestId);
        const source = result.rows[0]!.source;
        expect(source.requestId).toBe(requestId);
        expect(source.targetUsername).toMatch(/^replay_[a-f0-9]{23}$/);
        expect(source).not.toHaveProperty('target');
        expect(JSON.stringify(source)).not.toContain('raw_target');
        expect(source.policyVersions).toEqual(JSON.parse(policy));
        expect(source.preflightRuns).toHaveLength(1);
        expect(source.providerRuns).toHaveLength(1);
    });

    it.each([
        { overrides: { requestAccess: 'test_entitlement' }, label: 'production request' },
        { overrides: { preflightAccess: 'test_entitlement' }, label: 'production preflight' },
        { overrides: { preflightUserId: crypto.randomUUID() }, label: 'same user' },
        { overrides: { scrubbed: false }, label: 'scrubbed preflight' },
        { overrides: { orderStatus: 'analysis_in_progress' }, label: 'completed order' },
        { overrides: { fulfillmentStatus: 'analysis_in_progress' }, label: 'completed fulfillment' },
        { overrides: { resultRisk: 'risk-policy-v2.4' }, label: 'risk-v2.5 result' },
        { overrides: { acceptedPayment: false }, label: 'accepted payment' },
        { overrides: { policy: JSON.stringify({ pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.9', scheduler: 'ai-scheduler-v1' }) }, label: 'v2.10 lineage' },
    ])('rejects a source without strict $label evidence', async ({ overrides }) => {
        const { requestId } = await insertSource(overrides);
        await expect(read(requestId)).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_SOURCE_NOT_FOUND',
        );
    });

    it.each([
        { overrides: { providerStatus: 'running' }, label: 'non-terminal' },
        { overrides: { reconciled: false }, label: 'unreconciled' },
    ])('rejects $label Apify ledger evidence', async ({ overrides }) => {
        const { requestId } = await insertSource(overrides);
        await expect(read(requestId)).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_PROVIDER_LEDGER_INVALID',
        );
    });

    it.each(['anon', 'authenticated'])('does not grant %s access', async role => {
        const { requestId } = await insertSource();
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query(
            'SELECT public.read_analysis_v2_current_production_replay_source($1)',
            [requestId],
        )).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });
});
