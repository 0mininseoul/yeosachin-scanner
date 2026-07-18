import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsDirectory).filter(file =>
    file.endsWith('_add_groble_phone_matching.sql')
);
const migration = migrationFiles.length === 1
    ? readFileSync(new URL(migrationFiles[0], migrationsDirectory), 'utf8')
    : '';

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
    it('is one new forward migration after the applied presale migration', () => {
        expect(migrationFiles).toHaveLength(1);
        expect(migrationFiles[0].localeCompare(
            '20260717140000_add_groble_earlybird_presale.sql'
        )).toBeGreaterThan(0);
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
            'SET phone_number_normalized = public.normalize_kr_mobile_e164(phone_number)'
        );
        const duplicateGuard = migration.indexOf('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX users_phone_number_normalized_unique');
        expect(backfill).toBeGreaterThanOrEqual(0);
        expect(duplicateGuard).toBeGreaterThan(backfill);
        expect(uniqueIndex).toBeGreaterThan(duplicateGuard);
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX users_phone_number_normalized_unique\s+ON public\.users\(phone_number_normalized\)\s+WHERE phone_number_normalized IS NOT NULL/
        );
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
            /UPDATE public\.earlybird_orders[\s\S]*?SET expected_buyer_phone_number_normalized = buyer\.phone_number_normalized[\s\S]*?status = 'payment_pending'/
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

    it('replaces checkout and finalization with empty search paths and service-only execution', () => {
        for (const functionName of [
            'create_earlybird_checkout',
            'finalize_earlybird_groble_payment',
        ]) {
            const definition = functionDefinition(functionName);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
        }
        expect(migration).toContain("RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED'");
        expect(migration).toMatch(
            /DROP FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\)/
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?p_buyer_email TEXT,[\s\S]*?p_buyer_phone_normalized TEXT,[\s\S]*?p_buyer_phone_raw TEXT,[\s\S]*?p_buyer_display_name TEXT,[\s\S]*?p_product_id TEXT/
        );
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
    });
});
