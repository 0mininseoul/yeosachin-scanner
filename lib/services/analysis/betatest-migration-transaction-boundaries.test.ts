import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pendingMigrationFiles = [
    '20260802060000_expose_betatest_frozen_provider_budgets.sql',
    '20260802070000_wire_betatest_preflight_credit_runtime.sql',
    '20260802080000_admit_betatest_apify_plan.sql',
    '20260802090000_settle_betatest_terminal_credit.sql',
    '20260802100000_harden_betatest_entry_lifecycle.sql',
    '20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
    '20260802100200_validate_betatest_entry_lifecycle.sql',
    '20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
    '20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
    '20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
    '20260802100600_add_betatest_pool_observability.sql',
] as const;

const fenceStart = 'DO $migration_transaction_fence$';
const fenceEnd = '$migration_transaction_fence$;';
const lockStatement =
    'LOCK TABLE public.analysis_beta_pool_allocations IN EXCLUSIVE MODE;';
const lockTimeout =
    "PERFORM pg_catalog.set_config('lock_timeout', '5s', true);";
const statementTimeout =
    "PERFORM pg_catalog.set_config('statement_timeout', '2min', true);";

function executableSql(sql: string): string {
    return sql.replace(/^\s*--.*$/gm, '').trim();
}

function migrationFenceViolations(file: string, source: string): string[] {
    const sql = executableSql(source);
    const violations: string[] = [];
    const fenceEndIndex = sql.indexOf(fenceEnd);
    const fence = fenceEndIndex < 0 ? '' : sql.slice(0, fenceEndIndex + fenceEnd.length);

    if (!sql.startsWith(fenceStart) || fenceEndIndex < 0) {
        violations.push('first executable statement must be the transaction fence DO block');
    }
    if (!fence.startsWith(`${fenceStart}\nBEGIN\n`)
        || !fence.endsWith(`\nEND;\n${fenceEnd}`)) {
        violations.push('transaction fence must be one complete DO block');
    }
    if (!fence.includes(lockTimeout)
        || !fence.includes(statementTimeout)
        || (sql.match(/pg_catalog\.set_config\('lock_timeout'/g) ?? []).length !== 1
        || (sql.match(/pg_catalog\.set_config\('statement_timeout'/g) ?? []).length !== 1) {
        violations.push('transaction fence must set both local timeouts with set_config true');
    }
    if (/^\s*SET\s+LOCAL\b/im.test(sql)) {
        violations.push('SET LOCAL must not be a top-level statement');
    }
    if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) {
        violations.push('explicit transaction control must not split the CLI batch');
    }
    if (/\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|^\s*(?:VACUUM|REINDEX|CLUSTER|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE)\b/im.test(sql)) {
        violations.push('migration contains a transaction-incompatible statement');
    }

    const requiresAllocationLock = file.startsWith('20260802060000_');
    if (requiresAllocationLock && !fence.includes(lockStatement)) {
        violations.push('060000 allocation lock must be inside the transaction fence');
    }
    if (requiresAllocationLock && sql.slice(fence.length).includes(lockStatement)) {
        violations.push('060000 allocation lock must not be outside the transaction fence');
    }
    if (!requiresAllocationLock && sql.includes('LOCK TABLE')) {
        violations.push('only 060000 may take the allocation table lock');
    }

    return violations;
}

function validFence(extra = ''): string {
    return `${fenceStart}
BEGIN
    ${lockTimeout}
    ${statementTimeout}
${extra}END;
${fenceEnd}
SELECT 1;`;
}

describe('pending betatest migration transaction fences', () => {
    it('covers exactly the eleven migrations that are not remotely applied', () => {
        expect(pendingMigrationFiles).toEqual([
            '20260802060000_expose_betatest_frozen_provider_budgets.sql',
            '20260802070000_wire_betatest_preflight_credit_runtime.sql',
            '20260802080000_admit_betatest_apify_plan.sql',
            '20260802090000_settle_betatest_terminal_credit.sql',
            '20260802100000_harden_betatest_entry_lifecycle.sql',
            '20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
            '20260802100200_validate_betatest_entry_lifecycle.sql',
            '20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
            '20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
            '20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
            '20260802100600_add_betatest_pool_observability.sql',
        ]);
    });

    it.each(pendingMigrationFiles)(
        '%s keeps timeout and lock setup inside the leading DO statement',
        file => {
            const migration = readFileSync(
                new URL(`../../../supabase/migrations/${file}`, import.meta.url),
                'utf8'
            );

            expect(migrationFenceViolations(file, migration)).toEqual([]);
        }
    );

    it('rejects transaction control that can commit before migration history', () => {
        expect(migrationFenceViolations(
            pendingMigrationFiles[1],
            `${validFence()}\nCOMMIT;`
        )).toContain('explicit transaction control must not split the CLI batch');
    });

    it('rejects statements that cannot run in the encompassing transaction', () => {
        expect(migrationFenceViolations(
            pendingMigrationFiles[1],
            `${validFence()}\nCREATE INDEX CONCURRENTLY broken_idx ON public.example(id);`
        )).toContain('migration contains a transaction-incompatible statement');
    });

    it('rejects the 060000 allocation lock outside its leading DO statement', () => {
        expect(migrationFenceViolations(
            pendingMigrationFiles[0],
            `${validFence()}\n${lockStatement}`
        )).toContain('060000 allocation lock must be inside the transaction fence');
    });

    it('rejects a non-local timeout configuration', () => {
        expect(migrationFenceViolations(
            pendingMigrationFiles[1],
            validFence().replace(lockTimeout, lockTimeout.replace('true', 'false'))
        )).toContain('transaction fence must set both local timeouts with set_config true');
    });
});
