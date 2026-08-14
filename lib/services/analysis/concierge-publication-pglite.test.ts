import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAtomicPublicationSql } from '../../../scripts/correct-concierge-basic-result';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260814210000_add_legacy_result_overview.sql', import.meta.url),
    'utf8',
);

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '223e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '323e4567-e89b-42d3-a456-426614174000';

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
    `);
    await db.exec(migration);
});

afterEach(async () => {
    await db.close();
});

describe('concierge publication persistence contract', () => {
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

        await db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [{
                rank: 1,
                suspect_instagram_id: 'candidate.one',
                suspect_profile_image: null,
                suspect_full_name: 'Candidate One',
                bio: '공개 계정',
                risk_score: 7,
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
                sourceFingerprint: 'a'.repeat(64),
                relationship: { completenessProven: true },
                hydration: { exactMutual: 150, hydrated: 149, public: 148, private: 1, unresolved: 1 },
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
        }>(
            'SELECT one_line_overview, risk_grade FROM public.analysis_results WHERE request_id = $1',
            [REQUEST_ID],
        );
        expect(result.rows).toEqual([{
            one_line_overview: '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
            risk_grade: 'caution',
        }]);
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

        await expect(db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: { relationship: { completenessProven: false } },
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

        await expect(db.exec(buildAtomicPublicationSql({
            orderId: ORDER_ID,
            requestId: REQUEST_ID,
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknown: 0 },
            mutualFollows: 150,
            lineage: { relationship: { completenessProven: true } },
        }))).rejects.toThrow('CONCIERGE_ATOMIC_IDENTITY_SCOPE_CONFLICT');
        await db.exec('ROLLBACK');

        await expect(db.query('SELECT count(*)::int AS count FROM public.analysis_results'))
            .resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(db.query('SELECT step_data FROM public.analysis_requests WHERE id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [{ step_data: { keep: true } }] });
    });
});
