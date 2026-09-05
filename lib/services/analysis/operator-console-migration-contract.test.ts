import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260905100000_add_operator_console_audit_projection.sql';
const sql = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('operator console additive audit projection migration', () => {
    it('follows the permanent bundle migration and projects retention and gender counts', () => {
        expect(existsSync(migrationPath)).toBe(true);
        expect(sql).toContain('-- MIGRATION_PREDECESSOR=20260904130000');
        expect(sql).toContain('analysis_order_audit_bundle_payload');
        expect(sql).toContain('list_analysis_order_audit_bundles');
        expect(sql).toContain('purgeFencedAt');
        expect(sql).toContain('purgeFenceReason');
        expect(sql).toContain('queueStatus');
        expect(sql).toContain('initialResolved');
        expect(sql).toContain('finalResolved');
        expect(sql).toMatch(/security definer/i);
        expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|FUNCTION)/i);
    });

    it('projects only semantic female/male gender outputs, including when final exceeds initial', () => {
        expect(sql).toMatch(/WHERE candidate\.initial_gender_output IN \('female', 'male'\)/);
        expect(sql).toMatch(/WHERE candidate\.final_gender_output IN \('female', 'male'\)/);
        expect(sql).not.toMatch(/WHERE candidate\.initial_gender_model IS NOT NULL/);
        expect(sql).not.toMatch(/WHERE candidate\.final_gender_model IS NOT NULL/);

        const initialOutputs = ['female', 'male', 'unknown', 'unavailable', null, 'female'];
        const finalOutputs = ['female', 'male', 'unknown', 'unavailable', null, 'female', 'male', 'female'];
        const semanticCount = (outputs: readonly (string | null)[]) => outputs.filter(output => output === 'female' || output === 'male').length;
        expect(semanticCount(initialOutputs)).toBe(3);
        expect(semanticCount(finalOutputs)).toBe(5);
        expect(semanticCount(finalOutputs)).toBeGreaterThan(semanticCount(initialOutputs));
    });

    it('keeps the exact detail RPC signature service-role-only', () => {
        expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.load_analysis_order_audit_bundle\(\s*UUID, TEXT, INTEGER, INTEGER, TEXT\s*\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
        expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.load_analysis_order_audit_bundle\(\s*UUID, TEXT, INTEGER, INTEGER, TEXT\s*\)\s+TO service_role;/);
    });
});
