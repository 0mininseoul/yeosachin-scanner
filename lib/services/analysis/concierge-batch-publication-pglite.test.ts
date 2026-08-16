import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260816153000_publish_concierge_batch_manual_override.sql', import.meta.url),
    'utf8',
);

const ORDER_ID = '123e4567-e89b-42d3-a456-426614174000';
const REQUEST_ID = '223e4567-e89b-42d3-a456-426614174000';
const SOURCE_REQUEST_ID = '323e4567-e89b-42d3-a456-426614174000';
const OWNER_ID = '423e4567-e89b-42d3-a456-426614174000';
const HASH = 'a'.repeat(64);

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
            mutual_follows INTEGER,
            opposite_gender_count INTEGER,
            gender_stats JSONB,
            step_data JSONB NOT NULL DEFAULT '{}'::JSONB
        );
        CREATE TABLE public.earlybird_orders (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            target_instagram_id TEXT NOT NULL,
            result_request_id UUID NOT NULL,
            status TEXT NOT NULL,
            paid_at TIMESTAMPTZ
        );
        CREATE TABLE public.analysis_results (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL,
            rank INTEGER NOT NULL,
            suspect_instagram_id TEXT NOT NULL,
            suspect_profile_image TEXT,
            suspect_full_name TEXT,
            bio TEXT,
            risk_score INTEGER NOT NULL,
            photogenic_grade INTEGER,
            exposure_level TEXT,
            is_tagged BOOLEAN,
            risk_grade TEXT,
            gender_confidence DOUBLE PRECISION,
            gender_status TEXT,
            is_unlocked BOOLEAN,
            likes_count INTEGER,
            intimate_comments_count INTEGER,
            one_line_overview TEXT,
            risk_analysis JSONB NOT NULL DEFAULT '[]'::JSONB
        );
        CREATE TABLE public.private_accounts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL,
            instagram_id TEXT NOT NULL,
            profile_image TEXT,
            full_name TEXT,
            name_female_score REAL,
            name_is_name BOOLEAN,
            name_confidence REAL,
            UNIQUE (request_id, instagram_id)
        );
    `);
    await db.exec(migration);
    await db.query(
        `INSERT INTO public.analysis_requests(id, user_id, target_instagram_id, status)
         VALUES ($1, $3, 'target', 'completed'), ($2, $3, 'target', 'failed')`,
        [REQUEST_ID, SOURCE_REQUEST_ID, OWNER_ID],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders(
            id, user_id, target_instagram_id, result_request_id, status, paid_at
         ) VALUES ($1, $2, 'target', $3, 'analysis_in_progress', now())`,
        [ORDER_ID, OWNER_ID, REQUEST_ID],
    );
});

afterEach(async () => {
    await db.close();
});

function publicationPayload(privateRows: unknown[] = [
    { sort_ordinal: 1, instagram_id: 'alpha', profile_image: 'https://images.example/alpha.jpg', full_name: '알파', name_female_score: Math.fround(0.8123456789), name_is_name: true, name_confidence: Math.fround(0.2345678912) },
    { sort_ordinal: 2, instagram_id: 'beta', profile_image: 'https://images.example/beta.jpg', full_name: '베타', name_female_score: Math.fround(0.8123456789), name_is_name: true, name_confidence: Math.fround(0.2345678912) },
    { sort_ordinal: 3, instagram_id: 'zulu', profile_image: 'https://images.example/zulu.jpg', full_name: '줄리', name_female_score: 0.7, name_is_name: true, name_confidence: 0.2 },
]) {
    return {
        rows: [{
            rank: 1, suspect_instagram_id: 'public.female', suspect_profile_image: null,
            suspect_full_name: '공개 여성', bio: '공개 계정', risk_score: 42,
            photogenic_grade: 3, exposure_level: 'medium', is_tagged: false,
            risk_grade: 'caution', gender_confidence: 0.9, gender_status: 'confirmed',
            is_unlocked: true, likes_count: 0, intimate_comments_count: 0,
            one_line_overview: '공개 프로필을 중심으로 정리한 계정입니다.', risk_analysis: [],
        }],
        privateRows,
        counts: {
            male: 1, female: 1, unknown: 0, public: 2, private: privateRows.length,
            unresolved: 0, mutual: privateRows.length + 2,
            authoritativeMutual: privateRows.length + 2,
            hydrated: privateRows.length + 2, analyzed: 2,
        },
    };
}

