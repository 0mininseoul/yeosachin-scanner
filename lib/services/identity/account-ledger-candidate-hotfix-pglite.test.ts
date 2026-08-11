import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const bridgeMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260810074911_add_account_principal_bridge.sql',
    import.meta.url,
), 'utf8');
const correctiveMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260812010000_correct_account_ledger_legacy_e2e_marker.sql',
    import.meta.url,
), 'utf8');

const PGLITE_TEST_TIMEOUT_MS = 30_000;
const databases: PGlite[] = [];

const INTENDED_ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const EXTERNAL_ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';
const MIXED_ACCOUNT_ID = '10000000-0000-4000-8000-000000000003';
const MALFORMED_ACCOUNT_ID = '10000000-0000-4000-8000-000000000004';
const MISMATCH_ACCOUNT_ID = '10000000-0000-4000-8000-000000000005';
const AUTH_LINKED_ACCOUNT_ID = '10000000-0000-4000-8000-000000000006';
const NO_ANALYSIS_ACCOUNT_ID = '10000000-0000-4000-8000-000000000007';
const NO_ORDER_ACCOUNT_ID = '10000000-0000-4000-8000-000000000008';
const NO_EVENT_ACCOUNT_ID = '10000000-0000-4000-8000-000000000009';
const OPERATOR_ACCOUNT_ID = '10000000-0000-4000-8000-000000000010';
const INTERNAL_TESTER_ACCOUNT_ID = '10000000-0000-4000-8000-000000000011';
const NEW_INTENDED_ACCOUNT_ID = '10000000-0000-4000-8000-000000000012';

const INTENDED_ORDER_ID = '20000000-0000-4000-8000-000000000001';
const EXTERNAL_ORDER_ID = '20000000-0000-4000-8000-000000000002';
const MIXED_MARKER_ORDER_ID = '20000000-0000-4000-8000-000000000003';
const MIXED_EXTERNAL_ORDER_ID = '20000000-0000-4000-8000-000000000004';
const MALFORMED_ORDER_ID = '20000000-0000-4000-8000-000000000005';
const MISMATCH_ORDER_ID = '20000000-0000-4000-8000-000000000006';
const AUTH_LINKED_ORDER_ID = '20000000-0000-4000-8000-000000000007';
const NO_ANALYSIS_ORDER_ID = '20000000-0000-4000-8000-000000000008';
const NO_EVENT_ORDER_ID = '20000000-0000-4000-8000-000000000009';
const NEW_INTENDED_ORDER_ID = '20000000-0000-4000-8000-000000000010';

type DatabaseRole = 'anon' | 'authenticated' | 'service_role';

async function withRole<T>(
    db: PGlite,
    role: DatabaseRole,
    operation: () => Promise<T>,
): Promise<T> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await operation();
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function asService<T>(
    db: PGlite,
    sql: string,
    params: unknown[] = [],
): Promise<Results<T>> {
    return withRole(db, 'service_role', () => db.query<T>(sql, params));
}

