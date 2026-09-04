import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
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

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidSchema = z.string().uuid();

export async function GET(
    request: Request,
    context: { params: Promise<{ requestId: string }> },
) {
    let supabase: Awaited<ReturnType<typeof createClient>>;
    let user: { id: string } | null = null;
    try {
        supabase = await createClient();
        const auth = await supabase.auth.getUser();
        if (auth.error) {
            if (classifyOperatorAuthError(auth.error) === 'unauthorized') {
                return privateJson({ error: 'Unauthorized' }, 401);
            }
            return privateJson({ error: 'Authentication unavailable' }, 503);
        }
        user = auth.data.user;
    } catch (caught) {
        if (classifyOperatorAuthError(caught) === 'unauthorized') {
            return privateJson({ error: 'Unauthorized' }, 401);
        }
        return privateJson({ error: 'Authentication unavailable' }, 503);
    }
    if (!user || !uuidSchema.safeParse(user.id).success) {
        return privateJson({ error: 'Unauthorized' }, 401);
    }

    let operatorDecision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        operatorDecision = getAnalysisAuditOperatorDecision(user.id);
    } catch {
        return privateJson({ error: 'Authentication unavailable' }, 503);
    }
    if (operatorDecision === 'unavailable') {
        return privateJson({ error: 'Authentication unavailable' }, 503);
    }
    if (operatorDecision === 'forbidden') {
        return privateJson({ error: 'Forbidden' }, 403);
    }

    let requestId: string;
    let query: ReturnType<typeof parseOrderAuditQuery>;
    try {
        ({ requestId } = await context.params);
        if (!requestIdPattern.test(requestId)) {
            return privateJson({ error: 'Invalid audit request' }, 400);
        }
        // section, pageSize, and filter stay bounded at the typed service boundary.
        query = parseOrderAuditQuery(request.url);
    } catch {
        return privateJson({ error: 'Invalid audit request' }, 400);
    }

    try {
        const payload = await loadAnalysisOrderAuditBundle(
            supabaseAdmin,
            requestId,
            query,
        );
        if (!payload) return privateJson({ error: 'Not found' }, 404);
        return privateJson(payload);
    } catch (caught) {
        if (caught instanceof Error && caught.message === 'ANALYSIS_ORDER_AUDIT_NOT_FOUND') {
            return privateJson({ error: 'Not found' }, 404);
        }
        if (caught instanceof Error && caught.message === 'ANALYSIS_ORDER_AUDIT_INVALID_QUERY') {
            return privateJson({ error: 'Invalid audit request' }, 400);
        }
        return privateJson({ error: 'Audit service unavailable' }, 503);
    }
}
