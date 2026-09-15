import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_V2_PROVIDER_OPERATION_KINDS } from '../../../lib/services/analysis/v2-provider-run-store';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260721000000_allow_analysis_v2_profile_repair_operation_key.sql',
        import.meta.url
    ),
    'utf8'
);

const originalMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260713171647_add_analysis_v2_provider_run_ledger.sql',
        import.meta.url
    ),
    'utf8'
);

function validatorDefinition(source: string): string {
    const start = source.indexOf(
        'CREATE OR REPLACE FUNCTION public.analysis_v2_valid_provider_operation_key('
    );
    expect(start, 'validator must exist').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n$$;', start);
    expect(end, 'validator must have a bounded body').toBeGreaterThan(start);
    return source.slice(start, end);
}

/** Reconstruct the DB validator predicate from the migration SQL: length bound AND regex. */
function migrationValidator(source: string): (key: string) => boolean {
    const definition = validatorDefinition(source);
    const bound = definition.match(
        /char_length\(p_operation_key\) BETWEEN (\d+) AND (\d+)/
    );
    if (!bound) throw new Error('length bound not found');
    const [lo, hi] = [Number(bound[1]), Number(bound[2])];
    const regexLiteral = definition.match(/p_operation_key ~ '([^']+)'/);
    if (!regexLiteral) throw new Error('operation key regex not found');
    const regex = new RegExp(regexLiteral[1]);
    return (key) => key.length >= lo && key.length <= hi && regex.test(key);
}

const HEX64 = 'a'.repeat(64);

describe('analysis V2 profile-repair operation key migration contract', () => {
    it('reproduces the STRICT IMMUTABLE modifier list verbatim and changes nothing else', () => {
        // The plan spec block dropped STRICT; keeping it is the whole point of the correction.
        const definition = validatorDefinition(migration);
        expect(definition).toContain(
            "LANGUAGE sql\nIMMUTABLE\nSTRICT\nSET search_path = ''"
        );
        // Exactly one statement: the CREATE OR REPLACE. No table/grant/revoke/DML churn.
        expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
        for (const forbidden of [
            'CREATE TABLE',
            'ALTER TABLE',
            'DROP ',
            'GRANT ',
            'REVOKE ',
            'INSERT ',
            'UPDATE ',
            'DELETE ',
            'CREATE INDEX',
        ]) {
            expect(migration).not.toContain(forbidden);
        }
        // The length bound is untouched from the original ledger migration.
        expect(migration).toContain(
            'pg_catalog.char_length(p_operation_key) BETWEEN 78 AND 87'
        );
        expect(validatorDefinition(originalMigration)).toContain(
            'pg_catalog.char_length(p_operation_key) BETWEEN 78 AND 87'
        );
    });

    it('documents the widening as a length-safe strict superset', () => {
        expect(migration.toLowerCase()).toContain('superset');
        expect(migration).toContain('79');
    });

    it('accepts profile-repair keys and still accepts all seven pre-existing kinds', () => {
        const accepts = migrationValidator(migration);

        expect(accepts(`profile-repair:${HEX64}`)).toBe(true);
        expect(`profile-repair:${HEX64}`).toHaveLength(79);

        for (const kind of [
            'target-profile',
            'profile-fallback',
            'relationship-followers',
            'relationship-following',
            'target-likers',
            'target-comments',
            'candidate-likers',
        ]) {
            expect(accepts(`${kind}:${HEX64}`), `must still accept ${kind}`).toBe(true);
        }

        // The migration validator must admit exactly the kinds the TypeScript source registers.
        for (const kind of ANALYSIS_V2_PROVIDER_OPERATION_KINDS) {
            expect(accepts(`${kind}:${HEX64}`), `must accept ${kind}`).toBe(true);
        }
    });

    it('rejects unknown kinds and malformed digests', () => {
        const accepts = migrationValidator(migration);
        // Right structure, wrong kind (a valid kind with one extra char).
        expect(accepts(`profile-repairx:${HEX64}`)).toBe(false);
        expect(accepts(`repair:${HEX64}`)).toBe(false);
        // Uppercase hex is outside [0-9a-f].
        expect(accepts(`profile-repair:${'A'.repeat(64)}`)).toBe(false);
        // Digest length off by one in either direction.
        expect(accepts(`profile-repair:${'a'.repeat(63)}`)).toBe(false);
        expect(accepts(`profile-repair:${'a'.repeat(65)}`)).toBe(false);
    });

    it('does not widen the original ledger migration in place (append-only)', () => {
        expect(validatorDefinition(originalMigration)).not.toContain('profile-repair');
    });
});
