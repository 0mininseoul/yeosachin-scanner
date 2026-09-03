import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationName = '20260904100000_analysis_v2_scheduler_recovery_index.sql';
const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations', migrationName),
    'utf8',
);

function normalizedStatements(): string[] {
    return migration
        .replace(/^\s*--.*$/gm, '')
        .split(';')
        .map(statement => statement.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
}

describe('analysis v2 scheduler recovery index migration', () => {
    it('is reserved after the approved predecessor and stays one-file/transaction-compatible', () => {
        const statements = normalizedStatements();
        const indexStatements = statements.filter(statement =>
            statement.startsWith('CREATE INDEX IF NOT EXISTS'),
        );

        expect(Number(migrationName.slice(0, 14))).toBeGreaterThan(20260904000000);
        expect(migration).toContain('-- MIGRATION_PREDECESSOR=20260904000000');
        expect(statements).toHaveLength(3);
        expect(indexStatements).toHaveLength(1);
        expect(migration).not.toMatch(/\b(BEGIN|COMMIT|DROP|ALTER|UPDATE|INSERT|DELETE|TRUNCATE|VACUUM|REINDEX|CONCURRENTLY)\b/i);
        expect(migration).not.toMatch(/\b(payment|provider|vertex|gemini|apify|user)\b/i);
    });

    it('matches the observed recovery predicate/order and bounds rollout waits', () => {
        expect(migration).toContain(
            'CREATE INDEX IF NOT EXISTS analysis_v2_scheduler_operations_recovery_idx',
        );
        expect(migration).toMatch(
            /ON public\.analysis_v2_scheduler_operations\s*\(\s*recovery_deadline_at,\s*request_id,\s*operation_key\s*\)/,
        );
        expect(migration).toContain("WHERE status = 'claimed';");
        expect(migration).toContain("SET LOCAL lock_timeout = '5s';");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min';");
    });
});
