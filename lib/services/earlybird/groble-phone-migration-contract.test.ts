import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const MIGRATION_SUFFIXES = [
    'add_groble_phone_matching.sql',
    'activate_groble_phone_checkout.sql',
    'backfill_groble_phone_matching.sql',
    'validate_groble_phone_matching.sql',
    'activate_groble_phone_finalization.sql',
] as const;
const migrationFiles = readdirSync(migrationsDirectory)
    .filter(file => MIGRATION_SUFFIXES.some(suffix => file.endsWith(`_${suffix}`)))
    .sort();
const migrations = migrationFiles.map(file =>
    readFileSync(new URL(file, migrationsDirectory), 'utf8')
);

function migrationFor(suffix: typeof MIGRATION_SUFFIXES[number]): string {
    const index = migrationFiles.findIndex(file => file.endsWith(`_${suffix}`));
    return index >= 0 ? migrations[index] : '';
}

const ddlMigration = migrationFor('add_groble_phone_matching.sql');
const checkoutMigration = migrationFor('activate_groble_phone_checkout.sql');
const backfillMigration = migrationFor('backfill_groble_phone_matching.sql');
const validationMigration = migrationFor('validate_groble_phone_matching.sql');
const finalizationMigration = migrationFor('activate_groble_phone_finalization.sql');
const migration = migrations.join('\n');

const AUTHENTICATED_ORDER_COLUMNS = [
    'id',
    'user_id',
    'target_instagram_id',
    'plan_id',
    'actual_amount_krw',
    'status',
    'paid_at',
    'due_at',
    'plan_sequence',
    'result_request_id',
    'created_at',
];

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = migration.indexOf('\n$$;', start);
    return start >= 0 && end >= 0 ? migration.slice(start, end + 4) : '';
}

