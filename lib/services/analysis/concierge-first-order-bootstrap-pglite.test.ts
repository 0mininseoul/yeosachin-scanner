import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migrationPath = new URL(
    '../../../supabase/migrations/20260815090000_bootstrap_v211_concierge_first_order.sql',
    import.meta.url,
);
const migration = existsSync(migrationPath)
    ? readFileSync(migrationPath, 'utf8')
    : '';

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '223e4567-e89b-42d3-a456-426614174000';
const SOURCE_REQUEST_ID = '323e4567-e89b-42d3-a456-426614174000';
const FIRST_RELATIONSHIP_REQUEST_ID = '423e4567-e89b-42d3-a456-426614174000';
const SECOND_RELATIONSHIP_REQUEST_ID = '523e4567-e89b-42d3-a456-426614174000';
const FAILED_PREFLIGHT_ID = '623e4567-e89b-42d3-a456-426614174000';
const REARMED_PREFLIGHT_ID = '723e4567-e89b-42d3-a456-426614174000';
const RESULT_REQUEST_ID = '823e4567-e89b-42d3-a456-426614174000';
const SOURCE_FINGERPRINT = 'a'.repeat(64);
const RESULT_HASH = 'b'.repeat(64);
const TARGET_EVIDENCE_HASH = 'c'.repeat(64);
const UNKNOWN_REVIEW_SHA256 = '1c66ac59cb97a18441c613178a77202f6a9501d22d5de85e561e0208a568e367';

const migrationContract = [
    'bootstrap_earlybird_v211_concierge_first_order',
    'SECURITY DEFINER',
    "SET search_path = ''",
    'pg_advisory_xact_lock',
    'earlybird_orders',
    'earlybird_fulfillments',
    'reviewed_source_fingerprint',
    'published_result_hash',
    'CONCIERGE_BOOTSTRAP_RELATIONSHIP_ARTIFACT_MISSING',
    'CONCIERGE_BOOTSTRAP_PUBLICATION_CAS_CONFLICT',
    'REVOKE ALL ON FUNCTION',
    'GRANT EXECUTE ON FUNCTION',
] as const;

function relationshipRows(count: number, prefix: string): unknown[] {
    return Array.from({ length: count }, (_, index) => ({
        username: `${prefix}${index.toString(36)}`,
        isPrivate: false,
    }));
}

function exactRelationships(): { followers: unknown[]; following: unknown[] } {
    const followers = relationshipRows(157, 'f');
    const following = relationshipRows(361, 'g');
    for (let index = 0; index < 150; index += 1) {
        followers[index] = { username: `mutual${index}`, isPrivate: index >= 53 };
        following[index] = { username: `mutual${index}`, isPrivate: index >= 53 };
    }
    return { followers, following };
}

function targetEvidence(): unknown[] {
    return Array.from({ length: 95 }, (_, index) => ({
        actorUsername: `actor${index}`,
        postId: `post-${index}`,
        signal: index % 2 === 0 ? 'target_post_like' : 'target_post_comment',
        sourceInteractionId: `interaction-${index}`,
    }));
}

function publicationPayload() {
    return {
        sourceFingerprint: SOURCE_FINGERPRINT,
        resultHash: RESULT_HASH,
        femaleRows: Array.from({ length: 16 }, (_, index) => ({
            rank: index + 1,
            suspect_instagram_id: `mutual${index}`,
            suspect_profile_image: null,
            suspect_full_name: `Candidate ${index}`,
            bio: 'Public profile',
            risk_score: index === 0 ? 7 : 4,
            risk_grade: index === 0 ? 'high_risk' : 'normal',
            gender_status: 'confirmed',
            one_line_overview: `공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정 ${index}입니다.`,
            risk_analysis: index === 0 ? ['첫 문장', '둘째 문장'] : [],
        })),
        privateRows: Array.from({ length: 96 }, (_, index) => ({
            instagram_id: `private${index}`,
            profile_image: null,
            full_name: `Private ${index}`,
        })),
    };
}

