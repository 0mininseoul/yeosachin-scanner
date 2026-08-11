import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260810074911_add_account_principal_bridge.sql',
    import.meta.url,
), 'utf8');

const PGLITE_TEST_TIMEOUT_MS = 30_000;
const databases: PGlite[] = [];

const EXTERNAL_ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const OPERATOR_ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';
const E2E_ACCOUNT_ID = '10000000-0000-4000-8000-000000000003';
const INTERNAL_TESTER_ACCOUNT_ID = '10000000-0000-4000-8000-000000000004';
const EXTERNAL_LATE_ORDER_ID = '20000000-0000-4000-8000-000000000001';
const EXTERNAL_EARLY_ORDER_ID = '20000000-0000-4000-8000-000000000002';
const OPERATOR_ORDER_ID = '20000000-0000-4000-8000-000000000003';
const E2E_ORDER_ID = '20000000-0000-4000-8000-000000000004';
const INTERNAL_TESTER_ORDER_ID = '20000000-0000-4000-8000-000000000005';

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
            event_type VARCHAR(64) NOT NULL,
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
    await db.exec(migration);
    return db;
}

async function seedLedgerScenario(db: PGlite): Promise<void> {
    await db.exec(`
        INSERT INTO public.users(id, email, provider) VALUES
            ('${EXTERNAL_ACCOUNT_ID}', 'external@invalid.test', 'kakao'),
            ('${OPERATOR_ACCOUNT_ID}', 'operator@invalid.test', 'google'),
            ('${E2E_ACCOUNT_ID}', 'e2e@invalid.test', 'kakao'),
            ('${INTERNAL_TESTER_ACCOUNT_ID}', 'tester@invalid.test', 'google');

        INSERT INTO public.earlybird_orders(
            id, user_id, status, payment_id, actual_groble_product_id,
            actual_amount_krw, paid_at
        ) VALUES
            (
                '${EXTERNAL_LATE_ORDER_ID}', '${EXTERNAL_ACCOUNT_ID}', 'paid',
                'payment-external-late', 'product-basic', 14900,
                '2026-08-04T00:00:00Z'
            ),
            (
                '${EXTERNAL_EARLY_ORDER_ID}', '${EXTERNAL_ACCOUNT_ID}', 'completed',
                'payment-external-early', 'product-basic', 14900,
                '2026-08-01T00:00:00Z'
            ),
            (
                '${OPERATOR_ORDER_ID}', '${OPERATOR_ACCOUNT_ID}', 'paid',
                'payment-operator', 'product-basic', 14900,
                '2026-08-02T00:00:00Z'
            ),
            (
                '${E2E_ORDER_ID}', '${E2E_ACCOUNT_ID}', 'paid',
                'payment-e2e', 'product-basic', 14900,
                '2026-08-02T00:00:00Z'
            ),
            (
                '${INTERNAL_TESTER_ORDER_ID}', '${INTERNAL_TESTER_ACCOUNT_ID}', 'paid',
                'payment-tester', 'product-basic', 14900,
                '2026-08-02T00:00:00Z'
            );

        INSERT INTO public.earlybird_webhook_events(
            event_id, event_type, payment_id, product_id, amount_krw,
            disposition, order_id
        ) VALUES
            (
                'event-external-late', 'payment.completed',
                'payment-external-late', 'product-basic', 14900, 'accepted',
                '${EXTERNAL_LATE_ORDER_ID}'
            ),
            (
                'event-external-early', 'payment.completed',
                'payment-external-early', 'product-basic', 14900, 'accepted',
                '${EXTERNAL_EARLY_ORDER_ID}'
            ),
            (
                'event-operator', 'payment.completed',
                'payment-operator', 'product-basic', 14900, 'accepted',
                '${OPERATOR_ORDER_ID}'
            ),
            (
                'event-e2e', 'payment.completed',
                'payment-e2e', 'product-basic', 14900, 'accepted',
                '${E2E_ORDER_ID}'
            ),
            (
                'event-tester', 'payment.completed',
                'payment-tester', 'product-basic', 14900, 'accepted',
                '${INTERNAL_TESTER_ORDER_ID}'
            );
    `);
}

