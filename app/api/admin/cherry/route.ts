import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';
import { cherryAdminActionSchema, loadCherryAdminOverview, runCherryAdminAction } from '@/lib/services/cherry/admin';
import { readCherryMutation } from '@/lib/services/cherry/session';

export const dynamic = 'force-dynamic';

export async function GET() {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    try {
        return privateJson(await loadCherryAdminOverview());
    } catch {
        return privateJson({ error: 'unavailable' }, 503);
    }
}

export async function POST(request: Request) {
    const mutation = await readCherryMutation(request, 4096);
    if (!mutation.ok) return mutation.response;
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    const parsed = cherryAdminActionSchema.safeParse(mutation.body);
    if (!parsed.success) return privateJson({ error: 'invalid_request' }, 400);
    try {
        return privateJson({ outcome: await runCherryAdminAction(parsed.data, operator.userId) });
    } catch {
        return privateJson({ error: 'unavailable' }, 503);
    }
}