function callParams(overrides: Record<string, unknown> = {}) {
    const relationships = exactRelationships();
    return [
        ORDER_ID,
        OWNER_ID,
        SOURCE_REQUEST_ID,
        FIRST_RELATIONSHIP_REQUEST_ID,
        SECOND_RELATIONSHIP_REQUEST_ID,
        FAILED_PREFLIGHT_ID,
        REARMED_PREFLIGHT_ID,
        RESULT_REQUEST_ID,
        'target',
        'analysis_in_progress',
        2,
        150,
        149,
        53,
        96,
        1,
        SOURCE_FINGERPRINT,
        RESULT_HASH,
        JSON.stringify({
            sourceFingerprint: SOURCE_FINGERPRINT,
            resultHash: RESULT_HASH,
            targetEvidenceManifest: TARGET_EVIDENCE_HASH,
            allPublicClassifications: '47a657f1c534680043e24ca44f9e2eaa16854b55cd34ab65e3bb2a8dee7fa8cb',
            unknownReviewCsv: UNKNOWN_REVIEW_SHA256,
        }),
        JSON.stringify(relationships.followers),
        JSON.stringify(relationships.following),
        JSON.stringify(targetEvidence()),
        JSON.stringify(publicationPayload()),
        ...Object.values(overrides),
    ];
}

let db: PGlite;

