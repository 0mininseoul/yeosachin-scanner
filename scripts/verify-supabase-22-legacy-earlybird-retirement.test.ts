import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const MIGRATION_PATH = resolve(
    REPO_ROOT,
    'supabase/migrations/20260911001903_retire_legacy_earlybird_recovery_tables.sql',
);
const MANIFEST_PATH = resolve(
    REPO_ROOT,
    'docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-manifest.json',
);
const RESTORE_PATH = resolve(
    REPO_ROOT,
    'supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql',
);
const VERIFIER_PATH = resolve(
    REPO_ROOT,
    'supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql',
);
const REPORT_PATH = resolve(
    REPO_ROOT,
    'docs/reports/2026-09-11-supabase-22-legacy-earlybird-retirement-evidence.md',
);

const TARGETS = [
    'earlybird_concierge_batch_target_lineage_repairs',
    'earlybird_partial_adoption_second_rearms',
    'earlybird_profile_evidence_failure_recoveries',
    'earlybird_v211_apify_transient_admission_resumes',
    'earlybird_v211_concierge_copy_corrections',
    'earlybird_v212_concierge_copy_corrections',
    'earlybird_v213_concierge_copy_corrections',
    'earlybird_v214_concierge_gemini_copy_corrections',
] as const;

const SOURCE_COUNTS = [3, 1, 2, 1, 1, 1, 1, 1] as const;
const EXPECTED_TOTAL = 11;
const EXPECTED_BASELINE_TABLE_COUNT = 185;
const EXPECTED_FINAL_TABLE_COUNT = 177;
const ALLOWLIST_CANONICAL_JSON = JSON.stringify(TARGETS);
const ALLOWLIST_SHA256 = createHash('sha256')
    .update(ALLOWLIST_CANONICAL_JSON, 'utf8')
    .digest('hex');

const ROUTINES = [
    'public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()',
    'public.reconcile_exact_three_concierge_target_lineage(text)',
    'public.prevent_earlybird_partial_adoption_second_rearm_mutation()',
    'public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)',
    'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)',
    'public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)',
    'public.prevent_earlybird_v211_concierge_copy_correction_mutation()',
    'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)',
    'public.prevent_earlybird_v212_concierge_copy_correction_mutation()',
    'public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
    'public.prevent_earlybird_v213_concierge_copy_correction_mutation()',
    'public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
    'public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()',
    'public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)',
] as const;

type RetirementManifest = {
    schemaVersion: string;
    baselineCommit: string;
    publicBasePartitionedTableCount: { before: number; after: number; delta: number };
    destructiveAllowlist: readonly string[];
    destructiveAllowlistCanonicalJson: string;
    destructiveAllowlistSha256: string;
    sourceCounts: Record<string, number>;
    expectedCanonicalRowCount: number;
    canonicalDestination: string;
    routineSignatures: readonly string[];
    routinePolicy: {
        dropOnlyExactSignatures: boolean;
        sharedRoutineSignaturesExcluded: readonly string[];
        noCascade: boolean;
    };
    excludedFromWave: { table: string; reason: string; expectedCount: number };
    rollbackSource: string;
    restoreStatus: string;
    restoreEvidence: {
        environment: string;
        schemaVerified: boolean;
        typedColumnParityVerified: boolean;
        canonicalRowsUnchanged: boolean;
        tables: readonly string[];
    };
    verificationOperation: string;
    rolloutStatus: string;
    evidenceStatus: string;
    validation: {
        isolatedRestoreDrill: string;
    };
};

function readMigration(): string {
    return readFileSync(MIGRATION_PATH, 'utf8');
}

function readManifest(): RetirementManifest {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RetirementManifest;
}

function readRestoreOperation(): string {
    return readFileSync(RESTORE_PATH, 'utf8');
}

function readVerifierOperation(): string {
    return readFileSync(VERIFIER_PATH, 'utf8');
}

