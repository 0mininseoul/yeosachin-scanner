import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260808280000_publish_v211_first_payment_concierge.sql',
), 'utf8');
const coverageCorrectionMigration = readFileSync(join(
    process.cwd(),
    'supabase/migrations/20260808290000_correct_v211_first_payment_concierge_coverage.sql',
), 'utf8');

describe('first payment concierge publication migration', () => {
    it('keeps both source and publication RPCs service-role-only', () => {
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_recovery_source()',
        );
        expect(migration).toContain(
            'GRANT EXECUTE ON FUNCTION public.publish_earlybird_v211_first_payment_concierge(',
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('anon', v_publish_signature, 'EXECUTE')",
        );
        expect(migration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_publish_signature, 'EXECUTE')",
        );
    });

    it('does not accept a request, order, owner, or Instagram identity as input', () => {
        const signature = migration.slice(
            migration.indexOf('CREATE FUNCTION public.publish_earlybird_v211_first_payment_concierge('),
            migration.indexOf('RETURNS JSONB', migration.indexOf(
                'CREATE FUNCTION public.publish_earlybird_v211_first_payment_concierge(',
            )),
        );
        expect(signature).toContain('p_descriptor_hash TEXT');
        expect(signature).toContain('p_evidence_hash TEXT');
        expect(signature).toContain('p_payload JSONB');
        expect(signature).not.toMatch(/request_id|order_id|user_id|instagram/i);
    });

    it('binds the one-shot path to the exact paid Basic v2.11 incident counts', () => {
        for (const marker of [
            "v_order.plan_id <> 'basic'",
            'v_order.expected_amount_krw <> 990',
            "'aiStage', 'ai-stage-policy-v2.11'",
            'v_followers_collected <> 390',
            'v_following_collected <> 256',
            'v_detected_mutuals <> 182',
            'v_public_mutuals <> 134',
            'v_private_mutuals <> 48',
            'v_screened_mutuals <> 130',
            'v_not_screened_mutuals <> 4',
        ]) expect(migration).toContain(marker);
    });

    it('skips normal finalization triggers only while the incident audit marker publishes', () => {
        expect(migration).toContain(
            'NOT public.analysis_v2_is_first_payment_concierge_publication(NEW.request_id)',
        );
        expect(migration).toContain(
            'EXECUTE FUNCTION public.analysis_v2_populate_result_gender_stats()',
        );
        expect(migration).toContain(
            'EXECUTE FUNCTION public.analysis_v2_seal_gender_resolution_metrics()',
        );
    });
});

describe('first payment concierge coverage correction migration', () => {
    it('replaces only the exact one-shot publisher definition', () => {
        expect(coverageCorrectionMigration).toContain('MIGRATION_PREDECESSOR=20260808280000');
        expect(coverageCorrectionMigration).toContain(
            "'public.publish_earlybird_v211_first_payment_concierge(text,text,jsonb)'::pg_catalog.regprocedure",
        );
        expect(coverageCorrectionMigration).toContain('EXECUTE v_corrected_definition');
    });

    it('uses the frozen Basic scope and truthful unavailable count', () => {
        for (const marker of [
            'OR v_screened_mutuals <> 134',
            'OR v_not_screened_mutuals <> 0',
            'OR v_fetch_unavailable <> 5',
            'OR v_unknown NOT BETWEEN 5 AND 134',
            'OR v_male + v_female + v_unknown <> 134',
            'OR v_fetch_unavailable + v_media_unavailable',
        ]) expect(coverageCorrectionMigration).toContain(marker);
    });

    it('retains the service-role-only publication fence', () => {
        expect(coverageCorrectionMigration).toContain(
            "pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')",
        );
        expect(coverageCorrectionMigration).toContain(
            "pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')",
        );
        expect(coverageCorrectionMigration).toContain(
            "pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')",
        );
    });
});
