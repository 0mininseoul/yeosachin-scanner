import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
} from '@/lib/services/analysis/score-audit';

export function privateJson(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

/**
 * Same operator gate the existing admin APIs use: a signed-in session whose
 * user id is on the operator allowlist. Returns a ready error response
 * otherwise.
 */
export async function requireConsoleOperator(): Promise<
    { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
    let userId: string | null = null;
    try {
        const supabase = await createClient();
        const auth = await supabase.auth.getUser();
        if (auth.error) {
            return {
                ok: false,
                response: classifyOperatorAuthError(auth.error) === 'unauthorized'
                    ? privateJson({ error: 'Unauthorized' }, 401)
                    : privateJson({ error: 'Authentication unavailable' }, 503),
            };
        }
        userId = auth.data.user?.id ?? null;
    } catch (caught) {
        return {
            ok: false,
            response: classifyOperatorAuthError(caught) === 'unauthorized'
                ? privateJson({ error: 'Unauthorized' }, 401)
                : privateJson({ error: 'Authentication unavailable' }, 503),
        };
    }
    if (!userId || !z.string().uuid().safeParse(userId).success) {
        return { ok: false, response: privateJson({ error: 'Unauthorized' }, 401) };
    }
    let decision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        decision = getAnalysisAuditOperatorDecision(userId);
    } catch {
        return { ok: false, response: privateJson({ error: 'Authentication unavailable' }, 503) };
    }
    if (decision === 'unavailable') {
        return { ok: false, response: privateJson({ error: 'Authentication unavailable' }, 503) };
    }
    if (decision === 'forbidden') return { ok: false, response: privateJson({ error: 'Forbidden' }, 403) };
    return { ok: true, userId };
}
