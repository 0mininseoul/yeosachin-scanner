import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDirectory = resolve(process.cwd(), 'supabase/migrations');
const migrationName = readdirSync(migrationDirectory)
    .find(name => name.endsWith('_add_account_principal_bridge.sql'));
const migration = migrationName
    ? readFileSync(resolve(migrationDirectory, migrationName), 'utf8')
    : '';

function source(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('account principal additive migration contract', () => {
    it('adds bounded classification and paid-ever state without performing the rename cutover', () => {
        expect(migrationName).toBeDefined();
        expect(migration).toMatch(/ALTER TABLE public\.users[\s\S]*ADD COLUMN account_class TEXT NOT NULL DEFAULT 'production'/);
        expect(migration).toMatch(/ADD COLUMN traffic_class TEXT NOT NULL DEFAULT 'external'/);
        expect(migration).toMatch(/ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'/);
        expect(migration).toMatch(/ADD COLUMN first_paid_at TIMESTAMP WITH TIME ZONE/);
        expect(migration).toMatch(/account_class IN \('production', 'e2e_test'\)/);
        expect(migration).toMatch(
            /traffic_class IN\s*\(\s*'external',\s*'operator',\s*'e2e_test',\s*'internal_tester'\s*\)/,
        );
        expect(migration).toMatch(/lifecycle IN \('active', 'retired'\)/);
        expect(migration).toMatch(
            /REVOKE ALL ON TABLE public\.users\s+FROM PUBLIC, anon, authenticated/,
        );
        expect(migration).toMatch(
            /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.users\s+TO service_role/,
        );
        expect(migration).not.toMatch(/ALTER TABLE public\.users RENAME TO account_principals/i);
        expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?VIEW public\.users/i);
    });

    it('creates a service-only, immutable paid evidence boundary and derived active-purchase state', () => {
        expect(migration).toMatch(/CREATE TABLE public\.account_paid_evidence/);
        expect(migration).toMatch(/order_id UUID PRIMARY KEY[\s\S]*REFERENCES public\.earlybird_orders/);
        expect(migration).toMatch(/event_id (?:TEXT|VARCHAR\(256\)) NOT NULL UNIQUE[\s\S]*REFERENCES public\.earlybird_webhook_events/);
        expect(migration).toMatch(/CREATE (?:OR REPLACE )?FUNCTION public\.record_external_paid_ever/);
        expect(migration).toMatch(/event_type = 'payment\.completed'/);
        expect(migration).toMatch(/disposition = 'accepted'/);
        expect(migration).toMatch(/actual_amount_krw > 0/);
        expect(migration).toMatch(/traffic_class = 'external'/);
        expect(migration).toMatch(/is_paid_user = TRUE/);
        expect(migration).toMatch(/first_paid_at = CASE/);
        expect(migration).toMatch(/CREATE (?:OR REPLACE )?FUNCTION public\.load_account_principal_v1/);
        expect(migration).toMatch(/has_active_purchase BOOLEAN/);
        expect(migration).toMatch(/'paid', 'analysis_in_progress', 'completed'/);
    });

    it('keeps every bridge function security-definer and service-role only', () => {
        const functionNames = [
            'load_account_principal_v1',
            'ensure_account_principal_v1',
            'upsert_kakao_account_profile_v1',
            'load_account_checkout_phone_v1',
            'load_account_classification_v1',
            'record_external_paid_ever',
            'classify_account_principals_v1',
            'list_account_ledger_legacy_e2e_candidates_v1',
            'build_account_ledger_classification_plan_v1',
            'load_account_ledger_rollout_state_v1',
            'provision_e2e_test_runner_v1',
            'load_e2e_test_runner_v1',
            'list_e2e_test_runner_plans_v1',
        ];

        for (const functionName of functionNames) {
            expect(migration).toMatch(new RegExp(
                `FUNCTION public\\.${functionName}\\([\\s\\S]*?SECURITY DEFINER[\\s\\S]*?SET search_path = ''`,
            ));
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated`,
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]*?TO service_role`,
            ));
        }
    });

    it('recomputes the legacy candidate set in the database without UUID or email allowlists', () => {
        const start = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1',
        );
        const end = migration.indexOf('$$;', start);
        const body = migration.slice(start, end);

        expect(start).toBeGreaterThanOrEqual(0);
        expect(body).toContain('FROM auth.users AS auth_user');
        expect(body).toContain('FROM public.analysis_requests AS analysis_request');
        expect(body).toContain('FROM public.earlybird_orders AS paid_order');
        expect(body).toContain("webhook_event.disposition = 'accepted'");
        expect(body).not.toContain('account.email');
        expect(body).not.toContain('IN (\'');
    });

    it('keeps the Basic and Standard runner registry immutable and validates Auth metadata', () => {
        expect(migration).toMatch(/CREATE TABLE public\.account_e2e_test_runners/);
        expect(migration).toMatch(/runner_plan TEXT NOT NULL UNIQUE CHECK \(runner_plan IN \('basic', 'standard'\)\)/);
        expect(migration).toMatch(/CREATE TRIGGER reject_account_e2e_test_runner_mutation_before_write/);
        expect(migration).toMatch(/raw_app_meta_data ->> 'analysis_test_runner_v1'/);
        expect(migration).toMatch(/ACCOUNT_E2E_TEST_RUNNER_PLAN_ALREADY_BOUND/);
        expect(migration).toMatch(/ACCOUNT_E2E_TEST_RUNNER_AUTH_METADATA_MISMATCH/);
    });

    it('reaches paid-ever recording from every payment completion entry point', () => {
        const calls = migration.match(/record_external_paid_ever\(/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(4);
        expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment_by_reference/);
        expect(migration.match(/CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(/g)).toHaveLength(2);
    });

    it('takes each classification account advisory lock before its row lock', () => {
        const start = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.classify_account_principals_v1',
        );
        const end = migration.indexOf('$$;', start);
        const body = migration.slice(start, end);
        const advisoryLock = body.indexOf('pg_advisory_xact_lock');
        const rowLock = body.indexOf('FOR UPDATE;');

        expect(advisoryLock).toBeGreaterThanOrEqual(0);
        expect(advisoryLock).toBeLessThan(rowLock);
        expect(body).toContain(
            "hashtextextended(v_account_id::TEXT, 0)",
        );
    });

    it('takes the paid-ever account advisory lock before the rollout share lock', () => {
        const start = migration.indexOf(
            'CREATE OR REPLACE FUNCTION public.record_external_paid_ever',
        );
        const end = migration.indexOf('$$;', start);
        const body = migration.slice(start, end);
        const advisoryLock = body.indexOf('pg_advisory_xact_lock');
        const rolloutLock = body.indexOf(
            'FROM public.account_ledger_rollout_state',
        );

        expect(advisoryLock).toBeGreaterThanOrEqual(0);
        expect(advisoryLock).toBeLessThan(rolloutLock);
        expect(body).toContain(
            "hashtextextended(v_account_id::TEXT, 0)",
        );
    });

    it('redeclares the existing owner-history signature, security boundary, and ACL after replacement', () => {
        const start = migration.lastIndexOf(
            'CREATE OR REPLACE FUNCTION public.load_analysis_owner_history_v1()',
        );
        expect(start).toBeGreaterThanOrEqual(0);
        const replacement = migration.slice(start);

        expect(replacement).toMatch(
            /CREATE OR REPLACE FUNCTION public\.load_analysis_owner_history_v1\(\)\s+RETURNS JSONB\s+LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/,
        );
        expect(replacement).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+FROM PUBLIC, anon, authenticated, service_role/,
        );
        expect(replacement).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+TO authenticated/,
        );
        expect(replacement).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_owner_history_v1\(\)\s+TO (?:anon|service_role)/,
        );
    });
});

describe('account principal application bridge contract', () => {
    it('removes direct users relation access from the five application call sites', () => {
        const currentUserSource = source('app/api/user/me/route.ts');
        const callbackSource = source('app/auth/callback/route.ts');
        const checkoutSource = source('lib/services/earlybird/store.ts');
        const principalStoreSource = source(
            'lib/services/identity/account-principal-store.ts',
        );
        const applicationSources = [
            currentUserSource,
            callbackSource,
            checkoutSource,
            principalStoreSource,
        ].join('\n');

        expect(applicationSources).not.toMatch(/\.from\(['"]users['"]\)/);
        expect(currentUserSource).toContain('loadAccountPrincipal');
        expect(currentUserSource).toContain('ensureAccountPrincipal');
        expect(callbackSource).toContain('upsertKakaoAccountProfile');
        expect(checkoutSource).toContain('loadAccountCheckoutPhone');
        expect(principalStoreSource).toContain("'load_account_principal_v1'");
        expect(principalStoreSource).toContain("'ensure_account_principal_v1'");
        expect(principalStoreSource).toContain("'upsert_kakao_account_profile_v1'");
        expect(principalStoreSource).toContain("'load_account_checkout_phone_v1'");
    });
});
