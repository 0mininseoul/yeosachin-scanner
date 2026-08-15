import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    assertConciergePublicationRiskScores,
    buildAtomicPublicationSql,
} from '../../../scripts/correct-concierge-basic-result';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814210000_add_legacy_result_overview.sql', import.meta.url),
    'utf8',
);
const reviewedSourceMigration = readFileSync(
    new URL('../../../supabase/migrations/20260814223000_register_concierge_reviewed_source.sql', import.meta.url),
    'utf8',
);

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '223e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '323e4567-e89b-42d3-a456-426614174000';
const SOURCE_REQUEST_ID = '423e4567-e89b-42d3-a456-426614174000';
const SOURCE_FINGERPRINT = 'a'.repeat(64);
const CHANGED_SOURCE_FINGERPRINT = 'b'.repeat(64);

let db: PGlite;

beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            status TEXT NOT NULL,
            pipeline_version TEXT NOT NULL,
            progress INTEGER NOT NULL,
            progress_step TEXT,
            mutual_follows INTEGER,
            opposite_gender_count INTEGER,
            gender_stats JSONB,
            step_data JSONB,
            current_step TEXT,
            error_message TEXT,
            completed_at TIMESTAMPTZ
        );
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            result_request_id UUID NOT NULL,
            status TEXT NOT NULL,
            plan_id TEXT NOT NULL,
            paid_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.analysis_results (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL,
            rank INTEGER NOT NULL,
            suspect_instagram_id TEXT NOT NULL,
            suspect_profile_image TEXT,
            suspect_full_name TEXT,
            bio TEXT,
            risk_score INTEGER,
            photogenic_grade INTEGER,
            exposure_level TEXT,
            is_tagged BOOLEAN,
            risk_grade TEXT,
            gender_confidence DOUBLE PRECISION,
            gender_status TEXT,
            is_unlocked BOOLEAN,
            likes_count INTEGER,
            intimate_comments_count INTEGER,
            risk_analysis JSONB NOT NULL DEFAULT '[]'::JSONB
        );
        CREATE TABLE public.private_accounts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL,
            instagram_id TEXT NOT NULL,
            profile_image TEXT,
            full_name TEXT,
            name_female_score DOUBLE PRECISION,
            name_is_name BOOLEAN,
            name_confidence DOUBLE PRECISION
        );
        CREATE TABLE public.concierge_publication_mutations (kind TEXT NOT NULL);
        CREATE FUNCTION public.record_concierge_publication_mutation()
        RETURNS TRIGGER LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO public.concierge_publication_mutations(kind)
            VALUES (TG_OP);
            RETURN COALESCE(NEW, OLD);
        END;
        $$;
        CREATE TRIGGER record_concierge_publication_mutation
        AFTER INSERT OR DELETE ON public.analysis_results
        FOR EACH ROW EXECUTE FUNCTION public.record_concierge_publication_mutation();
        CREATE TABLE public.earlybird_v211_concierge_replays (
            order_id UUID PRIMARY KEY,
            original_failed_request_id UUID NOT NULL,
            first_relationship_failed_request_id UUID,
            second_relationship_failed_request_id UUID,
            failed_preflight_id UUID,
            rearmed_preflight_id UUID,
            expected_fulfillment_attempt_count SMALLINT,
            expected_manual_review_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ DEFAULT now()
        );
    `);
    await db.exec(migration);
    await db.exec(reviewedSourceMigration);
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
            mutual_follows, step_data, current_step
        ) VALUES ($1, $2, 'retained.1234567890abcdef1234', 'failed', 'v2', 100, '실패', 0, '{}'::jsonb, 'failed')`,
        [SOURCE_REQUEST_ID, OWNER_ID],
    );
});

afterEach(async () => {
    await db.close();
});