describe('Groble phone matching migration contract', () => {
    it('is five ordered forward migrations after the applied presale migration', () => {
        expect(migrationFiles.map(file => file.replace(/^\d+_/, ''))).toEqual(
            MIGRATION_SUFFIXES
        );
        for (const file of migrationFiles) {
            expect(file.localeCompare(
                '20260717140000_add_groble_earlybird_presale.sql'
            )).toBeGreaterThan(0);
        }
    });

    it('isolates DDL, checkout transition, backfill, validation/indexes, and finalization', () => {
        for (const source of migrations) {
            expect(source).toContain("SET LOCAL lock_timeout = '5s'");
            expect(source).toContain("SET LOCAL statement_timeout = '2min'");

            const addsColumnsOrConstraints = /^ALTER TABLE[\s\S]*?\bADD (?:COLUMN|CONSTRAINT)\b/m
                .test(source);
            const backfillsRows = /^UPDATE public\.(?:users|earlybird_orders)\b/m.test(source);
            expect(addsColumnsOrConstraints && backfillsRows).toBe(false);
        }

        expect(ddlMigration).toContain('ADD COLUMN phone_number_normalized TEXT');
        expect(ddlMigration.match(/NOT VALID/g)).toHaveLength(8);
        expect(ddlMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.normalize_kr_mobile_e164'
        );
        expect(ddlMigration).not.toMatch(/^UPDATE public\./m);
        expect(ddlMigration).not.toContain('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        expect(ddlMigration).not.toContain('VALIDATE CONSTRAINT');
        expect(ddlMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(ddlMigration).not.toContain('create_earlybird_checkout');

        expect(checkoutMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );
        expect(checkoutMigration).toMatch(
            /SELECT buyer\.provider, buyer\.phone_number,[\s\S]*?buyer\.phone_number_normalized/
        );
        expect(checkoutMigration).toMatch(
            /COALESCE\([\s\S]*?public\.normalize_kr_mobile_e164\(v_user_phone_number\)[\s\S]*?v_user_phone_number_normalized[\s\S]*?\)/
        );
        expect(checkoutMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\(/
        );
        expect(checkoutMigration).not.toMatch(/^ALTER TABLE/m);
        expect(checkoutMigration).not.toMatch(/^UPDATE public\./m);
        expect(checkoutMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(checkoutMigration).not.toContain('finalize_earlybird_groble_payment');

        expect(backfillMigration.match(
            /^UPDATE public\.(?:users|earlybird_orders)\b/gm
        )).toHaveLength(2);
        expect(backfillMigration).toContain('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        expect(backfillMigration).not.toMatch(/^ALTER TABLE/m);
        expect(backfillMigration).not.toMatch(/^CREATE (?:OR REPLACE FUNCTION|(?:UNIQUE )?INDEX)/m);
        expect(backfillMigration).not.toMatch(/^(?:GRANT|REVOKE)\b/m);

        expect(validationMigration.match(/VALIDATE CONSTRAINT/g)).toHaveLength(8);
        expect(validationMigration.match(/^CREATE (?:UNIQUE )?INDEX/gm)).toHaveLength(3);
        expect(validationMigration).not.toContain('ADD COLUMN');
        expect(validationMigration).not.toContain('NOT VALID');
        expect(validationMigration).not.toMatch(/^UPDATE public\./m);
        expect(validationMigration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(validationMigration).not.toMatch(/^(?:GRANT|REVOKE)\b/m);

        expect(finalizationMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment'
        );
        expect(finalizationMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.set_earlybird_refund_status'
        );
        expect(finalizationMigration).toMatch(/^GRANT SELECT \(/m);
        expect(finalizationMigration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );
        expect(finalizationMigration).not.toMatch(/^ALTER TABLE/m);
        expect(finalizationMigration).not.toMatch(/^UPDATE public\./m);
        expect(finalizationMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(finalizationMigration).not.toContain('normalize_kr_mobile_e164');
    });

    it('normalizes and backfills users before rejecting duplicates and indexing', () => {
        expect(migration).toContain('ADD COLUMN phone_number_normalized TEXT');
        expect(migration).toMatch(
            /phone_number_normalized IS NULL\s+OR phone_number_normalized ~ '\^\\\+8210\[0-9\]\{8\}\$'/
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.normalize_kr_mobile_e164\(p_value TEXT\)[\s\S]*?IMMUTABLE[\s\S]*?(?:STRICT|RETURNS NULL ON NULL INPUT)[\s\S]*?SET search_path = ''/
        );
        expect(migration).toMatch(
            /regexp_replace\(p_value, '\[\^0-9\]', '', 'g'\)[\s\S]*?\^010\[0-9\]\{8\}\$[\s\S]*?\^8210\[0-9\]\{8\}\$/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.normalize_kr_mobile_e164\(TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );

        const backfill = migration.indexOf(
            'SET phone_number_normalized = COALESCE('
        );
        const duplicateGuard = migration.indexOf('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX users_phone_number_normalized_unique');
        expect(backfill).toBeGreaterThanOrEqual(0);
        expect(backfillMigration).toMatch(
            /SET phone_number_normalized = COALESCE\(\s*public\.normalize_kr_mobile_e164\(phone_number\),\s*phone_number_normalized\s*\)/
        );
        expect(duplicateGuard).toBeGreaterThan(backfill);
        expect(uniqueIndex).toBeGreaterThan(duplicateGuard);
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX users_phone_number_normalized_unique\s+ON public\.users\(phone_number_normalized\)\s+WHERE phone_number_normalized IS NOT NULL/
        );
    });

    it('bounds migration locks and defers table scans until constraint validation', () => {
        expect(migration).not.toContain('LOCK TABLE public.users');
        expect(validationMigration).toMatch(/row-count[\s\S]*?maintenance window/i);
        expect(migration).not.toContain('CREATE INDEX CONCURRENTLY');
    });

    it('adds bounded service-only order snapshots and webhook evidence', () => {
        expect(migration).toContain('expected_buyer_phone_number_normalized TEXT');
        for (const column of [
            'groble_buyer_email TEXT',
            'groble_buyer_phone_number TEXT',
            'groble_buyer_display_name TEXT',
        ]) {
            expect(migration.match(new RegExp(column, 'g'))).toHaveLength(2);
        }
        expect(migration).toMatch(/groble_buyer_email[\s\S]*?char_length\(groble_buyer_email\) <= 320/);
        expect(migration).toMatch(/groble_buyer_phone_number[\s\S]*?char_length\(groble_buyer_phone_number\) <= 64/);
        expect(migration).toMatch(/groble_buyer_display_name[\s\S]*?char_length\(groble_buyer_display_name\) <= 100/);
        expect(migration).toMatch(
            /CREATE INDEX earlybird_orders_pending_phone_product_idx[\s\S]*?expected_buyer_phone_number_normalized, expected_groble_product_id[\s\S]*?WHERE status = 'payment_pending'/
        );
        expect(migration).toMatch(
            /UPDATE public\.earlybird_orders[\s\S]*?SET expected_buyer_phone_number_normalized = buyer\.phone_number_normalized[\s\S]*?status IN \('payment_pending', 'cancelled'\)[\s\S]*?payment_id IS NULL/
        );
    });

    it('preserves the exact authenticated order grant and excludes all new evidence', () => {
        const grant = migration.match(
            /GRANT SELECT \(([\s\S]*?)\)\s+ON public\.earlybird_orders TO authenticated/
        )?.[1];
        expect(grant).toBeDefined();
        const grantedColumns = grant
            ?.split(',')
            .map(column => column.trim())
            .filter(Boolean);
        expect(grantedColumns).toEqual(AUTHENTICATED_ORDER_COLUMNS);
        expect(grant).not.toMatch(/groble_buyer|expected_buyer_phone/);
        expect(migration).not.toMatch(
            /GRANT SELECT[^;]*(?:groble_buyer|expected_buyer_phone)[^;]*;/
        );
        expect(migration).not.toMatch(/GRANT SELECT ON TABLE public\.earlybird_webhook_events/i);
    });

    it('keeps canonical and rolling-deploy finalizers search-path safe and service-only', () => {
        for (const functionName of [
            'create_earlybird_checkout',
            'finalize_earlybird_groble_payment',
        ]) {
            const definition = functionDefinition(functionName);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
        }
        expect(migration).toContain("RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED'");
        expect(migration).not.toMatch(/DROP FUNCTION public\.finalize_earlybird_groble_payment/);
        expect(migration.match(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(/g
        )).toHaveLength(2);
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?p_buyer_email TEXT,[\s\S]*?p_buyer_phone_normalized TEXT,[\s\S]*?p_buyer_phone_raw TEXT,[\s\S]*?p_buyer_display_name TEXT,[\s\S]*?p_product_id TEXT/
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(\s*p_event_id TEXT,[\s\S]*?p_buyer_email TEXT,[\s\S]*?p_product_id TEXT,[\s\S]*?p_paid_at TIMESTAMP WITH TIME ZONE\s*\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''[\s\S]*?p_buyer_phone_normalized => NULL::TEXT[\s\S]*?p_buyer_phone_raw => NULL::TEXT[\s\S]*?p_buyer_display_name => NULL::TEXT/
        );
        expect(migration).toMatch(/post-drain migration/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?TO service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?TO service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) TO service_role/
        );
    });

    it('locks every potential user deterministically before authoritative matching', () => {
        const definition = functionDefinition('finalize_earlybird_groble_payment');
        const lockLoop = definition.indexOf('FOR v_lock_user_id IN');
        const firstCandidateCount = definition.indexOf('INTO v_candidate_count');

        expect(lockLoop).toBeGreaterThanOrEqual(0);
        expect(definition).toContain('ORDER BY potential_user.user_id::TEXT');
        expect(definition).toMatch(
            /buyer\.phone_number_normalized = p_buyer_phone_normalized[\s\S]*?UNION[\s\S]*?lower\(pg_catalog\.btrim\(buyer\.email\)\)[\s\S]*?UNION[\s\S]*?status IN \('payment_pending', 'cancelled'\)[\s\S]*?expected_buyer_phone_number_normalized/
        );
        expect(firstCandidateCount).toBeGreaterThan(lockLoop);
    });

    it('serializes profile snapshots and refund transitions with the user lock', () => {
        const checkout = functionDefinition('create_earlybird_checkout');
        expect(checkout).toMatch(
            /SELECT buyer\.provider, buyer\.phone_number, buyer\.phone_number_normalized[\s\S]*?WHERE buyer\.id = p_user_id\s+FOR UPDATE/
        );

        const refund = functionDefinition('set_earlybird_refund_status');
        const userDiscovery = refund.indexOf('SELECT earlybird_order.user_id');
        const userLock = refund.indexOf('pg_advisory_xact_lock');
        const orderLock = refund.indexOf('FOR UPDATE');
        expect(refund).toContain('SECURITY DEFINER');
        expect(refund).toContain("SET search_path = ''");
        expect(userDiscovery).toBeGreaterThanOrEqual(0);
        expect(userLock).toBeGreaterThan(userDiscovery);
        expect(orderLock).toBeGreaterThan(userLock);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_earlybird_refund_status\(UUID, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_earlybird_refund_status\(UUID, TEXT\)[\s\S]*?TO service_role/
        );
    });
});
