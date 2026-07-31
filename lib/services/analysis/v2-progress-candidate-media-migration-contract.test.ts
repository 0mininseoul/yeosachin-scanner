import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'supabase/migrations/20260801010000_add_progress_candidate_media.sql'
);

describe('V2 progress candidate-media migration contract', () => {
    it('adds one bounded, unique proxy-path array to the existing heartbeat', () => {
        expect(existsSync(migrationPath)).toBe(true);
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain(
            "ADD COLUMN feed_image_urls TEXT[] NOT NULL DEFAULT '{}'::TEXT[]"
        );
        expect(migration).toContain('analysis_v2_valid_active_profile_feed_image_urls');
        expect(migration).toContain('analysis_v2_active_profile_feed_images_check');
        expect(migration).toContain("url NOT LIKE '/api/image-proxy?%'");
        expect(migration).toContain('pg_catalog.count(DISTINCT url)');
        expect(migration).toContain('pg_catalog.array_ndims(p_feed_image_urls) <> 1');
        expect(migration).toContain('pg_catalog.array_lower(p_feed_image_urls, 1) <> 1');
        expect(migration).not.toContain('pg_catalog.array_position(p_feed_image_urls, NULL)');
        expect(migration).not.toMatch(/CREATE\s+TABLE/i);
    });

    it('adds only a nullable opaque candidate key with an exact lowercase digest check', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('ADD COLUMN candidate_key TEXT');
        expect(migration).toContain('analysis_v2_active_profile_candidate_key_check');
        expect(migration).toContain("candidate_key ~ '^[a-f0-9]{64}$'");
        expect(migration).not.toMatch(/raw_username|instagram_username/i);
        expect(migration).not.toMatch(/candidate_key\s+TEXT\s+NOT NULL/i);
    });

    it('replaces the exact heartbeat signature without retaining an overload', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain(
            'DROP FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(\n    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT\n);'
        );
        expect(migration).toContain('p_feed_image_urls TEXT[] DEFAULT \'{}\'::TEXT[]');
        expect(migration).toContain('p_candidate_key TEXT DEFAULT NULL');
        expect(migration).toContain(
            'UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT, TEXT[], TEXT'
        );
        expect(migration.match(/DROP FUNCTION public\.checkpoint_analysis_v2_active_profile_heartbeat/g))
            .toHaveLength(1);
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat');
    });

    it('keeps the existing heartbeat fences and idempotent started-at/claim behavior', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        for (const fence of [
            'v_job.input_hash IS DISTINCT FROM p_job_input_hash',
            'v_job.lease_token IS DISTINCT FROM p_claim_token',
            'v_job.lease_expires_at <= v_now',
            'ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH',
            'EXCLUDED.claim_token\n            IS DISTINCT FROM',
            'EXCLUDED.started_at\n                > public.analysis_v2_active_profile_heartbeats.started_at',
        ]) expect(migration).toContain(fence);
        expect(migration).toContain('feed_image_urls = EXCLUDED.feed_image_urls');
        expect(migration).toContain('candidate_key = EXCLUDED.candidate_key');
    });

    it('overlays only the latest live heartbeat media through the owner-scoped loader', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).toContain('CREATE OR REPLACE FUNCTION public.load_analysis_v2_progress');
        expect(migration).toContain('analysis_request.user_id = p_user_id');
        expect(migration).toContain("'feedImageUrls', heartbeat.feed_image_urls");
        expect(migration).toContain("'candidateKey', heartbeat.candidate_key");
        expect(migration).toContain('WHEN heartbeat.candidate_key IS NULL THEN');
        expect(migration).toContain('job.lease_expires_at > pg_catalog.clock_timestamp()');
        expect(migration).toContain(
            'ORDER BY heartbeat.started_at DESC, heartbeat.updated_at DESC, heartbeat.job_key DESC'
        );
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.load_analysis_v2_progress');
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress');
    });

    it('does not modify terminal cleanup, payment/order, or preflight state', () => {
        const migration = readFileSync(migrationPath, 'utf8');
        expect(migration).not.toMatch(/public\.(?:payments?|orders?|analysis_preflights)\b/i);
        expect(migration).not.toMatch(/(?:CREATE|DROP)\s+TRIGGER/i);
        expect(migration).not.toMatch(/UPDATE\s+public\.analysis_requests/i);
    });
});