describe('concierge publication persistence contract', () => {
    it('rejects missing, non-finite, out-of-range, or grade-incompatible risk scores', () => {
        const valid = { risk_score: 43, risk_grade: 'caution' };

        expect(() => assertConciergePublicationRiskScores([
            { risk_grade: 'caution' },
        ])).toThrow('CONCIERGE_PUBLICATION_RISK_SCORE_INVALID');
        expect(() => assertConciergePublicationRiskScores([
            { ...valid, risk_score: Number.POSITIVE_INFINITY },
        ])).toThrow('CONCIERGE_PUBLICATION_RISK_SCORE_INVALID');
        expect(() => assertConciergePublicationRiskScores([
            { ...valid, risk_score: 101 },
        ])).toThrow('CONCIERGE_PUBLICATION_RISK_SCORE_INVALID');
        expect(() => assertConciergePublicationRiskScores([
            { risk_score: 67, risk_grade: 'normal' },
        ])).toThrow('CONCIERGE_PUBLICATION_RISK_SCORE_GRADE_MISMATCH');
        expect(() => assertConciergePublicationRiskScores([
            { risk_score: 43, risk_grade: 'caution' },
            { risk_score: 67, risk_grade: 'caution' },
        ])).not.toThrow();
    });

    it('retains owner step data while atomically persisting the producer overview and mutual count', async () => {
        const targetProfileImage = 'https://scontent.cdninstagram.com/target.jpg';
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'target', 'completed', 'v1', 100, '완료', 149,
                $3::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID, JSON.stringify({
                mutualFollows: ['candidate.one'],
                targetProfileImage,
                targetPosts: [{ id: 'post-1' }],
                unrelatedRetainedKey: { keep: true },
            })],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );

        await db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [43, 67].map((riskScore, index) => ({
                rank: index + 1,
                suspect_instagram_id: `candidate.${index + 1}`,
                suspect_profile_image: null,
                suspect_full_name: `Candidate ${index + 1}`,
                bio: '공개 계정',
                risk_score: riskScore,
                photogenic_grade: 3,
                exposure_level: 'medium',
                is_tagged: false,
                risk_grade: 'caution',
                gender_confidence: 0.9,
                gender_status: 'confirmed',
                is_unlocked: true,
                likes_count: 0,
                intimate_comments_count: 0,
                one_line_overview: `공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정 ${index + 1}입니다.`,
                risk_analysis: [],
            })),
            privateRows: [],
            counts: { male: 0, female: 2, unknown: 0 },
            mutualFollows: 150,
            lineage: {
                schema: 'concierge-exact-mutual-v1',
                sourceFingerprint: 'a'.repeat(64),
                relationship: { completenessProven: true },
                hydration: { exactMutual: 150, hydrated: 149, public: 148, private: 1, unresolved: 1 },
            },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: 'target',
                resultRequestId: REQUEST_ID,
                targetPosts: [],
                targetEvidence: [],
            },
        }));

        const request = await db.query<{
            mutual_follows: number;
            step_data: Record<string, unknown>;
        }>(
            'SELECT mutual_follows, step_data FROM public.analysis_requests WHERE id = $1',
            [REQUEST_ID],
        );
        expect(request.rows[0]).toMatchObject({
            mutual_follows: 150,
            step_data: {
                mutualFollows: ['candidate.one'],
                targetProfileImage,
                targetPosts: [{ id: 'post-1' }],
                unrelatedRetainedKey: { keep: true },
                conciergeEvidence: {
                    schema: 'concierge-exact-mutual-v1',
                    sourceFingerprint: 'a'.repeat(64),
                    hydration: { exactMutual: 150, hydrated: 149, public: 148, private: 1, unresolved: 1 },
                },
            },
        });

        const result = await db.query<{
            one_line_overview: string;
            risk_grade: string;
            risk_score: number;
        }>(
            'SELECT one_line_overview, risk_grade, risk_score FROM public.analysis_results WHERE request_id = $1 ORDER BY rank',
            [REQUEST_ID],
        );
        expect(result.rows.map(row => ({ riskScore: row.risk_score, riskGrade: row.risk_grade })))
            .toEqual([
                { riskScore: 43, riskGrade: 'caution' },
                { riskScore: 67, riskGrade: 'caution' },
            ]);
        expect(result.rows.every(row => Number.isFinite(row.risk_score))).toBe(true);
    });

    it('rejects a publication when the relationship snapshot is incomplete', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'target', 'completed', 'v1', 100, '완료', 149, '{}'::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );

        await expect(db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: { sourceFingerprint: SOURCE_FINGERPRINT, relationship: { completenessProven: false } },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: 'target',
                resultRequestId: REQUEST_ID,
                targetPosts: [],
                targetEvidence: [],
            },
        }))).rejects.toThrow('CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE');
    });

    it('rejects a normalized owner/target mismatch before any publication write', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'other-target', 'completed', 'v1', 100, '완료', 149, '{"keep":true}'::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );

        await expect(db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: { sourceFingerprint: SOURCE_FINGERPRINT, relationship: { completenessProven: true } },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: 'target',
                resultRequestId: REQUEST_ID,
                targetPosts: [],
                targetEvidence: [],
            },
        }))).rejects.toThrow('CONCIERGE_ATOMIC_IDENTITY_SCOPE_CONFLICT');
        await db.exec('ROLLBACK');

        await expect(db.query('SELECT count(*)::int AS count FROM public.analysis_results'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(db.query('SELECT step_data FROM public.analysis_requests WHERE id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [{ step_data: { keep: true } }] });
    });

    it('registers the reviewed live snapshot when the failed V2 source is empty and staging is gone', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'target', 'completed', 'v1', 100, '완료', 149, '{}'::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );

        const targetPosts = [{ id: 'post-live-1', taggedUsers: ['candidate.one'], mentionedUsers: [] }];
        const targetEvidence = [{
            actorUsername: 'candidate.one', postId: 'post-live-1', signal: 'target_post_like',
            sourceInteractionId: 'interaction-live-1', occurredAt: null, content: null,
        }];
        await db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: {
                schema: 'concierge-exact-mutual-v1',
                sourceFingerprint: SOURCE_FINGERPRINT,
                relationship: { completenessProven: true },
            },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: ' @TARGET ',
                resultRequestId: REQUEST_ID,
                targetPosts,
                targetEvidence,
            },
        }));

        await expect(db.query(
            `SELECT reviewed_source_owner_id, reviewed_source_target_instagram_id,
                    reviewed_source_result_request_id, reviewed_source_target_posts,
                    reviewed_source_target_evidence, reviewed_source_fingerprint,
                    published_source_fingerprint, published_result_hash
               FROM public.earlybird_v211_concierge_replays WHERE order_id = $1`,
            [ORDER_ID],
        )).resolves.toMatchObject({ rows: [{
            reviewed_source_owner_id: OWNER_ID,
            reviewed_source_target_instagram_id: 'target',
            reviewed_source_result_request_id: REQUEST_ID,
            reviewed_source_target_posts: targetPosts,
            reviewed_source_target_evidence: targetEvidence,
            reviewed_source_fingerprint: SOURCE_FINGERPRINT,
            published_source_fingerprint: SOURCE_FINGERPRINT,
        }] });
    });

    it('makes an identical source-fingerprint retry idempotent without a second delete/insert', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'target', 'completed', 'v1', 100, '완료', 149, '{}'::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );
        const input = {
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [{
                rank: 1,
                suspect_instagram_id: 'candidate.one',
                suspect_profile_image: null,
                suspect_full_name: 'Candidate One',
                bio: '공개 계정',
                risk_score: 50,
                photogenic_grade: 3,
                exposure_level: 'medium',
                is_tagged: false,
                risk_grade: 'caution',
                gender_confidence: 0.9,
                gender_status: 'confirmed',
                is_unlocked: true,
                likes_count: 0,
                intimate_comments_count: 0,
                one_line_overview: '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
                risk_analysis: [],
            }],
            privateRows: [],
            counts: { male: 0, female: 1, unknown: 0 },
            mutualFollows: 150,
            lineage: {
                schema: 'concierge-exact-mutual-v1',
                sourceFingerprint: SOURCE_FINGERPRINT,
                relationship: { completenessProven: true },
            },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: 'target',
                resultRequestId: REQUEST_ID,
                targetPosts: [],
                targetEvidence: [],
            },
        } as const;
        await db.exec(buildAtomicPublicationSql(input));
        const first = await db.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM public.concierge_publication_mutations',
        );
        await db.exec(buildAtomicPublicationSql(input));
        await expect(db.query('SELECT count(*)::int AS count FROM public.concierge_publication_mutations'))
            .resolves.toMatchObject({ rows: [{ count: 1 }] });
        expect(first.rows[0]?.count).toBe(1);
    });

    it('rejects a changed source fingerprint before touching publication rows', async () => {
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version, progress, progress_step,
                mutual_follows, step_data, current_step
            ) VALUES ($1, $2, 'target', 'completed', 'v1', 100, '완료', 149, '{}'::jsonb, 'completed')`,
            [REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_orders (
                id, user_id, target_instagram_id, result_request_id, status, plan_id, paid_at
            ) VALUES ($1, $3, 'target', $2, 'completed', 'basic', '2026-08-12T09:07:30.000Z')`,
            [ORDER_ID, REQUEST_ID, OWNER_ID],
        );
        await db.query(
            `INSERT INTO public.earlybird_v211_concierge_replays(order_id, original_failed_request_id)
             VALUES ($1, $2)`,
            [ORDER_ID, SOURCE_REQUEST_ID],
        );
        const base = {
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: { schema: 'concierge-exact-mutual-v1', relationship: { completenessProven: true } },
            reviewedSource: {
                sourceRequestId: SOURCE_REQUEST_ID,
                ownerId: OWNER_ID,
                targetUsername: 'target',
                resultRequestId: REQUEST_ID,
                targetPosts: [],
                targetEvidence: [],
            },
        } as const;
        await db.exec(buildAtomicPublicationSql({
            ...base,
            lineage: { ...base.lineage, sourceFingerprint: SOURCE_FINGERPRINT },
        }));
        const before = await db.query('SELECT count(*)::int AS count FROM public.analysis_results');
        await expect(db.exec(buildAtomicPublicationSql({
            ...base,
            lineage: { ...base.lineage, sourceFingerprint: CHANGED_SOURCE_FINGERPRINT },
        }))).rejects.toThrow('CONCIERGE_PUBLICATION_CAS_CONFLICT');
        await db.exec('ROLLBACK');
        await expect(db.query('SELECT count(*)::int AS count FROM public.analysis_results'))
            .resolves.toEqual(before);
    });
});
