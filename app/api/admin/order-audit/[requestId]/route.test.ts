import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const route = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');

describe('operator order-audit route contract', () => {
    it('uses cookie session authentication and an environment operator allowlist', () => {
        expect(route).toContain('createClient');
        expect(route).toContain('supabase.auth.getUser()');
        expect(route).toContain('isAnalysisAuditOperator(user.id)');
        expect(route).toContain("privateJson({ error: 'Unauthorized' }, 401)");
        expect(route).toContain("privateJson({ error: 'Forbidden' }, 403)");
        expect(route).toContain("privateJson({ error: 'Not found' }, 404)");
        expect(route).toContain("'Cache-Control': 'private, no-store'");
    });

    it('parses bounded section/filter pagination and only calls the redacted loader', () => {
        expect(route).toContain('loadAnalysisOrderAuditBundle');
        expect(route).toContain('parseOrderAuditQuery');
        expect(route).toContain('supabaseAdmin');
        expect(route).toContain('section');
        expect(route).toContain('pageSize');
        expect(route).toContain('filter');
        expect(route).not.toContain('analysis_v2_result_summaries');
        expect(route).not.toContain('providerToken');
        expect(route).not.toContain('userId');
    });
});