async function withRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await operation();
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function seed() {
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            preflight_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            result_request_id UUID NOT NULL,
            status TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            expected_amount_krw INTEGER NOT NULL,
            actual_amount_krw INTEGER,
            payment_id TEXT,
            expected_groble_product_id TEXT,
            actual_groble_product_id TEXT,
            seller_reference_confirmed_at TIMESTAMPTZ,
            paid_at TIMESTAMPTZ NOT NULL,
            exclusion_decision TEXT NOT NULL DEFAULT 'skip',
            excluded_instagram_id TEXT
        );
        CREATE TABLE public.earlybird_fulfillments (
            order_id UUID PRIMARY KEY,
            status TEXT NOT NULL,
            attempt_count SMALLINT NOT NULL,
            request_id UUID NOT NULL,
            manual_review_at TIMESTAMPTZ,
            last_error_code TEXT
        );
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            preflight_id UUID,
            target_instagram_id TEXT,
            status TEXT NOT NULL,
            pipeline_version TEXT NOT NULL,
            step_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            completed_at TIMESTAMPTZ,
            mutual_follows INTEGER
        );
        CREATE TABLE public.analysis_results (
            request_id UUID NOT NULL,
            rank INTEGER NOT NULL,
            suspect_instagram_id TEXT NOT NULL,
            suspect_profile_image TEXT,
            suspect_full_name TEXT,
            bio TEXT,
            risk_score INTEGER,
            risk_grade TEXT,
            gender_status TEXT,
            one_line_overview TEXT,
            risk_analysis JSONB
        );
        CREATE TABLE public.private_accounts (
            request_id UUID NOT NULL,
            instagram_id TEXT NOT NULL,
            profile_image TEXT,
            full_name TEXT
        );
        CREATE TABLE public.earlybird_webhook_events (
            event_type TEXT NOT NULL,
            payment_id TEXT NOT NULL,
            product_id TEXT,
            amount_krw INTEGER,
            refund_amount_krw INTEGER,
            partial_refund BOOLEAN
        );
        CREATE TABLE public.earlybird_v211_concierge_replays (
            order_id UUID PRIMARY KEY,
            original_failed_request_id UUID NOT NULL,
            first_relationship_failed_request_id UUID NOT NULL,
            second_relationship_failed_request_id UUID NOT NULL,
            failed_preflight_id UUID NOT NULL,
            rearmed_preflight_id UUID NOT NULL,
            expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (expected_fulfillment_attempt_count = 1),
            expected_manual_review_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            reviewed_source_request_id UUID,
            reviewed_source_owner_id UUID,
            reviewed_source_target_instagram_id TEXT,
            reviewed_source_result_request_id UUID,
            reviewed_source_target_posts JSONB,
            reviewed_source_target_evidence JSONB,
            reviewed_source_fingerprint TEXT,
            reviewed_source_registered_at TIMESTAMPTZ,
            published_source_fingerprint TEXT,
            published_result_hash TEXT,
            published_at TIMESTAMPTZ
        );
        ALTER TABLE public.earlybird_v211_concierge_replays ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.earlybird_v211_concierge_replays FORCE ROW LEVEL SECURITY;
        REVOKE ALL ON public.earlybird_v211_concierge_replays FROM PUBLIC, anon, authenticated, service_role;
    `);
    await db.exec(migration);
    await db.query(`
        INSERT INTO public.analysis_requests(id, user_id, preflight_id, target_instagram_id, status, pipeline_version, step_data)
            VALUES
            ($1, $2, $3, 'target', 'failed', 'v2', jsonb_build_object('sourceFingerprint', $4::text)),
            ($7, $2, $3, 'retained.abcdef0123456789abcd', 'failed', 'v2', '{}'::jsonb),
            ($8, $2, $3, 'retained.abcdef0123456789abcd', 'failed', 'v2', '{}'::jsonb),
            ($5, $2, $6, 'target', 'completed', 'v1', '{}'::jsonb)
    `, [SOURCE_REQUEST_ID, OWNER_ID, FAILED_PREFLIGHT_ID, SOURCE_FINGERPRINT, RESULT_REQUEST_ID, REARMED_PREFLIGHT_ID, FIRST_RELATIONSHIP_REQUEST_ID, SECOND_RELATIONSHIP_REQUEST_ID]);
    await db.query(`
        INSERT INTO public.earlybird_orders(
            id, user_id, preflight_id, target_instagram_id, result_request_id, status, plan_id,
            expected_amount_krw, actual_amount_krw, payment_id, expected_groble_product_id,
            actual_groble_product_id, seller_reference_confirmed_at, paid_at
        ) VALUES ($1, $2, $3, 'target', $4, 'completed', 'basic', 990, 990, 'payment-1', 'product-1', 'product-1', now(), '2026-08-12T09:07:30Z')
        `, [ORDER_ID, OWNER_ID, REARMED_PREFLIGHT_ID, RESULT_REQUEST_ID]);
    await db.query(`
        INSERT INTO public.earlybird_fulfillments(order_id, status, attempt_count, request_id, manual_review_at)
        VALUES ($1, 'analysis_in_progress', 2, $2, now())
    `, [ORDER_ID, SOURCE_REQUEST_ID]);
}

beforeEach(async () => {
    db = await PGlite.create();
    await seed();
});

afterEach(async () => {
    await db.close();
});

describe('concierge first-order bootstrap migration contract', () => {
    it.each(migrationContract)('includes the narrow %s guard', (marker) => {
        expect(migration).toContain(marker);
    });

    it('bootstraps only with complete relationship evidence and keeps the V1 pointer unchanged', async () => {
        const result = await withRole('service_role', () => db.query<{ result: Record<string, unknown> }>(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            ) AS result`,
            callParams(),
        ));
        expect(result.rows[0]?.result).toMatchObject({
            disposition: 'published',
            orderId: ORDER_ID,
            resultRequestId: RESULT_REQUEST_ID,
            sourceFingerprint: SOURCE_FINGERPRINT,
            resultHash: RESULT_HASH,
        });
        await expect(db.query(
            'SELECT result_request_id, status FROM public.earlybird_orders WHERE id = $1',
            [ORDER_ID],
        )).resolves.toMatchObject({ rows: [{ result_request_id: RESULT_REQUEST_ID, status: 'completed' }] });
        await expect(db.query(
            `SELECT reviewed_source_owner_id, reviewed_source_target_instagram_id,
                    reviewed_source_result_request_id, reviewed_source_fingerprint,
                    published_source_fingerprint, published_result_hash
               FROM public.earlybird_v211_concierge_replays WHERE order_id = $1`,
            [ORDER_ID],
        )).resolves.toMatchObject({ rows: [{
            reviewed_source_owner_id: OWNER_ID,
            reviewed_source_target_instagram_id: 'target',
            reviewed_source_result_request_id: RESULT_REQUEST_ID,
            reviewed_source_fingerprint: SOURCE_FINGERPRINT,
            published_source_fingerprint: SOURCE_FINGERPRINT,
            published_result_hash: RESULT_HASH,
        }] });
    });

    it('binds one failed V2 source request when its durable ledger has both relationship runs', async () => {
        await db.exec(`
            CREATE TABLE public.analysis_v2_provider_runs(
                request_id uuid NOT NULL,
                job_key text NOT NULL,
                operation_key text NOT NULL,
                logical_provider text NOT NULL,
                credential_slot text NOT NULL,
                status text NOT NULL,
                run_id text
            );
            INSERT INTO public.analysis_v2_provider_runs(
                request_id, job_key, operation_key, logical_provider,
                credential_slot, status, run_id
            ) VALUES
                ('${SOURCE_REQUEST_ID}', 'track:relationships:collect',
                 'relationship-followers:${'a'.repeat(64)}', 'apify', 'tertiary', 'succeeded', 'followers-run'),
                ('${SOURCE_REQUEST_ID}', 'track:relationships:collect',
                 'relationship-following:${'b'.repeat(64)}', 'apify', 'tertiary', 'succeeded', 'following-run');
        `);
        const params = callParams();
        params[3] = SOURCE_REQUEST_ID;
        params[4] = SOURCE_REQUEST_ID;
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            params,
        ))).resolves.toBeDefined();
    });

    it('is idempotent for an identical hash and rejects a different result hash', async () => {
        const call = () => withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            callParams(),
        ));
        await call();
        await expect(call()).resolves.toBeDefined();
        const changed = callParams();
        changed[17] = 'e'.repeat(64);
        changed[18] = JSON.stringify({
            sourceFingerprint: SOURCE_FINGERPRINT,
            resultHash: 'e'.repeat(64),
            targetEvidenceManifest: TARGET_EVIDENCE_HASH,
            allPublicClassifications: '47a657f1c534680043e24ca44f9e2eaa16854b55cd34ab65e3bb2a8dee7fa8cb',
            unknownReviewCsv: UNKNOWN_REVIEW_SHA256,
        });
        changed[22] = JSON.stringify({
            ...publicationPayload(), resultHash: 'e'.repeat(64),
        });
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            changed,
        ))).rejects.toThrow('CONCIERGE_BOOTSTRAP_PUBLICATION_CAS_CONFLICT');
    });

    it('fails before any write when relationship arrays are absent', async () => {
        const params = callParams();
        params[19] = JSON.stringify([]);
        params[20] = JSON.stringify([]);
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            params,
        ))).rejects.toThrow('CONCIERGE_BOOTSTRAP_RELATIONSHIP_ARTIFACT_MISSING');
        await expect(db.query('SELECT count(*)::int AS count FROM public.earlybird_v211_concierge_replays'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it('rejects a preexisting transient or recovery ledger row for the exact order', async () => {
        await db.exec(`
            CREATE TABLE public.earlybird_v211_apify_transient_replays(order_id uuid NOT NULL);
            INSERT INTO public.earlybird_v211_apify_transient_replays(order_id) VALUES ('${ORDER_ID}');
        `);
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            callParams(),
        ))).rejects.toThrow('CONCIERGE_FIRST_ORDER_BOOTSTRAP_RECOVERY_SCOPE_CONFLICT');
        await expect(db.query('SELECT count(*)::int AS count FROM public.earlybird_v211_concierge_replays'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it('rejects a high-risk payload without its two-line narrative', async () => {
        const params = callParams();
        params[22] = JSON.stringify({
            ...publicationPayload(),
            femaleRows: [{ ...publicationPayload().femaleRows[0], risk_analysis: [] }],
        });
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            params,
        ))).rejects.toThrow('CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID');
        await expect(db.query('SELECT count(*)::int AS count FROM public.earlybird_v211_concierge_replays'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it.each([
        ['canceled order', "UPDATE public.earlybird_orders SET status = 'cancelled' WHERE id = $1", 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT'],
        ['refunded order', "INSERT INTO public.earlybird_webhook_events(event_type,payment_id,product_id,amount_krw,refund_amount_krw,partial_refund) VALUES ('payment.refunded','payment-1','product-1',990,990,FALSE)", 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT'],
        ['cross-owner input', "SELECT 1", 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT'],
    ])('rejects the %s scope before publication', async (_label, mutation, error) => {
        if (mutation.startsWith('UPDATE')) {
            await db.query(mutation, [ORDER_ID]);
        } else {
            await db.exec(mutation);
        }
        const params = callParams();
        if (_label === 'cross-owner input') params[1] = '923e4567-e89b-42d3-a456-426614174000';
        await expect(withRole('service_role', () => db.query(
            `SELECT public.bootstrap_earlybird_v211_concierge_first_order(
                $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
                $9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,
                $15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,
                $22::jsonb,$23::jsonb
            )`,
            params,
        ))).rejects.toThrow(error);
        await expect(db.query('SELECT count(*)::int AS count FROM public.earlybird_v211_concierge_replays'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
    });

    it.each([
        ['anon', 'permission denied'],
        ['authenticated', 'permission denied'],
    ])('exposes no direct or RPC access to %s', async (role, error) => {
        await expect(withRole(role, () => db.query(
            'SELECT public.bootstrap_earlybird_v211_concierge_first_order($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::text,$10::text,$11::smallint,$12::integer,$13::integer,$14::integer,$15::integer,$16::integer,$17::text,$18::text,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb)',
            callParams(),
        ))).rejects.toThrow(error);
    });
});
