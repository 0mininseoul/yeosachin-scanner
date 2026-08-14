import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814210000_add_legacy_result_overview.sql', import.meta.url),
    'utf8',
);
const correctionScript = readFileSync(
    new URL('../../../scripts/correct-concierge-basic-result.ts', import.meta.url),
    'utf8',
);
const sourceAccessorMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814220000_add_concierge_source_accessor.sql', import.meta.url),
    'utf8',
);
const reviewedSourceMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814223000_register_concierge_reviewed_source.sql', import.meta.url),
    'utf8',
);
const bootstrapMigration = readFileSync(
    new URL('../../../supabase/migrations/20260815090000_bootstrap_v211_concierge_first_order.sql', import.meta.url),
    'utf8',
);

describe('legacy concierge result overview persistence contract', () => {
    it('adds an additive bounded overview column without changing the narrative field', () => {
        expect(migration).toContain(
            'ADD COLUMN IF NOT EXISTS one_line_overview VARCHAR(180)',
        );
        expect(migration).toContain(
            'CHECK (one_line_overview IS NULL OR char_length(one_line_overview) BETWEEN 1 AND 180)',
        );
        expect(migration).toContain('COMMENT ON COLUMN public.analysis_results.one_line_overview');
        expect(migration).not.toContain('DROP COLUMN');
        expect(migration).not.toContain('risk_analysis');
    });

    it('publishes and verifies the overview through the legacy row contract', () => {
        expect(correctionScript).toContain('one_line_overview');
        expect(correctionScript).toContain('risk_analysis');
        expect(correctionScript).toContain(
            "select('rank,risk_score,risk_grade,one_line_overview,risk_analysis,gender_status')",
        );
        expect(correctionScript).toContain('CONCIERGE_PUBLICATION_OVERVIEW_VERIFY_FAILED');
    });

    it('keeps operator output free of request and result identifiers', () => {
        expect(correctionScript).toContain("state: 'completed'");
        expect(correctionScript).not.toContain('resultPath: `/result/${order.result_request_id}`');
        expect(correctionScript).not.toContain('semanticInputFingerprint:');
    });

    it('binds the correction source through the order-scoped replay lineage', () => {
        expect(correctionScript).toContain('sourceCandidates');
        expect(correctionScript).toContain("candidate.pipeline_version === 'v2'");
        expect(correctionScript).toContain('load_analysis_v2_target_evidence');
        expect(sourceAccessorMigration).toContain(
            'CREATE FUNCTION public.read_earlybird_v211_concierge_result_source(',
        );
        expect(sourceAccessorMigration).toContain('SECURITY DEFINER');
        expect(sourceAccessorMigration).toContain("SET search_path = ''");
        expect(sourceAccessorMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.read_earlybird_v211_concierge_result_source\(UUID\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
        );
        expect(sourceAccessorMigration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.read_earlybird_v211_concierge_result_source\(UUID\)[\s\S]*?TO service_role;/,
        );
        expect(sourceAccessorMigration).not.toMatch(/GRANT .* ON TABLE public\.earlybird_v211_concierge_replays/);
        expect(sourceAccessorMigration).not.toContain(
            'source_request.target_instagram_id = earlybird_order.target_instagram_id',
        );
        expect(sourceAccessorMigration).toContain('source_preflight.target_instagram_id');
        expect(correctionScript.indexOf('await verifyAuthorization')).toBeLessThan(
            correctionScript.indexOf('applyAtomicPublication({'),
        );
        expect(correctionScript).toContain('sourceRequest.preflight_id');
    });

    it('uses the reviewed live snapshot and existing replay row instead of terminal V2 staging', () => {
        expect(correctionScript).toContain('loadReviewedTargetSnapshot');
        expect(correctionScript).not.toContain('sourceRequest.step_data');
        expect(correctionScript).toContain('load_analysis_v2_target_evidence');
        expect(correctionScript).toContain('targetEvidenceManifest');
        expect(reviewedSourceMigration).toContain(
            'ALTER TABLE public.earlybird_v211_concierge_replays',
        );
        expect(reviewedSourceMigration).not.toContain(
            'CREATE TABLE public.earlybird_v211_concierge',
        );
        expect(reviewedSourceMigration).toContain('reviewed_source_target_posts');
        expect(reviewedSourceMigration).toContain('reviewed_source_target_evidence');
        expect(reviewedSourceMigration).toContain(
            'GRANT EXECUTE ON FUNCTION public.register_earlybird_v211_concierge_reviewed_source(',
        );
        expect(reviewedSourceMigration).not.toMatch(/GRANT .* ON TABLE public\.earlybird_v211_concierge_replays/);
    });

    it('binds publication writes to a persisted fingerprint and result hash CAS marker', () => {
        expect(correctionScript).toContain('CONCIERGE_PUBLICATION_CAS_CONFLICT');
        expect(correctionScript).toContain('published_source_fingerprint');
        expect(correctionScript).toContain('published_result_hash');
        expect(correctionScript).toContain('publication_skip');
        expect(correctionScript).toContain(
            'FROM public.earlybird_v211_concierge_replays WHERE order_id =',
        );
        expect(correctionScript).toContain('FOR UPDATE');
        expect(reviewedSourceMigration).toContain('published_source_fingerprint');
        expect(reviewedSourceMigration).toContain('published_result_hash');
    });

    it('hydrates only the remaining profile scope with actual senary-then-quinary lineage', () => {
        const hydrationStart = correctionScript.indexOf('async function hydrateExactMutualProfiles');
        const hydration = correctionScript.slice(hydrationStart);
        expect(hydration).toContain("const PROFILE_HYDRATION_SLOTS = ['senary', 'quinary'] as const");
        expect(hydration).toContain('const provider = makeDirectProvider(slot, token)');
        expect(hydration).toContain('credentialSlot: slot');
        expect(hydration).not.toContain("credentialSlot: 'primary' as const");
        expect(hydration).not.toContain("makeDirectProvider('tertiary'");
        expect(hydration).toContain('profileUnavailableUsernames');
        expect(bootstrapMigration).toContain("p_publication_payload->'unavailablePublicUsernames'");
        expect(bootstrapMigration).toContain('CONCIERGE_BOOTSTRAP_PROFILE_UNAVAILABLE_PROVENANCE_INVALID');
    });

    it('reconciles the private artifact to the current exact-mutual intersection', () => {
        expect(correctionScript).toContain("const UNRESOLVED_PRIVATE_USERNAME = 'sunghueee';");
        expect(correctionScript).toContain(
            'const stalePrivateRows = rawPrivateRows.filter(row => !orderedMutualUsernames.includes(normalizedUsername(row.instagram_id)))',
        );
        expect(correctionScript).toContain(
            'const privateRows = rawPrivateRows.filter(row => orderedMutualUsernames.includes(normalizedUsername(row.instagram_id))',
        );
        expect(correctionScript).not.toContain("const UNRESOLVED_PRIVATE_USERNAME = 'yan_e_0089';");
    });
});