function approvedClassifications(): string {
    return JSON.stringify([
        {
            account_id: EXTERNAL_ACCOUNT_ID,
            account_class: 'production',
            traffic_class: 'external',
            lifecycle: 'active',
            reason_code: 'INITIAL_EXTERNAL',
        },
        {
            account_id: OPERATOR_ACCOUNT_ID,
            account_class: 'production',
            traffic_class: 'operator',
            lifecycle: 'active',
            reason_code: 'INITIAL_OPERATOR',
        },
        {
            account_id: E2E_ACCOUNT_ID,
            account_class: 'e2e_test',
            traffic_class: 'e2e_test',
            lifecycle: 'active',
            reason_code: 'INITIAL_E2E',
        },
        {
            account_id: INTERNAL_TESTER_ACCOUNT_ID,
            account_class: 'e2e_test',
            traffic_class: 'internal_tester',
            lifecycle: 'retired',
            reason_code: 'INITIAL_INTERNAL_TESTER',
        },
    ]);
}

async function activateAndReplay(db: PGlite) {
    return asService<{
        updated_count: number;
        evidence_count: number;
        paid_account_count: number;
    }>(
        db,
        `SELECT * FROM public.classify_account_principals_v1(
            $1::JSONB, 'account-ledger-v1', TRUE
        )`,
        [approvedClassifications()],
    );
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('account-principal Phase A+B migration semantics', () => {
    it('keeps qualifying payment evidence inert while the rollout remains pending', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);

        const recorded = await asService<{ recorded: boolean }>(
            db,
            `SELECT public.record_external_paid_ever($1::UUID, $2) AS recorded`,
            [EXTERNAL_LATE_ORDER_ID, 'event-external-late'],
        );

        expect(recorded.rows).toEqual([{ recorded: false }]);
        expect((await db.query<{ paid_ever_state: string }>(
            'SELECT paid_ever_state FROM public.account_ledger_rollout_state',
        )).rows).toEqual([{ paid_ever_state: 'pending' }]);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.account_paid_evidence',
        )).rows).toEqual([{ count: 0 }]);
        expect((await db.query<{ is_paid_user: boolean }>(
            'SELECT is_paid_user FROM public.users WHERE id = $1',
            [EXTERNAL_ACCOUNT_ID],
        )).rows).toEqual([{ is_paid_user: false }]);
    }, PGLITE_TEST_TIMEOUT_MS);

    it('activates only after classification and replays accepted external evidence idempotently', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);

        const result = await activateAndReplay(db);

        expect(result.rows).toEqual([{
            updated_count: 4,
            evidence_count: 5,
            paid_account_count: 1,
        }]);
        expect((await db.query<{
            paid_ever_state: string;
            classification_command_version: string | null;
        }>(
            `SELECT paid_ever_state, classification_command_version
             FROM public.account_ledger_rollout_state`,
        )).rows).toEqual([{
            paid_ever_state: 'active',
            classification_command_version: 'account-ledger-v1',
        }]);
        expect((await db.query<{
            account_id: string;
            is_paid_user: boolean;
            first_paid_at_is_earliest: boolean | null;
            first_paid_at_is_null: boolean;
        }>(
            `SELECT
                id::TEXT AS account_id,
                is_paid_user,
                first_paid_at = '2026-08-01T00:00:00Z'::TIMESTAMP WITH TIME ZONE
                    AS first_paid_at_is_earliest,
                first_paid_at IS NULL AS first_paid_at_is_null
             FROM public.users
             ORDER BY id`,
        )).rows).toEqual([
            {
                account_id: EXTERNAL_ACCOUNT_ID,
                is_paid_user: true,
                first_paid_at_is_earliest: true,
                first_paid_at_is_null: false,
            },
            {
                account_id: OPERATOR_ACCOUNT_ID,
                is_paid_user: false,
                first_paid_at_is_earliest: null,
                first_paid_at_is_null: true,
            },
            {
                account_id: E2E_ACCOUNT_ID,
                is_paid_user: false,
                first_paid_at_is_earliest: null,
                first_paid_at_is_null: true,
            },
            {
                account_id: INTERNAL_TESTER_ACCOUNT_ID,
                is_paid_user: false,
                first_paid_at_is_earliest: null,
                first_paid_at_is_null: true,
            },
        ]);
        expect((await db.query<{
            counts_as_external: boolean;
            count: number;
        }>(
            `SELECT counts_as_external, COUNT(*)::INTEGER AS count
             FROM public.account_paid_evidence
             GROUP BY counts_as_external
             ORDER BY counts_as_external`,
        )).rows).toEqual([
            { counts_as_external: false, count: 3 },
            { counts_as_external: true, count: 2 },
        ]);

        await expect(asService<{ recorded: boolean }>(
            db,
            `SELECT public.record_external_paid_ever($1::UUID, $2) AS recorded`,
            [EXTERNAL_EARLY_ORDER_ID, 'event-external-early'],
        )).resolves.toMatchObject({ rows: [{ recorded: true }] });
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.account_paid_evidence',
        )).rows).toEqual([{ count: 5 }]);
    }, PGLITE_TEST_TIMEOUT_MS);

    it('replays an already-active classification command without duplicating audit transitions', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        await activateAndReplay(db);

        const replay = await asService<{
            updated_count: number;
            evidence_count: number;
            paid_account_count: number;
        }>(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'account-ledger-v1', TRUE
            )`,
            [approvedClassifications()],
        );

        expect(replay.rows).toEqual([{
            updated_count: 0,
            evidence_count: 5,
            paid_account_count: 1,
        }]);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.account_classification_audit',
        )).rows).toEqual([{ count: 4 }]);

        const replayAssignments = JSON.parse(approvedClassifications()) as Array<Record<string, string>>;
        replayAssignments[1] = {
            ...replayAssignments[1],
            traffic_class: 'e2e_test',
        };
        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'account-ledger-v1', TRUE
            )`,
            [JSON.stringify(replayAssignments)],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_INPUT_INVALID');

        const validButDifferentReplay = JSON.parse(approvedClassifications()) as Array<Record<string, string>>;
        validButDifferentReplay[0] = {
            ...validButDifferentReplay[0],
            lifecycle: 'retired',
            reason_code: 'DIFFERENT_REPLAY',
        };
        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'account-ledger-v1', TRUE
            )`,
            [JSON.stringify(validButDifferentReplay)],
        )).rejects.toThrow('ACCOUNT_PAID_EVER_ACTIVATION_CONFLICT');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects non-activation classification mutations after paid-ever activation', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        await activateAndReplay(db);

        const changedAssignments = JSON.parse(approvedClassifications()) as Array<Record<string, string>>;
        changedAssignments[0] = {
            ...changedAssignments[0],
            lifecycle: 'retired',
            reason_code: 'RETIRE_AFTER_ACTIVATION',
        };
        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'post-activation-change', FALSE
            )`,
            [JSON.stringify(changedAssignments)],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_ROLLOUT_ACTIVE');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rechecks the rollout after account locking when activation wins the interleaving', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        await db.exec(`
            CREATE FUNCTION public.activate_rollout_after_first_classification()
            RETURNS TRIGGER
            LANGUAGE plpgsql
            AS $$
            BEGIN
                UPDATE public.account_ledger_rollout_state
                SET paid_ever_state = 'active',
                    classification_command_version = 'activation-won',
                    classification_completed_at = pg_catalog.clock_timestamp(),
                    updated_at = pg_catalog.clock_timestamp()
                WHERE singleton IS TRUE;
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER activate_rollout_after_first_classification_trigger
            AFTER UPDATE OF classification_version ON public.users
            FOR EACH ROW
            WHEN (OLD.classification_version IS DISTINCT FROM NEW.classification_version)
            EXECUTE FUNCTION public.activate_rollout_after_first_classification();
        `);

        const assignments = JSON.stringify(
            (JSON.parse(approvedClassifications()) as Array<Record<string, string>>)
                .slice(0, 2),
        );
        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'racing-classification', FALSE
            )`,
            [assignments],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_ROLLOUT_ACTIVE');

        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.account_classification_audit`,
        )).rows).toEqual([{ count: 0 }]);
        expect((await db.query<{ paid_ever_state: string }>(
            `SELECT paid_ever_state
             FROM public.account_ledger_rollout_state`,
        )).rows).toEqual([{ paid_ever_state: 'pending' }]);
        expect((await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count
             FROM public.users
             WHERE classification_version = 'racing-classification'`,
        )).rows).toEqual([{ count: 0 }]);
    }, PGLITE_TEST_TIMEOUT_MS);

    it('does not turn pending, failed, cancelled, zero-value, or unaccepted orders into paid-ever during replay', async () => {
        const db = await createDatabase();
        const candidates = [
            {
                accountId: '30000000-0000-4000-8000-000000000001',
                orderId: '40000000-0000-4000-8000-000000000001',
                eventId: 'event-pending',
                paymentId: 'payment-pending',
                status: 'payment_pending',
                amountKrw: 14900,
                disposition: 'accepted',
                recordable: true,
            },
            {
                accountId: '30000000-0000-4000-8000-000000000002',
                orderId: '40000000-0000-4000-8000-000000000002',
                eventId: 'event-failed',
                paymentId: 'payment-failed',
                status: 'payment_failed',
                amountKrw: 14900,
                disposition: 'accepted',
                recordable: true,
            },
            {
                accountId: '30000000-0000-4000-8000-000000000003',
                orderId: '40000000-0000-4000-8000-000000000003',
                eventId: 'event-cancelled',
                paymentId: 'payment-cancelled',
                status: 'cancelled',
                amountKrw: 14900,
                disposition: 'accepted',
                recordable: true,
            },
            {
                accountId: '30000000-0000-4000-8000-000000000004',
                orderId: '40000000-0000-4000-8000-000000000004',
                eventId: 'event-zero-value',
                paymentId: 'payment-zero-value',
                status: 'paid',
                amountKrw: 0,
                disposition: 'accepted',
                recordable: false,
            },
            {
                accountId: '30000000-0000-4000-8000-000000000005',
                orderId: '40000000-0000-4000-8000-000000000005',
                eventId: 'event-unaccepted',
                paymentId: 'payment-unaccepted',
                status: 'paid',
                amountKrw: 14900,
                disposition: 'duplicate_event',
                recordable: false,
            },
        ] as const;
        for (const candidate of candidates) {
            await db.query(
                `INSERT INTO public.users(id, email, provider)
                 VALUES ($1::UUID, $2, 'kakao')`,
                [candidate.accountId, `${candidate.status}@invalid.test`],
            );
            await db.query(
                `INSERT INTO public.earlybird_orders(
                    id, user_id, status, payment_id, actual_groble_product_id,
                    actual_amount_krw, paid_at
                ) VALUES (
                    $1::UUID, $2::UUID, $3, $4, 'product-basic', $5,
                    '2026-08-02T00:00:00Z'::TIMESTAMP WITH TIME ZONE
                )`,
                [
                    candidate.orderId,
                    candidate.accountId,
                    candidate.status,
                    candidate.paymentId,
                    candidate.amountKrw,
                ],
            );
            await db.query(
                `INSERT INTO public.earlybird_webhook_events(
                    event_id, event_type, payment_id, product_id, amount_krw,
                    disposition, order_id
                ) VALUES (
                    $1, 'payment.completed', $2, 'product-basic', $3,
                    $4, $5::UUID
                )`,
                [
                    candidate.eventId,
                    candidate.paymentId,
                    candidate.amountKrw,
                    candidate.disposition,
                    candidate.orderId,
                ],
            );
        }

        const classifications = JSON.stringify(candidates.map(candidate => ({
            account_id: candidate.accountId,
            account_class: 'production',
            traffic_class: 'external',
            lifecycle: 'active',
            reason_code: 'NONQUALIFYING_STATUS',
        })));
        expect((await asService<{
            updated_count: number;
            evidence_count: number;
            paid_account_count: number;
        }>(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'account-ledger-v1', TRUE
            )`,
            [classifications],
        )).rows).toEqual([{
            updated_count: 5,
            evidence_count: 0,
            paid_account_count: 0,
        }]);
        for (const candidate of candidates) {
            const record = asService<{ recorded: boolean }>(
                db,
                `SELECT public.record_external_paid_ever($1::UUID, $2)
                     AS recorded`,
                [candidate.orderId, candidate.eventId],
            );
            if (candidate.recordable) {
                expect((await record).rows).toEqual([{ recorded: false }]);
            } else {
                await expect(record).rejects.toThrow('ACCOUNT_PAID_EVIDENCE_INVALID');
            }
        }
    }, PGLITE_TEST_TIMEOUT_MS);

    it('keeps paid evidence and classification audit immutable and preserves paid-ever monotonicity', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        await activateAndReplay(db);

        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.account_classification_audit',
        )).rows).toEqual([{ count: 4 }]);
        await expect(db.query(
            `UPDATE public.account_paid_evidence
             SET amount_krw = 1
             WHERE order_id = $1::UUID`,
            [EXTERNAL_EARLY_ORDER_ID],
        )).rejects.toThrow('ACCOUNT_PAID_EVIDENCE_IMMUTABLE');
        await expect(db.query(
            `UPDATE public.account_classification_audit
             SET reason_code = 'TAMPERED'
             WHERE account_id = $1::UUID`,
            [EXTERNAL_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_AUDIT_IMMUTABLE');
        await expect(db.query(
            `UPDATE public.users
             SET is_paid_user = FALSE
             WHERE id = $1::UUID`,
            [EXTERNAL_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_PAID_EVER_REGRESSION');
        await expect(db.query(
            `UPDATE public.users
             SET first_paid_at = '2026-08-05T00:00:00Z'::TIMESTAMP WITH TIME ZONE
             WHERE id = $1::UUID`,
            [EXTERNAL_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_FIRST_PAID_AT_REGRESSION');
        await expect(db.query(
            `UPDATE public.users
             SET first_paid_at = NULL
             WHERE id = $1::UUID`,
            [EXTERNAL_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_FIRST_PAID_AT_REGRESSION');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('derives active purchase from current order status and fails closed for retired accounts', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        await activateAndReplay(db);

        expect((await asService<{ has_active_purchase: boolean }>(
            db,
            `SELECT has_active_purchase
             FROM public.load_account_principal_v1($1::UUID)`,
            [EXTERNAL_ACCOUNT_ID],
        )).rows).toEqual([{ has_active_purchase: true }]);
        await db.query(
            `UPDATE public.earlybird_orders
             SET status = 'refunded'
             WHERE id IN ($1::UUID, $2::UUID)`,
            [EXTERNAL_LATE_ORDER_ID, EXTERNAL_EARLY_ORDER_ID],
        );
        expect((await asService<{ has_active_purchase: boolean }>(
            db,
            `SELECT has_active_purchase
             FROM public.load_account_principal_v1($1::UUID)`,
            [EXTERNAL_ACCOUNT_ID],
        )).rows).toEqual([{ has_active_purchase: false }]);
        expect((await db.query<{
            is_paid_user: boolean;
            first_paid_at_is_earliest: boolean;
        }>(
            `SELECT is_paid_user,
                first_paid_at = '2026-08-01T00:00:00Z'::TIMESTAMP WITH TIME ZONE
                    AS first_paid_at_is_earliest
             FROM public.users WHERE id = $1::UUID`,
            [EXTERNAL_ACCOUNT_ID],
        )).rows).toEqual([{
            is_paid_user: true,
            first_paid_at_is_earliest: true,
        }]);
        await expect(asService(
            db,
            'SELECT * FROM public.load_account_principal_v1($1::UUID)',
            [INTERNAL_TESTER_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_RETIRED');
        await expect(asService(
            db,
            'SELECT * FROM public.load_account_checkout_phone_v1($1::UUID)',
            [INTERNAL_TESTER_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_RETIRED');
        await expect(asService(
            db,
            `SELECT * FROM public.ensure_account_principal_v1(
                $1::UUID, 'tester@invalid.test', 'google', '{}'::JSONB
            )`,
            [INTERNAL_TESTER_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_RETIRED');
        await expect(asService(
            db,
            `SELECT * FROM public.upsert_kakao_account_profile_v1(
                $1::UUID, NULL, '{}'::JSONB
            )`,
            [INTERNAL_TESTER_ACCOUNT_ID],
        )).rejects.toThrow('ACCOUNT_RETIRED');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects a NULL profile patch at the database boundary', async () => {
        const db = await createDatabase();
        await expect(asService(
            db,
            `SELECT * FROM public.ensure_account_principal_v1(
                $1::UUID, 'new@invalid.test', 'google', NULL::JSONB
            )`,
            ['50000000-0000-4000-8000-000000000001'],
        )).rejects.toThrow('ACCOUNT_PRINCIPAL_INPUT_INVALID');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects a NULL provider at the database boundary', async () => {
        const db = await createDatabase();
        await expect(asService(
            db,
            `SELECT * FROM public.ensure_account_principal_v1(
                $1::UUID, 'new@invalid.test', NULL::TEXT, '{}'::JSONB
            )`,
            ['50000000-0000-4000-8000-000000000003'],
        )).rejects.toThrow('ACCOUNT_PRINCIPAL_INPUT_INVALID');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects NULL classification assignments at the database boundary', async () => {
        const db = await createDatabase();
        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                NULL::JSONB, 'account-ledger-v1', FALSE
            )`,
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_INPUT_INVALID');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects NULL classification account ids at the database boundary', async () => {
        const db = await createDatabase();
        const assignments = JSON.stringify([{
            account_id: null,
            account_class: 'production',
            traffic_class: 'external',
            lifecycle: 'active',
            reason_code: 'MISSING_ACCOUNT_ID',
        }]);

        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'account-ledger-v1', FALSE
            )`,
            [assignments],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_INPUT_INVALID');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('gives legacy user inserts a runtime classification version', async () => {
        const db = await createDatabase();
        await db.query(
            `INSERT INTO public.users(id, email, provider)
             VALUES ($1::UUID, 'legacy@invalid.test', 'google')`,
            ['50000000-0000-4000-8000-000000000002'],
        );

        expect((await db.query<{ classification_version: string | null }>(
            `SELECT classification_version
             FROM public.users
             WHERE id = $1::UUID`,
            ['50000000-0000-4000-8000-000000000002'],
        )).rows).toEqual([{ classification_version: 'runtime_default_v1' }]);
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects contradictory account and traffic classifications', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);
        const contradictory = JSON.stringify([{
            account_id: E2E_ACCOUNT_ID,
            account_class: 'e2e_test',
            traffic_class: 'external',
            lifecycle: 'active',
            reason_code: 'CONTRADICTORY_CLASS',
        }]);

        await expect(asService(
            db,
            `SELECT * FROM public.classify_account_principals_v1(
                $1::JSONB, 'contradictory-class', FALSE
            )`,
            [contradictory],
        )).rejects.toThrow('ACCOUNT_CLASSIFICATION_INPUT_INVALID');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('rejects contradictory classification through the users table boundary', async () => {
        const db = await createDatabase();
        await seedLedgerScenario(db);

        await expect(db.query(
            `UPDATE public.users
             SET account_class = 'e2e_test', traffic_class = 'external'
             WHERE id = $1::UUID`,
            [E2E_ACCOUNT_ID],
        )).rejects.toThrow('users_classification_pair_check');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('grants the bridge RPCs to service_role and rejects client-role execution', async () => {
        const db = await createDatabase();
        const grants = await db.query<{
            function_name: string;
            anon_allowed: boolean;
            authenticated_allowed: boolean;
            service_allowed: boolean;
        }>(`
            SELECT
                'load'::TEXT AS function_name,
                has_function_privilege(
                    'anon',
                    'public.load_account_principal_v1(uuid)'::REGPROCEDURE,
                    'EXECUTE'
                ) AS anon_allowed,
                has_function_privilege(
                    'authenticated',
                    'public.load_account_principal_v1(uuid)'::REGPROCEDURE,
                    'EXECUTE'
                ) AS authenticated_allowed,
                has_function_privilege(
                    'service_role',
                    'public.load_account_principal_v1(uuid)'::REGPROCEDURE,
                    'EXECUTE'
                ) AS service_allowed
            UNION ALL
            SELECT
                'classify'::TEXT,
                has_function_privilege(
                    'anon',
                    'public.classify_account_principals_v1(jsonb,text,boolean)'::REGPROCEDURE,
                    'EXECUTE'
                ),
                has_function_privilege(
                    'authenticated',
                    'public.classify_account_principals_v1(jsonb,text,boolean)'::REGPROCEDURE,
                    'EXECUTE'
                ),
                has_function_privilege(
                    'service_role',
                    'public.classify_account_principals_v1(jsonb,text,boolean)'::REGPROCEDURE,
                    'EXECUTE'
                )
            UNION ALL
            SELECT
                'paid_ever'::TEXT,
                has_function_privilege(
                    'anon',
                    'public.record_external_paid_ever(uuid,text)'::REGPROCEDURE,
                    'EXECUTE'
                ),
                has_function_privilege(
                    'authenticated',
                    'public.record_external_paid_ever(uuid,text)'::REGPROCEDURE,
                    'EXECUTE'
                ),
                has_function_privilege(
                    'service_role',
                    'public.record_external_paid_ever(uuid,text)'::REGPROCEDURE,
                    'EXECUTE'
                )
            ORDER BY function_name
        `);
        expect(grants.rows).toEqual([
            {
                function_name: 'classify',
                anon_allowed: false,
                authenticated_allowed: false,
                service_allowed: true,
            },
            {
                function_name: 'load',
                anon_allowed: false,
                authenticated_allowed: false,
                service_allowed: true,
            },
            {
                function_name: 'paid_ever',
                anon_allowed: false,
                authenticated_allowed: false,
                service_allowed: true,
            },
        ]);
        await expect(withRole(db, 'anon', () => db.query(
            'SELECT * FROM public.load_account_principal_v1($1::UUID)',
            [EXTERNAL_ACCOUNT_ID],
        ))).rejects.toThrow();
        await expect(withRole(db, 'authenticated', () => db.query(
            'SELECT * FROM public.load_account_principal_v1($1::UUID)',
            [EXTERNAL_ACCOUNT_ID],
        ))).rejects.toThrow();
    }, PGLITE_TEST_TIMEOUT_MS);

    it('keeps the physical users relation service-role-only during Phase A+B', async () => {
        const db = await createDatabase();
        const grants = await db.query<{
            anon_select: boolean;
            authenticated_select: boolean;
            service_select: boolean;
            service_update: boolean;
        }>(`
            SELECT
                has_table_privilege('anon', 'public.users', 'SELECT') AS anon_select,
                has_table_privilege('authenticated', 'public.users', 'SELECT')
                    AS authenticated_select,
                has_table_privilege('service_role', 'public.users', 'SELECT')
                    AS service_select,
                has_table_privilege('service_role', 'public.users', 'UPDATE')
                    AS service_update
        `);

        expect(grants.rows).toEqual([{
            anon_select: false,
            authenticated_select: false,
            service_select: true,
            service_update: true,
        }]);
        await expect(withRole(db, 'authenticated', () => db.query(
            'SELECT id, lifecycle FROM public.users',
        ))).rejects.toThrow();
    }, PGLITE_TEST_TIMEOUT_MS);

    it('recomputes the bounded legacy E2E candidate set and rejects a stale planner payload', async () => {
        const db = await createDatabase();
        await db.exec(`
            INSERT INTO public.users(id, email, provider, classification_version) VALUES
                ('${E2E_ACCOUNT_ID}', 'legacy-e2e@invalid.test', 'kakao', NULL),
                ('${OPERATOR_ACCOUNT_ID}', 'operator@invalid.test', 'google', NULL),
                ('${INTERNAL_TESTER_ACCOUNT_ID}', 'internal@invalid.test', 'google', NULL);
            INSERT INTO public.analysis_requests(id, user_id) VALUES
                ('${EXTERNAL_LATE_ORDER_ID}', '${E2E_ACCOUNT_ID}');
            INSERT INTO public.earlybird_orders(
                id, user_id, status, payment_id, actual_groble_product_id,
                actual_amount_krw, paid_at
            ) VALUES (
                '${E2E_ORDER_ID}', '${E2E_ACCOUNT_ID}', 'completed', 'legacy-payment',
                'legacy-product', 1000, pg_catalog.clock_timestamp()
            );
        `);

        const candidates = await asService<{ account_id: string }>(db,
            'SELECT account_id FROM public.list_account_ledger_legacy_e2e_candidates_v1()',
        );
        expect(candidates.rows.map(row => row.account_id)).toEqual([E2E_ACCOUNT_ID]);

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
            JSON.stringify([E2E_ACCOUNT_ID]),
            JSON.stringify([OPERATOR_ACCOUNT_ID]),
            JSON.stringify([INTERNAL_TESTER_ACCOUNT_ID]),
        ]);
        expect(plan.rows).toEqual([{
            total_count: 3,
            legacy_e2e_count: 1,
            operator_count: 1,
            internal_tester_count: 1,
        }]);
        await expect(asService(db, `
            SELECT * FROM public.build_account_ledger_classification_plan_v1(
                $1::JSONB, $2::JSONB, $3::JSONB
            )
        `, [
            JSON.stringify([EXTERNAL_ACCOUNT_ID]),
            JSON.stringify([OPERATOR_ACCOUNT_ID]),
            JSON.stringify([INTERNAL_TESTER_ACCOUNT_ID]),
        ])).rejects.toThrow('ACCOUNT_CLASSIFICATION_LEGACY_CANDIDATE_DRIFT');
    }, PGLITE_TEST_TIMEOUT_MS);

    it('keeps runner provisioning and reads fail-closed until the exact active command, Auth email, metadata, and principal agree', async () => {
        const db = await createDatabase();
        const basicRunnerId = '50000000-0000-4000-8000-000000000001';
        const standardRunnerId = '50000000-0000-4000-8000-000000000002';
        const duplicateBasicRunnerId = '50000000-0000-4000-8000-000000000003';
        await db.exec(`
            INSERT INTO auth.users(id, email, raw_app_meta_data) VALUES
                ('${basicRunnerId}', 'basic-runner@invalid.test', '{"analysis_test_runner_v1":"basic"}'::JSONB),
                ('${standardRunnerId}', 'standard-runner@invalid.test', '{"analysis_test_runner_v1":"standard"}'::JSONB),
                ('${duplicateBasicRunnerId}', 'duplicate-runner@invalid.test', '{"analysis_test_runner_v1":"basic"}'::JSONB);
        `);

        await expect(asService(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'account-ledger-v1'
            )
        `, [basicRunnerId, 'basic-runner@invalid.test']))
            .rejects.toThrow('ACCOUNT_E2E_TEST_RUNNER_ROLLOUT_NOT_ACTIVE');
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.account_e2e_test_runners',
        )).rows).toEqual([{ count: 0 }]);

        await db.exec(`
            UPDATE public.account_ledger_rollout_state
            SET paid_ever_state = 'active',
                classification_command_version = 'account-ledger-v1',
                classification_completed_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
            WHERE singleton IS TRUE;
        `);

        await expect(asService(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'wrong-command-version'
            )
        `, [basicRunnerId, 'basic-runner@invalid.test']))
            .rejects.toThrow('ACCOUNT_E2E_TEST_RUNNER_ROLLOUT_COMMAND_MISMATCH');
        await expect(asService(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'account-ledger-v1'
            )
        `, [basicRunnerId, 'wrong-runner@invalid.test']))
            .rejects.toThrow('ACCOUNT_E2E_TEST_RUNNER_AUTH_EMAIL_MISMATCH');

        const firstBasic = await asService<{ runner_plan: string; created: boolean }>(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'account-ledger-v1'
            )
        `, [basicRunnerId, 'basic-runner@invalid.test']);
        const replayBasic = await asService<{ runner_plan: string; created: boolean }>(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'account-ledger-v1'
            )
        `, [basicRunnerId, 'basic-runner@invalid.test']);
        await asService(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'standard', 'account-ledger-v1'
            )
        `, [standardRunnerId, 'standard-runner@invalid.test']);
        expect(firstBasic.rows).toEqual([{ runner_plan: 'basic', created: true }]);
        expect(replayBasic.rows).toEqual([{ runner_plan: 'basic', created: false }]);
        await expect(asService(db, `
            SELECT * FROM public.provision_e2e_test_runner_v1(
                $1::UUID, $2::TEXT, 'basic', 'account-ledger-v1'
            )
        `, [duplicateBasicRunnerId, 'duplicate-runner@invalid.test']))
            .rejects.toThrow('ACCOUNT_E2E_TEST_RUNNER_PLAN_ALREADY_BOUND');

        const plans = await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.list_e2e_test_runner_plans_v1()',
        );
        expect(plans.rows.map(row => row.runner_plan)).toEqual(['basic', 'standard']);

        await db.exec(`
            UPDATE public.account_ledger_rollout_state
            SET classification_command_version = 'wrong-command-version'
            WHERE singleton IS TRUE;
        `);
        expect((await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.load_e2e_test_runner_v1($1::UUID)',
            [basicRunnerId],
        )).rows).toEqual([]);
        expect((await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.list_e2e_test_runner_plans_v1()',
        )).rows).toEqual([]);
        await db.exec(`
            UPDATE public.account_ledger_rollout_state
            SET classification_command_version = 'account-ledger-v1'
            WHERE singleton IS TRUE;
            UPDATE auth.users
            SET email = 'wrong-runner@invalid.test'
            WHERE id = '${basicRunnerId}';
        `);
        expect((await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.load_e2e_test_runner_v1($1::UUID)',
            [basicRunnerId],
        )).rows).toEqual([]);
        await db.exec(`
            UPDATE auth.users
            SET email = 'basic-runner@invalid.test',
                raw_app_meta_data = '{"analysis_test_runner_v1":"standard"}'::JSONB
            WHERE id = '${basicRunnerId}';
        `);
        expect((await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.load_e2e_test_runner_v1($1::UUID)',
            [basicRunnerId],
        )).rows).toEqual([]);
        await db.exec(`
            UPDATE auth.users
            SET raw_app_meta_data = '{"analysis_test_runner_v1":"basic"}'::JSONB
            WHERE id = '${basicRunnerId}';
        `);
        await asService(db,
            "UPDATE public.users SET lifecycle = 'retired' WHERE id = $1::UUID",
            [basicRunnerId],
        );
        const retiredRunner = await asService<{ runner_plan: string }>(db,
            'SELECT runner_plan FROM public.load_e2e_test_runner_v1($1::UUID)',
            [basicRunnerId],
        );
        expect(retiredRunner.rows).toEqual([]);
    }, PGLITE_TEST_TIMEOUT_MS);
});
