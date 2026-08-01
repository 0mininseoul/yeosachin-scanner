import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql',
        import.meta.url
    ),
    'utf8'
);
const freshnessRaceMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731020000_fix_earlybird_fulfillment_admission_freshness_race.sql',
        import.meta.url
    ),
    'utf8'
);
const capacitySafeCountDriftMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731030000_allow_capacity_safe_earlybird_admission_count_drift.sql',
        import.meta.url
    ),
    'utf8'
);
const schemaRecoveryCapacitySafeCountDriftMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260801130000_allow_schema_recovery_capacity_safe_count_drift.sql',
        import.meta.url
    ),
    'utf8'
);
const scrubbedFreshnessRecoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731040000_recover_scrubbed_earlybird_freshness_conflict.sql',
        import.meta.url
    ),
    'utf8'
);
const recoveredRequestGenerationMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731050000_bound_recovered_earlybird_request_generation.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(name: string): string {
    const start = migration.indexOf(`CREATE FUNCTION public.${name}(`);
    expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function scrubbedRecoveryFunctionDefinition(name: string): string {
    const markers = [
        `CREATE FUNCTION public.${name}(`,
        `CREATE OR REPLACE FUNCTION public.${name}(`,
    ];
    const start = Math.max(...markers.map(marker =>
        scrubbedFreshnessRecoveryMigration.indexOf(marker)
    ));
    expect(start, `${name} must exist in scrubbed recovery`).toBeGreaterThanOrEqual(0);
    const end = scrubbedFreshnessRecoveryMigration.indexOf('\n$$;', start);
    expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
    return scrubbedFreshnessRecoveryMigration.slice(start, end);
}

describe('earlybird fulfillment outbox migration contract', () => {
    it('creates one private, RLS-enabled row per paid order', () => {
        expect(migration).toContain(
            'CREATE TABLE public.earlybird_fulfillments'
        );
        expect(migration).toContain(
            'order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)'
        );
        expect(migration).toContain(
            "status IN ('awaiting_operator', 'admission_pending', "
            + "'analysis_in_progress', 'completed', 'retryable_failure', "
            + "'manual_review')"
        );
        expect(migration).toContain(
            'ALTER TABLE public.earlybird_fulfillments ENABLE ROW LEVEL SECURITY'
        );
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.earlybird_fulfillments'
        );
        expect(migration).not.toMatch(
            /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL).*earlybird_fulfillments.*(?:anon|authenticated)/i
        );
    });

    it('lets payment confirmation enqueue only an operator-waiting row', () => {
        const enqueue = functionDefinition('enqueue_earlybird_fulfillment');
        expect(enqueue).toContain("v_order.status = 'paid'");
        expect(enqueue).toContain(
            'v_order.seller_reference_confirmed_at IS NOT NULL'
        );
        expect(enqueue).toContain("'awaiting_operator'");
        expect(enqueue).not.toMatch(
            /INSERT INTO public\.analysis_requests|reserve_analysis_v2|provider/i
        );
        expect(migration).toContain(
            'CREATE TRIGGER enqueue_reference_confirmed_earlybird_fulfillment'
        );
    });

    it('requires an explicit operator transition before any admission can be claimed', () => {
        const admit = functionDefinition('admit_earlybird_fulfillment');
        expect(admit).toContain("v_fulfillment.status = 'awaiting_operator'");
        expect(admit).toContain("status = 'admission_pending'");
        expect(admit).toContain("v_order.status = 'paid'");
        expect(admit).toContain(
            'v_order.seller_reference_confirmed_at IS NOT NULL'
        );

        const claim = functionDefinition('claim_earlybird_fulfillment');
        expect(claim).toContain(
            "v_fulfillment.status IN ('admission_pending', 'retryable_failure')"
        );
        expect(claim).toContain('v_preflight.admission_refreshed_at');
        expect(claim).toContain('v_fulfillment.lease_fence + 1');
        expect(claim).not.toContain("'awaiting_operator'");
    });

    it('creates or replays exactly one production V2 request behind the lease fence', () => {
        const create = functionDefinition(
            'create_or_replay_earlybird_fulfillment_request'
        );
        expect(create).toContain(
            'v_fulfillment.lease_token IS DISTINCT FROM p_lease_token'
        );
        expect(create).toContain(
            'v_fulfillment.lease_fence IS DISTINCT FROM p_lease_fence'
        );
        expect(create).toContain('INSERT INTO public.analysis_requests');
        expect(create).toContain("'production'");
        expect(create).toContain("'coordinator:bootstrap'");
        expect(create).toContain(
            'INSERT INTO public.analysis_pipeline_jobs'
        );
        expect(create).toContain('result_request_id = v_request_id');
        expect(create).toContain("status = 'analysis_in_progress'");
        expect(create).not.toContain('test_entitlement_jti_hash');
    });

    it('recovers only admitted work and never auto-admits waiting payments', () => {
        const list = functionDefinition(
            'list_recoverable_earlybird_fulfillments'
        );
        expect(list).toContain(
            "fulfillment.status IN ('admission_pending', 'retryable_failure')"
        );
        expect(list).not.toContain("'awaiting_operator'");

        const reconcile = functionDefinition('reconcile_earlybird_fulfillments');
        expect(reconcile).toContain("analysis_request.status = 'completed'");
        expect(reconcile).toContain("analysis_request.status = 'failed'");
        expect(reconcile).toContain("status = 'manual_review'");
        expect(reconcile).toContain("status = 'retryable_failure'");
    });

    it('keeps every runtime RPC service-role only', () => {
        const names = [
            'enqueue_earlybird_fulfillment',
            'admit_earlybird_fulfillment',
            'list_recoverable_earlybird_fulfillments',
            'claim_earlybird_fulfillment',
            'create_or_replay_earlybird_fulfillment_request',
            'mark_earlybird_fulfillment_manual_review',
            'reconcile_earlybird_fulfillments',
        ];
        for (const name of names) {
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'FROM PUBLIC, anon, authenticated, service_role;'
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?`
                + 'TO service_role;'
            ));
        }
    });

    it('replaces create with a stale-only retry seam and protects the one-shot recovery RPC', () => {
        expect(freshnessRaceMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_or_replay_earlybird_fulfillment_request('
        );
        expect(freshnessRaceMigration).toContain(
            "last_error_code = 'ADMISSION_FRESHNESS_EXPIRED'"
        );
        expect(freshnessRaceMigration).toContain(
            "'retryable_failure'::TEXT"
        );
        expect(freshnessRaceMigration).toContain(
            "v_preflight.admission_refreshed_at IS NOT NULL"
        );
        expect(freshnessRaceMigration).toContain(
            "v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'"
        );
        expect(freshnessRaceMigration).toContain(
            'CREATE FUNCTION public.recover_earlybird_freshness_snapshot_conflict('
        );
        expect(freshnessRaceMigration).toContain(
            'p_expected_manual_review_at TIMESTAMP WITH TIME ZONE'
        );
        expect(freshnessRaceMigration).toContain(
            "EARLYBIRD_FRESHNESS_RECOVERY_CAS_MISMATCH"
        );
        expect(freshnessRaceMigration).toContain(
            'CREATE FUNCTION public.earlybird_fulfillment_clock()'
        );
        expect(freshnessRaceMigration).toContain('SECURITY INVOKER');
        expect(freshnessRaceMigration).toContain(
            'SELECT pg_catalog.clock_timestamp()'
        );
        expect(freshnessRaceMigration).toContain(
            'v_now TIMESTAMP WITH TIME ZONE := public.earlybird_fulfillment_clock();'
        );
        expect(freshnessRaceMigration).toContain(
            "EARLYBIRD_FRESHNESS_RECOVERY_ACTIVE_REQUEST_CONFLICT"
        );
        expect(freshnessRaceMigration).toContain(
            "active_request.status IN ('pending', 'processing')"
        );
        expect(freshnessRaceMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_fulfillment_clock\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(freshnessRaceMigration).not.toContain(
            'GRANT EXECUTE ON FUNCTION public.earlybird_fulfillment_clock()'
        );
        expect(freshnessRaceMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_earlybird_freshness_snapshot_conflict\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(freshnessRaceMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_earlybird_freshness_snapshot_conflict\([\s\S]*?TO service_role;/
        );
    });

    it('permits only fresh-admission-witnessed count drift that remains inside the paid card capacity', () => {
        expect(capacitySafeCountDriftMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_or_replay_earlybird_fulfillment_request('
        );
        expect(capacitySafeCountDriftMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.recover_earlybird_freshness_snapshot_conflict('
        );
        expect(capacitySafeCountDriftMigration).toContain(
            'v_preflight.admission_target_followers_count IS DISTINCT FROM v_preflight.target_followers_count'
        );
        expect(capacitySafeCountDriftMigration).toContain(
            'v_preflight.admission_target_following_count IS DISTINCT FROM v_preflight.target_following_count'
        );
        expect(capacitySafeCountDriftMigration).toContain(
            'v_preflight.admission_plan_cards_snapshot IS DISTINCT FROM v_preflight.plan_cards_snapshot'
        );
        expect(capacitySafeCountDriftMigration).toContain(
            "v_order.target_followers_count > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER"
        );
        expect(capacitySafeCountDriftMigration).toContain(
            "v_preflight.target_followers_count > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER"
        );
    });

    it('preserves linked expiry evidence and narrowly recovers canonical scrubbed tombstones', () => {
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_or_replay_analysis_v2_preflight('
        );
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /SET status = 'expired',[\s\S]*?lease_token = NULL,[\s\S]*?AND EXISTS \([\s\S]*?earlybird_order\.status IN \([\s\S]*?'payment_pending'[\s\S]*?'completed'/
        );
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /pii_scrubbed_at = v_now,[\s\S]*?AND NOT EXISTS \([\s\S]*?earlybird_order\.preflight_id = preflight\.id/
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'CREATE FUNCTION public.recover_scrubbed_earlybird_freshness_snapshot_conflict('
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            "v_old.target_instagram_id IS DISTINCT FROM ("
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            "v_old.admission_status <> 'ready'"
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_old.admission_plan_cards_snapshot IS DISTINCT FROM v_cards'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_order.target_followers_count'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_order_cards JSONB'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_new.capacity_required_plan_id IS DISTINCT FROM v_order_capacity_plan'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_new.plan_cards_snapshot IS DISTINCT FROM v_order_cards'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_rebound_id := public.rebind_expired_paid_earlybird_preflight(p_order_id)'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            'v_rebound_id = v_old.id'
        );
        expect(scrubbedFreshnessRecoveryMigration).toContain(
            "v_new.admission_status NOT IN ('idle', 'pending')"
        );
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_scrubbed_earlybird_freshness_snapshot_conflict\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_scrubbed_earlybird_freshness_snapshot_conflict\([\s\S]*?TO service_role;/
        );
        expect(scrubbedFreshnessRecoveryMigration).not.toMatch(
            /active_request[\s\S]{0,200}FOR UPDATE/
        );
        const recovery = scrubbedRecoveryFunctionDefinition(
            'recover_scrubbed_earlybird_freshness_snapshot_conflict'
        );
        const userHint = recovery.indexOf(
            'SELECT earlybird_order.user_id INTO v_user_id_hint'
        );
        const userLock = recovery.indexOf(
            'FROM public.users AS recovery_user'
        );
        const orderLock = recovery.indexOf(
            'SELECT earlybird_order.* INTO v_order'
        );
        const fulfillmentLock = recovery.indexOf(
            'SELECT fulfillment.* INTO v_fulfillment'
        );
        const preflightLock = recovery.indexOf(
            'SELECT preflight.* INTO v_old'
        );
        expect(userHint).toBeGreaterThanOrEqual(0);
        expect(userLock).toBeGreaterThan(userHint);
        expect(orderLock).toBeGreaterThan(userLock);
        expect(fulfillmentLock).toBeGreaterThan(orderLock);
        expect(preflightLock).toBeGreaterThan(fulfillmentLock);
        expect(recovery).toContain('FOR KEY SHARE');
        expect(recovery).toContain(
            'v_order.user_id IS DISTINCT FROM v_user_id_hint'
        );

        const sharedRebind = scrubbedRecoveryFunctionDefinition(
            'rebind_expired_paid_earlybird_preflight'
        );
        const sharedUserHint = sharedRebind.indexOf(
            'SELECT earlybird_order.user_id INTO v_user_id_hint'
        );
        const sharedUserLock = sharedRebind.indexOf(
            'FROM public.users AS rebind_user'
        );
        const sharedOrderLock = sharedRebind.indexOf(
            'SELECT earlybird_order.* INTO v_order'
        );
        const sharedFulfillmentLock = sharedRebind.indexOf(
            'SELECT fulfillment.* INTO v_fulfillment'
        );
        const sharedPreflightLock = sharedRebind.indexOf(
            'SELECT preflight.* INTO v_preflight'
        );
        expect(sharedUserHint).toBeGreaterThanOrEqual(0);
        expect(sharedUserLock).toBeGreaterThan(sharedUserHint);
        expect(sharedOrderLock).toBeGreaterThan(sharedUserLock);
        expect(sharedFulfillmentLock).toBeGreaterThan(sharedOrderLock);
        expect(sharedPreflightLock).toBeGreaterThan(sharedFulfillmentLock);
        expect(sharedRebind).toContain('c_max_generations CONSTANT INTEGER := 10');
        expect(sharedRebind).toContain("v_generation_prefix := v_base_key || '.r'");
        expect(sharedRebind).toContain('v_generation >= c_max_generations');
        expect(sharedRebind).toContain('v_order.user_id IS DISTINCT FROM v_user_id_hint');
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.rebind_expired_paid_earlybird_preflight\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(scrubbedFreshnessRecoveryMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.rebind_expired_paid_earlybird_preflight\(UUID\)[\s\S]*?TO service_role;/
        );
    });

    it('permits schema-failure recovery count drift only inside the immutable selected card', () => {
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            "SET LOCAL lock_timeout = '5s';"
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            "SET LOCAL statement_timeout = '2min';"
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.recover_earlybird_schema_failed_fulfillment('
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).not.toContain(
            'v_preflight.target_followers_count\n            IS DISTINCT FROM v_order.target_followers_count'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'v_order.target_followers_count IS NULL'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'v_preflight.target_followers_count IS NULL'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'v_plan_id = v_order.plan_id'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'v_preflight.target_followers_count > v_card_followers'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            'v_required_card_count <> 1'
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toContain(
            "MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_SNAPSHOT_CONFLICT'"
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.recover_earlybird_schema_failed_fulfillment\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(schemaRecoveryCapacitySafeCountDriftMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.recover_earlybird_schema_failed_fulfillment\(UUID\)[\s\S]*?TO service_role;/
        );
    });

    it('bounds recovered request generations behind exact lineage and provider adoption', () => {
        expect(recoveredRequestGenerationMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_or_replay_earlybird_fulfillment_request('
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'c_max_request_generations CONSTANT INTEGER := 10'
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'public.earlybird_schema_failure_recoveries'
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'recovery.failed_request_id = v_conflicting_request.id'
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'v_recovery_preflight.id'
        );
        expect(recoveredRequestGenerationMigration).toContain(
            "v_rebind_preflight_base_key := 'earlybird.fulfillment.'"
        );
        expect(recoveredRequestGenerationMigration).toContain(
            "last_error_code = 'PROVIDER_RUN_ADOPTION_REQUIRED'"
        );
        expect(recoveredRequestGenerationMigration).toMatch(
            /FROM public\.analysis_v2_provider_runs AS provider_run\s+WHERE provider_run\.request_id = v_conflicting_request\.id\s+\) AND NOT public\.earlybird_provider_run_adoption_ready/
        );
        expect(recoveredRequestGenerationMigration).not.toMatch(
            /provider_run\.request_id = v_conflicting_request\.id\s+AND provider_run\.status/
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'public.earlybird_provider_run_adoption_ready('
        );
        expect(recoveredRequestGenerationMigration).toContain(
            "last_error_code = 'REQUEST_IDEMPOTENCY_EXHAUSTED'"
        );
        expect(recoveredRequestGenerationMigration).toContain(
            'v_request_idempotency_key'
        );
        expect(recoveredRequestGenerationMigration).not.toMatch(
            /UPDATE public\.analysis_requests AS analysis_request[\s\S]*?status\s*=/
        );
        expect(recoveredRequestGenerationMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.earlybird_provider_run_adoption_ready\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
    });
});
