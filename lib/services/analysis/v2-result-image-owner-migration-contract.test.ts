import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714035000_bind_analysis_v2_result_images_to_owner.sql',
        import.meta.url
    ),
    'utf8'
);

describe('analysis V2 result image owner migration contract', () => {
    it('removes the ownerless RPC and requires owner equality in its replacement', () => {
        expect(migration).toContain(
            'DROP FUNCTION IF EXISTS public.load_analysis_v2_result_image_url(UUID, TEXT, TEXT)'
        );
        expect(migration).toContain(
            'analysis_request.user_id = p_user_id'
        );
        expect(migration).toContain('SECURITY DEFINER');
        expect(migration).toContain("SET search_path = ''");
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.load_analysis_v2_result_image_url\(UUID, UUID, TEXT, TEXT\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.load_analysis_v2_result_image_url\(UUID, UUID, TEXT, TEXT\)[\s\S]*TO service_role/
        );
    });
});
