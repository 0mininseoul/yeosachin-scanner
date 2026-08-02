import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationFiles = [
    '20260802010000_add_betatest_apify_credit_pool.sql',
    '20260802010100_validate_betatest_entry_channel_constraints.sql',
    '20260802020000_add_betatest_apify_credit_reservations.sql',
    '20260802030000_bind_betatest_provider_policy.sql',
    '20260802030100_validate_betatest_provider_policy.sql',
    '20260802040000_settle_betatest_apify_credit_reservations.sql',
    '20260802050000_harden_betatest_apify_credit_capacity.sql',
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

function executableSql(sql: string): string {
    return sql.replace(/^\s*--.*$/gm, '').trim();
}

describe('betatest migration CLI batch contract', () => {
    it.each(migrationFiles)('%s leaves the CLI-owned batch open through history insertion', file => {
        const sql = executableSql(readFileSync(
            new URL(`../../../supabase/migrations/${file}`, import.meta.url),
            'utf8',
        ));

        expect(sql, `${file} must not commit before the CLI history insert`)
            .not.toMatch(/^BEGIN\s*;/);
        expect(sql, `${file} must leave the batch-owned transaction open`)
            .not.toMatch(/COMMIT\s*;$/);
    });

    it('takes the frozen-budget apply fence inside a DO block', () => {
        const sql = executableSql(readFileSync(new URL(
            '../../../supabase/migrations/20260802060000_expose_betatest_frozen_provider_budgets.sql',
            import.meta.url,
        ), 'utf8'));

        expect(sql).not.toMatch(/^LOCK TABLE public\.analysis_beta_pool_allocations/m);
        expect(sql).toMatch(
            /DO \$\$\s*BEGIN\s*EXECUTE 'LOCK TABLE public\.analysis_beta_pool_allocations IN EXCLUSIVE MODE';\s*END;\s*\$\$;/
        );
    });
});
