import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const activeMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260720100000_shorten_earlybird_delivery_window.sql',
        import.meta.url
    ),
    'utf8'
);
const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123100_fix_discounted_late_cancelled_payment.sql',
        import.meta.url
    ),
    'utf8'
);

const functionStart =
    'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment(';

function replaceLateCancelledAmountChecks(sql: string): string {
    return sql
        .replace(
            /^(\s*)AND (cancelled_candidate|cancelled_order)\.expected_amount_krw = p_amount_krw/gm,
            '$1AND $2.expected_amount_krw >= p_amount_krw\n$1AND p_amount_krw >= 0'
        )
        .replace(
            /^(\s*)OR candidate\.expected_amount_krw = p_amount_krw/gm,
            '$1OR candidate.expected_amount_krw >= p_amount_krw\n$1AND p_amount_krw >= 0'
        );
}

describe('discounted late-cancel migration contract', () => {
    it('changes only the five late-cancel amount comparisons in both overloads', () => {
        const activeFunctions = activeMigration.slice(
            activeMigration.indexOf(functionStart)
        );
        const migratedFunctions = migration.slice(migration.indexOf(functionStart));

        expect(migratedFunctions).toBe(
            replaceLateCancelledAmountChecks(activeFunctions)
        );
        expect(migration.match(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(/g
        )).toHaveLength(2);
        expect(migration.match(
            /expected_amount_krw >= p_amount_krw/g
        )).toHaveLength(5);
        expect(migration.match(/p_amount_krw >= 0/g)).toHaveLength(5);
    });

    it('retains matching, locking, delivery, and role boundaries', () => {
        expect(migration).toContain('pg_advisory_xact_lock');
        expect(migration).toContain(
            "expected_groble_product_id = p_product_id"
        );
        expect(migration).toContain(
            "buyer_match_policy = 'verified_kakao_phone'"
        );
        expect(migration).toContain("buyer_match_policy = 'legacy_email'");
        expect(migration).toContain("due_at = p_paid_at + INTERVAL '24 hours'");
        expect(migration).toContain("'late_cancelled_payment'::TEXT");
        expect(migration).toContain("'GROBLE_CANONICAL_PHONE_REQUIRED'");
        expect(migration).not.toMatch(
            /(?:cancelled_candidate|cancelled_order)\.expected_amount_krw = p_amount_krw/
        );
    });
});
