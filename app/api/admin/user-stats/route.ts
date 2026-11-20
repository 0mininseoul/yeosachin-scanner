import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadAdminUserStats } from '@/lib/services/admin/console-records';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';

export const dynamic = 'force-dynamic';

/** GET /api/admin/user-stats — gender × age, acquisition source, and 30-day daily signups. */
export async function GET() {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    try {
        return privateJson(await loadAdminUserStats(supabaseAdmin));
    } catch {
        return privateJson({ error: 'User stats unavailable' }, 503);
    }
}
