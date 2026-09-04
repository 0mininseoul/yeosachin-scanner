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

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuthErrorLike = {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
};

function isUnauthenticatedAuthError(error: unknown, allowMessageFallback = true): boolean {
    if (!error || typeof error !== 'object') return false;
    const authError = error as AuthErrorLike;
    const status = typeof authError.status === 'number'
        ? authError.status
        : Number(authError.status);
    if (status === 401 || status === 403) return true;
    if (status === 429 || status >= 500) return false;

    const name = typeof authError.name === 'string' ? authError.name : '';
    if (
        name === 'AuthSessionMissingError'
        || name === 'AuthInvalidCredentialsError'
        || name === 'AuthInvalidJwtError'
    ) {
        return true;
    }

    const code = typeof authError.code === 'string'
        ? authError.code.toLowerCase()
        : '';
    if (
        code === 'invalid_token'
        || code === 'invalid_jwt'
        || code === 'bad_jwt'
        || code === 'no_authorization'
        || code === 'invalid_credentials'
        || code === 'jwt_expired'
        || code === 'session_expired'
        || code === 'session_not_found'
        || code === 'refresh_token_not_found'
        || code === 'refresh_token_already_used'
        || code === 'user_not_found'
        || code === 'unauthorized'
    ) {
        return true;
    }

    if (!allowMessageFallback) return false;
    const message = typeof authError.message === 'string' ? authError.message : '';
    return /(?:invalid|expired|missing|not found).*(?:token|session|jwt)|(?:token|session|jwt).*(?:invalid|expired|missing|not found)/i.test(message);
}

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
            if (isUnauthenticatedAuthError(auth.error)) {
                return privateJson({ error: 'Unauthorized' }, 401);
            }
            return privateJson({ error: 'Authentication unavailable' }, 503);
        }
        user = auth.data.user;
    } catch (caught) {
        if (isUnauthenticatedAuthError(caught, false)) {
            return privateJson({ error: 'Unauthorized' }, 401);
        }
        return privateJson({ error: 'Authentication unavailable' }, 503);
    }
    if (!user) return privateJson({ error: 'Unauthorized' }, 401);
    try {
        if (!isAnalysisAuditOperator(user.id)) {
            return privateJson({ error: 'Forbidden' }, 403);
        }
    } catch {
        return privateJson({ error: 'Authentication unavailable' }, 503);
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