async function createDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;

        CREATE SCHEMA auth;
        CREATE TABLE auth.users (
            id UUID PRIMARY KEY,
            email TEXT,
            raw_app_meta_data JSONB NOT NULL DEFAULT '{}'::JSONB
        );

        CREATE TABLE public.users (
            id UUID PRIMARY KEY,
            email VARCHAR NOT NULL,
            provider VARCHAR NOT NULL,
            analysis_count INTEGER NOT NULL DEFAULT 0,
            is_paid_user BOOLEAN NOT NULL DEFAULT FALSE,
            is_unlimited BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp(),
            name VARCHAR,
            nickname VARCHAR,
            profile_image TEXT,
            gender VARCHAR,
            birthyear VARCHAR,
            phone_number VARCHAR,
            phone_number_normalized TEXT,
            phone_number_verification_source TEXT,
            phone_number_verified_at TIMESTAMP WITH TIME ZONE
        );

        GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO anon, authenticated;

        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES public.users(id)
        );

        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES public.users(id),
            status TEXT NOT NULL,
            payment_id VARCHAR,
            actual_groble_product_id VARCHAR,
            actual_amount_krw INTEGER,
            paid_at TIMESTAMP WITH TIME ZONE,
            groble_seller_reference TEXT,
            seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp()
        );

        CREATE TABLE public.earlybird_webhook_events (
            event_id VARCHAR(256) PRIMARY KEY,
            idempotency_key VARCHAR(256) NOT NULL UNIQUE,
            event_type VARCHAR(64) NOT NULL,
            occurred_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp(),
            payment_id VARCHAR(256) NOT NULL,
            product_id VARCHAR(128) NOT NULL,
            amount_krw INTEGER NOT NULL,
            disposition TEXT NOT NULL,
            order_id UUID REFERENCES public.earlybird_orders(id),
            processed_at TIMESTAMP WITH TIME ZONE NOT NULL
                DEFAULT pg_catalog.clock_timestamp()
        );

        CREATE FUNCTION public.finalize_earlybird_groble_payment_refund_aware(
            p_referenced_order_id UUID,
            p_require_legacy_email_only BOOLEAN,
            p_event_id TEXT,
            p_idempotency_key TEXT,
            p_event_type TEXT,
            p_occurred_at TIMESTAMP WITH TIME ZONE,
            p_payment_id TEXT,
            p_buyer_email TEXT,
            p_buyer_phone_normalized TEXT,
            p_buyer_phone_raw TEXT,
            p_buyer_display_name TEXT,
            p_product_id TEXT,
            p_amount_krw INTEGER,
            p_paid_at TIMESTAMP WITH TIME ZONE
        )
        RETURNS TABLE(
            disposition TEXT,
            order_id UUID,
            status TEXT,
            plan_sequence SMALLINT
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
            SELECT
                'unmatched'::TEXT,
                NULL::UUID,
                NULL::TEXT,
                NULL::SMALLINT
        $$;
    `);
    await db.exec(bridgeMigration);
    await db.exec(correctiveMigration);
    return db;
}

async function insertAccount(
    db: PGlite,
    accountId: string,
    withAnalysis: boolean,
): Promise<void> {
    await db.query(
        `INSERT INTO public.users(id, email, provider, classification_version)
         VALUES ($1::UUID, $2, 'kakao', NULL)`,
        [accountId, `${accountId.slice(-4)}@invalid.test`],
    );
    if (withAnalysis) {
        await db.query(
            `INSERT INTO public.analysis_requests(id, user_id)
             VALUES ($1::UUID, $2::UUID)`,
            [accountId.replace('10000000', '30000000'), accountId],
        );
    }
}

async function insertOrder(
    db: PGlite,
    orderId: string,
    accountId: string,
    paymentId: string,
): Promise<void> {
    await db.query(
        `INSERT INTO public.earlybird_orders(
            id, user_id, status, payment_id, actual_groble_product_id,
            actual_amount_krw, paid_at
        ) VALUES ($1::UUID, $2::UUID, 'completed', $3, 'standard_product',
            1990, '2026-08-10T00:00:00Z')`,
        [orderId, accountId, paymentId],
    );
}

async function insertAcceptedEvent(
    db: PGlite,
    input: {
        eventId: string;
        idempotencyKey: string;
        paymentId: string;
        orderId: string;
        productId?: string;
        amount?: number;
    },
): Promise<void> {
    await db.query(
        `INSERT INTO public.earlybird_webhook_events(
            event_id, idempotency_key, event_type, payment_id, product_id,
            amount_krw, disposition, order_id
        ) VALUES ($1, $2, 'payment.completed', $3, $4, $5, 'accepted', $6::UUID)`,
        [
            input.eventId,
            input.idempotencyKey,
            input.paymentId,
            input.productId ?? 'standard_product',
            input.amount ?? 1990,
            input.orderId,
        ],
    );
}

async function seedCandidates(db: PGlite): Promise<void> {
    for (const [accountId, withAnalysis] of [
        [INTENDED_ACCOUNT_ID, true],
        [EXTERNAL_ACCOUNT_ID, true],
        [MIXED_ACCOUNT_ID, true],
        [MALFORMED_ACCOUNT_ID, true],
        [MISMATCH_ACCOUNT_ID, true],
        [AUTH_LINKED_ACCOUNT_ID, true],
        [NO_ANALYSIS_ACCOUNT_ID, false],
        [NO_ORDER_ACCOUNT_ID, true],
        [NO_EVENT_ACCOUNT_ID, true],
        [OPERATOR_ACCOUNT_ID, false],
        [INTERNAL_TESTER_ACCOUNT_ID, false],
    ] as const) {
        await insertAccount(db, accountId, withAnalysis);
    }

    await insertOrder(
        db,
        INTENDED_ORDER_ID,
        INTENDED_ACCOUNT_ID,
        'e2e-payment-intended',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-event-intended',
        idempotencyKey: 'e2e-idem-intended',
        paymentId: 'e2e-payment-intended',
        orderId: INTENDED_ORDER_ID,
    });

    await insertOrder(
        db,
        EXTERNAL_ORDER_ID,
        EXTERNAL_ACCOUNT_ID,
        'external-payment-normal',
    );
    await insertAcceptedEvent(db, {
        eventId: 'external-event-normal',
        idempotencyKey: 'external-idem-normal',
        paymentId: 'external-payment-normal',
        orderId: EXTERNAL_ORDER_ID,
    });

    await insertOrder(
        db,
        MIXED_MARKER_ORDER_ID,
        MIXED_ACCOUNT_ID,
        'e2e-payment-mixed',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-event-mixed',
        idempotencyKey: 'e2e-idem-mixed',
        paymentId: 'e2e-payment-mixed',
        orderId: MIXED_MARKER_ORDER_ID,
    });
    await insertOrder(
        db,
        MIXED_EXTERNAL_ORDER_ID,
        MIXED_ACCOUNT_ID,
        'external-payment-mixed',
    );
    await insertAcceptedEvent(db, {
        eventId: 'external-event-mixed',
        idempotencyKey: 'external-idem-mixed',
        paymentId: 'external-payment-mixed',
        orderId: MIXED_EXTERNAL_ORDER_ID,
    });

    await insertOrder(
        db,
        MALFORMED_ORDER_ID,
        MALFORMED_ACCOUNT_ID,
        'e2e-',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-',
        idempotencyKey: 'e2e-idem-malformed',
        paymentId: 'e2e-',
        orderId: MALFORMED_ORDER_ID,
    });

    await insertOrder(
        db,
        MISMATCH_ORDER_ID,
        MISMATCH_ACCOUNT_ID,
        'e2e-payment-mismatch',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-event-mismatch',
        idempotencyKey: 'e2e-idem-mismatch',
        paymentId: 'e2e-payment-mismatch',
        orderId: MISMATCH_ORDER_ID,
        productId: 'wrong_product',
    });

    await insertOrder(
        db,
        AUTH_LINKED_ORDER_ID,
        AUTH_LINKED_ACCOUNT_ID,
        'e2e-payment-auth-linked',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-event-auth-linked',
        idempotencyKey: 'e2e-idem-auth-linked',
        paymentId: 'e2e-payment-auth-linked',
        orderId: AUTH_LINKED_ORDER_ID,
    });
    await db.query(
        `INSERT INTO auth.users(id, email)
         VALUES ($1::UUID, 'auth-linked@invalid.test')`,
        [AUTH_LINKED_ACCOUNT_ID],
    );

    await insertOrder(
        db,
        NO_ANALYSIS_ORDER_ID,
        NO_ANALYSIS_ACCOUNT_ID,
        'e2e-payment-no-analysis',
    );
    await insertAcceptedEvent(db, {
        eventId: 'e2e-event-no-analysis',
        idempotencyKey: 'e2e-idem-no-analysis',
        paymentId: 'e2e-payment-no-analysis',
        orderId: NO_ANALYSIS_ORDER_ID,
    });

    await insertOrder(
        db,
        NO_EVENT_ORDER_ID,
        NO_EVENT_ACCOUNT_ID,
        'e2e-payment-no-event',
    );
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('account-ledger candidate corrective migration PGlite', () => {
    it('includes only the exact marker lineage and excludes every unsafe neighbor', async () => {
        const db = await createDatabase();
        await seedCandidates(db);

        const listed = await asService<{ account_id: string }>(db, `
            SELECT account_id
            FROM public.list_account_ledger_legacy_e2e_candidates_v1()
        `);
        expect(listed.rows).toEqual([{ account_id: INTENDED_ACCOUNT_ID }]);
    }, PGLITE_TEST_TIMEOUT_MS);

    it('recomputes candidates during plan construction and rejects stale payloads', async () => {
        const db = await createDatabase();
        await seedCandidates(db);

        const plan = await asService<{
            total_count: number;
            legacy_e2e_count: number;
            operator_count: number;
            internal_tester_count: number;
        }>(db, `
            SELECT total_count, legacy_e2e_count, operator_count, internal_tester_count
            FROM public.build_account_ledger_classification_plan_v1(
                $1::JSONB, $2::JSONB, $3::JSONB
            )
        `, [
            JSON.stringify([INTENDED_ACCOUNT_ID]),
            JSON.stringify([OPERATOR_ACCOUNT_ID]),
            JSON.stringify([INTERNAL_TESTER_ACCOUNT_ID]),
        ]);
        expect(plan.rows).toEqual([{
            total_count: 11,
            legacy_e2e_count: 1,
            operator_count: 1,
            internal_tester_count: 1,
        }]);

        await insertAccount(db, NEW_INTENDED_ACCOUNT_ID, true);
        await insertOrder(
            db,
            NEW_INTENDED_ORDER_ID,
            NEW_INTENDED_ACCOUNT_ID,
            'e2e-payment-new',
        );
        await insertAcceptedEvent(db, {
            eventId: 'e2e-event-new',
            idempotencyKey: 'e2e-idem-new',
            paymentId: 'e2e-payment-new',
            orderId: NEW_INTENDED_ORDER_ID,
        });

        await expect(asService(db, `
            SELECT * FROM public.build_account_ledger_classification_plan_v1(
                $1::JSONB, $2::JSONB, $3::JSONB
            )
        `, [
            JSON.stringify([INTENDED_ACCOUNT_ID]),
            JSON.stringify([OPERATOR_ACCOUNT_ID]),
            JSON.stringify([INTERNAL_TESTER_ACCOUNT_ID]),
        ])).rejects.toThrow('ACCOUNT_CLASSIFICATION_LEGACY_CANDIDATE_DRIFT');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('keeps the replacement RPC service-role-only', async () => {
        const db = await createDatabase();
        const grants = await db.query<{
            anon_allowed: boolean;
            authenticated_allowed: boolean;
            service_allowed: boolean;
            outer_service_allowed: boolean;
        }>(`
            SELECT
                has_function_privilege(
                    'anon',
                    'public.account_ledger_legacy_e2e_candidate_ids_v1()'::REGPROCEDURE,
                    'EXECUTE'
                ) AS anon_allowed,
                has_function_privilege(
                    'authenticated',
                    'public.account_ledger_legacy_e2e_candidate_ids_v1()'::REGPROCEDURE,
                    'EXECUTE'
                ) AS authenticated_allowed,
                has_function_privilege(
                    'service_role',
                    'public.account_ledger_legacy_e2e_candidate_ids_v1()'::REGPROCEDURE,
                    'EXECUTE'
                ) AS service_allowed,
                has_function_privilege(
                    'service_role',
                    'public.list_account_ledger_legacy_e2e_candidates_v1()'::REGPROCEDURE,
                    'EXECUTE'
                ) AS outer_service_allowed
        `);
        expect(grants.rows).toEqual([{
            anon_allowed: false,
            authenticated_allowed: false,
            service_allowed: false,
            outer_service_allowed: true,
        }]);
    }, PGLITE_TEST_TIMEOUT_MS);
});
