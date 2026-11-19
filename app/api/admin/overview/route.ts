import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadConsoleOverview } from '@/lib/services/admin/console-overview';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';

export const dynamic = 'force-dynamic';

/** GET /api/admin/overview — KPI cards and daily/weekly chart series. */
export async function GET() {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    try {
        return privateJson(await loadConsoleOverview({ client: supabaseAdmin }));
    } catch {
        return privateJson({ error: 'Overview unavailable' }, 503);
    }
}
