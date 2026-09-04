import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
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

const uuidSchema = z.string().uuid();

export async function GET(request: Request) {
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

    let query: ReturnType<typeof parseAnalysisAuditQuery>;
    try {
        query = parseAnalysisAuditQuery(request.url);
    } catch {
        return privateJson({ error: 'Invalid audit request' }, 400);
    }

    try {
        const payload = await loadAnalysisScoreAudit(supabaseAdmin, query);
        if (!payload) return privateJson({ error: 'Not found' }, 404);
        return privateJson(payload);
    } catch {
        return privateJson({ error: 'Audit service unavailable' }, 503);
    }
}
