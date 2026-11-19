import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadAdminOrderCustomers } from '@/lib/services/admin/console-records';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';

export const dynamic = 'force-dynamic';

const requestIdsSchema = z.array(z.string().uuid()).min(1).max(50);

/**
 * GET /api/admin/order-customers?requestId=<uuid>&requestId=<uuid>…
 * Customer, payment, acquisition and device facts for the orders on screen.
 */
export async function GET(request: Request) {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== 'requestId')) {
        return privateJson({ error: 'Invalid order customer request' }, 400);
    }
    const parsed = requestIdsSchema.safeParse([...new Set(params.getAll('requestId'))]);
    if (!parsed.success) return privateJson({ error: 'Invalid order customer request' }, 400);
    try {
        return privateJson({ rows: await loadAdminOrderCustomers(supabaseAdmin, parsed.data) });
    } catch {
        return privateJson({ error: 'Order customer service unavailable' }, 503);
    }
}
