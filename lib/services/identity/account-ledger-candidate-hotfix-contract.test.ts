import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260812010000_correct_account_ledger_legacy_e2e_marker.sql',
    import.meta.url,
), 'utf8');

function candidateFunctionBody(): string {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1',
    );
    const end = migration.indexOf('$$;', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('account-ledger candidate corrective migration contract', () => {
    it('is a new forward-only migration that replaces the candidate function', () => {
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1()',
        );
        expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/i);
        expect(migration).toContain('SET LOCAL lock_timeout');
        expect(migration).toContain("SET LOCAL statement_timeout");
    });

    it('requires the complete bounded synthetic payment lineage and rejects drift', () => {
        const body = candidateFunctionBody();

        expect(body).toContain('account.classification_version IS NULL');
        expect(body).toContain('FROM auth.users AS auth_user');
        expect(body).toContain('FROM public.analysis_requests AS analysis_request');
        expect(body).toContain('FROM public.earlybird_orders AS paid_order');
        expect(body).toContain('webhook_event.order_id = paid_order.id');
        expect(body).toContain("webhook_event.event_type = 'payment.completed'");
        expect(body).toContain("webhook_event.disposition = 'accepted'");
        expect(body).toContain('webhook_event.payment_id = paid_order.payment_id');
        expect(body).toContain(
            'webhook_event.product_id = paid_order.actual_groble_product_id',
        );
        expect(body).toContain('webhook_event.amount_krw = paid_order.actual_amount_krw');
        expect(body).toContain("paid_order.payment_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'");
        expect(body).toContain("webhook_event.event_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'");
        expect(body).toContain(
            "webhook_event.idempotency_key ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'",
        );
        expect(body).toContain(
            "webhook_event.payment_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'",
        );
        expect(body).toContain('NOT EXISTS');
        expect(body).toContain('IS DISTINCT FROM');
    });

    it('keeps the replacement service-role-only with a fixed search path', () => {
        expect(migration).toMatch(
            /LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/,
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.account_ledger_legacy_e2e_candidate_ids_v1\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.account_ledger_legacy_e2e_candidate_ids_v1\(\)[\s\S]*?TO (?:anon|authenticated|service_role);/,
        );
    });
});
