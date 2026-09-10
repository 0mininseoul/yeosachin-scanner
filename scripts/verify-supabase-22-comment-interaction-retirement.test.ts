import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'supabase/migrations');
const MIGRATION_FILE_NAME = '20260910123053_retire_comment_interaction_evidence.sql';
const MIGRATION_RELATIVE_PATH = `supabase/migrations/${MIGRATION_FILE_NAME}`;
const MIGRATION_PATH = resolve(MIGRATIONS_DIR, MIGRATION_FILE_NAME);
const SQL_PATH = resolve(
    REPO_ROOT,
    'supabase/operations/20260910_retire_comment_interaction_evidence_draft.sql',
);
const MANIFEST_PATH = resolve(
    REPO_ROOT,
    'docs/reports/2026-09-10-supabase-22-comment-interaction-retirement-manifest.json',
);
const REPORT_PATH = resolve(
    REPO_ROOT,
    'docs/reports/2026-09-10-supabase-22-comment-interaction-retirement-evidence.md',
);
const TARGETS = ['public.comment_details', 'public.interaction_logs'] as const;
const EXPECTED_DROP_STATEMENTS = TARGETS.map(table => `DROP TABLE ${table};`);
const ALLOWLIST_CANONICAL_JSON = JSON.stringify(TARGETS);
const ALLOWLIST_SHA256 = 'a616d2972b931904113f18fb075850ef13cba0a384ea3b819740ee2f012dabe6';
const ZERO_ROW_DATASET_CANONICAL_JSON = JSON.stringify([
    { table: TARGETS[0], rows: [] },
    { table: TARGETS[1], rows: [] },
]);
const ZERO_ROW_DATASET_SHA256 = createHash('sha256')
    .update(ZERO_ROW_DATASET_CANONICAL_JSON, 'utf8')
    .digest('hex');