function stripSqlComments(sql: string): string {
    return sql
        .replace(/--[^\r\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeSqlWhitespace(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

function extractDropStatements(sql: string): string[] {
    const activeSql = stripSqlComments(sql);
    return [...activeSql.matchAll(/(?:^|[;\r\n])\s*(DROP\s+(?:TABLE|FUNCTION)\b[^;]*(?:;|$))/gim)]
        .map(match => normalizeSqlWhitespace(match[1]))
        .map(statement => statement.endsWith(';') ? statement : `${statement};`);
}

function containsDynamicDestructiveSql(sql: string): boolean {
    const activeSql = stripSqlComments(sql);
    const doBlockPattern = /\bDO\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)([\s\S]*?)\1/gi;
    return [...activeSql.matchAll(doBlockPattern)].some(match => {
        const codeBody = match[2].replace(/'(?:''|[^'])*'/g, "''");
        return /\bEXECUTE\s+(?:format\s*\(|[A-Za-z_][A-Za-z0-9_]*|E?'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i.test(codeBody)
            || /\b(?:DROP|CREATE|ALTER|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE)\b/i.test(codeBody);
    });
}

function expectedDropStatements(): string[] {
    return [
        ...TARGETS.map(table => `DROP TABLE public.${table};`),
        ...ROUTINES.map(signature => `DROP FUNCTION ${signature};`),
    ];
}

function sourceShape(table: string): string[] {
    const shapes: Record<string, string[]> = {
        earlybird_concierge_batch_target_lineage_repairs: [
            'cohort_key:text:false', 'order_id:uuid:false', 'request_id:uuid:false',
            'preflight_id:uuid:false', 'rearm_generation:smallint:false',
            'source_failure_code:text:false', 'source_credential_slot:text:false',
            'fallback_credential_slot:text:false', 'allowlist_hash:text:false',
            'old_request_target_hash:text:false', 'old_preflight_target_hash:text:false',
            'repaired_target_hash:text:false', 'repaired_at:timestamp with time zone:false',
        ],
        earlybird_partial_adoption_second_rearms: [
            'order_id:uuid:false', 'original_failed_request_id:uuid:false',
            'first_policy_failed_request_id:uuid:false', 'second_policy_failed_request_id:uuid:false',
            'rearmed_preflight_id:uuid:false', 'expected_fulfillment_attempt_count:smallint:false',
            'expected_manual_review_at:timestamp with time zone:false',
            'created_at:timestamp with time zone:false',
        ],
        earlybird_profile_evidence_failure_recoveries: [
            'order_id:uuid:false', 'failed_request_id:uuid:false', 'recovery_preflight_id:uuid:false',
            'prior_attempt_count:smallint:false', 'expected_manual_review_at:timestamp with time zone:false',
            'created_at:timestamp with time zone:false',
        ],
        earlybird_v211_apify_transient_admission_resumes: [
            'order_id:uuid:false', 'expected_manual_review_at:timestamp with time zone:false',
            'created_at:timestamp with time zone:false',
        ],
        earlybird_v211_concierge_copy_corrections: [
            'order_id:uuid:false', 'result_request_id:uuid:false',
            'published_source_fingerprint:text:false', 'expected_published_result_hash:text:false',
            'correction_result_hash:text:false', 'copy_payload:jsonb:false',
            'corrected_at:timestamp with time zone:false',
        ],
        earlybird_v212_concierge_copy_corrections: [
            'order_id:uuid:false', 'result_request_id:uuid:false',
            'prior_correction_result_hash:text:false', 'correction_result_hash:text:false',
            'copy_payload:jsonb:false', 'corrected_at:timestamp with time zone:false',
        ],
        earlybird_v213_concierge_copy_corrections: [
            'order_id:uuid:false', 'result_request_id:uuid:false',
            'prior_correction_result_hash:text:false', 'correction_result_hash:text:false',
            'copy_payload:jsonb:false', 'corrected_at:timestamp with time zone:false',
        ],
        earlybird_v214_concierge_gemini_copy_corrections: [
            'order_id:uuid:false', 'result_request_id:uuid:false',
            'prior_correction_result_hash:text:false', 'correction_result_hash:text:false',
            'copy_payload:jsonb:false', 'corrected_at:timestamp with time zone:false',
        ],
    };
    return shapes[table] ?? [];
}

describe('Supabase 22 legacy earlybird retirement contract', () => {
    it('binds the manifest to the exact eight-table, 11-row, 185-to-177 contract', () => {
        const manifest = readManifest();
        expect(manifest.schemaVersion).toBe('supabase-22-legacy-earlybird-retirement-v1');
        expect(manifest.baselineCommit).toBe('e2edd2d18a8425721ce8e52f671230e9a1ff3231');
        expect(manifest.publicBasePartitionedTableCount).toEqual({ before: 185, after: 177, delta: -8 });
        expect(manifest.destructiveAllowlist).toEqual([...TARGETS]);
        expect(manifest.destructiveAllowlistCanonicalJson).toBe(ALLOWLIST_CANONICAL_JSON);
        expect(manifest.destructiveAllowlistSha256).toBe(ALLOWLIST_SHA256);
        expect(manifest.sourceCounts).toEqual(Object.fromEntries(TARGETS.map((table, index) => [table, SOURCE_COUNTS[index]])));
        expect(manifest.expectedCanonicalRowCount).toBe(EXPECTED_TOTAL);
        expect(manifest.canonicalDestination).toBe('maintenance_jobs');
        expect(manifest.routineSignatures).toEqual([...ROUTINES]);
        expect(manifest.routinePolicy).toMatchObject({
            dropOnlyExactSignatures: true,
            noCascade: true,
        });
        expect(manifest.routinePolicy.sharedRoutineSignaturesExcluded)
            .toContain('public.prevent_earlybird_schema_failure_recovery_mutation()');
        expect(manifest.excludedFromWave.table).toBe('earlybird_v211_concierge_publications');
        expect(manifest.rollbackSource)
            .toBe('supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql');
        expect(manifest.restoreStatus).toBe('verified');
        expect(manifest.restoreEvidence).toMatchObject({
            environment: 'isolated-pglite',
            schemaVerified: true,
            typedColumnParityVerified: true,
            canonicalRowsUnchanged: true,
            tables: [...TARGETS],
        });
        expect(manifest.verificationOperation)
            .toBe('supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql');
        expect(manifest.validation.isolatedRestoreDrill).toContain('14-test');
        expect(manifest.rolloutStatus).toBe('not_applied');
        expect(manifest.evidenceStatus).toBe('READY_FOR_REVIEW_NOT_APPLIED');
    });

    it('uses one bounded transaction and guards the catalog before any destructive DDL', () => {
        const sql = readMigration();
        const activeSql = stripSqlComments(sql);
        expect(activeSql.trimStart()).toMatch(/^BEGIN;\s*SET LOCAL lock_timeout\s*=\s*'5s';/i);
        expect(activeSql).toMatch(/SET LOCAL statement_timeout\s*=\s*'2min';/i);
        expect(activeSql).toMatch(/pg_catalog\.pg_advisory_xact_lock\(/i);
        expect(activeSql).toMatch(new RegExp(`expected ${EXPECTED_BASELINE_TABLE_COUNT}`));
        expect(activeSql).toMatch(new RegExp(`expected ${EXPECTED_FINAL_TABLE_COUNT}`));
        expect(activeSql).toContain('pg_catalog.pg_attribute');
        expect(activeSql).toContain('pg_catalog.pg_constraint');
        expect(activeSql).toContain('pg_catalog.pg_depend');
        expect(activeSql).toContain('pg_catalog.pg_publication');
        expect(activeSql).toContain('pg_catalog.pg_proc');
        expect(activeSql).toContain('pg_catalog.to_regprocedure');
        expect(activeSql).toContain('pg_catalog.pg_get_function_identity_arguments');
        expect(activeSql).toContain('RETIREMENT_GUARD_RETAINED_ROUTINE_CALLER');
        expect(activeSql).toContain('RETIREMENT_GUARD_ACTIVE_DDL');
        expect(activeSql).toContain('activity.backend_type');
        expect(activeSql).toContain('activity.datname = pg_catalog.current_database()');
        expect(activeSql).toContain('pg_catalog.set_config(');
        expect(activeSql).toContain('retirement.expected_maintenance_jobs_oid');
        expect(activeSql).toContain('retirement.expected_earlybird_v214_concierge_gemini_copy_corrections_oid');
        expect(activeSql).toContain('RETIREMENT_GUARD_TABLE_REPLACED');
        expect(activeSql).toContain('retirement.expected_routine_');
        expect(activeSql).toContain('pg_catalog.lpad(v_routine_index::TEXT, 2, \'0\')');
        expect(activeSql).toContain('RETIREMENT_GUARD_ROUTINE_REPLACED');
        expect(activeSql.match(/RETIREMENT_GUARD_ACTIVE_DDL/g)).toHaveLength(2);
        const activeDdlGuards = [...activeSql.matchAll(
            /DO \$retirement_active_ddl_guard\$[\s\S]*?\$retirement_active_ddl_guard\$;/g,
        )].map(match => match[0]);
        expect(activeDdlGuards).toHaveLength(2);
        activeDdlGuards.forEach(guard => {
            expect(guard).toContain('activity.datname = pg_catalog.current_database()');
            expect(guard).toContain('activity.backend_type IS NULL');
            expect(guard).toContain("activity.backend_type = 'client backend'");
            expect(guard).toContain("activity.query = '<insufficient privilege>'");
            expect(guard).toContain('$retirement_active_ddl_pattern$');
        });
        TARGETS.forEach(table => {
            expect(activeSql).toContain(`retirement.expected_${table}_oid`);
            expect(activeSql).toContain(`RETIREMENT_GUARD_TABLE_REPLACED: public.${table}`);
        });
        expect(activeSql.indexOf('RETIREMENT_GUARD'))
            .toBeLessThan(activeSql.indexOf('DROP TABLE'));
        expect(activeSql.trimEnd()).toMatch(/COMMIT;\s*$/i);
        expect(activeSql).not.toMatch(/\b(?:supabase_migrations|auth|storage)\./i);
    });

    it('contains exactly the manifest tables and orphaned routine identities, without CASCADE', () => {
        const sql = readMigration();
        expect(containsDynamicDestructiveSql(sql)).toBe(false);
        const drops = extractDropStatements(sql).map(statement => statement.toLowerCase());
        expect(drops).toEqual(expectedDropStatements().map(statement => statement.toLowerCase()));
        expect(drops.filter(statement => /\bdrop table\b/.test(statement))).toHaveLength(TARGETS.length);
        expect(drops.filter(statement => /\bdrop function\b/.test(statement))).toHaveLength(ROUTINES.length);
        expect(sql).not.toMatch(/\bCASCADE\b/i);
        expect(stripSqlComments(sql)).not.toMatch(/\bEXECUTE\s+(?:format|v_|sql|drop|create|alter)/i);
        expect(sql).not.toContain('earlybird_v211_concierge_publications');
        expect(sql).not.toContain('earlybird_fulfillments');
        expect(sql).not.toContain('earlybird_payment_discord_outbox');
        expect(sql).not.toContain('earlybird_first15_canary_provider_rearms');
    });

    it('rejects a broadened or dynamically assembled destructive contract', () => {
        const broadened = `${readMigration()}\nDROP TABLE public.unapproved_table;`;
        expect(extractDropStatements(broadened).map(statement => statement.toLowerCase()))
            .not.toEqual(expectedDropStatements().map(statement => statement.toLowerCase()));
        expect(containsDynamicDestructiveSql([
            'DO $$',
            'BEGIN',
            "  EXECUTE format('DROP TABLE public.%I', table_name);",
            'END;',
            '$$;',
        ].join('\n'))).toBe(true);
        expect(extractDropStatements([
            'DROP TABLE public.earlybird_concierge_batch_target_lineage_repairs;',
            'DROP TABLE public.earlybird_partial_adoption_second_rearms',
        ].join('\n'))).toHaveLength(2);
    });

    it('pins all source shapes and exact source counts in the migration', () => {
        const sql = readMigration();
        TARGETS.forEach((table, index) => {
            expect(sql).toContain(`public.${table}`);
            expect(sql).toContain(`RETIREMENT_GUARD_SOURCE_COUNT: public.${table}`);
            expect(sql).toContain(`expected ${SOURCE_COUNTS[index]}`);
            sourceShape(table).forEach(shape => {
                const [column, type] = shape.split(':');
                expect(sql).toContain(column);
                expect(sql).toContain(type);
            });
        });
        expect(sql).toContain("legacy_source_table");
        expect(sql).toContain("legacy_primary_key");
        expect(sql).toContain("legacy_row");
        expect(sql).toContain("schema_version");
        expect(sql).toContain("ON CONFLICT (kind, target_key_hash) DO NOTHING");
        expect(sql).not.toContain("ON CONFLICT (kind, target_key_hash) DO UPDATE");
        expect(sql).toContain('retirement_expected_canonical_rows');
        expect(sql).toContain('retirement_canonical_conflict_guard');
        expect(sql).toContain('MAINTENANCE_CONTENT_CONFLICT');
        expect(sql).toContain('RETIREMENT_GUARD_CANONICAL_TOTAL');
        expect(sql).toContain('RETIREMENT_GUARD_CANONICAL_PARITY');
    });
});

describe('Supabase 22 legacy earlybird isolated operations', () => {
    it('requires an explicit isolated restore guard and restores typed columns only', () => {
        const sql = readRestoreOperation();
        const activeSql = stripSqlComments(sql);
        expect(sql).toContain("current_setting('supabase.retirement_isolated', TRUE)");
        expect(sql).toContain("IS DISTINCT FROM 'true'");
        expect(sql).toContain('RETIREMENT_RESTORE_ISOLATED_GUARD');
        expect(sql).toContain('RETIREMENT_RESTORE_TARGET_ALREADY_PRESENT');
        expect(sql).toContain('LOCK TABLE public.maintenance_jobs IN SHARE MODE');
        expect(sql).toContain('RETIREMENT_RESTORE_CANONICAL_PARITY_MISMATCH');
        expect(sql).toContain('RETIREMENT_RESTORE_CANONICAL_TOTAL_MISMATCH');
        expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/i);
        expect(activeSql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.)\b/i);
        expect(sql).toContain('::UUID');
        expect(sql).toContain('::SMALLINT');
        expect(sql).toContain('::TIMESTAMPTZ');
        expect(sql).toContain("job.payload->'legacy_row'");
        for (const table of TARGETS) {
            expect(sql).toContain(`CREATE TABLE public.${table}`);
            expect(sql).toContain(`INSERT INTO public.${table}`);
            sourceShape(table).forEach(([column]) => expect(sql).toContain(column));
        }
    });

    it('provides sanitized preflight/postapply verifier modes with rollback-only state', () => {
        const sql = readVerifierOperation();
        expect(sql).toMatch(/current_setting\(\s*'supabase\.retirement_verifier_mode',\s*TRUE\s*\)/i);
        expect(sql).toContain("IS DISTINCT FROM 'preflight'");
        expect(sql).toContain("IS DISTINCT FROM 'postapply'");
        expect(sql).toContain('RETIREMENT_VERIFIER_MODE_REQUIRED');
        expect(sql).toContain('CREATE TEMP TABLE pg_temp.retirement_verifier_output');
        expect(sql).toContain('ON COMMIT DROP');
        expect(sql).toContain('SELECT report FROM pg_temp.retirement_verifier_output');
        expect(sql.trimEnd()).toMatch(/ROLLBACK;\s*$/i);
        expect(sql).toContain('pg_catalog.pg_get_function_identity_arguments');
        expect(sql).toContain('pg_catalog.pg_publication_namespace');
        expect(sql).toContain('migrationHistoryOccurrences');
        expect(sql).toContain('canonicalAggregateSha256');
        expect(sql).toContain('RETIREMENT_VERIFIER_PREFLIGHT_SOURCE_MISMATCH');
        expect(sql).toContain('RETIREMENT_VERIFIER_PREFLIGHT_CATALOG_MISMATCH');
        expect(sql).toContain('RETIREMENT_VERIFIER_POSTAPPLY_MISMATCH');
        expect(sql).toContain('RETIREMENT_VERIFIER_CANONICAL_CONFLICT');
        expect(sql).toMatch(/payload->>'legacy_source_table'\s+IN\s*\([\s\S]*earlybird_v214_concierge_gemini_copy_corrections/);
        expect(sql).not.toMatch(/\bINSERT INTO\s+public\./i);
        expect(sql).not.toMatch(/\b(?:UPDATE|DELETE FROM|DROP TABLE|TRUNCATE)\b/i);
        for (const table of TARGETS) expect(sql).toContain(table);
        expect(sql).not.toContain('payment_pending');
    });

    it('records a pre-apply evidence boundary and coordinator-only rollout gate', () => {
        const report = readFileSync(REPORT_PATH, 'utf8');
        expect(report).toContain('READY_FOR_REVIEW_NOT_APPLIED');
        expect(report).toContain('expected canonical total is 11 rows');
        expect(report).toContain('185');
        expect(report).toContain('177');
        expect(report).toMatch(/PGlite suite passed\s+14 tests/);
        expect(report).toContain('No analysis admission was activated');
        expect(report).toMatch(/real `0_min\._\.00` canary was\s+never run/);
        expect(report).toContain('payment_pending');
        expect(report).toContain('coordinator-owned gates');
    });
});

type RetirementFixture = {
    db: PGlite;
    sourceRows: Readonly<Record<string, readonly string[]>>;
};

async function createRetirementFixture(): Promise<RetirementFixture> {
    const db = await PGlite.create();
    const hash = 'a'.repeat(64);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE ${['service', 'role'].join('_')} NOLOGIN;
        CREATE SCHEMA extensions;
        CREATE FUNCTION extensions.gen_random_uuid()
        RETURNS uuid LANGUAGE sql VOLATILE
        AS $fn$ SELECT pg_catalog.gen_random_uuid() $fn$;

        CREATE TABLE public.maintenance_jobs (
            id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
            kind TEXT NOT NULL CHECK (kind IN ('recovery', 'replay', 'rearm', 'cleanup', 'terminalize', 'purge', 'audit_assembly')),
            target_key_hash TEXT NOT NULL CHECK (target_key_hash ~ '^[a-f0-9]{64}$'),
            state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'retryable', 'blocked')),
            attempt_count SMALLINT NOT NULL DEFAULT 0,
            lease_generation BIGINT NOT NULL DEFAULT 0,
            lease_token UUID,
            lease_holder_hash TEXT,
            lease_expires_at TIMESTAMPTZ,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
            terminal_at TIMESTAMPTZ,
            last_error_code TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::JSONB,
            content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
            created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
            UNIQUE (kind, target_key_hash)
        );

        CREATE TABLE public.earlybird_concierge_batch_target_lineage_repairs (
            cohort_key TEXT NOT NULL, order_id UUID NOT NULL, request_id UUID NOT NULL,
            preflight_id UUID NOT NULL, rearm_generation SMALLINT NOT NULL,
            source_failure_code TEXT NOT NULL, source_credential_slot TEXT NOT NULL,
            fallback_credential_slot TEXT NOT NULL, allowlist_hash TEXT NOT NULL,
            old_request_target_hash TEXT NOT NULL, old_preflight_target_hash TEXT NOT NULL,
            repaired_target_hash TEXT NOT NULL, repaired_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_partial_adoption_second_rearms (
            order_id UUID NOT NULL, original_failed_request_id UUID NOT NULL,
            first_policy_failed_request_id UUID NOT NULL, second_policy_failed_request_id UUID NOT NULL,
            rearmed_preflight_id UUID NOT NULL, expected_fulfillment_attempt_count SMALLINT NOT NULL,
            expected_manual_review_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_profile_evidence_failure_recoveries (
            order_id UUID NOT NULL, failed_request_id UUID NOT NULL,
            recovery_preflight_id UUID NOT NULL, prior_attempt_count SMALLINT NOT NULL,
            expected_manual_review_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_v211_apify_transient_admission_resumes (
            order_id UUID NOT NULL, expected_manual_review_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_v211_concierge_copy_corrections (
            order_id UUID NOT NULL, result_request_id UUID NOT NULL,
            published_source_fingerprint TEXT NOT NULL, expected_published_result_hash TEXT NOT NULL,
            correction_result_hash TEXT NOT NULL, copy_payload JSONB NOT NULL,
            corrected_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_v212_concierge_copy_corrections (
            order_id UUID NOT NULL, result_request_id UUID NOT NULL,
            prior_correction_result_hash TEXT NOT NULL, correction_result_hash TEXT NOT NULL,
            copy_payload JSONB NOT NULL, corrected_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_v213_concierge_copy_corrections (
            order_id UUID NOT NULL, result_request_id UUID NOT NULL,
            prior_correction_result_hash TEXT NOT NULL, correction_result_hash TEXT NOT NULL,
            copy_payload JSONB NOT NULL, corrected_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE public.earlybird_v214_concierge_gemini_copy_corrections (
            order_id UUID NOT NULL, result_request_id UUID NOT NULL,
            prior_correction_result_hash TEXT NOT NULL, correction_result_hash TEXT NOT NULL,
            copy_payload JSONB NOT NULL, corrected_at TIMESTAMPTZ NOT NULL
        );
    `);

    const fixtureTables = 9;
    const fillerTables = Array.from({ length: EXPECTED_BASELINE_TABLE_COUNT - fixtureTables }, (_, index) =>
        `CREATE TABLE public.retirement_fixture_${String(index).padStart(3, '0')} (id INTEGER);`);
    await db.exec(fillerTables.join('\n'));

    await db.exec(`
        INSERT INTO public.earlybird_concierge_batch_target_lineage_repairs VALUES
        ('concierge-fallback-20260816', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201', 3, 'JOB_ATTEMPTS_EXHAUSTED', 'quinary', 'primary', '${hash}', '${hash}', '${hash}', '${hash}', '2026-08-16T00:00:00Z'),
        ('concierge-fallback-20260816', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000202', 3, 'SCRAPING_INCOMPLETE_ERROR', 'quinary', 'primary', '${hash}', '${hash}', '${hash}', '${hash}', '2026-08-16T00:01:00Z'),
        ('concierge-fallback-20260816', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000203', 3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR', 'quinary', 'primary', '${hash}', '${hash}', '${hash}', '${hash}', '2026-08-16T00:02:00Z');
        INSERT INTO public.earlybird_partial_adoption_second_rearms VALUES
        ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000204', 3, '2026-08-01T00:00:00Z', '2026-08-01T00:01:00Z');
        INSERT INTO public.earlybird_profile_evidence_failure_recoveries VALUES
        ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000205', 1, '2026-08-04T00:00:00Z', '2026-08-04T00:01:00Z'),
        ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000108', '00000000-0000-4000-8000-000000000206', 2, '2026-08-04T00:02:00Z', '2026-08-04T00:03:00Z');
        INSERT INTO public.earlybird_v211_apify_transient_admission_resumes VALUES
        ('00000000-0000-4000-8000-000000000007', '2026-08-08T00:00:00Z', '2026-08-08T00:01:00Z');
        INSERT INTO public.earlybird_v211_concierge_copy_corrections VALUES
        ('00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000208', '${hash}', '${hash}', '${hash}', '{"fixture": true}'::jsonb, '2026-08-15T00:00:00Z');
        INSERT INTO public.earlybird_v212_concierge_copy_corrections VALUES
        ('00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000209', '${hash}', '${hash}', '{"fixture": true}'::jsonb, '2026-08-15T00:01:00Z');
        INSERT INTO public.earlybird_v213_concierge_copy_corrections VALUES
        ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000210', '${hash}', '${hash}', '{"fixture": true}'::jsonb, '2026-08-15T00:02:00Z');
        INSERT INTO public.earlybird_v214_concierge_gemini_copy_corrections VALUES
        ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000211', '${hash}', '${hash}', '{"fixture": true}'::jsonb, '2026-08-15T00:03:00Z');
    `);

    await db.exec(`
        CREATE FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.reconcile_exact_three_concierge_target_lineage(p_expected_allowlist_hash text)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.rearm_earlybird_partial_adoption_second_failure(p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamptz)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamptz)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.resume_earlybird_v211_apify_transient_admission(p_order_id uuid, p_expected_manual_review_at timestamptz)
        RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
        CREATE FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.correct_earlybird_v211_concierge_copy(p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_correction_result_hash text, p_copy_payload jsonb)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.prevent_earlybird_v212_concierge_copy_correction_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.correct_earlybird_v212_concierge_copy(p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.prevent_earlybird_v213_concierge_copy_correction_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.correct_earlybird_v213_concierge_copy(p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
        CREATE FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$;
        CREATE FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_expected_v213_fact_snapshot jsonb, p_correction_result_hash text, p_copy_payload jsonb)
        RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '{}'::jsonb $fn$;
    `);

    const sourceRows: Record<string, readonly string[]> = {};
    for (const table of TARGETS) {
        const rows = await db.query<{ row_text: string }>(
            `SELECT (pg_catalog.to_jsonb(source_row))::TEXT AS row_text FROM public.${table} AS source_row ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT`,
        );
        sourceRows[table] = rows.rows.map(row => row.row_text);
    }
    return { db, sourceRows };
}

async function seedRestoreParents(db: PGlite): Promise<void> {
    await db.exec(`
        CREATE TABLE public.earlybird_orders (id UUID PRIMARY KEY);
        CREATE TABLE public.analysis_requests (id UUID PRIMARY KEY);
        CREATE TABLE public.analysis_preflights (id UUID PRIMARY KEY);
        CREATE TABLE public.earlybird_v211_apify_transient_replays (order_id UUID PRIMARY KEY);

        INSERT INTO public.earlybird_orders (id)
        SELECT DISTINCT (job.payload->'legacy_row'->>'order_id')::UUID
        FROM public.maintenance_jobs AS job
        WHERE job.payload ? 'legacy_source_table';

        INSERT INTO public.analysis_requests (id)
        SELECT DISTINCT request_id::UUID
        FROM (
            SELECT job.payload->'legacy_row'->>'request_id' AS request_id
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_concierge_batch_target_lineage_repairs'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'original_failed_request_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'first_policy_failed_request_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'second_policy_failed_request_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'failed_request_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_profile_evidence_failure_recoveries'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'result_request_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' IN (
                'earlybird_v211_concierge_copy_corrections',
                'earlybird_v212_concierge_copy_corrections',
                'earlybird_v213_concierge_copy_corrections',
                'earlybird_v214_concierge_gemini_copy_corrections'
            )
        ) AS request_ids(request_id)
        WHERE request_id IS NOT NULL;

        INSERT INTO public.analysis_preflights (id)
        SELECT DISTINCT preflight_id::UUID
        FROM (
            SELECT job.payload->'legacy_row'->>'preflight_id' AS preflight_id
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_concierge_batch_target_lineage_repairs'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'rearmed_preflight_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms'
            UNION ALL
            SELECT job.payload->'legacy_row'->>'recovery_preflight_id'
            FROM public.maintenance_jobs AS job
            WHERE job.payload->>'legacy_source_table' = 'earlybird_profile_evidence_failure_recoveries'
        ) AS preflight_ids(preflight_id)
        WHERE preflight_id IS NOT NULL;

        INSERT INTO public.earlybird_v211_apify_transient_replays (order_id)
        SELECT (job.payload->'legacy_row'->>'order_id')::UUID
        FROM public.maintenance_jobs AS job
        WHERE job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_admission_resumes';
    `);
}

describe('Supabase 22 legacy earlybird retirement PGlite apply', () => {
    it('preserves every source column in maintenance_jobs before dropping only the approved scope', async () => {
        const fixture = await createRetirementFixture();
        try {
            await fixture.db.exec(readMigration());

            const tableCount = await fixture.db.query<{ count: number }>(`
                SELECT pg_catalog.count(*)::INTEGER AS count
                FROM pg_catalog.pg_class AS relation_row
                JOIN pg_catalog.pg_namespace AS relation_schema
                  ON relation_schema.oid = relation_row.relnamespace
                WHERE relation_schema.nspname = 'public'
                  AND relation_row.relkind IN ('r', 'p')
            `);
            expect(Number(tableCount.rows[0]?.count)).toBe(EXPECTED_FINAL_TABLE_COUNT);

            const canonicalRows = await fixture.db.query<{
                source_table: string;
                row_text: string;
                payload_text: string;
                state: string;
                content_hash: string;
            }>(`
                SELECT payload->>'legacy_source_table' AS source_table,
                       (payload->'legacy_row')::TEXT AS row_text,
                       payload::TEXT AS payload_text,
                       state,
                       content_hash
                FROM public.maintenance_jobs
                WHERE payload ? 'legacy_source_table'
                ORDER BY source_table, row_text
            `);
            expect(canonicalRows.rows).toHaveLength(EXPECTED_TOTAL);
            for (const table of TARGETS) {
                const rows = canonicalRows.rows.filter(row => row.source_table === table);
                expect(rows).toHaveLength(fixture.sourceRows[table]?.length ?? -1);
                expect(rows.map(row => row.row_text)).toEqual(fixture.sourceRows[table]);
                rows.forEach(row => {
                    expect(row.state).toBe('succeeded');
                    expect(row.content_hash).toBe(createHash('sha256').update(row.payload_text, 'utf8').digest('hex'));
                });
            }

            const remainingTargets = await fixture.db.query<{ name: string }>(`
                SELECT relation_row.relname AS name
                FROM pg_catalog.pg_class AS relation_row
                JOIN pg_catalog.pg_namespace AS relation_schema
                  ON relation_schema.oid = relation_row.relnamespace
                WHERE relation_schema.nspname = 'public'
                  AND relation_row.relname = ANY($1::TEXT[])
            `, [[...TARGETS]]);
            expect(remainingTargets.rows).toEqual([]);

            for (const signature of ROUTINES) {
                const routine = await fixture.db.query<{ routine: string | null }>(
                    'SELECT pg_catalog.to_regprocedure($1)::TEXT AS routine', [signature],
                );
                expect(routine.rows[0]?.routine ?? null).toBeNull();
            }
        } finally {
            await fixture.db.close();
        }
    });

    it('fails closed on canonical conflicts unless state, payload, and content_hash are exact', async () => {
        const scenarios = [
            { name: 'state', state: 'queued', payload: 'expected.payload', hash: "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex')" },
            { name: 'payload', state: 'succeeded', payload: "expected.payload || '{\"drift\": true}'::JSONB", hash: "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex')" },
            { name: 'content-hash', state: 'succeeded', payload: 'expected.payload', hash: "pg_catalog.repeat('b', 64)" },
        ] as const;

        for (const scenario of scenarios) {
            const fixture = await createRetirementFixture();
            try {
                await fixture.db.exec(`
                    WITH expected AS (
                        SELECT
                            'recovery'::TEXT AS kind,
                            pg_catalog.jsonb_build_object(
                                'legacy_source_table', 'earlybird_concierge_batch_target_lineage_repairs',
                                'legacy_primary_key', pg_catalog.jsonb_build_object(
                                    'cohort_key', source_row.cohort_key,
                                    'order_id', source_row.order_id
                                ),
                                'legacy_row', pg_catalog.to_jsonb(source_row),
                                'schema_version', 1
                            ) AS payload
                        FROM public.earlybird_concierge_batch_target_lineage_repairs AS source_row
                        ORDER BY source_row.order_id
                        LIMIT 1
                    ), conflict AS (
                        SELECT
                            kind,
                            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                                'supabase-22-legacy-earlybird-retirement-v1:' || kind
                                || ':earlybird_concierge_batch_target_lineage_repairs:'
                                || (payload->'legacy_primary_key')::TEXT,
                                'UTF8'
                            )), 'hex') AS target_key_hash,
                            ${scenario.payload} AS payload
                        FROM expected
                    )
                    INSERT INTO public.maintenance_jobs (kind, target_key_hash, state, payload, content_hash)
                    SELECT kind, target_key_hash, '${scenario.state}', payload,
                           ${scenario.hash}
                    FROM conflict;
                `);

                let migrationError: unknown;
                try {
                    await fixture.db.exec(readMigration());
                } catch (error) {
                    migrationError = error;
                }
                expect(migrationError, scenario.name).toBeDefined();
                expect(String(migrationError), scenario.name).toContain('MAINTENANCE_CONTENT_CONFLICT');
                await fixture.db.exec('ROLLBACK;');

                const sourceStillExists = await fixture.db.query<{ count: number }>(`
                    SELECT pg_catalog.count(*)::INTEGER AS count
                    FROM public.earlybird_concierge_batch_target_lineage_repairs
                `);
                expect(Number(sourceStillExists.rows[0]?.count), scenario.name).toBe(3);
            } finally {
                await fixture.db.close();
            }
        }
    });

    it('fails closed on baseline, source-count, shape, routine, and caller drift', async () => {
        const scenarios: ReadonlyArray<{
            name: string;
            mutate: (db: PGlite) => Promise<void>;
            expectedError: string;
        }> = [
            {
                name: 'baseline',
                mutate: async db => { await db.exec('DROP TABLE public.retirement_fixture_000;'); },
                expectedError: 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT',
            },
            {
                name: 'source-count',
                mutate: async db => { await db.exec("DELETE FROM public.earlybird_profile_evidence_failure_recoveries WHERE order_id = '00000000-0000-4000-8000-000000000006';"); },
                expectedError: 'RETIREMENT_GUARD_SOURCE_COUNT',
            },
            {
                name: 'shape',
                mutate: async db => { await db.exec('ALTER TABLE public.earlybird_v213_concierge_copy_corrections ADD COLUMN unexpected_shape TEXT;'); },
                expectedError: 'RETIREMENT_GUARD_SOURCE_SHAPE',
            },
            {
                name: 'routine',
                mutate: async db => { await db.exec('DROP FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb);'); },
                expectedError: 'RETIREMENT_GUARD_ROUTINE_MISSING',
            },
            {
                name: 'routine-caller',
                mutate: async db => {
                    await db.exec(`
                        CREATE FUNCTION public.retained_routine_caller()
                        RETURNS jsonb LANGUAGE sql
                        AS $fn$ SELECT public.correct_earlybird_v211_concierge_copy(
                            NULL, NULL, NULL, NULL, NULL, NULL, NULL
                        ) $fn$;
                    `);
                },
                expectedError: 'RETIREMENT_GUARD_RETAINED_ROUTINE_CALLER',
            },
        ];

        for (const scenario of scenarios) {
            const fixture = await createRetirementFixture();
            try {
                await scenario.mutate(fixture.db);
                let migrationError: unknown;
                try {
                    await fixture.db.exec(readMigration());
                } catch (error) {
                    migrationError = error;
                }
                expect(migrationError, scenario.name).toBeDefined();
                expect(String(migrationError), scenario.name).toContain(scenario.expectedError);
                await fixture.db.exec('ROLLBACK;');
                const sourceStillExists = await fixture.db.query<{ count: number }>(`
                    SELECT pg_catalog.count(*)::INTEGER AS count
                    FROM pg_catalog.pg_class AS relation_row
                    JOIN pg_catalog.pg_namespace AS relation_schema
                      ON relation_schema.oid = relation_row.relnamespace
                    WHERE relation_schema.nspname = 'public'
                      AND relation_row.relname = 'earlybird_profile_evidence_failure_recoveries'
                `);
                expect(Number(sourceStillExists.rows[0]?.count)).toBe(1);
            } finally {
                await fixture.db.close();
            }
        }
    });

    it('rejects a non-isolated restore, then restores typed rows and exact field shapes', async () => {
        const unguardedFixture = await createRetirementFixture();
        try {
            let restoreError: unknown;
            try {
                await unguardedFixture.db.exec(readRestoreOperation());
            } catch (error) {
                restoreError = error;
            }
            expect(String(restoreError)).toContain('RETIREMENT_RESTORE_ISOLATED_GUARD');
            await unguardedFixture.db.exec('ROLLBACK;');
        } finally {
            await unguardedFixture.db.close();
        }

        const fixture = await createRetirementFixture();
        try {
            await fixture.db.exec(readMigration());
            await seedRestoreParents(fixture.db);
            await fixture.db.exec(`SET supabase.retirement_isolated = 'true';`);
            await fixture.db.exec(readRestoreOperation());

            for (const table of TARGETS) {
                const rows = await fixture.db.query<{ row_text: string }>(
                    `SELECT (pg_catalog.to_jsonb(source_row))::TEXT AS row_text FROM public.${table} AS source_row ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT`,
                );
                expect(rows.rows.map(row => row.row_text)).toEqual(fixture.sourceRows[table]);

                const columns = await fixture.db.query<{
                    column_name: string;
                    data_type: string;
                    is_nullable: string;
                }>(`
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = '${table}'
                    ORDER BY ordinal_position
                `);
                expect(columns.rows.map(column =>
                    `${column.column_name}:${column.data_type}:${column.is_nullable === 'YES'}`,
                )).toEqual(sourceShape(table));
            }

            const canonicalRows = await fixture.db.query<{ count: number }>(`
                SELECT pg_catalog.count(*)::INTEGER AS count
                FROM public.maintenance_jobs
                WHERE payload ? 'legacy_source_table'
            `);
            expect(Number(canonicalRows.rows[0]?.count)).toBe(EXPECTED_TOTAL);
        } finally {
            await fixture.db.close();
        }
    });

    it('executes sanitized verifier preflight and postapply modes in disposable databases', async () => {
        const preflightFixture = await createRetirementFixture();
        try {
            await preflightFixture.db.exec(`
                CREATE SCHEMA supabase_migrations;
                CREATE TABLE supabase_migrations.schema_migrations (version TEXT NOT NULL);
                SET supabase.retirement_verifier_mode = 'preflight';
            `);
            await preflightFixture.db.exec(readVerifierOperation());
        } finally {
            await preflightFixture.db.close();
        }

        const postapplyFixture = await createRetirementFixture();
        try {
            await postapplyFixture.db.exec(readMigration());
            await postapplyFixture.db.exec(`
                CREATE SCHEMA supabase_migrations;
                CREATE TABLE supabase_migrations.schema_migrations (version TEXT NOT NULL);
                INSERT INTO supabase_migrations.schema_migrations VALUES ('20260911001903');
                SET supabase.retirement_verifier_mode = 'postapply';
            `);
            await postapplyFixture.db.exec(readVerifierOperation());
        } finally {
            await postapplyFixture.db.close();
        }
    });

    it('raises on verifier source/canonical drift while ignoring out-of-scope legacy source values', async () => {
        const preflightFixture = await createRetirementFixture();
        try {
            await preflightFixture.db.exec(`
                DELETE FROM public.earlybird_profile_evidence_failure_recoveries
                WHERE order_id = '00000000-0000-4000-8000-000000000006';
                SET supabase.retirement_verifier_mode = 'preflight';
            `);
            let verifierError: unknown;
            try {
                await preflightFixture.db.exec(readVerifierOperation());
            } catch (error) {
                verifierError = error;
            }
            expect(String(verifierError)).toContain('RETIREMENT_VERIFIER_PREFLIGHT_SOURCE_MISMATCH');
            await preflightFixture.db.exec('ROLLBACK;');
        } finally {
            await preflightFixture.db.close();
        }

        const postapplyFixture = await createRetirementFixture();
        try {
            await postapplyFixture.db.exec(readMigration());
            await postapplyFixture.db.exec(`
                CREATE SCHEMA supabase_migrations;
                CREATE TABLE supabase_migrations.schema_migrations (version TEXT NOT NULL);
                INSERT INTO supabase_migrations.schema_migrations VALUES ('20260911001903');
                INSERT INTO public.maintenance_jobs (kind, target_key_hash, state, payload, content_hash)
                SELECT 'audit_assembly', pg_catalog.repeat('c', 64), 'succeeded',
                       '{"legacy_source_table":"unapproved_legacy","legacy_row":{"fixture":true}}'::JSONB,
                       pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                           '{"legacy_row":{"fixture":true},"legacy_source_table":"unapproved_legacy"}'::JSONB::TEXT,
                           'UTF8'
                       )), 'hex');
                SET supabase.retirement_verifier_mode = 'postapply';
            `);
            await postapplyFixture.db.exec(readVerifierOperation());

            await postapplyFixture.db.exec(`
                UPDATE public.maintenance_jobs
                SET state = 'queued'
                WHERE id = (
                    SELECT id
                    FROM public.maintenance_jobs
                    WHERE payload->>'legacy_source_table' = 'earlybird_concierge_batch_target_lineage_repairs'
                    LIMIT 1
                );
                SET supabase.retirement_verifier_mode = 'postapply';
            `);
            let verifierError: unknown;
            try {
                await postapplyFixture.db.exec(readVerifierOperation());
            } catch (error) {
                verifierError = error;
            }
            expect(String(verifierError)).toContain('RETIREMENT_VERIFIER_CANONICAL_CONFLICT');
            await postapplyFixture.db.exec('ROLLBACK;');
        } finally {
            await postapplyFixture.db.close();
        }
    });
});
