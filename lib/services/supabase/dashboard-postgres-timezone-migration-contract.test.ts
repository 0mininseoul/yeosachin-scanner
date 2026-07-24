import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationFileName =
    '20260724203500_set_dashboard_postgres_timezone_kst.sql';
const migrationUrl = new URL(
    `../../../supabase/migrations/${migrationFileName}`,
    import.meta.url
);
const migration = existsSync(migrationUrl)
    ? readFileSync(migrationUrl, 'utf8')
    : null;

function requireMigration(): string {
    expect(
        migration,
        `Missing required migration ${migrationFileName}`
    ).not.toBeNull();

    return migration ?? '';
}

function executableSql(sql: string): string {
    return sql
        .replace(/--.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}

describe('Supabase Dashboard postgres timezone migration contract', () => {
    it('sets only the postgres login default for this database to KST', () => {
        const sql = executableSql(requireMigration());

        expect(sql).toBe(
            "ALTER ROLE postgres IN DATABASE postgres SET timezone TO 'Asia/Seoul';"
        );
    });

    it('leaves database-wide and application role timezone defaults unchanged', () => {
        const sql = executableSql(requireMigration());

        expect(sql).not.toMatch(/\bALTER\s+DATABASE\b/i);
        expect(sql).not.toMatch(
            /\bALTER\s+ROLE\s+(?:authenticator|anon|authenticated|service_role)\b/i
        );
    });

    it('does not rewrite timestamp columns, data, defaults, or managed schemas', () => {
        const sql = executableSql(requireMigration());

        expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
        expect(sql).not.toMatch(/\b(?:SET|DROP)\s+DEFAULT\b/i);
        expect(sql).not.toMatch(/\bTYPE\s+(?:timestamp|timestamptz)\b/i);
        expect(sql).not.toMatch(/\b(?:auth|realtime|storage)\s*\./i);
        expect(sql).not.toMatch(
            /\bALTER\s+ROLE\s+(?:supabase_auth_admin|supabase_realtime_admin|supabase_storage_admin)\b/i
        );
    });

    it('documents session scope and the Table Editor reconnect requirement', () => {
        const sql = requireMigration();

        expect(sql).toContain('Stored timestamptz instants remain UTC');
        expect(sql).toContain('new sessions logged in as postgres');
        expect(sql).toContain('Application/PostgREST roles remain UTC');
        expect(sql).toContain('reconnect or refresh the Dashboard Table Editor');
    });
});
