import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { AdminConsoleCursorInvalidError, loadAdminOrders } from '@/lib/services/admin/console-records';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
    cursor: z.string().min(1).max(256).optional(),
    pageSize: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(),
}).strict();

/** GET /api/admin/orders — every paid order, newest first, with its audit bundle when one exists. */
export async function GET(request: Request) {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => params.getAll(key).length > 1)) {
        return privateJson({ error: 'Invalid order request' }, 400);
    }
    const parsed = querySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) return privateJson({ error: 'Invalid order request' }, 400);
    try {
        return privateJson(await loadAdminOrders(supabaseAdmin, {
            cursor: parsed.data.cursor,
            pageSize: parsed.data.pageSize ? Number(parsed.data.pageSize) : 25,
        }));
    } catch (error) {
        if (error instanceof AdminConsoleCursorInvalidError) return privateJson({ error: 'Invalid order request' }, 400);
        return privateJson({ error: 'Order service unavailable' }, 503);
    }
}
