import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = resolve(process.cwd(), 'supabase/migrations');
const migrationNames = readdirSync(migrationsDirectory).sort();
const readinessMigrationName = migrationNames.find(name =>
    /_add_authorized_revenue_settlement_readiness\.sql$/.test(name)
);
const hardeningMigrationName = migrationNames.find(name =>
    /_harden_preflight_target_lineage\.sql$/.test(name)
);
const readinessMigration = readinessMigrationName
    ? readFileSync(resolve(migrationsDirectory, readinessMigrationName), 'utf8')
    : '';
const hardeningMigration = hardeningMigrationName
    ? readFileSync(resolve(migrationsDirectory, hardeningMigrationName), 'utf8')
    : '';

describe('revenue settlement target-lineage hardening migration', () => {
    it('applies after readiness and retains the deployed four-argument compatibility signature', () => {
        expect(readinessMigrationName).toBeDefined();
        expect(hardeningMigrationName).toBeDefined();
        expect(migrationNames.indexOf(readinessMigrationName!))
            .toBeLessThan(migrationNames.indexOf(hardeningMigrationName!));
        expect(readinessMigration).toContain(
            'prepare_analysis_v2_authorized_revenue_settlement_admission(\n    UUID, UUID, TEXT, TEXT\n) TO service_role',
        );
        expect(hardeningMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(',
        );
        expect(hardeningMigration).toContain(
            'p_entitlement_jti_hash,\n        NULL',
        );
    });

    it('removes only the authenticated owner-row UPDATE surface and keeps anonymous invoker/RLS capabilities intact', () => {
        expect(hardeningMigration).toContain(
            'DROP POLICY IF EXISTS analysis_preflights_authenticated_owner_update',
        );
        expect(hardeningMigration).not.toContain(
            'analysis_preflights_anonymous_update\n    ON public.analysis_preflights;',
        );
        expect(hardeningMigration).not.toContain(
            'analysis_preflights_authenticated_claim_update\n    ON public.analysis_preflights;',
        );
        expect(hardeningMigration).not.toContain('REVOKE UPDATE ON TABLE public.analysis_preflights');
        expect(hardeningMigration).not.toContain(
            'ALTER FUNCTION public.create_anonymous_analysis_v2_preflight',
        );
        expect(hardeningMigration).not.toContain(
            'ALTER FUNCTION public.claim_anonymous_analysis_v2_preflight',
        );
    });

    it('allows a NULL target hash to bind only from the server HMAC matching both provider rows', () => {
        expect(hardeningMigration).toContain(
            'p_server_target_input_hash TEXT',
        );
        expect(hardeningMigration).toContain(
            'p_server_target_input_hash IS NULL',
        );
        expect(hardeningMigration).toContain(
            'v_fallback.input_hash IS DISTINCT FROM p_server_target_input_hash',
        );
        expect(hardeningMigration).toContain(
            'v_fresh.input_hash IS DISTINCT FROM p_server_target_input_hash',
        );
        expect(hardeningMigration).toContain(
            'SET target_input_hash = p_server_target_input_hash',
        );
        expect(hardeningMigration).not.toContain(
            'SET target_input_hash = v_fallback.input_hash',
        );
    });

    it('makes each new readiness SECURITY DEFINER function owned, schema-safe, and service-only', () => {
        expect(hardeningMigration).toContain('SECURITY DEFINER');
        expect(hardeningMigration).toContain("SET search_path = ''");
        expect(hardeningMigration).toContain('OWNER TO postgres');
        expect(hardeningMigration).toContain(
            'REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(',
        );
        expect(hardeningMigration).toContain('TO service_role');
        expect(hardeningMigration.trimEnd()).toMatch(/NOTIFY pgrst, 'reload schema';$/);
    });
});
