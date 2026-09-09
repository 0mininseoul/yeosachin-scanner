import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

function migrationSql(): string {
    const migration = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_add_commerce_operation_canonical_tables.sql'))
        .sort();
    if (migration.length !== 1) {
        throw new Error(
            `Expected one generated commerce migration, found ${migration.length}`,
        );
    }
    return readFileSync(
        join(process.cwd(), 'supabase/migrations', migration[0]),
        'utf8',
    );
}

describe('commerce canonical SQL smoke contract', () => {
    it('can execute the immutable guard shape in disposable PostgreSQL syntax', async () => {
        const db = new PGlite();
        await db.exec(`
            CREATE TABLE canonical_probe (id integer PRIMARY KEY, value text NOT NULL);
            CREATE FUNCTION reject_probe_mutation()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'APPEND_ONLY'; END; $$;
            CREATE TRIGGER canonical_probe_immutable
            BEFORE UPDATE OR DELETE ON canonical_probe
            FOR EACH ROW EXECUTE FUNCTION reject_probe_mutation();
        `);
        await db.exec('INSERT INTO canonical_probe VALUES (1, \'ok\')');
        await expect(db.exec("UPDATE canonical_probe SET value = 'nope'"))
            .rejects.toThrow('APPEND_ONLY');
        await db.close();
    });

    it('contains the PostgreSQL constructs that the disposable smoke test protects', () => {
        const sql = migrationSql();
        expect(sql).toContain('CREATE TRIGGER payment_events_immutable');
        expect(sql).toContain('CREATE TRIGGER account_lifecycle_immutable');
        expect(sql).toContain('CREATE TRIGGER system_configuration_immutable');
        expect(sql).toContain('CREATE INDEX payment_events_order_recorded_idx');
        expect(sql).toContain('CREATE INDEX maintenance_jobs_recovery_idx');
    });
});
