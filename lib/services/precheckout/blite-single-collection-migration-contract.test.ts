import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSingleCollectionMigration(): string {
    const migrations = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_precheckout_blite_single_collection.sql'));
    expect(migrations).toHaveLength(1);
    return readFileSync(join(process.cwd(), 'supabase/migrations', migrations[0]), 'utf8');
}

function readRunbook(): string {
    return readFileSync(
        join(process.cwd(), 'docs/precheckout-blite-single-collection-runbook.md'),
        'utf8',
    );
}

function functionDefinition(migration: string, name: string): string {
    const start = migration.indexOf(`FUNCTION public.${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

describe('precheckout B-lite single-collection migration', () => {
    it('snapshots cohort/deadline metadata and creates an isolated bounded source row', () => {
        const migration = readSingleCollectionMigration();

        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS precheckout_blite_cohort BOOLEAN NOT NULL DEFAULT FALSE/);
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP WITH TIME ZONE/);
        expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMP WITH TIME ZONE/);
        expect(migration).toContain('CREATE TABLE public.precheckout_blite_sources');
        for (const column of [
            'preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE',
            'schema_version SMALLINT NOT NULL',
            'target_input_hash VARCHAR(64) NOT NULL',
            'provider_run_id UUID',
            'provider_operation_key TEXT NOT NULL',
            'provider_run_reference TEXT',
            'payload JSONB NOT NULL',
            'payload_bytes INTEGER NOT NULL',
            'payload_hash VARCHAR(64) NOT NULL',
            'collected_at TIMESTAMP WITH TIME ZONE NOT NULL',
            'expires_at TIMESTAMP WITH TIME ZONE NOT NULL',
        ]) expect(migration).toContain(column);
        expect(migration).toContain(
            'FOREIGN KEY (provider_run_id, provider_operation_key)',
        );
        expect(migration).toContain(
            'REFERENCES public.analysis_preflight_provider_runs(preflight_id, operation_key)',
        );
        expect(migration).toMatch(/payload_bytes <= 262144/);
        expect(migration).toMatch(/payload_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
        expect(migration).toContain("pg_catalog.jsonb_typeof(p_payload) <> 'object'");
        expect(migration).toContain("p_expires_at > v_preflight.expires_at");
        expect(migration).toContain("p_expires_at > p_collected_at + INTERVAL '30 minutes'");
    });

    it('upgrades the result state machine and fences its bounded terminal lifecycle', () => {
        const migration = readSingleCollectionMigration();

        expect(migration).toContain('DROP CONSTRAINT precheckout_blite_cache_state_check');
        expect(migration).toMatch(
            /ADD CONSTRAINT precheckout_blite_cache_state_check CHECK \(\s*state IN \('pending', 'complete', 'failed'\)/,
        );
        expect(migration).toContain("state IN ('pending', 'complete', 'failed')");
        expect(migration).toContain('attempt_count SMALLINT NOT NULL DEFAULT 0');
        expect(migration).toContain('failure_reason TEXT');
        expect(migration).toContain('failed_at TIMESTAMP WITH TIME ZONE');
        expect(migration).toContain("completed_at = v_now");
        expect(migration).toContain("attempt_count < 2");
        expect(migration).toContain("v_preflight.deadline_at > v_now");
        expect(migration).toContain("v_preflight.deadline_at - INTERVAL '4 seconds' > v_now");
        expect(migration).toContain("v_source.expires_at > v_now");
        expect(migration).toContain("failure_reason IN ('source_missing', 'source_expired', 'source_invalid', 'source_insufficient', 'dispatch_failed', 'inference_timeout', 'inference_rate_limited', 'inference_provider_failed', 'inference_response_invalid', 'persistence_failed', 'attempts_exhausted')");
    });

    it('anchors every cohort deadline to immutable preflight creation rather than worker wall time', () => {
        const migration = readSingleCollectionMigration();
        const clock = functionDefinition(migration, 'enforce_precheckout_blite_preflight_clock_v1');

        expect(migration).toContain('submitted_at = created_at');
        expect(migration).toContain("deadline_at = created_at + INTERVAL '60 seconds'");
        expect(clock).toContain('NEW.submitted_at := NEW.created_at;');
        expect(clock).toContain("NEW.deadline_at := NEW.created_at + INTERVAL '60 seconds';");
        expect(clock).toContain('NEW.created_at IS DISTINCT FROM OLD.created_at');
        expect(migration).toContain(
            'UPDATE OF precheckout_blite_cohort, submitted_at, deadline_at, created_at',
        );
    });

    it('provides only security-definer service RPCs with exact v2 names', () => {
        const migration = readSingleCollectionMigration();
        const names = [
            'finalize_preflight_blite_source_v1',
            'claim_precheckout_blite_v2',
            'complete_precheckout_blite_v2',
            'fail_precheckout_blite_v2',
            'read_precheckout_blite_status_v1',
            'purge_expired_precheckout_blite_sources_v1',
        ];

        for (const name of names) {
            const definition = functionDefinition(migration, name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role`
            ));
        }

        expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/);
        expect(migration).toMatch(/REVOKE ALL ON TABLE public\.precheckout_blite_sources FROM PUBLIC, anon, authenticated/);
        expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.precheckout_blite_sources TO service_role/);
    });

    it('finalizes source and ready-state atomically, then deletes source on every scrub/terminal path', () => {
        const migration = readSingleCollectionMigration();
        const finalize = functionDefinition(migration, 'finalize_preflight_blite_source_v1');

        expect(finalize).toContain('FOR UPDATE');
        expect(finalize).toContain('p_claim_token');
        expect(finalize).toContain('p_target_input_hash');
        expect(finalize).toContain('p_provider_run_id');
        expect(finalize).toContain('p_provider_operation_key');
        expect(finalize).toContain('provider_run.operation_key = p_provider_operation_key');
        expect(finalize).toContain('public.complete_analysis_v2_preflight(');
        expect(finalize).toContain('public.complete_anonymous_analysis_v2_preflight(');
        expect(finalize).toContain('INSERT INTO public.precheckout_blite_sources');
        expect(finalize).toContain("extensions.digest(pg_catalog.convert_to(p_payload::TEXT, 'UTF8'), 'sha256')");
        expect(finalize).toContain('v_source.payload_hash = v_payload_hash');
        expect(migration).toContain('complete_analysis_v2_preflight_with_blite_source_v1');
        expect(migration).toContain('complete_anonymous_analysis_v2_preflight_with_blite_source_v1');
        expect(migration).toMatch(/DELETE FROM public\.precheckout_blite_sources[\s\S]*DELETE FROM public\.precheckout_blite_cache/);
        expect(migration).toContain('AFTER UPDATE OF pii_scrubbed_at ON public.analysis_preflights');
        expect(migration).not.toContain('PRECHECKOUT_BLITE_ENABLED');
    });

    it('requires the database to validate every complete DTO, full provider lineage, and safe cleanup lock order', () => {
        const migration = readSingleCollectionMigration();
        const complete = functionDefinition(migration, 'complete_precheckout_blite_v2');
        const purge = functionDefinition(migration, 'purge_expired_precheckout_blite_sources_v1');
        const piiCleanup = functionDefinition(migration, 'delete_precheckout_blite_cache_on_pii_scrub_v1');

        expect(complete).toContain('public.precheckout_blite_v1_dto_is_valid(p_dto)');
        expect(complete).toContain("v_preflight.deadline_at - INTERVAL '4 seconds' > v_now");
        expect(complete).toContain("failure_reason = 'inference_timeout'");
        expect(purge.indexOf('FROM public.precheckout_blite_cache AS cache'))
            .toBeLessThan(purge.indexOf('FROM public.precheckout_blite_sources AS source'));
        expect(piiCleanup.indexOf('FROM public.precheckout_blite_cache AS cache'))
            .toBeLessThan(piiCleanup.indexOf('FROM public.precheckout_blite_sources AS source'));
    });

    it('re-evaluates wall time after preflight, cache, and source lock waits', () => {
        const migration = readSingleCollectionMigration();
        const finalizer = functionDefinition(migration, 'finalize_preflight_blite_source_v1');
        const claim = functionDefinition(migration, 'claim_precheckout_blite_v2');

        const complete = functionDefinition(migration, 'complete_precheckout_blite_v2');
        const fail = functionDefinition(migration, 'fail_precheckout_blite_v2');
        for (const definition of [finalizer, claim]) {
            const sourceLock = definition.indexOf('FROM public.precheckout_blite_sources AS source');
            const refreshedClock = definition.indexOf('v_now := pg_catalog.clock_timestamp();', sourceLock);
            expect(sourceLock).toBeGreaterThanOrEqual(0);
            expect(refreshedClock).toBeGreaterThan(sourceLock);
        }
        for (const definition of [complete, fail]) {
            const cacheLock = definition.indexOf('FROM public.precheckout_blite_cache AS cache');
            const refreshedClock = definition.indexOf('v_now := pg_catalog.clock_timestamp();', cacheLock);
            expect(cacheLock).toBeGreaterThanOrEqual(0);
            expect(refreshedClock).toBeGreaterThan(cacheLock);
        }
    });

    it('keeps the service-only v1 cache RPCs executable during the DB-first rollout window', () => {
        const migration = readSingleCollectionMigration();

        for (const signature of [
            'claim_precheckout_blite_v1(UUID)',
            'complete_precheckout_blite_v1(UUID, UUID, JSONB)',
            'release_precheckout_blite_v1(UUID, UUID)',
        ]) {
            expect(migration).not.toContain(`DROP FUNCTION public.${signature}`);
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&').replaceAll(', ', ',\\s*')}[\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`,
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${signature.replace(/[()]/g, '\\$&').replaceAll(', ', ',\\s*')}[\\s\\S]*?TO service_role`,
            ));
        }
    });

    it('keeps dispatch recovery additive inside the single release migration and allowlist', () => {
        const migration = readSingleCollectionMigration();
        const migrationFiles = readdirSync(join(process.cwd(), 'supabase/migrations'))
            .filter(name => name.includes('precheckout_blite'))
            .filter(name => !name.startsWith('20260812231822_'))
            .sort();
        expect(migrationFiles).toEqual([
            '20260813041712_precheckout_blite_single_collection.sql',
        ]);
        const runbook = readRunbook();
        expect(runbook).toMatch(
            /exact allowlist contains only[\s\S]*`20260813041712_precheckout_blite_single_collection\.sql`/,
        );
        expect(runbook).not.toMatch(/20260813\d+_precheckout_blite_dispatch_recovery\.sql/);

        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.precheckout_blite_dispatches');
        expect(migration).toContain('ALTER TABLE public.precheckout_blite_dispatches ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain('ALTER TABLE public.precheckout_blite_dispatches FORCE ROW LEVEL SECURITY');
        expect(migration).toContain(
            'REVOKE ALL ON TABLE public.precheckout_blite_dispatches FROM PUBLIC, anon, authenticated',
        );
        expect(migration).toContain(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.precheckout_blite_dispatches TO service_role',
        );
        for (const name of [
            'reserve_precheckout_blite_dispatch_v1',
            'mark_precheckout_blite_dispatch_failed_v1',
            'mark_precheckout_blite_dispatch_enqueued_v1',
        ]) {
            const definition = functionDefinition(migration, name);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
            expect(migration).toMatch(new RegExp(
                `REVOKE ALL ON FUNCTION public\\.${name}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`,
            ));
            expect(migration).toMatch(new RegExp(
                `GRANT EXECUTE ON FUNCTION public\\.${name}\\([\\s\\S]*?TO service_role`,
            ));
        }
        const reserve = functionDefinition(migration, 'reserve_precheckout_blite_dispatch_v1');
        expect(reserve).toContain('v_preflight.precheckout_blite_cohort');
        expect(reserve).toContain("v_preflight.status <> 'ready'");
        expect(reserve.indexOf('FOR UPDATE')).toBeLessThan(
            reserve.indexOf('v_now := pg_catalog.clock_timestamp();', reserve.indexOf('FOR UPDATE')),
        );
        expect(reserve).toContain("'should_enqueue', FALSE");
        expect(reserve).toContain('public.precheckout_blite_sources AS source');
        expect(reserve).toContain('public.precheckout_blite_cache AS cache');
        expect(reserve).toContain("v_dispatch.state = 'enqueued'");
        expect(migration).toContain("failure_reason = 'dispatch_failed'");
        expect(migration).toContain('public.precheckout_blite_dispatches AS dispatch');
        expect(migration).toContain('DELETE FROM public.precheckout_blite_dispatches');
    });
});
