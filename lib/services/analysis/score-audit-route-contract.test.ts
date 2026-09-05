import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const route = readFileSync(new URL(
    '../../../app/api/admin/analysis-audit/route.ts', import.meta.url,
), 'utf8');
const workbench = readFileSync(new URL(
    '../../../app/admin/analysis-audit/workbench.tsx', import.meta.url,
), 'utf8');

describe('analysis audit operator route privacy contract', () => {
    it('authenticates the Supabase session before the service-role audit RPC', () => {
        expect(route).toContain('createClient');
        expect(route).toContain('supabase.auth.getUser()');
        expect(route).toContain('getAnalysisAuditOperatorDecision(user.id)');
        expect(route.slice(route.indexOf('getAnalysisAuditOperatorDecision(user.id)')))
            .toContain('loadAnalysisScoreAudit(supabaseAdmin, query)');
        expect(route).toContain("'Cache-Control': 'private, no-store'");
        expect(route).toContain("privateJson({ error: 'Unauthorized' }, 401)");
        expect(route).toContain("privateJson({ error: 'Forbidden' }, 403)");
    });

    it('does not render images or raw provider/prompt material', () => {
        expect(workbench).not.toMatch(/<Image|profileImage|prompt|api[_ -]?token|fullName|row\.bio/iu);
        expect(workbench).toContain('공개 여성 위험 산출');
        expect(workbench).toContain("filter: 'public_female'");
    });

    it('fences stale responses and uses stable composite row identities', () => {
        expect(workbench).toContain('new AbortController()');
        expect(workbench).toContain('activeRequest.current?.controller.abort()');
        expect(workbench).toContain('signal: controller.signal');
        expect(workbench).toContain(
            'activeRequest.current?.sequence !== sequence'
        );
        expect(workbench).toContain('key={`${row.ordinal}:${row.evidenceId}`}');
        expect(workbench).toContain('key={row.candidateId}');
        expect(workbench).not.toContain('displayedRows.map(row => <>');
    });
});
