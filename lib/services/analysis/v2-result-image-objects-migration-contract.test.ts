import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123500_add_analysis_v2_result_image_objects.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 retained result image migration contract', () => {
    it('keeps metadata and the purge outbox private', () => {
        for (const table of [
            'analysis_v2_result_image_manifests',
            'analysis_v2_result_image_objects',
            'analysis_v2_result_image_purge_outbox',
        ]) {
            expect(migration).toContain(
                `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`
            );
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON TABLE public\\.${table}\\s+`
                + 'FROM PUBLIC, anon, authenticated, service_role'
            ));
        }
        expect(migration).not.toMatch(
            /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL).*TO (?:anon|authenticated)/i
        );
    });

    it('enforces bounded opaque metadata and 30-day retention', () => {
        const objectTable = migration.slice(
            migration.indexOf(
                'CREATE TABLE public.analysis_v2_result_image_objects'
            ),
            migration.indexOf(
                'CREATE TABLE public.analysis_v2_result_image_purge_outbox'
            )
        );
        expect(migration).toContain(
            "status IN ('ready', 'source_missing', 'capture_failed')"
        );
        expect(migration).toContain(
            "object_key ~ '^v1/[a-f0-9]{32}/(target|female|private)/[a-f0-9]{32}[.]webp$'"
        );
        expect(migration).toContain("sha256 ~ '^[a-f0-9]{64}$'");
        expect(migration).toContain('byte_size BETWEEN 1 AND 131072');
        expect(migration).toContain("INTERVAL '30 days'");
        expect(migration).toContain('captured_at IS NOT NULL');
        expect(migration).toContain('object_key IS NULL');
        expect(objectTable).not.toContain('source_url');
        expect(objectTable).not.toContain('profile_image_url');
    });

    it('uses bounded row and sourced-image coverage with mandatory images', () => {
        expect(migration).toContain(
            'p_durable_rows::NUMERIC / p_expected_rows >= 0.98'
        );
        expect(migration).toContain(
            'p_expected_rows - p_durable_rows <= 5'
        );
        expect(migration).toContain(
            'p_ready_images::NUMERIC / p_sourced_images >= 0.95'
        );
        expect(migration).toContain('p_capture_failed_images <= 10');
        expect(migration).toContain('image_object.is_mandatory');
        expect(migration).toContain("image_object.status <> 'ready'");
        expect(migration).toContain(
            'ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY'
        );
    });

    it('provides fenced idempotent registry, purge, and finalizer RPCs', () => {
        for (const name of [
            'begin_analysis_v2_result_image_manifest',
            'register_analysis_v2_result_image_outcome',
            'seal_analysis_v2_result_image_manifest',
            'load_analysis_v2_result_image_manifest_page',
            'claim_analysis_v2_result_image_purges',
            'complete_analysis_v2_result_image_purge',
            'complete_analysis_v2_result_and_purge_with_images',
            'load_analysis_v2_result_image_object',
        ]) {
            expect(migration).toContain(
                `FUNCTION public.${name}(`
            );
        }
        expect(migration).toContain('ordered_manifest_hash');
        expect(migration).toContain('producer_claim_token');
        expect(migration).toContain(
            'SET producer_claim_token = p_claim_token'
        );
        expect(migration).toContain(
            'manifest.producer_claim_token IS DISTINCT FROM p_claim_token'
        );
        expect(migration).toContain('lease_expires_at');
        expect(migration).toContain('ON CONFLICT');
        expect(migration).toContain(
            'enqueue_analysis_v2_result_image_purges_before_delete'
        );
    });

    it('revokes RPCs from browser roles and grants only service_role', () => {
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.begin_analysis_v2_result_image_manifest\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.begin_analysis_v2_result_image_manifest\([\s\S]*?TO service_role;/
        );
        expect(migration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.(?:begin|register|seal|claim|complete)_analysis_v2_result_image[\s\S]*?TO (?:anon|authenticated);/
        );
    });
});
