import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    isAnalysisAuditOperator,
} from '@/lib/services/analysis/score-audit';
import {
    loadAnalysisOrderAuditBundle,
    parseOrderAuditQuery,
} from '@/lib/services/analysis/order-audit-query';

/** Operator-only, private projection of the immutable order audit copy. */
function privateJson(body: unknown, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

export async function GET(
    request: Request,
    context: { params: Promise<{ requestId: string }> },
) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return privateJson({ error: 'Unauthorized' }, 401);
    if (!isAnalysisAuditOperator(user.id)) {
        return privateJson({ error: 'Forbidden' }, 403);
    }

    try {
        const { requestId } = await context.params;
        // section, pageSize, and filter stay bounded at the typed service boundary.
        const query = parseOrderAuditQuery(request.url);
        const payload = await loadAnalysisOrderAuditBundle(
            supabaseAdmin,
            requestId,
            query,
        );
        if (!payload) return privateJson({ error: 'Not found' }, 404);
        return privateJson(payload);
    } catch (caught) {
        if (
            caught instanceof Error
            && caught.message === 'ANALYSIS_ORDER_AUDIT_NOT_FOUND'
        ) {
            return privateJson({ error: 'Not found' }, 404);
        }
        return privateJson({ error: 'Invalid audit request' }, 400);
    }
}
