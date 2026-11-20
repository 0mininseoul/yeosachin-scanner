import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    AdminConsoleCursorInvalidError,
    leadMappingStatusSchema,
    leadPreflightFilterSchema,
    loadAdminLeadInputs,
    type AdminLeadInputQuery,
} from '@/lib/services/admin/console-records';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';
import { normalizeLeadInstagramId } from '@/lib/services/leads/contracts';

export const dynamic = 'force-dynamic';

const ALLOWED_KEYS = new Set(['mappingStatus', 'preflightStatus', 'instagramId', 'from', 'to', 'cursor', 'pageSize']);
const dateTime = z.string().datetime({ offset: true });

function single(params: URLSearchParams, key: string): string | null {
    const values = params.getAll(key);
    if (values.length > 1) throw new Error('INVALID_QUERY');
    return values[0] ?? null;
}

function parseLeadInputQuery(url: string): AdminLeadInputQuery {
    const params = new URL(url).searchParams;
    for (const key of params.keys()) if (!ALLOWED_KEYS.has(key)) throw new Error('INVALID_QUERY');
    const mappingStatus = single(params, 'mappingStatus');
    const preflightStatus = single(params, 'preflightStatus');
    const rawInstagramId = single(params, 'instagramId');
    const from = single(params, 'from');
    const to = single(params, 'to');
    const cursor = single(params, 'cursor');
    const pageSize = single(params, 'pageSize');
    const instagramId = rawInstagramId === null ? undefined : normalizeLeadInstagramId(rawInstagramId);
    if (rawInstagramId !== null && !instagramId) throw new Error('INVALID_QUERY');
    const parsedFrom = from === null ? undefined : dateTime.parse(from);
    const parsedTo = to === null ? undefined : dateTime.parse(to);
    if (parsedFrom && parsedTo && Date.parse(parsedFrom) >= Date.parse(parsedTo)) throw new Error('INVALID_QUERY');
    if (pageSize !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(pageSize)) throw new Error('INVALID_QUERY');
    return {
        mappingStatus: mappingStatus === null ? undefined : leadMappingStatusSchema.parse(mappingStatus),
        preflightStatus: preflightStatus === null ? undefined : leadPreflightFilterSchema.parse(preflightStatus),
        instagramId: instagramId ?? undefined,
        from: parsedFrom,
        to: parsedTo,
        cursor: cursor === null ? undefined : z.string().min(1).max(256).parse(cursor),
        pageSize: pageSize === null ? 25 : Number(pageSize),
    };
}

/** GET /api/admin/lead-inputs — one row per analysis input (target + optional exclusion). */
export async function GET(request: Request) {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    let query: AdminLeadInputQuery;
    try {
        query = parseLeadInputQuery(request.url);
    } catch {
        return privateJson({ error: 'Invalid lead request' }, 400);
    }
    try {
        return privateJson(await loadAdminLeadInputs(supabaseAdmin, query));
    } catch (error) {
        if (error instanceof AdminConsoleCursorInvalidError) {
            return privateJson({ error: 'Invalid lead request' }, 400);
        }
        return privateJson({ error: 'Lead service unavailable' }, 503);
    }
}
