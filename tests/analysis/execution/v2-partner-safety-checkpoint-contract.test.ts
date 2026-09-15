import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260723013000_fix_partner_safety_checkpoint_contract.sql',
        import.meta.url
    ),
    'utf8'
);

describe('partner-safety raw checkpoint contract migration', () => {
    it('rebuilds the public envelope from raw feature and partner model checkpoints', () => {
        expect(migration).toContain('v_features := v_feature_ai.result_json;');
        expect(migration).toContain('v_assessment := v_partner_ai.result_json;');
        expect(migration).not.toContain("v_feature_ai.result_json->'features'");
        expect(migration).not.toContain("v_partner_ai.result_json->'assessment'");
        expect(migration).not.toContain("v_partner_ai.result_json->>'source'");
        expect(migration).toContain('analysis_v2_ai_fallback_evidence_matches');
    });

    it('requires the distinct partner media bundle to be registered by the fenced job', () => {
        expect(migration).toContain("'analysis-v2-partner-safety-bundle:v1'");
        expect(migration).toContain("'analysis-v2-media-bundle-key:v1'");
        expect(migration).toContain("artifact.artifact_kind = 'media_bundle'");
        expect(migration).toContain('artifact.registration_job_key = p_partner_job_key');
        expect(migration).toContain('artifact.deleted_at IS NULL');
        expect(migration).not.toContain(
            "p_value->>'bundleId' IS DISTINCT FROM v_feature.media_context->>'bundleId'"
        );
    });

    it('accepts raw durable checkpoints only when their partner bundle is fenced', async () => {
        const originalBigIntToJson = Object.getOwnPropertyDescriptor(
            BigInt.prototype,
            'toJSON'
        );
        const db = await PGlite.create({ extensions: { pgcrypto } });
        try {
            await db.exec(`
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN;
                CREATE SCHEMA extensions;
                CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
                CREATE TABLE public.analysis_v2_candidate_feature_rows (
                    request_id UUID, candidate_id TEXT, batch INTEGER,
                    terminal_classification TEXT, feature_operation_key TEXT,
                    feature_result_hash TEXT, media_context JSONB
                );
                CREATE TABLE public.analysis_v2_candidate_feature_manifests (
                    request_id UUID, batch INTEGER, producer_job_key TEXT
                );
                CREATE TABLE public.analysis_v2_ai_result_checkpoints (
                    request_id UUID, job_key TEXT, operation_key TEXT,
                    stage TEXT, result_hash TEXT, result_json JSONB
                );
                CREATE TABLE public.analysis_v2_media_artifacts (
                    request_id UUID, registration_job_key TEXT, artifact_kind TEXT,
                    deleted_at TIMESTAMP WITH TIME ZONE, artifact_key TEXT
                );
                CREATE FUNCTION public.analysis_v2_ai_fallback_evidence_matches(
                    UUID, TEXT, TEXT, TEXT
                ) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT FALSE $$;
                CREATE FUNCTION public.analysis_v2_result_valid_ref_list(TEXT[], INTEGER)
                RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            `);
            await db.exec(migration);

            const requestId = '11111111-1111-4111-8111-111111111111';
            const candidateId = 'candidate:one';
            const partnerJob = 'track:partner-safety:batch:0';
            const featureJob = 'track:profile-ai:batch:0';
            const featureOperation = `feature-analysis:${'1'.repeat(64)}`;
            const partnerOperation = `partner-safety:${'2'.repeat(64)}`;
            const featureHash = '3'.repeat(64);
            const partnerHash = '4'.repeat(64);
            const contactSelectionId = 'post:carousel:frame-2';
            const bundleId = `bundle:${createHash('sha256').update(
                `analysis-v2-partner-safety-bundle:v1\n${candidateId}`,
                'utf8'
            ).digest('hex')}`;
            const artifactKey = createHash('sha256').update(
                `analysis-v2-media-bundle-key:v1\n${bundleId}`,
                'utf8'
            ).digest('hex');

            await db.query(
                `INSERT INTO public.analysis_v2_candidate_feature_rows VALUES (
                    $1, $2, 0, 'verified_female', $3, $4,
                    '{"selectionIds":["profile:one"],"bundleId":"bundle:feature"}'::JSONB
                 )`,
                [requestId, candidateId, featureOperation, featureHash]
            );
            await db.query(
                'INSERT INTO public.analysis_v2_candidate_feature_manifests VALUES ($1, 0, $2)',
                [requestId, featureJob]
            );
            await db.query(
                `INSERT INTO public.analysis_v2_ai_result_checkpoints VALUES
                 ($1, $2, $3, 'featureAnalysis', $4, $5::JSONB),
                 ($1, $6, $7, 'partnerSafety', $8, $9::JSONB)`,
                [
                    requestId,
                    featureJob,
                    featureOperation,
                    featureHash,
                    JSON.stringify({
                        partnerExclusionContext: 'none',
                        marriageEvidence: 'none',
                        partnerEvidence: 'none',
                        evidenceSelectionIds: { marriagePartner: [] },
                    }),
                    partnerJob,
                    partnerOperation,
                    partnerHash,
                    JSON.stringify({
                        companionPattern: 'single_two_person',
                        partnerEvidence: 'weak',
                        exclusionContext: 'none',
                        confidence: 'medium',
                        evidenceSourceSelectionIds: [contactSelectionId],
                    }),
                ]
            );
            await db.query(
                `INSERT INTO public.analysis_v2_media_artifacts
                 VALUES ($1, $2, 'media_bundle', NULL, $3)`,
                [requestId, partnerJob, artifactKey]
            );

            const publicRow = {
                candidateId,
                source: 'gemini',
                hasStrongPartnerEvidence: false,
                hasWeakPartnerEvidence: true,
                strongEvidenceBasis: 'none',
                evidenceSelectionIds: [contactSelectionId],
                bundleId,
                operationKey: partnerOperation,
                aiResultHash: partnerHash,
            };
            const matched = await db.query<{ matched: boolean }>(
                `SELECT public.analysis_v2_result_partner_safety_row_matches(
                    $1, $2, $3::JSONB
                 ) AS matched`,
                [requestId, partnerJob, JSON.stringify(publicRow)]
            );
            expect(matched.rows).toEqual([{ matched: true }]);

            await db.query(
                'UPDATE public.analysis_v2_media_artifacts SET deleted_at = clock_timestamp()',
            );
            const withoutBundle = await db.query<{ matched: boolean }>(
                `SELECT public.analysis_v2_result_partner_safety_row_matches(
                    $1, $2, $3::JSONB
                 ) AS matched`,
                [requestId, partnerJob, JSON.stringify(publicRow)]
            );
            expect(withoutBundle.rows).toEqual([{ matched: false }]);
        } finally {
            await db.close();
            if (originalBigIntToJson) {
                Object.defineProperty(BigInt.prototype, 'toJSON', originalBigIntToJson);
            } else {
                Reflect.deleteProperty(BigInt.prototype, 'toJSON');
            }
        }
    }, 30_000);
});
