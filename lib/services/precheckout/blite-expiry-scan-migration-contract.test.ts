import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_SUFFIX = '_optimize_precheckout_blite_expiry_scan.sql';
const EXPECTED_PREDECESSOR = '20260905110000';

function readOptimizerMigration(): string {
    const migrations = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith(MIGRATION_SUFFIX));

    if (migrations.length === 0) {
        throw new Error('PRECHECKOUT_BLITE_EXPIRY_SCAN_MIGRATION_MISSING');
    }
    expect(migrations).toHaveLength(1);
    return readFileSync(join(process.cwd(), 'supabase/migrations', migrations[0]), 'utf8');
}

function functionDefinition(migration: string): string {
    const start = migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.purge_expired_precheckout_blite_sources_v1(',
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf('\n$$;', start);
    expect(end).toBeGreaterThan(start);
    return migration.slice(start, end);
}

function executableSql(migration: string): string {
    return migration
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('precheckout B-lite expiry scan optimizer migration', () => {
    it('is one bounded replacement after the current migration tip', () => {
        const migration = readOptimizerMigration();
        const sql = executableSql(migration);

        expect(migration).toContain(`-- MIGRATION_PREDECESSOR=${EXPECTED_PREDECESSOR}`);
        expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min';");
        expect(sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION/gi)).toHaveLength(1);
        expect(sql).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+TABLE\b/i);
        expect(sql).not.toMatch(/\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\b/i);
        expect(sql).not.toMatch(/\bTRUNCATE\b/i);
        expect(sql).not.toMatch(/\b(?:GRANT|REVOKE)\b/i);
        expect(sql).not.toMatch(/\b(?:payment|admin|cron|scheduler)\w*\b/i);
    });

    it('drives candidates from expired sources while locking only the parent row', () => {
        const definition = functionDefinition(readOptimizerMigration());

        expect(definition).toMatch(
            /SELECT\s+preflight\.id\s+FROM\s+public\.precheckout_blite_sources\s+AS\s+expired_source\s+JOIN\s+public\.analysis_preflights\s+AS\s+preflight\s+ON\s+preflight\.id\s*=\s*expired_source\.preflight_id/i,
        );
        expect(definition).toContain(
            'expired_source.expires_at <= pg_catalog.clock_timestamp()',
        );
        expect(definition).toMatch(
            /ORDER BY\s+preflight\.id\s+LIMIT\s+p_limit\s+FOR UPDATE OF preflight SKIP LOCKED/i,
        );
        expect(definition).not.toMatch(/WHERE\s+EXISTS\s*\(/i);
    });

    it('preserves identity, privilege, validation, and cleanup contracts', () => {
        const definition = functionDefinition(readOptimizerMigration());

        expect(definition).toContain('p_limit INTEGER DEFAULT 100');
        expect(definition).toContain('RETURNS INTEGER');
        expect(definition).toContain('LANGUAGE plpgsql');
        expect(definition).toContain('SECURITY DEFINER');
        expect(definition).toContain("SET search_path = ''");
        expect(definition).toContain(
            'IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN',
        );
        expect(definition).toContain('PRECHECKOUT_BLITE_INVALID_MAINTENANCE_INPUT');

        const cacheLock = definition.indexOf(
            'FROM public.precheckout_blite_cache AS cache',
        );
        const sourceLock = definition.indexOf(
            'FROM public.precheckout_blite_sources AS source',
        );
        const refreshedClock = definition.indexOf(
            'v_now := pg_catalog.clock_timestamp();',
            sourceLock,
        );
        const expiryRecheck = definition.indexOf(
            'IF NOT FOUND OR v_source.expires_at > v_now THEN',
            refreshedClock,
        );
        const cacheDelete = definition.indexOf(
            'DELETE FROM public.precheckout_blite_cache',
            expiryRecheck,
        );
        const sourceDelete = definition.indexOf(
            'DELETE FROM public.precheckout_blite_sources',
            cacheDelete,
        );

        expect(cacheLock).toBeGreaterThanOrEqual(0);
        expect(sourceLock).toBeGreaterThan(cacheLock);
        expect(refreshedClock).toBeGreaterThan(sourceLock);
        expect(expiryRecheck).toBeGreaterThan(refreshedClock);
        expect(cacheDelete).toBeGreaterThan(expiryRecheck);
        expect(sourceDelete).toBeGreaterThan(cacheDelete);
        expect(definition.slice(cacheLock, sourceLock)).toContain('FOR UPDATE');
        expect(definition.slice(sourceLock, refreshedClock)).toContain('FOR UPDATE');
    });
});