async function publish(payload = publicationPayload()) {
    return db.query<{ result: Record<string, unknown> }>(
        `SELECT public.publish_concierge_batch_manual_override(
            $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::uuid,
            $7::text, $8::text, $9::integer, $10::text, $11::text, $12::text,
            $13::text, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb
        ) AS result`,
        [
            ORDER_ID, REQUEST_ID, OWNER_ID, 'target', HASH, SOURCE_REQUEST_ID,
            'b'.repeat(64), 'c'.repeat(64), 0, null, 'd'.repeat(64),
            `/result/${REQUEST_ID}`, 'e'.repeat(64), {}, payload, {}, {},
        ],
    );
}

describe('future concierge batch publication RPC', () => {
    it('atomically persists and reads text-only private-name fields in display order', async () => {
        const response = await publish();

        expect(response.rows[0]!.result).toMatchObject({
            published: true,
            idempotent: false,
            ownerReadContractVerified: true,
            adminReadContractVerified: true,
            resultHash: 'd'.repeat(64),
            resultUrl: `/result/${REQUEST_ID}`,
            requestId: REQUEST_ID,
            version: 1,
            counts: { male: 1, female: 1, unknown: 0, public: 2, private: 3 },
            privateRows: [
                { sortOrdinal: 1, instagramId: 'alpha', nameFemaleScore: 0.8123457, nameIsName: true, nameConfidence: 0.2345679 },
                { sortOrdinal: 2, instagramId: 'beta', nameFemaleScore: 0.8123457, nameIsName: true, nameConfidence: 0.2345679 },
                { sortOrdinal: 3, instagramId: 'zulu', nameFemaleScore: 0.7, nameIsName: true, nameConfidence: 0.2 },
            ],
        });

        const persisted = await db.query<{
            instagram_id: string;
            name_female_score: number;
            name_is_name: boolean;
            name_confidence: number;
        }>(
            `SELECT instagram_id, name_female_score, name_is_name, name_confidence
             FROM public.private_accounts WHERE request_id = $1
             ORDER BY name_female_score DESC, name_confidence DESC, instagram_id ASC`,
            [REQUEST_ID],
        );
        expect(persisted.rows).toEqual([
            { instagram_id: 'alpha', name_female_score: 0.8123457, name_is_name: true, name_confidence: 0.2345679 },
            { instagram_id: 'beta', name_female_score: 0.8123457, name_is_name: true, name_confidence: 0.2345679 },
            { instagram_id: 'zulu', name_female_score: 0.7, name_is_name: true, name_confidence: 0.2 },
        ]);

        const request = await db.query<{
            gender_stats: Record<string, number>;
            opposite_gender_count: number;
            order_status: string;
        }>(
            `SELECT request.gender_stats, request.opposite_gender_count, earlybird_order.status AS order_status
             FROM public.analysis_requests AS request
             JOIN public.earlybird_orders AS earlybird_order ON earlybird_order.id = $2
             WHERE request.id = $1`,
            [REQUEST_ID, ORDER_ID],
        );
        expect(request.rows[0]).toEqual({
            gender_stats: { male: 1, female: 1, unknown: 0 },
            opposite_gender_count: 1,
            order_status: 'completed',
        });
    });

    it('rejects an invalid private row before replacing any result projection', async () => {
        const invalidPayload = publicationPayload([
            { sort_ordinal: 2, instagram_id: 'alpha', profile_image: null, full_name: null, name_female_score: 0.9, name_is_name: true, name_confidence: 0.6 },
        ]);

        await expect(publish(invalidPayload)).rejects.toThrow('CONCIERGE_PUBLICATION_PRIVATE_ORDER_MISMATCH');
        await expect(db.query('SELECT * FROM public.analysis_results WHERE request_id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [] });
        await expect(db.query('SELECT * FROM public.private_accounts WHERE request_id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [] });
    });

    it('refuses the first-order bootstrap request without changing its projection', async () => {
        await db.query(
            `UPDATE public.analysis_requests
             SET step_data = '{"conciergeBootstrap":{"resultHash":"historic"}}'::jsonb
             WHERE id = $1`,
            [REQUEST_ID],
        );

        await expect(publish()).rejects.toThrow('CONCIERGE_PUBLICATION_FIRST_ORDER_IMMUTABLE');
        await expect(db.query('SELECT * FROM public.analysis_results WHERE request_id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [] });
        await expect(db.query('SELECT * FROM public.private_accounts WHERE request_id = $1', [REQUEST_ID]))
            .resolves.toMatchObject({ rows: [] });
    });
});
