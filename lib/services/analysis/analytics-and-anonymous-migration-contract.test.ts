import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lifecycleMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260805090000_add_analysis_lifecycle_analytics_ledger.sql',
), 'utf8');
const failureMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260805091000_add_preflight_failure_ledger.sql',
), 'utf8');
const anonymousMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260805092000_add_anonymous_preflight_claim_runtime.sql',
), 'utf8');
const anonymousClaimRetryMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260807150000_resume_oauth_against_existing_owner_preflight.sql',
), 'utf8');
const anonymousClaimExpiryMigration = readFileSync(resolve(
    process.cwd(),
    'supabase/migrations/20260807170000_ignore_expired_oauth_owner_preflight.sql',
), 'utf8');

describe('analytics and anonymous preflight migration contracts', () => {
    it('keeps server lifecycle delivery durable, bounded, and service-only', () => {
        expect(lifecycleMigration).toContain(
            'PRIMARY KEY (request_id, event_name)',
        );
        expect(lifecycleMigration).toContain(
            'insert_id TEXT NOT NULL UNIQUE',
        );
        expect(lifecycleMigration).toContain(
            "event_name IN ('analysis_started', 'analysis_completed', 'analysis_failed')",
        );
        expect(lifecycleMigration).toContain(
            'ON CONFLICT (request_id, event_name) DO NOTHING',
        );
        expect(lifecycleMigration).toContain(
            'SET delivery_attempts = delivery_attempts + 1',
        );
        expect(lifecycleMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.claim_analysis_lifecycle_event\(UUID, TEXT, TEXT\)\s+FROM PUBLIC, anon, authenticated;/,
        );
        expect(lifecycleMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.claim_analysis_lifecycle_event\(UUID, TEXT, TEXT\)\s+TO service_role;/,
        );
        expect(lifecycleMigration).not.toMatch(/target_instagram_id|raw_error|provider_run_id/iu);
    });

    it('stores only bounded preflight failure reasons without raw input', () => {
        expect(failureMigration).toContain('CREATE TABLE public.analysis_preflight_failures');
        expect(failureMigration).toContain("stage IN ('request', 'profile', 'exclusion')");
        for (const reason of [
            'HANDLE_FORMAT_INVALID',
            'TARGET_NOT_FOUND',
            'TARGET_PRIVATE',
            'PLAN_CAPACITY_EXCEEDED',
            'EXCLUSION_RULE_VIOLATION',
            'PROVIDER_TEMPORARY_FAILURE',
        ]) {
            expect(failureMigration).toContain(`'${reason}'`);
        }
        expect(failureMigration).not.toMatch(
            /target_instagram_id|raw_error|error_message|provider_run_id/iu,
        );
    });

    it('isolates anonymous ownership, claim replay, rate limits, and target single-flight', () => {
        expect(anonymousMigration).toContain('ALTER COLUMN user_id DROP NOT NULL');
        expect(anonymousMigration).toContain("provider_selector IN ('selfhosted_auth', 'anonymous_apify')");
        expect(anonymousMigration).toContain('analysis_preflights_anonymous_idempotency_idx');
        expect(anonymousMigration).toContain('analysis_anonymous_profile_cache');
        expect(anonymousMigration).toContain('analysis_anonymous_profile_cache_locks');
        expect(anonymousMigration).toContain('analysis_anonymous_preflight_attempts');
        expect(anonymousMigration).toContain('reserve_anonymous_preflight_budget');
        expect(anonymousMigration).toContain('hashtextextended');
        expect(anonymousMigration).toContain('ANONYMOUS_PREFLIGHT_IDEMPOTENCY_CONFLICT');
        expect(anonymousMigration).toContain("status IN ('ready', 'blocked')");
        expect(anonymousMigration).toContain('claim_token_hash = NULL');
        expect(anonymousMigration).toContain('anonymous_apify');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_authenticated_owner_select');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_authenticated_owner_update');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_anonymous_claim_select');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_anonymous_insert');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_anonymous_update');
        expect(anonymousMigration).toContain('CREATE POLICY analysis_preflights_authenticated_claim_update');
        expect(anonymousMigration).toContain(
            'GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_preflights TO anon, authenticated;',
        );
        expect(anonymousMigration).toContain("current_setting('app.anonymous_preflight_claim_hash'");
        expect(anonymousMigration).toContain("set_config(\n        'app.anonymous_preflight_claim_hash'");
        expect(anonymousMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.read_anonymous_analysis_v2_preflight_public(',
        );
        expect(anonymousMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(',
        );
        const browserFunctionNames = [
            'create_anonymous_analysis_v2_preflight',
            'read_anonymous_analysis_v2_preflight_public',
            'claim_anonymous_analysis_v2_preflight',
            'set_anonymous_analysis_v2_preflight_exclusion',
            'set_authenticated_analysis_v2_preflight_exclusion',
            'reserve_anonymous_analysis_v2_preflight_dispatch',
            'mark_anonymous_analysis_v2_preflight_dispatched',
        ];
        const browserFunctionBlocks = [
            ...anonymousMigration.matchAll(
                /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?(?=\nCREATE OR REPLACE FUNCTION public\.|$)/giu,
            ),
        ].filter(match => browserFunctionNames.includes(match[1].toLowerCase())).map(match => match[0]);
        expect(browserFunctionBlocks).toHaveLength(browserFunctionNames.length);
        for (const browserFunction of browserFunctionBlocks) {
            expect(browserFunction).not.toMatch(/SECURITY DEFINER/iu);
        }
        expect(anonymousMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.claim_anonymous_analysis_v2_preflight\(UUID, VARCHAR, UUID\)\s+FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(anonymousMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.claim_anonymous_analysis_v2_preflight\(UUID, VARCHAR, UUID\)\s+TO authenticated;/,
        );
        expect(anonymousMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.read_anonymous_analysis_v2_preflight_public\(UUID, VARCHAR\)\s+TO anon, authenticated;/,
        );
        expect(anonymousMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\(UUID, UUID, TEXT, TEXT\)\s+TO authenticated;/,
        );
        expect(anonymousMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.reserve_anonymous_analysis_v2_preflight_dispatch\(UUID, VARCHAR, UUID\)\s+TO anon, authenticated;/,
        );
        expect(anonymousMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.mark_anonymous_analysis_v2_preflight_dispatched\(UUID, VARCHAR, INTEGER, UUID\)\s+TO anon, authenticated;/,
        );
        const publicRead = anonymousMigration.slice(
            anonymousMigration.indexOf(
                'CREATE OR REPLACE FUNCTION public.read_anonymous_analysis_v2_preflight_public(',
            ),
            anonymousMigration.indexOf(
                'CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight(',
            ),
        );
        const publicProjection = publicRead.slice(
            publicRead.indexOf('SELECT'),
            publicRead.indexOf('FROM public.analysis_preflights'),
        );
        expect(publicProjection).not.toMatch(
            /claim_token_hash|claim_expires_at|target_input_hash|target_profile_image_url|lease_token|dispatch_token/iu,
        );
        const attemptsTable = anonymousMigration.slice(
            anonymousMigration.indexOf('CREATE TABLE public.analysis_anonymous_preflight_attempts'),
            anonymousMigration.indexOf('CREATE INDEX analysis_anonymous_attempts_ip_idx'),
        );
        expect(attemptsTable).not.toMatch(/target_instagram_id|raw_error|error_message/iu);
    });

    it('returns an existing same-target owner preflight for OAuth retries', () => {
        expect(anonymousClaimRetryMigration).toContain(
            'DROP FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID);',
        );
        expect(anonymousClaimRetryMigration).toContain('owner_preflight_id UUID');
        expect(anonymousClaimRetryMigration).toContain("'owner_active'::TEXT");
        expect(anonymousClaimRetryMigration).toContain("status = 'expired'");
        expect(anonymousClaimRetryMigration).toContain('claim_token_hash = NULL');
        expect(anonymousClaimRetryMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)',
        );
    });

    it('does not reuse an expired owner row during an OAuth retry', () => {
        expect(anonymousClaimExpiryMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight(',
        );
        expect(anonymousClaimExpiryMigration).toContain(
            'IF v_owner.expires_at <= v_now THEN',
        );
        expect(anonymousClaimExpiryMigration).toContain(
            "SET status = 'expired'",
        );
        expect(anonymousClaimExpiryMigration).toContain(
            "status IN ('pending', 'processing', 'ready')",
        );
        expect(anonymousClaimExpiryMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)',
        );
    });
});
