import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    classifyOperatorAuthError,
    getAnalysisAuditOperatorDecision,
} from '@/lib/services/analysis/score-audit';
import {
    landingLeadListRowSchema,
    loadLandingLeadAdminProjection,
} from '@/lib/services/landing/landing-lead-journey';
import { normalizeLeadInstagramId } from '@/lib/services/leads/contracts';

const allowedQueryKeys = new Set([
    'context', 'mappingStatus', 'instagramId', 'from', 'to', 'cursor', 'pageSize',
]);
const mappingStatusSchema = z.enum([
    'legacy_unlinked', 'anonymous_device', 'authenticated_user', 'unlinked_after_deletion',
]);
const contextSchema = z.enum(['target', 'excluded']);
const dateTimeSchema = z.string().datetime({ offset: true });
const cursorSchema = z.string().min(1).max(512);
const pageSizePattern = /^(?:[1-9]|[1-4][0-9]|50)$/;

type LandingLeadListQuery = {
    context?: 'target' | 'excluded';
    mappingStatus?: 'legacy_unlinked' | 'anonymous_device' | 'authenticated_user' | 'unlinked_after_deletion';
    instagramId?: string;
    from?: string;
    to?: string;
    cursor?: string;
    pageSize: number;
};

function privateJson(body: unknown, status = 200) {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

function parseQueryParamOnce(params: URLSearchParams, key: string): string | null {
    const values = params.getAll(key);
    if (values.length > 1) throw new Error('LANDING_LEAD_INVALID_QUERY');
    return values[0] ?? null;
}

function parseLandingLeadListQuery(url: string): LandingLeadListQuery {
    let params: URLSearchParams;
    try {
        params = new URL(url).searchParams;
    } catch {
        throw new Error('LANDING_LEAD_INVALID_QUERY');
    }
    for (const key of params.keys()) {
        if (!allowedQueryKeys.has(key)) throw new Error('LANDING_LEAD_INVALID_QUERY');
    }

    const contextValue = parseQueryParamOnce(params, 'context');
    const mappingStatusValue = parseQueryParamOnce(params, 'mappingStatus');
    const rawInstagramId = parseQueryParamOnce(params, 'instagramId');
    const from = parseQueryParamOnce(params, 'from');
    const to = parseQueryParamOnce(params, 'to');
    const cursor = parseQueryParamOnce(params, 'cursor');
    const pageSizeValue = parseQueryParamOnce(params, 'pageSize');

    const context = contextValue === null ? undefined : contextSchema.parse(contextValue);
    const mappingStatus = mappingStatusValue === null ? undefined : mappingStatusSchema.parse(mappingStatusValue);
    const instagramId = rawInstagramId === null ? undefined : normalizeLeadInstagramId(rawInstagramId);
    if (rawInstagramId !== null && !instagramId) throw new Error('LANDING_LEAD_INVALID_QUERY');
    const parsedFrom = from === null ? undefined : dateTimeSchema.parse(from);
    const parsedTo = to === null ? undefined : dateTimeSchema.parse(to);
    if (parsedFrom && parsedTo && Date.parse(parsedFrom) >= Date.parse(parsedTo)) {
        throw new Error('LANDING_LEAD_INVALID_QUERY');
    }
    const parsedCursor = cursor === null ? undefined : cursorSchema.parse(cursor);
    if (pageSizeValue !== null && !pageSizePattern.test(pageSizeValue)) {
        throw new Error('LANDING_LEAD_INVALID_QUERY');
    }
    const pageSize = pageSizeValue === null ? 25 : Number(pageSizeValue);
    return { context, mappingStatus, instagramId: instagramId ?? undefined, from: parsedFrom, to: parsedTo, cursor: parsedCursor, pageSize };
}

const safeProjectionSchema = z.object({
    rows: z.array(landingLeadListRowSchema).max(50),
    nextCursor: z.string().max(512).nullable(),
}).strict();

function safeProjection(payload: unknown): z.infer<typeof safeProjectionSchema> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('LANDING_LEAD_PROJECTION_INVALID');
    }
    const raw = payload as { rows?: unknown; nextCursor?: unknown };
    const rows = Array.isArray(raw.rows) ? raw.rows.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error('LANDING_LEAD_PROJECTION_INVALID');
        }
        const candidate = row as Record<string, unknown>;
        return landingLeadListRowSchema.parse({
            instagramId: candidate.instagramId,
            inputContext: candidate.inputContext,
            mappingStatus: candidate.mappingStatus,
            rowCountInJourney: candidate.rowCountInJourney,
            firstSeenAt: candidate.firstSeenAt,
            lastSeenAt: candidate.lastSeenAt,
        });
    }) : [];
    return safeProjectionSchema.parse({
        rows,
        nextCursor: raw.nextCursor === null || raw.nextCursor === undefined ? null : raw.nextCursor,
    });
}

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
    if (!user || !z.string().uuid().safeParse(user.id).success) {
        return privateJson({ error: 'Unauthorized' }, 401);
    }

    let decision: ReturnType<typeof getAnalysisAuditOperatorDecision>;
    try {
        decision = getAnalysisAuditOperatorDecision(user.id);
    } catch {
        return privateJson({ error: 'Authentication unavailable' }, 503);
    }
    if (decision === 'unavailable') return privateJson({ error: 'Authentication unavailable' }, 503);
    if (decision === 'forbidden') return privateJson({ error: 'Forbidden' }, 403);

    let query: LandingLeadListQuery;
    try {
        query = parseLandingLeadListQuery(request.url);
    } catch {
        return privateJson({ error: 'Invalid landing lead request' }, 400);
    }

    try {
        const payload = await loadLandingLeadAdminProjection(supabaseAdmin, query);
        return privateJson(safeProjection(payload));
    } catch {
        return privateJson({ error: 'Landing lead service unavailable' }, 503);
    }
}
