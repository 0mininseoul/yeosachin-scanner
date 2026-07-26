import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    isAnalysisAuditOperator,
    loadAnalysisScoreAudit,
    parseAnalysisAuditQuery,
} from '@/lib/services/analysis/score-audit';

/** Operator-only, deliberately cookie-authenticated audit projection. */
function privateJson(body: unknown, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

export async function GET(request: Request) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return privateJson({ error: 'Unauthorized' }, 401);
    if (!isAnalysisAuditOperator(user.id)) {
        return privateJson({ error: 'Forbidden' }, 403);
    }
    try {
        const query = parseAnalysisAuditQuery(request.url);
        const payload = await loadAnalysisScoreAudit(supabaseAdmin, query);
        if (!payload) return privateJson({ error: 'Not found' }, 404);
        return privateJson(payload);
    } catch {
        return privateJson({ error: 'Invalid audit request' }, 400);
    }
}
