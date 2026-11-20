import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { AdminConsoleCursorInvalidError, loadAdminUsers } from '@/lib/services/admin/console-records';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
    search: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(256).optional(),
    pageSize: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(),
}).strict();

/** GET /api/admin/users — every users column plus order/lead totals, newest signup first. */
export async function GET(request: Request) {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length > 1)) {
        return privateJson({ error: 'Invalid user request' }, 400);
    }
    const parsed = querySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) return privateJson({ error: 'Invalid user request' }, 400);
    try {
        return privateJson(await loadAdminUsers(supabaseAdmin, {
            search: parsed.data.search,
            cursor: parsed.data.cursor,
            pageSize: parsed.data.pageSize ? Number(parsed.data.pageSize) : 25,
        }));
    } catch (error) {
        if (error instanceof AdminConsoleCursorInvalidError) return privateJson({ error: 'Invalid user request' }, 400);
        return privateJson({ error: 'User service unavailable' }, 503);
    }
}