function stripSqlComments(sql: string): string {
    return sql
        .replace(/--[^\r\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeSqlWhitespace(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function extractNormalizedDropStatements(sql: string): string[] {
    const activeSql = stripSqlComments(sql);
    return [...activeSql.matchAll(/(?:^|[;\r\n])\s*(DROP\b[^;]*;)/gim)]
        .map(match => normalizeSqlWhitespace(match[1]));
}

function readDraft(): string {
    return readFileSync(SQL_PATH, 'utf8');
}

function readMigration(): string {
    return readFileSync(MIGRATION_PATH, 'utf8');
}

function extractRestoreSql(sql: string): string {
    const marker = sql.indexOf('RESTORE ONLY');
    const commentStart = sql.lastIndexOf('/*', marker);
    const commentEnd = sql.indexOf('*/', marker);
    if (marker < 0 || commentStart < 0 || commentEnd < 0 || commentEnd <= commentStart) {
        throw new Error('RESTORE_BLOCK_NOT_FOUND');
    }
    const restoreSql = sql.slice(commentStart + 2, commentEnd);
    if (!/^\s*--\s*RESTORE ONLY/m.test(restoreSql)
        || !/\bBEGIN\s*;/i.test(restoreSql)
        || !/\bCOMMIT\s*;/i.test(restoreSql)
        || /\bDROP\s+TABLE\b/i.test(restoreSql)) {
        throw new Error('RESTORE_BLOCK_UNSAFE');
    }
    return restoreSql;
}

type RetirementManifest = {
    destructiveAllowlist: readonly string[];
    destructiveAllowlistCanonicalJson: string;
    destructiveAllowlistSha256: string;
    destructiveOperations: string;
    zeroRowDataset: {
        canonicalJson: string;
        sha256: string;
        rowCount: number;
        tables: readonly string[];
    };
    archiveStatus: string;
    archiveException: {
        acceptable: boolean;
        reason: string;
    };
    restoreStatus: string;
    restoreEvidence: {
        environment: string;
        schemaVerified: boolean;
        tables: readonly string[];
    };
    observationConclusion: {
        status: string;
        conclusion: string;
    };
    retirementDecision: {
        status: string;
        ownerApproval: string;
        migrationFileCreated: boolean;
        migrationFilePath: string;
    };
    validation: {
        focusedTests: string;
        lint: string;
        diffReview: string;
        stagedSecretScan: string;
    };
};

function readManifest(): RetirementManifest {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RetirementManifest;
}

async function createRestoreDrillDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    await db.exec(`
        -- These roles, schemas, and helpers are the smallest harness boundary
        -- needed to execute the commented restore block without Supabase.
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE SCHEMA extensions;
        CREATE SCHEMA auth;
        CREATE FUNCTION extensions.uuid_generate_v4()
        RETURNS uuid
        LANGUAGE sql VOLATILE
        AS $$ SELECT pg_catalog.gen_random_uuid() $$;
        CREATE FUNCTION auth.uid()
        RETURNS uuid
        LANGUAGE sql STABLE
        AS $$ SELECT NULL::uuid $$;
        CREATE TABLE public.analysis_requests (
            id uuid PRIMARY KEY,
            user_id uuid
        );
        CREATE TABLE public.analysis_results (
            id uuid PRIMARY KEY,
            request_id uuid NOT NULL REFERENCES public.analysis_requests(id)
                ON DELETE CASCADE
        );
    `);
    return db;
}

async function queryRows<T>(db: PGlite, sql: string): Promise<readonly T[]> {
    const result = await db.query<T>(sql);
    return result.rows;
}

describe('Supabase 22 comment/interactions retirement approval package', () => {
    it('uses the single CLI-generated migration path and keeps the draft outside migrations', () => {
        expect(SQL_PATH.startsWith(`${MIGRATIONS_DIR}/`)).toBe(false);
        expect(existsSync(SQL_PATH)).toBe(true);
        expect(existsSync(resolve(MIGRATIONS_DIR, '20260910_retire_comment_interaction_evidence_draft.sql')))
            .toBe(false);
        expect(existsSync(MIGRATION_PATH)).toBe(true);
        expect(readdirSync(MIGRATIONS_DIR)
            .filter(fileName => fileName.endsWith('_retire_comment_interaction_evidence.sql')))
            .toEqual([MIGRATION_FILE_NAME]);
        expect(readMigration()).not.toContain('RESTORE ONLY');
        expect(readMigration()).not.toContain('/*');
    });

    it('binds the generated migration to exactly the two qualified destructive targets', () => {
        const migration = readMigration();
        const activeMigration = stripSqlComments(migration);
        const destructiveStatements = activeMigration.match(
            /\b(?:DROP\s+(?:TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|INDEX|SEQUENCE|TYPE|DOMAIN|POLICY|TRIGGER)|TRUNCATE\s+TABLE)\b[^;]*;/gi,
        ) ?? [];
        const dropStatements = extractNormalizedDropStatements(migration);
        expect(destructiveStatements).toHaveLength(TARGETS.length);
        expect(dropStatements).toEqual(EXPECTED_DROP_STATEMENTS);
        expect(destructiveStatements.map(normalizeSqlWhitespace)).toEqual(dropStatements);
        expect(dropStatements.every(statement => !/\bCASCADE\b/i.test(statement))).toBe(true);
        expect(migration).not.toMatch(/\bDROP\s+TABLE\b[^;]*\bCASCADE\b/i);
        expect(activeMigration.match(
            /(?:^|[;\r\n])\s*(?:TRUNCATE|DELETE|UPDATE|INSERT|CREATE|ALTER|RENAME|GRANT|REVOKE)\b/gim,
        ) ?? []).toEqual([]);
    });

    it('rejects non-table DROP forms in the active statement allowlist', () => {
        const migrationWithNonTableDrop = [
            'DROP TABLE public.comment_details;',
            'DROP TABLE public.interaction_logs;',
            'DROP PROCEDURE public.legacy_cleanup();',
        ].join('\n');

        expect(extractNormalizedDropStatements(migrationWithNonTableDrop)).toEqual([
            'DROP TABLE public.comment_details;',
            'DROP TABLE public.interaction_logs;',
            'DROP PROCEDURE public.legacy_cleanup();',
        ]);
        expect(extractNormalizedDropStatements(migrationWithNonTableDrop))
            .not.toEqual(EXPECTED_DROP_STATEMENTS);

        const migrationWithDropInsideDo = [
            'DO $$',
            'BEGIN',
            '    DROP TABLE public.unapproved_table;',
            'END;',
            '$$;',
            'DROP TABLE public.comment_details;',
            'DROP TABLE public.interaction_logs;',
        ].join('\n');
        expect(extractNormalizedDropStatements(migrationWithDropInsideDo))
            .toEqual([
                'DROP TABLE public.unapproved_table;',
                ...EXPECTED_DROP_STATEMENTS,
            ]);
        expect(extractNormalizedDropStatements(migrationWithDropInsideDo))
            .not.toEqual(EXPECTED_DROP_STATEMENTS);
    });

    it('rejects a comma-separated third DROP TABLE target', () => {
        const migrationWithThirdTarget = [
            'DROP TABLE public.comment_details, public.unapproved_table;',
            'DROP TABLE public.interaction_logs;',
        ].join('\n');

        expect(extractNormalizedDropStatements(migrationWithThirdTarget)).toEqual([
            'DROP TABLE public.comment_details, public.unapproved_table;',
            'DROP TABLE public.interaction_logs;',
        ]);
        expect(extractNormalizedDropStatements(migrationWithThirdTarget))
            .not.toEqual(EXPECTED_DROP_STATEMENTS);
    });

    it('fails closed on missing, non-empty, or newly dependent targets', () => {
        const sql = readMigration();
        expect(sql).toContain("c.relname = 'comment_details'");
        expect(sql).toContain("c.relname = 'interaction_logs'");
        expect(sql).toContain('SELECT count(*) INTO v_comment_rows FROM public.comment_details');
        expect(sql).toContain('SELECT count(*) INTO v_interaction_rows FROM public.interaction_logs');
        expect(sql).toContain('RETIREMENT_GUARD_NONEMPTY: public.comment_details');
        expect(sql).toContain('RETIREMENT_GUARD_NONEMPTY: public.interaction_logs');
        expect(sql).toContain('pg_catalog.pg_constraint');
        expect(sql).toContain('fk.confrelid');
        expect(sql).toContain('RETIREMENT_GUARD_INCOMING_DEPENDENCY');
        expect(sql).toContain('RETIREMENT_GUARD_DEPENDENT_VIEW');
        expect(sql).toContain('RETIREMENT_GUARD_ROUTINE_DEPENDENCY');
        expect(sql).toContain('RETIREMENT_GUARD_ROUTINE_DEFINITION_REFERENCE');
        expect(sql).toContain('RETIREMENT_GUARD_USER_TRIGGER');
        expect(sql).toContain('RETIREMENT_GUARD_TABLE_REPLACED');
        expect(sql).toContain('RETIREMENT_GUARD_PUBLICATION_MEMBERSHIP');
        expect(sql).toContain('RETIREMENT_GUARD_PUBLICATION_ALL_TABLES');
        expect(sql).toContain('RETIREMENT_GUARD_PUBLICATION_SCHEMA');
        expect(sql).toContain('pg_catalog.set_config(');
        expect(sql).toContain('retirement.expected_comment_details_oid');
        expect(sql).toContain('retirement.expected_interaction_logs_oid');
        expect(sql).toContain('pg_catalog.current_setting(');
        expect(sql).toContain("dep.classid = 'pg_catalog.pg_rewrite'::regclass");
        expect(sql).toContain("dep.classid = 'pg_catalog.pg_proc'::regclass");
        expect(sql).toContain('pg_catalog.pg_get_functiondef');
        expect(sql).toContain("pg_catalog.pg_publication AS publication");
        expect(sql).toContain('publication.puballtables');
        expect(sql).toContain('pg_catalog.pg_publication_namespace');
        expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('RETIREMENT_GUARD_TABLE_REPLACED'));
        expect(sql.indexOf('RETIREMENT_GUARD_TABLE_REPLACED'))
            .toBeLessThan(sql.indexOf('SELECT count(*) INTO v_comment_rows'));
        expect(sql).toContain(
            'LOCK TABLE public.comment_details, public.interaction_logs IN ACCESS EXCLUSIVE MODE',
        );
    });

    it('serializes coordinated copies and guards both catalog evidence and drops from active DDL', () => {
        const sql = readMigration();
        const beginIndex = sql.indexOf('BEGIN;');
        expect(beginIndex).toBeGreaterThanOrEqual(0);
        const firstSqlAfterBegin = sql
            .slice(beginIndex + 'BEGIN;'.length)
            .replace(/^\s*--[^\r\n]*(?:\r?\n|$)/gm, '')
            .trimStart();
        expect(firstSqlAfterBegin).toMatch(
            /^SELECT pg_catalog\.pg_advisory_xact_lock\(22091010, 22\);/,
        );
        expect(sql).toContain('serializes coordinated copies');
        expect(sql).toContain('does not block uncoordinated PostgreSQL DDL');

        expect(sql.match(/RETIREMENT_GUARD_ACTIVE_DDL/g)).toHaveLength(2);
        expect(sql).toMatch(
            /activity\.pid\s*<>\s*pg_catalog\.pg_backend_pid\(\)[\s\S]*activity\.state\s*=\s*'active'[\s\S]*activity\.query[\s\S]*~\*/,
        );
        expect(sql).toContain('(CREATE|ALTER|DROP)[[:space:]]+PUBLICATION');
        expect(sql).toContain(
            '(CREATE[[:space:]]+OR[[:space:]]+REPLACE|CREATE|ALTER|DROP)',
        );
        expect(sql).toContain('[[:space:]]+(FUNCTION|PROCEDURE)');

        const firstActiveDdlGuard = sql.indexOf('RETIREMENT_GUARD_ACTIVE_DDL');
        const secondActiveDdlGuard = sql.indexOf(
            'RETIREMENT_GUARD_ACTIVE_DDL',
            firstActiveDdlGuard + 1,
        );
        const catalogEvidence = sql.indexOf('RETIREMENT_GUARD_PUBLICATION_ALL_TABLES');
        const firstDrop = sql.indexOf('DROP TABLE public.comment_details;');
        expect(firstActiveDdlGuard).toBeLessThan(catalogEvidence);
        expect(secondActiveDdlGuard).toBeGreaterThan(catalogEvidence);
        expect(secondActiveDdlGuard).toBeLessThan(firstDrop);
    });

    it('retains the contiguous scan and precisely guards EXECUTE split literals for both targets', () => {
        const sql = readMigration();
        expect(sql).toContain('RETIREMENT_GUARD_ROUTINE_DEFINITION_REFERENCE');
        expect(sql).toContain('RETIREMENT_GUARD_ROUTINE_SPLIT_LITERAL_REFERENCE');
        expect(sql).toContain('retirement_execute_token_pattern');
        expect(sql).toContain('(^|[^[:alnum:]_])EXECUTE([^[:alnum:]_]|$)');
        expect(sql).toContain(
            "'comment_'[[:space:]]*\\|\\|[[:space:]]*'details'",
        );
        expect(sql).toContain(
            "'interaction_'[[:space:]]*\\|\\|[[:space:]]*'logs'",
        );
        const executeToken = sql.indexOf('retirement_execute_token_pattern');
        const splitGuardMessage = sql.indexOf(
            'RETIREMENT_GUARD_ROUTINE_SPLIT_LITERAL_REFERENCE',
        );
        expect(executeToken).toBeGreaterThanOrEqual(0);
        expect(executeToken).toBeLessThan(splitGuardMessage);
    });

    it('covers exact restoration of columns, constraints, indexes, RLS policies, and grants', () => {
        const sql = readDraft();
        const restoreSql = extractRestoreSql(sql);
        for (const table of TARGETS) {
            expect(restoreSql).toContain(`CREATE TABLE ${table}`);
            expect(restoreSql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            expect(restoreSql).toContain(`ALTER TABLE ${table} OWNER TO postgres`);
            expect(restoreSql).toContain(`REVOKE ALL PRIVILEGES ON TABLE ${table} FROM PUBLIC, anon, authenticated`);
            expect(restoreSql).toContain(`GRANT ALL PRIVILEGES ON TABLE ${table} TO postgres, service_role`);
        }
        expect(restoreSql).toContain('extensions.uuid_generate_v4()');
        expect(restoreSql).toContain('comment_details_pkey');
        expect(restoreSql).toContain('comment_details_result_id_fkey');
        expect(restoreSql).toContain('comment_details_intimacy_level_check');
        expect(restoreSql).toContain('idx_comment_details_result_id');
        expect(restoreSql).toContain('interaction_logs_pkey');
        expect(restoreSql).toContain('interaction_logs_result_id_fkey');
        expect(restoreSql).toContain('interaction_logs_interaction_type_check');
        expect(restoreSql).toContain('idx_interaction_logs_result_id');
        expect(restoreSql).toContain('Users can view own comment details');
        expect(restoreSql).toContain('Users can view own interaction logs');
        expect(restoreSql).toContain('REFERENCES public.analysis_results(id)');
        expect(restoreSql).toContain('ON DELETE CASCADE');
    });

    it('executes an isolated PGlite restore drill and verifies the live contract', async () => {
        const db = await createRestoreDrillDatabase();
        try {
            // The active guard/drop section is intentionally not executed. PGlite
            // has no hosted Supabase publication/catalog boundary, and this drill
            // proves only the commented rollback SQL in a disposable database.
            await db.exec(extractRestoreSql(readDraft()));

            const columns = await queryRows<{
                table_name: string;
                ordinal_position: number;
                column_name: string;
                data_type: string;
                is_nullable: string;
                column_default: string | null;
            }>(db, `
                SELECT c.table_name, c.ordinal_position, c.column_name,
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                    c.is_nullable, c.column_default
                FROM information_schema.columns AS c
                JOIN pg_catalog.pg_namespace AS n
                    ON n.nspname = c.table_schema
                JOIN pg_catalog.pg_class AS t
                    ON t.relnamespace = n.oid AND t.relname = c.table_name
                JOIN pg_catalog.pg_attribute AS a
                    ON a.attrelid = t.oid AND a.attname = c.column_name
                WHERE c.table_schema = 'public'
                  AND c.table_name IN ('comment_details', 'interaction_logs')
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY c.table_name, c.ordinal_position
            `);
            expect(columns).toEqual([
                { table_name: 'comment_details', ordinal_position: 1, column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'extensions.uuid_generate_v4()' },
                { table_name: 'comment_details', ordinal_position: 2, column_name: 'result_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
                { table_name: 'comment_details', ordinal_position: 3, column_name: 'comment_text', data_type: 'text', is_nullable: 'NO', column_default: null },
                { table_name: 'comment_details', ordinal_position: 4, column_name: 'author_id', data_type: 'character varying(100)', is_nullable: 'NO', column_default: null },
                { table_name: 'comment_details', ordinal_position: 5, column_name: 'target_post_owner', data_type: 'character varying(100)', is_nullable: 'NO', column_default: null },
                { table_name: 'comment_details', ordinal_position: 6, column_name: 'intimacy_level', data_type: 'character varying(10)', is_nullable: 'YES', column_default: null },
                { table_name: 'comment_details', ordinal_position: 7, column_name: 'intimacy_indicators', data_type: 'text[]', is_nullable: 'YES', column_default: null },
                { table_name: 'comment_details', ordinal_position: 8, column_name: 'confidence', data_type: 'double precision', is_nullable: 'YES', column_default: null },
                { table_name: 'comment_details', ordinal_position: 9, column_name: 'comment_date', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
                { table_name: 'comment_details', ordinal_position: 10, column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: 'now()' },
                { table_name: 'interaction_logs', ordinal_position: 1, column_name: 'id', data_type: 'uuid', is_nullable: 'NO', column_default: 'extensions.uuid_generate_v4()' },
                { table_name: 'interaction_logs', ordinal_position: 2, column_name: 'result_id', data_type: 'uuid', is_nullable: 'NO', column_default: null },
                { table_name: 'interaction_logs', ordinal_position: 3, column_name: 'interaction_type', data_type: 'character varying(20)', is_nullable: 'NO', column_default: null },
                { table_name: 'interaction_logs', ordinal_position: 4, column_name: 'post_id', data_type: 'character varying(100)', is_nullable: 'YES', column_default: null },
                { table_name: 'interaction_logs', ordinal_position: 5, column_name: 'content', data_type: 'text', is_nullable: 'YES', column_default: null },
                { table_name: 'interaction_logs', ordinal_position: 6, column_name: 'interaction_date', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
                { table_name: 'interaction_logs', ordinal_position: 7, column_name: 'score', data_type: 'integer', is_nullable: 'YES', column_default: '0' },
                { table_name: 'interaction_logs', ordinal_position: 8, column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: 'now()' },
            ]);

            const constraints = await queryRows<{
                table_name: string;
                constraint_name: string;
                constraint_type: string;
                definition: string;
            }>(db, `
                SELECT cls.relname AS table_name, con.conname AS constraint_name,
                    CASE con.contype
                        WHEN 'p' THEN 'PRIMARY KEY'
                        WHEN 'f' THEN 'FOREIGN KEY'
                        WHEN 'c' THEN 'CHECK'
                    END AS constraint_type,
                    pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
                FROM pg_catalog.pg_constraint AS con
                JOIN pg_catalog.pg_class AS cls ON cls.oid = con.conrelid
                JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace
                WHERE ns.nspname = 'public'
                  AND cls.relname IN ('comment_details', 'interaction_logs')
                ORDER BY cls.relname, con.conname
            `);
            expect(constraints.map(row => row.constraint_name)).toEqual([
                'comment_details_intimacy_level_check',
                'comment_details_pkey',
                'comment_details_result_id_fkey',
                'interaction_logs_interaction_type_check',
                'interaction_logs_pkey',
                'interaction_logs_result_id_fkey',
            ]);
            expect(constraints.filter(row => row.constraint_type === 'PRIMARY KEY'))
                .toHaveLength(2);
            expect(constraints.filter(row => row.constraint_type === 'FOREIGN KEY')
                .map(row => row.definition.replace('REFERENCES analysis_results', 'REFERENCES public.analysis_results')))
                .toEqual([
                    'FOREIGN KEY (result_id) REFERENCES public.analysis_results(id) ON DELETE CASCADE',
                    'FOREIGN KEY (result_id) REFERENCES public.analysis_results(id) ON DELETE CASCADE',
                ]);
            expect(constraints.find(row => row.constraint_name === 'comment_details_intimacy_level_check')?.definition)
                .toContain("'intimate'");
            expect(constraints.find(row => row.constraint_name === 'comment_details_intimacy_level_check')?.definition)
                .toContain("'normal'");
            expect(constraints.find(row => row.constraint_name === 'interaction_logs_interaction_type_check')?.definition)
                .toContain("'comment_mention'");

            const indexes = await queryRows<{ indexname: string; indexdef: string }>(db, `
                SELECT indexname, indexdef
                FROM pg_catalog.pg_indexes
                WHERE schemaname = 'public'
                  AND tablename IN ('comment_details', 'interaction_logs')
                ORDER BY indexname
            `);
            expect(indexes.map(row => row.indexname)).toEqual([
                'comment_details_pkey',
                'idx_comment_details_result_id',
                'idx_interaction_logs_result_id',
                'interaction_logs_pkey',
            ]);
            expect(indexes.filter(row => row.indexdef.includes('(id)'))).toHaveLength(2);
            expect(indexes.filter(row => row.indexdef.includes('(result_id)'))).toHaveLength(2);

            const rls = await queryRows<{
                relname: string;
                relrowsecurity: boolean;
                relforcerowsecurity: boolean;
            }>(db, `
                SELECT relname, relrowsecurity, relforcerowsecurity
                FROM pg_catalog.pg_class AS cls
                JOIN pg_catalog.pg_namespace AS ns ON ns.oid = cls.relnamespace
                WHERE ns.nspname = 'public'
                  AND relname IN ('comment_details', 'interaction_logs')
                ORDER BY relname
            `);
            expect(rls).toEqual([
                { relname: 'comment_details', relrowsecurity: true, relforcerowsecurity: false },
                { relname: 'interaction_logs', relrowsecurity: true, relforcerowsecurity: false },
            ]);

            const policies = await queryRows<{
                tablename: string;
                policyname: string;
                cmd: string;
                qual: string | null;
            }>(db, `
                SELECT tablename, policyname, cmd, qual
                FROM pg_catalog.pg_policies
                WHERE schemaname = 'public'
                  AND tablename IN ('comment_details', 'interaction_logs')
                ORDER BY tablename, policyname
            `);
            expect(policies.map(row => [row.tablename, row.policyname, row.cmd])).toEqual([
                ['comment_details', 'Users can view own comment details', 'SELECT'],
                ['interaction_logs', 'Users can view own interaction logs', 'SELECT'],
            ]);
            expect(policies.every(row => row.qual?.includes('auth.uid()'))).toBe(true);
            expect(policies.every(row => row.qual?.includes('analysis_requests.user_id'))).toBe(true);

            const privileges = await queryRows<{
                table_name: string;
                grantee: string;
                privilege_type: string;
            }>(db, `
                SELECT table_name, grantee, privilege_type
                FROM information_schema.table_privileges
                WHERE table_schema = 'public'
                  AND table_name IN ('comment_details', 'interaction_logs')
                ORDER BY table_name, grantee, privilege_type
            `);
            expect(privileges).toHaveLength(28);
            expect(new Set(privileges.map(row => row.grantee))).toEqual(new Set(['postgres', 'service_role']));
            expect(new Set(privileges.map(row => row.privilege_type))).toEqual(new Set([
                'DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE',
            ]));
            expect(privileges.filter(row => row.grantee === 'postgres')).toHaveLength(14);
            expect(privileges.filter(row => row.grantee === 'service_role')).toHaveLength(14);

            const rowCounts = await queryRows<{ table_name: string; row_count: number }>(db, `
                SELECT 'public.comment_details' AS table_name,
                    count(*)::integer AS row_count FROM public.comment_details
                UNION ALL
                SELECT 'public.interaction_logs' AS table_name,
                    count(*)::integer AS row_count FROM public.interaction_logs
                ORDER BY table_name
            `);
            expect(rowCounts).toEqual([
                { table_name: 'public.comment_details', row_count: 0 },
                { table_name: 'public.interaction_logs', row_count: 0 },
            ]);
        } finally {
            await db.close();
        }
    });

    it('binds the exact ordered allowlist and deterministic zero-row checksum', () => {
        const manifest = readManifest();
        expect(manifest.destructiveAllowlist).toEqual([...TARGETS]);
        expect(manifest.destructiveAllowlistCanonicalJson).toBe(ALLOWLIST_CANONICAL_JSON);
        expect(createHash('sha256').update(ALLOWLIST_CANONICAL_JSON, 'utf8').digest('hex'))
            .toBe(ALLOWLIST_SHA256);
        expect(manifest.destructiveAllowlistSha256).toBe(ALLOWLIST_SHA256);
        expect(extractNormalizedDropStatements(readMigration()))
            .toEqual(EXPECTED_DROP_STATEMENTS);
        expect(manifest.destructiveOperations).toBe('refused');
        expect(manifest.zeroRowDataset.canonicalJson).toBe(ZERO_ROW_DATASET_CANONICAL_JSON);
        expect(manifest.zeroRowDataset.sha256).toBe(ZERO_ROW_DATASET_SHA256);
        expect(manifest.zeroRowDataset.rowCount).toBe(0);
        expect(manifest.zeroRowDataset.tables).toEqual([...TARGETS]);
        expect(manifest.archiveStatus).toBe('excepted-zero-row');
        expect(manifest.archiveException.acceptable).toBe(true);
        expect(manifest.archiveException.reason).toContain('No row payload exists to encrypt');
        expect(manifest.restoreStatus).toBe('verified');
        expect(manifest.restoreEvidence.environment).toBe('isolated-pglite');
        expect(manifest.restoreEvidence.schemaVerified).toBe(true);
        expect(manifest.restoreEvidence.tables).toEqual([...TARGETS]);
        expect(manifest.observationConclusion.status).toBe('bounded');
        expect(manifest.observationConclusion.conclusion).toContain('bounded');
        expect(manifest.retirementDecision.status).toBe('approved-not-applied');
        expect(manifest.retirementDecision.ownerApproval).toBe('approved');
        expect(manifest.retirementDecision.migrationFileCreated).toBe(true);
        expect(manifest.retirementDecision.migrationFilePath).toBe(MIGRATION_RELATIVE_PATH);

        const concurrency = (manifest as RetirementManifest & {
            concurrencyCorrection: {
                fixedTransactionAdvisoryLock: string;
                serializesCoordinatedCopiesOnly: boolean;
                blocksUncoordinatedPostgresqlDdl: boolean;
                activeDdlGuardBeforeCatalogEvidence: boolean;
                activeDdlGuardImmediatelyBeforeDrops: boolean;
                splitLiteralProductionMatchCount: number;
                rejectsAllExecuteRoutines: boolean;
                singleWriterDdlMaintenanceWindowRequired: boolean;
                coordinatorOnlyFromFinalPreflightThroughPostApplyVerification: boolean;
                currentProductionActiveRelevantDdlCount: number;
                trackedCiProductionDbPushEntrypoint: boolean;
                targetOrAdvisoryLocksAloneBlockUncoordinatedDdl: boolean;
            };
        }).concurrencyCorrection;
        expect(concurrency.fixedTransactionAdvisoryLock).toBe(
            'pg_advisory_xact_lock(22091010, 22)',
        );
        expect(concurrency.serializesCoordinatedCopiesOnly).toBe(true);
        expect(concurrency.blocksUncoordinatedPostgresqlDdl).toBe(false);
        expect(concurrency.activeDdlGuardBeforeCatalogEvidence).toBe(true);
        expect(concurrency.activeDdlGuardImmediatelyBeforeDrops).toBe(true);
        expect(concurrency.splitLiteralProductionMatchCount).toBe(0);
        expect(concurrency.rejectsAllExecuteRoutines).toBe(false);
        expect(concurrency.singleWriterDdlMaintenanceWindowRequired).toBe(true);
        expect(concurrency.coordinatorOnlyFromFinalPreflightThroughPostApplyVerification)
            .toBe(true);
        expect(concurrency.currentProductionActiveRelevantDdlCount).toBe(0);
        expect(concurrency.trackedCiProductionDbPushEntrypoint).toBe(false);
        expect(concurrency.targetOrAdvisoryLocksAloneBlockUncoordinatedDdl).toBe(false);
    });

    it('records the evidence and explicitly preserves non-production gates', () => {
        const report = readFileSync(REPORT_PATH, 'utf8');
        expect(report).toContain('Exact row counts are `0`');
        expect(report).toContain('2026-07-10T11:52:33+09:00');
        expect(report).toContain('nonzero `idx_scan` count is not direct-use proof');
        expect(report).toContain('No row payload exists to encrypt');
        expect(report).toContain('isolated PGlite restore drill');
        expect(report).toContain('bounded observation conclusion');
        expect(report).toContain('owner approval');
        expect(report).toContain('approved-but-not-applied');
        expect(report).toContain(MIGRATION_RELATIVE_PATH);
        expect(report).toContain('No flag activation');
        expect(report).toContain('No Management API log evidence was collected or claimed.');
        expect(report).toContain('single-writer DDL maintenance window');
        expect(report).toContain('coordinator-only');
        expect(report).toContain('current production relevant active DDL count is `0`');
        expect(report).toMatch(/Tracked CI has no\s+production `supabase db push` entrypoint/);
        expect(report).toContain('uncoordinated PostgreSQL DDL');
        expect(report).toContain('split-literal');
    });
});
